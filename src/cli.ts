#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureStateDirs,
  withRegistry,
  readRegistry,
  resolveRef,
  claimScope,
  upsertEntry,
  dropEntry,
  listEntries,
  retireStale,
  isPidAlive,
} from "./registry.ts";
import { dispatch } from "./dispatch.ts";
import { runWithLadder } from "./ladder.ts";
import { buildEnvelope } from "./envelope.ts";
import { buildInitialPrompt, buildContinuationPrompt } from "./contract.ts";
import { isGitRepo, currentHead } from "./verify.ts";
import {
  AGENT_NAME,
  OPENCODE_BIN,
  MAX_ROUNDS,
  CONCURRENCY_CAP,
  STATE_DIR,
  TRANSCRIPT_DIR,
  PROBE_TIMEOUT_MS,
  MODEL_PREF_PATH,
} from "./config.ts";
import {
  resolveModelChain,
  probeChain,
  loadHealth,
  pickVariant,
  readModelPref,
  writeModelPref,
  resolvePin,
  resolvePrefer,
} from "./models.ts";
import type { Envelope, TaskClass } from "./types.ts";

// --- tiny hand-rolled arg parser (no deps) ---------------------------------

const BOOLEAN_FLAGS = new Set(["bg", "fresh", "with-diff", "live", "probe", "refresh", "all", "unpin"]);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        flags[key] = rest[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: command ?? "", positionals, flags };
}

function strFlag(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === "string" ? v : undefined;
}

