import { openSync, closeSync, appendFileSync } from "node:fs";
import { OPENCODE_BIN, AGENT_NAME, TIMEOUTS_MS, STALL_POLL_MS, KILL_GRACE_MS } from "./config.ts";
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
  /** Effort variant for this specific model, from models.ts `pickVariant`.
   * Omitted or "" sends no `--variant` flag at all, which is correct for the
   * many models that publish no variants. There is deliberately no default:
   * a global default was previously hardcoded to "max", a value that no
   * model actually publishes. */
  variant?: string;
  agent?: string;
}

export type RawStatus = "completed" | "killed_wall" | "killed_stall" | "spawn_error";

export interface ToolUseRecord {
  tool: string;
  input: unknown;
  status: "completed" | "error" | "pending" | "running";
  error?: string;
  /** http(s) URLs appearing in a web tool's OUTPUT.
   *
   * Needed because only `webfetch` carries its URL in its input; `websearch`
   * takes `{ query }` and returns the URLs in its result body. Without this, a
   * task that searched but did not fetch would have zero recorded sources, and
   * the evidence gate would flag every correctly-cited URL as a phantom.
   *
   * ONLY the URLs are kept, capped — never the body. Dragging raw tool output
   * around is the exact thing ocd exists to avoid, and a search result body is
   * also attacker-controlled text that has no business near the envelope. */
  resultUrls?: string[];
}

/** Tools whose output is scanned for source URLs. Deliberately a fixed list
 * rather than "any tool with URLs in its output" — a grep across a repo full
 * of links would otherwise manufacture sources the model never retrieved. */
const WEB_TOOLS = new Set(["websearch", "webfetch"]);

/** Sanity bound on URLs pulled from one tool call — NOT a display cap.
 *
 * This number must stay well clear of anything a real search produces,
 * because the evidence gate treats this list as ground truth: a URL dropped
 * here becomes a URL the model is accused of inventing. That is not
 * hypothetical. At 20 this fired for real — a websearch returned 33 unique
 * URLs, the model correctly cited the one at index 29, and the gate reported
 * `phantom_source_reference` against a citation that was perfectly honest.
 *
 * Envelope size is handled separately and later, by SOURCES_REPORTED_CAP in
 * envelope.ts, which trims only what is REPORTED and only after the gate has
 * checked against the full set. Keeping the two caps apart is the whole
 * point: one bounds memory, the other bounds output, and neither gets to
 * decide whether the model told the truth. */
const MAX_RESULT_URLS = 500;

export function extractResultUrls(output: string | undefined): string[] {
  if (!output) return [];
  const out = new Set<string>();
  for (const m of output.matchAll(/https?:\/\/[^\s"'<>)\]}\\]+/gi)) {
    out.add(m[0].replace(/[.,;:!?]+$/, ""));
    if (out.size >= MAX_RESULT_URLS) break;
  }
  return [...out];
}

/** A provider-level failure reported by opencode itself.
 *
 * `message` is the clean, structured reason ("Model is disabled") and is the
 * ONLY thing that should be pattern-matched. The surrounding event carries a
 * `statusCode` that is actively misleading — a disabled model is reported as
 * `401`, which a naive regex over the raw JSON would classify as an expired
 * login and escalate instead of switching models. */
export interface ApiErrorRecord {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
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
  /** Set when opencode emitted a `type: "error"` event. */
  apiError: ApiErrorRecord | null;
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
  if (opts.variant) args.push("--variant", opts.variant);
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
      apiError: null,
    };
  }

  let lastEventAt = Date.now();
  let sessionId: string | null = opts.sessionId ?? null;
  const textParts: string[] = [];
  const toolUses: ToolUseRecord[] = [];
  let tokens: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let cost = 0;
  let malformedLines = 0;
  let apiError: ApiErrorRecord | null = null;
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

    // Provider failures arrive as their own event type on stdout, not on
    // stderr. Without capturing this a disabled/geo-blocked/delisted model
    // is indistinguishable from a model that simply said nothing.
    if (evt.type === "error" && evt.error) {
      const msg = evt.error.data?.message;
      if (typeof msg === "string" && msg && !apiError) {
        apiError = {
          message: msg,
          statusCode: evt.error.data?.statusCode,
          isRetryable: evt.error.data?.isRetryable,
        };
      }
      return;
    }

    const part = evt.part;
    if (!part) return;
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool" && part.tool) {
      const resultUrls = WEB_TOOLS.has(part.tool) ? extractResultUrls(part.state?.output) : [];
      toolUses.push({
        tool: part.tool,
        input: part.state?.input,
        status: (part.state?.status as ToolUseRecord["status"]) ?? "pending",
        error: part.state?.error,
        ...(resultUrls.length ? { resultUrls } : {}),
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
    apiError,
  };
}
