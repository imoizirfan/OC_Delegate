import { openSync, closeSync, appendFileSync } from "node:fs";
import { OPENCODE_BIN, AGENT_NAME, VARIANT, TIMEOUTS_MS, STALL_POLL_MS, KILL_GRACE_MS } from "./config.ts";
import type { RawEvent, TaskClass, TokenUsage } from "./types.ts";

export interface DispatchOptions {
  dir: string;
  prompt: string;
  taskClass: TaskClass;
  transcriptPath: string;
  /** Continue this opencode session instead of starting fresh. */
  sessionId?: string;
  /** Override the default free model (used by the fallback ladder). */
  model?: string;
  /** Defaults to config.VARIANT; pass "" to omit --variant entirely. */
  variant?: string;
  agent?: string;
}

export type RawStatus = "completed" | "killed_wall" | "killed_stall" | "spawn_error";

export interface ToolUseRecord {
  tool: string;
  input: unknown;
  status: "completed" | "error" | "pending" | "running";
  error?: string;
}

export interface DispatchResult {
  rawStatus: RawStatus;
  exitCode: number | null;
  sessionId: string | null;
  textParts: string[];
  toolUses: ToolUseRecord[];
  tokens: TokenUsage;
  cost: number;
  durationMs: number;
  stderrTail: string;
  malformedLines: number;
}

// Ground-truthed against a live denial (see plan doc): opencode returns this
// exact prefix on both explicit `deny` rules AND `ask` rules that auto-resolve
// to deny in headless mode (no TTY to confirm). A generic tool failure (e.g.
// file-not-found) has a completely different message shape, so this prefix
// reliably distinguishes "policy blocked this" from "the tool just failed".
const PERMISSION_DENIAL_PREFIX =
  "The user has specified a rule which prevents you from using this specific tool call";

export function isPermissionDenial(state: { status?: string; error?: string } | undefined): boolean {
  return state?.status === "error" && !!state.error?.startsWith(PERMISSION_DENIAL_PREFIX);
}

/** Strip the embedded permission-ruleset dump from a denial error so it never
 * reaches Claude's context (the raw error is the *entire* resolved ruleset). */
export function sanitizeDenialMessage(tool: string): string {
  return `tool '${tool}' blocked by permission rule`;
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const args = ["run", "--agent", opts.agent ?? AGENT_NAME, "--format", "json", "--dir", opts.dir];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  const variant = opts.variant === undefined ? VARIANT : opts.variant;
  if (variant) args.push("--variant", variant);
  args.push(opts.prompt);

  const { wall, stall } = TIMEOUTS_MS[opts.taskClass];
  const startedAt = Date.now();

  // Open once, append raw lines synchronously as they arrive. Confirmed by
  // probing: stdout is block-buffered when captured via a pipe, so a killed
  // process can leave a 0-byte redirect target even after real work happened.
  // Writing per-line to our own fd sidesteps that entirely.
  const fd = openSync(opts.transcriptPath, "a");

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [OPENCODE_BIN, ...args],
      cwd: opts.dir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (err) {
    closeSync(fd);
    return {
      rawStatus: "spawn_error",
      exitCode: null,
      sessionId: null,
      textParts: [],
      toolUses: [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cost: 0,
      durationMs: Date.now() - startedAt,
      stderrTail: String(err),
      malformedLines: 0,
    };
  }

  let lastEventAt = Date.now();
  let sessionId: string | null = opts.sessionId ?? null;
  const textParts: string[] = [];
  const toolUses: ToolUseRecord[] = [];
  let tokens: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let cost = 0;
  let malformedLines = 0;
  let rawStatus: RawStatus = "completed";
  let killed = false;

  function killProc(reason: RawStatus) {
    if (killed) return;
    killed = true;
    rawStatus = reason;
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
    setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        /* already dead */
      }
    }, KILL_GRACE_MS);
  }

  // No `timeout`/`gtimeout` binary on this machine (confirmed by probing) —
  // the wrapper owns both a hard wall-clock kill and a stall watchdog that
  // fires when no event has arrived recently, since observed latency ranged
  // from 0.5s to 6+ minutes and a silent hang is the failure mode that
  // matters most.
  const wallTimer = setTimeout(() => killProc("killed_wall"), wall);
  const stallTimer = setInterval(() => {
    if (Date.now() - lastEventAt > stall) killProc("killed_stall");
  }, STALL_POLL_MS);

  let buffer = "";
  const decoder = new TextDecoder();

  function handleLine(line: string) {
    if (!line.trim()) return;
    appendFileSync(fd, line + "\n");
    lastEventAt = Date.now();
    let evt: RawEvent;
    try {
      evt = JSON.parse(line);
    } catch {
      malformedLines++;
      return;
    }
    if (evt.sessionID) sessionId = evt.sessionID;
    const part = evt.part;
    if (!part) return;
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool" && part.tool) {
      toolUses.push({
        tool: part.tool,
        input: part.state?.input,
        status: (part.state?.status as ToolUseRecord["status"]) ?? "pending",
        error: part.state?.error,
      });
    } else if (part.type === "step-finish" && part.tokens) {
      tokens = {
        input: part.tokens.input,
        output: part.tokens.output,
        cache_read: part.tokens.cache?.read ?? 0,
        cache_write: part.tokens.cache?.write ?? 0,
      };
      if (typeof part.cost === "number") cost = part.cost;
    }
  }

  try {
    if (proc.stdout && typeof proc.stdout !== "number") {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      }
      if (buffer.trim()) handleLine(buffer);
    }
  } catch {
    // Stream errored, most likely because we just killed the process —
    // fall through and report whatever was captured up to that point.
  }

  clearTimeout(wallTimer);
  clearInterval(stallTimer);
  closeSync(fd);

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch {
    /* ignore */
  }

  let stderrTail = "";
  try {
    if (proc.stderr && typeof proc.stderr !== "number") {
      stderrTail = (await new Response(proc.stderr as ReadableStream<Uint8Array>).text()).slice(-2000);
    }
  } catch {
    /* ignore */
  }

  return {
    rawStatus,
    exitCode,
    sessionId,
    textParts,
    toolUses,
    tokens,
    cost,
    durationMs: Date.now() - startedAt,
    stderrTail,
    malformedLines,
  };
}