function printJSON(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(message: string, extra?: Record<string, unknown>): never {
  printJSON({ status: "error", error: message, ...extra });
  process.exit(1);
  throw new Error("unreachable");
}

const TASK_CLASSES = ["read", "analyze", "edit", "test"] as const;
function isTaskClass(v: unknown): v is TaskClass {
  return typeof v === "string" && (TASK_CLASSES as readonly string[]).includes(v);
}

async function runGitText(dir: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

// --- run --------------------------------------------------------------------

async function cmdRun(args: ParsedArgs): Promise<void> {
  const classFlag = strFlag(args, "class");
  const dir = strFlag(args, "dir");
  const tag = strFlag(args, "tag");
  const task = args.positionals[0];
  const scopeRaw = strFlag(args, "scope");
  const bg = args.flags["bg"] === true;

  if (!isTaskClass(classFlag)) fail("`--class` must be one of read|analyze|edit|test");
  if (!dir || !dir.startsWith("/")) fail("`--dir` is required and must be an absolute path");
  if (!existsSync(dir)) fail(`--dir does not exist: ${dir}`);
  if (!tag) fail("`--tag` is required (used as the ref for later ocd cont/poll/result calls)");
  if (!task) fail("a task description is required as the final argument");

  const taskClass = classFlag;
  const scope = scopeRaw ? scopeRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  ensureStateDirs();

  const existing = await resolveRef(tag);
  if (existing?.bg_status === "running" && existing.pid && isPidAlive(existing.pid)) {
    printJSON({ ref: tag, status: "conflict", next: "conflict", error: `tag '${tag}' already has a running task (pid ${existing.pid})` });
    process.exit(2);
  }

  let baseHead: string | undefined;
  if (taskClass === "edit") {
    if (!(await isGitRepo(dir))) fail(`--class edit requires --dir to be a git repository: ${dir}`);
    const status = await runGitText(dir, ["status", "--porcelain"]);
    if (status.stdout.trim().length > 0) {
      fail(
        `--class edit refused: working tree at ${dir} is not clean. Commit or stash existing changes first — an edit task's diff can only be verified against a known-clean base.`,
      );
    }
    baseHead = (await currentHead(dir)) ?? undefined;
    if (!baseHead) fail(`could not resolve HEAD in ${dir}`);

    const claim = await withRegistry((reg) => claimScope(reg, tag, dir, scope.length ? scope : [dir]));
    if (!claim.ok) {
      printJSON({ ref: tag, status: "conflict", next: "conflict", error: `scope overlaps with running task '${claim.conflictWith}' at '${claim.conflictPath}'` });
      process.exit(2);
    }
  }

  let branch: string | undefined;
  if (taskClass === "edit" && baseHead) {
    // Bookmark only — deliberately never checked out. Checking out a new
    // branch in the caller's actual working directory would yank whatever
    // else is using that directory onto a different branch mid-session;
    // instead the model's edits land directly on whatever branch was
    // already checked out (exactly like an uncommitted change a human would
    // make), and this bookmark just labels the pre-task state for revert.
    branch = `ocd/${tag}-${crypto.randomUUID().slice(0, 8)}`;
    await runGitText(dir, ["branch", branch, baseHead]);
  }

  if (bg) {
    const reg = await readRegistry();
    const runningCount = listEntries(reg).filter((e) => e.bg_status === "running" && e.pid && isPidAlive(e.pid)).length;
    if (runningCount >= CONCURRENCY_CAP) {
      fail(`concurrency cap reached (${CONCURRENCY_CAP} background tasks already running) — poll or wait for one to finish before dispatching another`);
    }
  }

  const transcriptPath = join(TRANSCRIPT_DIR, `${tag}.ndjson`);
  const initialPrompt = buildInitialPrompt(taskClass, task, scope);
  const effectiveScope = scope.length ? scope : taskClass === "edit" ? [dir] : undefined;

  if (!bg) {
    const ladderResult = await runWithLadder({ dir, taskClass, initialPrompt, transcriptPath, scope: effectiveScope, baseHead });
    const envelope = buildEnvelope({ ref: tag, ladderResult, rounds: 0, transcriptPath });

    await withRegistry((reg) => {
      retireStale(reg);
      upsertEntry(reg, {
        tag,
        session_id: envelope.session_id,
        dir,
        agent: AGENT_NAME,
        class: taskClass,
        model: envelope.model ?? "",
        initial_task: task,
        created_at: Date.now(),
        last_used_at: Date.now(),
        rounds: 0,
        turn_count: 1,
        scope,
        branch,
        base_head: baseHead,
        bg: false,
        transcript_path: transcriptPath,
        last_envelope: envelope,
      });
    });

    printJSON(envelope);
    process.exit(envelope.status === "ok" ? 0 : envelope.status === "conflict" ? 2 : 1);
  } else {
    const jobsDir = join(STATE_DIR, "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const jobPath = join(jobsDir, `${tag}.json`);
    writeFileSync(jobPath, JSON.stringify({ tag, dir, taskClass, initialPrompt, transcriptPath, scope: effectiveScope, baseHead }));

    const cliPath = fileURLToPath(import.meta.url);
    const child = Bun.spawn({
      cmd: ["bun", cliPath, "_bg-worker", jobPath],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();

    await withRegistry((reg) => {
      retireStale(reg);
      upsertEntry(reg, {
        tag,
        session_id: null,
        dir,
        agent: AGENT_NAME,
        class: taskClass,
        // Unknown until the background worker resolves the chain and
        // dispatches; it writes the real model back on completion. Empty (not
        // a guessed default) so a later `cont` falls through to fresh
        // discovery rather than resuming on a model that was never used.
        model: "",
        initial_task: task,
        created_at: Date.now(),
        last_used_at: Date.now(),
        rounds: 0,
        turn_count: 0,
        scope,
        branch,
        base_head: baseHead,
        bg: true,
        pid: child.pid,
        bg_status: "running",
        transcript_path: transcriptPath,
      });
    });

    printJSON({ ref: tag, status: "dispatched", pid: child.pid, transcript: transcriptPath, poll_hint: `ocd poll ${tag}` });
  }
}

// --- _bg-worker (internal) ---------------------------------------------------

async function cmdBgWorker(jobPath: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as {
    tag: string; dir: string; taskClass: TaskClass; initialPrompt: string;
    transcriptPath: string; scope?: string[]; baseHead?: string;
  };
  try {
    const ladderResult = await runWithLadder({
      dir: job.dir, taskClass: job.taskClass, initialPrompt: job.initialPrompt,
      transcriptPath: job.transcriptPath, scope: job.scope, baseHead: job.baseHead,
    });
    const envelope = buildEnvelope({ ref: job.tag, ladderResult, rounds: 0, transcriptPath: job.transcriptPath });
    await withRegistry((reg) => {
      const entry = reg.entries[job.tag];
      if (!entry) return;
      entry.session_id = envelope.session_id;
      entry.model = envelope.model ?? entry.model;
      entry.last_used_at = Date.now();
      entry.turn_count += 1;
      entry.bg_status = "done";
      entry.last_envelope = envelope;
    });
  } catch (err) {
    await withRegistry((reg) => {
      const entry = reg.entries[job.tag];
      if (!entry) return;
      entry.bg_status = "failed";
      const errorEnvelope: Envelope = {
        ref: job.tag,
        session_id: entry.session_id,
        status: "error",
        level: 0,
        model: entry.model,
        rounds: 0,
        text: "",
        evidence: { tool_calls: 0, tools: [], files_seen: [] },
        warnings: [],
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        cost: 0,
        duration_ms: 0,
        transcript: job.transcriptPath,
        next: "escalate",
        error: `background worker crashed: ${String(err).slice(0, 300)}`,
      };
      entry.last_envelope = errorEnvelope;
    });
  } finally {
    try {
      unlinkSync(jobPath);
    } catch {
      /* best effort */
    }
  }
}

// --- cont ---------------------------------------------------------------------

async function cmdCont(args: ParsedArgs): Promise<void> {
  const ref = args.positionals[0];
  const feedback = args.positionals[1];
  if (!ref) fail('usage: ocd cont <ref> "<feedback>"');
  if (!feedback) fail("feedback text is required as the second argument");

  const entry = await resolveRef(ref);
  if (!entry) fail(`unknown ref '${ref}' — no such tag or session_id in the registry. Use 'ocd run' to start a new task.`);

  if (entry.bg_status === "running") fail(`ref '${ref}' has a background task still running (pid ${entry.pid}) — poll it first`);

  if (entry.rounds >= MAX_ROUNDS) {
    printJSON({
      ref: entry.tag,
      session_id: entry.session_id,
      status: entry.last_envelope?.status ?? "error",
      next: "escalate",
      rounds: entry.rounds,
      error: `MAX_ROUNDS (${MAX_ROUNDS}) reached for this ref — stop iterating here; either accept the last result or start a fresh 'ocd run'`,
    });
    process.exit(1);
  }

  const continuationPrompt = buildContinuationPrompt(feedback);
  // Used only if the ladder must fall back to a fresh session on an alt
  // model — that session has no history, so it needs the real original
  // task, not just the follow-up feedback, to have a chance of a sane result.
  const initialPromptFallback = buildInitialPrompt(entry.class, `${entry.initial_task}\n\n(Follow-up feedback: ${feedback})`, entry.scope);

  const ladderResult = await runWithLadder({
    dir: entry.dir,
    taskClass: entry.class,
    initialPrompt: initialPromptFallback,
    continuationPrompt,
    sessionId: entry.session_id ?? undefined,
    startModel: entry.model,
    transcriptPath: entry.transcript_path,
    scope: entry.scope,
    baseHead: entry.base_head,
  });

  const envelope = buildEnvelope({ ref: entry.tag, ladderResult, rounds: entry.rounds + 1, transcriptPath: entry.transcript_path });

  await withRegistry((reg) => {
    const e = reg.entries[entry.tag];
    if (!e) return;
    e.session_id = envelope.session_id;
    e.model = envelope.model ?? e.model;
    e.last_used_at = Date.now();
    e.rounds += 1;
    e.turn_count += 1;
    e.last_envelope = envelope;
  });

  printJSON(envelope);
  process.exit(envelope.status === "ok" ? 0 : 1);
}

// --- poll / result / list / drop / revert -------------------------------------

async function cmdPoll(args: ParsedArgs): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) fail("usage: ocd poll <ref> [--wait <sec>]");
  const waitSec = Number(strFlag(args, "wait") ?? "0") || 0;
  const deadline = Date.now() + waitSec * 1000;

  for (;;) {
    const entry = await resolveRef(ref);
    if (!entry) fail(`unknown ref '${ref}'`);

    if (entry.bg_status !== "running") {
      if (entry.last_envelope) {
        printJSON(entry.last_envelope);
        process.exit(entry.last_envelope.status === "ok" ? 0 : 1);
      }
      fail(`ref '${ref}' has no result and is not running`);
    }

    if (entry.pid && !isPidAlive(entry.pid)) {
      await withRegistry((reg) => {
        const e = reg.entries[entry.tag];
        if (e) e.bg_status = "failed";
      });
      fail(`background worker for '${ref}' (pid ${entry.pid}) is no longer running but never reported a result`);
    }

    if (Date.now() >= deadline) {
      printJSON({ ref: entry.tag, status: "running", pid: entry.pid, next: "poll_again" });
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdResultCmd(args: ParsedArgs): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) fail("usage: ocd result <ref> [--with-diff]");
  const entry = await resolveRef(ref);
  if (!entry) fail(`unknown ref '${ref}'`);
  if (!entry.last_envelope) fail(`ref '${ref}' has no result yet`, { bg_status: entry.bg_status ?? "unknown" });

  const withDiff = args.flags["with-diff"] === true;
  if (withDiff && entry.class === "edit" && entry.base_head) {
    const diff = await runGitText(entry.dir, ["diff", entry.base_head]);
    printJSON({ ...entry.last_envelope, diff: diff.stdout.slice(0, 20000) });
  } else {
    printJSON(entry.last_envelope);
  }
  process.exit(entry.last_envelope.status === "ok" ? 0 : 1);
}

async function cmdList(): Promise<void> {
  const reg = await readRegistry();
  const entries = listEntries(reg).map((e) => ({
    tag: e.tag,
    class: e.class,
    dir: e.dir,
    model: e.model,
    status: e.last_envelope?.status ?? e.bg_status ?? "idle",
    bg_status: e.bg_status ?? null,
    rounds: e.rounds,
    turn_count: e.turn_count,
    created_at: new Date(e.created_at).toISOString(),
    last_used_at: new Date(e.last_used_at).toISOString(),
  }));
  printJSON(entries);
}

async function cmdDrop(args: ParsedArgs): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) fail("usage: ocd drop <ref>");
  const entry = await resolveRef(ref);
  if (!entry) fail(`unknown ref '${ref}'`);
  if (entry.pid && entry.bg_status === "running" && isPidAlive(entry.pid)) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  const dropped = await withRegistry((reg) => dropEntry(reg, ref));
  printJSON({ ref, dropped });
}

async function cmdRevert(args: ParsedArgs): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) fail("usage: ocd revert <ref>");
  const entry = await resolveRef(ref);
  if (!entry) fail(`unknown ref '${ref}'`);
  if (entry.class !== "edit" || !entry.base_head) fail(`ref '${ref}' is not an edit task with a recorded base — nothing to revert`);

  const changed = entry.last_envelope?.evidence.git?.changed ?? [];
  if (changed.length === 0) {
    printJSON({ ref, reverted: [], note: "no changed files recorded" });
    return;
  }

  // `git checkout <base_head> -- <path>` only works for files that existed
  // at base_head — it has no history to restore for a file the task newly
  // created, and fails with "pathspec did not match any files" if asked to.
  // Split on that: existing-file changes get restored via checkout (batched
  // into one call); new-since-base files get deleted directly, since
  // "revert" for a file that didn't exist before means it shouldn't exist
  // after. Never git reset --hard (stays deny-listed for the delegate agent
  // too) — this only touches the files this task actually changed.
  const existedAtBase: string[] = [];
  const newSinceBase: string[] = [];
  for (const file of changed) {
    const check = await runGitText(entry.dir, ["cat-file", "-e", `${entry.base_head}:${file}`]);
    (check.code === 0 ? existedAtBase : newSinceBase).push(file);
  }

  if (existedAtBase.length > 0) {
    const co = await runGitText(entry.dir, ["checkout", entry.base_head, "--", ...existedAtBase]);
    if (co.code !== 0) fail(`git checkout failed for ${JSON.stringify(existedAtBase)}: ${co.stderr.slice(0, 500)}`);
  }
  const deleteErrors: string[] = [];
  for (const file of newSinceBase) {
    try {
      rmSync(join(entry.dir, file), { force: true });
    } catch (err) {
      deleteErrors.push(`${file}: ${String(err)}`);
    }
  }
  if (deleteErrors.length > 0) fail(`failed to remove new-since-base files: ${deleteErrors.join("; ")}`);

  if (entry.branch) {
    await runGitText(entry.dir, ["branch", "-D", entry.branch]);
  }
  printJSON({ ref, reverted: changed, restored: existedAtBase, deleted: newSinceBase, branch_removed: entry.branch ?? null });
}

// --- doctor ---------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** `ocd models [--refresh] [--probe] [--all] [--pin <id>] [--prefer <a,b>] [--unpin]`
 *
 * Shows exactly which model would be chosen and why. This is the inspection
 * surface for the whole selection mechanism — without it, "we pick the best
 * free model" is an unfalsifiable claim. `--probe` additionally sends a real
 * request to candidates and records the result in the health file, which is
 * the only way to catch a model that advertises itself as active but is
 * disabled, geo-blocked, or hanging. */
async function cmdModels(args: ParsedArgs): Promise<void> {
  const refresh = args.flags["refresh"] === true;
  const doProbe = args.flags["probe"] === true;
  const probeAll = args.flags["all"] === true;

  // --pin / --prefer / --unpin persist an override to STATE_DIR and exit.
  // They are handled before resolution so `ocd models --pin X` reports the
  // state it just wrote rather than the chain it would have resolved without
  // it. Writing here (rather than in a separate `ocd model` command) keeps
  // the whole model-selection surface under one verb.
  const pinFlag = strFlag(args, "pin");
  const preferFlag = strFlag(args, "prefer");
  const unpin = args.flags["unpin"] === true;
  if (pinFlag !== undefined || preferFlag !== undefined || unpin) {
    if (unpin && (pinFlag !== undefined || preferFlag !== undefined)) {
      fail("--unpin clears the saved override; don't combine it with --pin or --prefer");
    }
    const current = readModelPref();
    const next = unpin
      ? { version: 1 as const }
      : {
          version: 1 as const,
          pin: pinFlag !== undefined ? pinFlag : current.pin,
          prefer:
            preferFlag !== undefined
              ? preferFlag.split(",").map((x) => x.trim()).filter(Boolean)
              : current.prefer,
        };
    if (!unpin && pinFlag !== undefined && !pinFlag.includes("/")) {
      fail(
        `--pin expects a provider-qualified model id (e.g. '<provider>/<model>'), got '${pinFlag}'. ` +
          "Run `ocd models` to see the exact ids currently on offer, or use --prefer for substring matching.",
      );
    }
    writeModelPref(next);
    const pin = resolvePin();
    const prefer = resolvePrefer();
    printJSON({
      ok: true,
      saved: next,
      path: MODEL_PREF_PATH,
      effective_pin: pin ? { id: pin.id, from: pin.from } : null,
      effective_prefer: prefer ? { list: prefer.list, from: prefer.from } : null,
      note:
        pin?.from === "env" || prefer?.from === "env"
          ? "OCD_MODEL / OCD_MODEL_PREFER is set in this environment and takes precedence over the saved file"
          : undefined,
    });
    return;
  }

  const resolved = await resolveModelChain({ refresh });
  const health = loadHealth();

  let probeOutcomes: Awaited<ReturnType<typeof probeChain>> | null = null;
  if (doProbe) {
    probeOutcomes = await probeChain(resolved.chain, PROBE_TIMEOUT_MS, { all: probeAll });
  }

  // Re-rank after probing so `selected` reflects what the probes just learned
  // rather than the stale ordering they were based on.
  const finalChain = doProbe ? (await resolveModelChain({ refresh: false })).chain : resolved.chain;
  const usable = finalChain.filter((c) => !c.benched);

  printJSON({
    ok: usable.length > 0,
    selected: usable[0]?.model.id ?? null,
    variant: usable[0] ? (pickVariant(usable[0].model) ?? null) : null,
    pinned: resolved.pinned,
    override: {
      pin: resolvePin(),
      prefer: resolvePrefer(),
      path: MODEL_PREF_PATH,
    },
    source: resolved.source,
    fetched_at: new Date(resolved.fetchedAt).toISOString(),
    warnings: resolved.warnings,
    candidates: finalChain.map((c) => ({
      id: c.model.id,
      score: Number(c.score.toFixed(1)),
      benched: c.benched,
      context: c.model.contextLimit,
      released: c.model.releaseDate,
      variants: c.model.variants,
      variant_used: pickVariant(c.model) ?? null,
      health: health.models[c.model.id]
        ? {
            ok: health.models[c.model.id]!.ok,
            kind: health.models[c.model.id]!.kind,
            detail: health.models[c.model.id]!.detail,
            checked: new Date(health.models[c.model.id]!.at).toISOString(),
          }
        : null,
      why: c.reason,
    })),
    probe: probeOutcomes
      ? { healthy: probeOutcomes.healthy, outcomes: probeOutcomes.outcomes }
      : null,
  });
  process.exit(usable.length > 0 ? 0 : 1);
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const checks: DoctorCheck[] = [];

  try {
    const proc = Bun.spawn({ cmd: [OPENCODE_BIN, "--version"], stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    checks.push({ name: "opencode_binary", ok: code === 0 && out.length > 0, detail: code === 0 ? `version ${out}` : "opencode --version failed" });
  } catch (err) {
    checks.push({ name: "opencode_binary", ok: false, detail: `opencode not found on PATH: ${String(err)}` });
  }

  try {
    const proc = Bun.spawn({ cmd: ["git", "--version"], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    checks.push({ name: "git_binary", ok: code === 0, detail: code === 0 ? "git available" : "git not found" });
  } catch (err) {
    checks.push({ name: "git_binary", ok: false, detail: String(err) });
  }

  try {
    const proc = Bun.spawn({ cmd: [OPENCODE_BIN, "providers", "list"], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const hasCreds = /credentials/i.test(out) && !/0 credentials/i.test(out);
    checks.push({ name: "opencode_zen_auth", ok: code === 0 && hasCreds, detail: hasCreds ? "credentials present" : "no provider credentials found — run `opencode auth login`" });
  } catch (err) {
    checks.push({ name: "opencode_zen_auth", ok: false, detail: String(err) });
  }

  try {
    const proc = Bun.spawn({ cmd: [OPENCODE_BIN, "debug", "agent", AGENT_NAME], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      checks.push({ name: "agent_permissions", ok: false, detail: `'${AGENT_NAME}' agent not found — run install.sh first (${out.slice(0, 200)})` });
    } else {
      const parsed = JSON.parse(out) as { permission?: { permission: string; pattern: string; action: string }[] };
      const rules = parsed.permission ?? [];
      // These are exactly the rules this system depends on for safety —
      // re-asserted against the LIVE resolved config every run rather than
      // trusted from the jsonc source. Resolved config lists base-then-
      // override rules per (permission, pattern), last one wins; this
      // matters because getting that wrong once already caused a false
      // "fixed" conclusion during development (see the comment history in
      // config/agent.ocd-delegate.jsonc) — worth re-checking mechanically
      // on every run rather than trusting a one-time reading again.
      const expectedDeny: [string, string][] = [
        ["bash", "git push*"],
        ["bash", "git push --force*"],
        ["bash", "git reset --hard*"],
        ["bash", "rm -rf*"],
        ["bash", "sudo*"],
        ["bash", "npm publish*"],
        ["external_directory", "*"],
        ["doom_loop", "*"],
        ["webfetch", "*"],
      ];
      const mismatches: string[] = [];
      for (const [perm, pattern] of expectedDeny) {
        const matches = rules.filter((r) => r.permission === perm && r.pattern === pattern);
        const resolved = matches.at(-1);
        if (!resolved || resolved.action !== "deny") {
          mismatches.push(`${perm}:${pattern} resolved to '${resolved?.action ?? "MISSING"}', expected 'deny'`);
        }
      }
      checks.push({
        name: "agent_permissions",
        ok: mismatches.length === 0,
        detail: mismatches.length === 0 ? "all expected deny-rules confirmed in resolved config" : mismatches.join("; "),
      });
    }
  } catch (err) {
    checks.push({ name: "agent_permissions", ok: false, detail: String(err) });
  }

  try {
    ensureStateDirs();
    await withRegistry((reg) => {
      retireStale(reg);
    });
    checks.push({ name: "registry_writable", ok: true, detail: STATE_DIR });
  } catch (err) {
    checks.push({ name: "registry_writable", ok: false, detail: String(err) });
  }

  // Model availability is a first-class health check: every other check can
  // pass while the tool is completely unusable because the provider retired
  // the free lineup. Probing (rather than just listing) is what catches a
  // model that lists as active but is disabled or geo-blocked.
  let selectedModel: string | undefined;
  let selectedVariant: string | undefined;
  try {
    const resolved = await resolveModelChain({ refresh: args.flags["refresh"] === true });
    if (resolved.chain.length === 0) {
      checks.push({
        name: "model_available",
        ok: false,
        detail: `no free tool-calling model found. ${resolved.warnings.join("; ")}`,
      });
    } else if (args.flags["live"] === true || args.flags["probe"] === true) {
      const { healthy, outcomes } = await probeChain(resolved.chain, PROBE_TIMEOUT_MS);
      selectedModel = healthy ?? undefined;
      const info = resolved.chain.find((c) => c.model.id === healthy);
      selectedVariant = info ? pickVariant(info.model) : undefined;
      const tried = outcomes.map((o) => `${o.model}=${o.ok ? "ok" : (o.kind ?? "fail")}`).join(", ");
      checks.push({
        name: "model_available",
        ok: !!healthy,
        detail: healthy
          ? `${healthy}${selectedVariant ? ` (variant ${selectedVariant})` : ""} responded; tried ${tried}`
          : `no candidate responded; tried ${tried}`,
      });
    } else {
      const usable = resolved.chain.filter((c) => !c.benched);
      selectedModel = usable[0]?.model.id;
      selectedVariant = usable[0] ? pickVariant(usable[0].model) : undefined;
      checks.push({
        name: "model_available",
        ok: usable.length > 0,
        detail: usable.length
          ? `${usable.length} candidate(s), best=${usable[0]!.model.id} (not probed; use --probe)`
          : `all ${resolved.chain.length} candidate(s) benched — run \`ocd models --probe\``,
      });
    }
  } catch (err) {
    checks.push({ name: "model_available", ok: false, detail: String(err) });
  }

  if (args.flags["live"] === true) {
    try {
      ensureStateDirs();
      const result = await dispatch({
        dir: STATE_DIR,
        prompt: "Reply with exactly the word OK and nothing else.",
        taskClass: "analyze",
        transcriptPath: join(TRANSCRIPT_DIR, "_doctor.ndjson"),
        // Exercise the same model the ladder would actually pick, rather
        // than whatever opencode defaults to (which may well be paid).
        model: selectedModel,
        variant: selectedVariant ?? "",
      });
      const ok = result.rawStatus === "completed" && result.textParts.length > 0;
      checks.push({ name: "live_dispatch", ok, detail: ok ? `round-trip ok in ${result.durationMs}ms` : `rawStatus=${result.rawStatus}` });
    } catch (err) {
      checks.push({ name: "live_dispatch", ok: false, detail: String(err) });
    }
  }

  const allOk = checks.every((c) => c.ok);
  printJSON({ ok: allOk, checks });
  process.exit(allOk ? 0 : 1);
}

// --- entry point ---------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run":
      return cmdRun(args);
    case "cont":
      return cmdCont(args);
    case "poll":
      return cmdPoll(args);
    case "result":
      return cmdResultCmd(args);
    case "list":
      return cmdList();
    case "drop":
      return cmdDrop(args);
    case "revert":
      return cmdRevert(args);
    case "doctor":
      return cmdDoctor(args);
    case "models":
      return cmdModels(args);
    case "_bg-worker": {
      const jobPath = args.positionals[0];
      if (!jobPath) fail("_bg-worker requires a job file path");
      return cmdBgWorker(jobPath);
    }
    default:
      console.error(
        "usage: ocd <run|cont|poll|result|list|drop|revert|models|doctor> ...\n" +
          '  ocd run --class <read|analyze|edit|test> --dir <abs> --tag <name> [--bg] [--scope a,b] "<task>"\n' +
          '  ocd cont <ref> "<feedback>"\n' +
          "  ocd poll <ref> [--wait <sec>]\n" +
          "  ocd result <ref> [--with-diff]\n" +
          "  ocd list\n" +
          "  ocd drop <ref>\n" +
          "  ocd revert <ref>\n" +
          "  ocd models [--refresh] [--probe] [--all]\n" +
          "  ocd models --pin <provider/model> | --prefer <substr,substr> | --unpin\n" +
          "  ocd doctor [--live] [--probe] [--refresh]",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "error", error: String(err?.stack ?? err) }));
  process.exit(1);
});
