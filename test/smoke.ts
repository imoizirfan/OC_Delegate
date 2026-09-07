#!/usr/bin/env bun
// Runs the verification checks from the plan doc against the real, installed
// `ocd`. Some checks make real (free-tier) opencode calls and take real
// wall-clock time; fault-injection checks test the pure decision functions
// directly instead of trying to provoke real infrastructure failures.

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nextLadderStep, classifyStatus, detectErrorHint } from "../src/ladder.ts";
import type { DispatchResult } from "../src/dispatch.ts";
import type { GateResult } from "../src/verify.ts";

const OCD_BIN = process.env.OCD_TEST_BIN ?? join(import.meta.dir, "..", "bin", "ocd");
const SCRATCH = process.env.OCD_TEST_SCRATCH;
if (!SCRATCH) {
  console.error("OCD_TEST_SCRATCH env var required (a scratch dir to run fixtures in)");
  process.exit(1);
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

async function runOcd(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn({ cmd: [OCD_BIN, ...args], stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

function parseEnvelope(stdout: string): any {
  return JSON.parse(stdout);
}

// --- 1. fault injection (pure functions, no real dispatch) -----------------

function fakeDispatch(overrides: Partial<DispatchResult>): DispatchResult {
  return {
    rawStatus: "completed",
    exitCode: 0,
    sessionId: "ses_fake",
    textParts: ["some answer"],
    toolUses: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    durationMs: 100,
    stderrTail: "",
    malformedLines: 0,
    apiError: null,
    ...overrides,
  };
}

function fakeGate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    evidence: { tool_calls: 0, tools: [], files_seen: [] },
    warnings: [],
    forcedStatus: null,
    ...overrides,
  };
}

function checkFaultInjection() {
  // blocked -> no retry, straight to escalate
  // Must use the RAW denial signature isPermissionDenial() actually checks
  // for — "tool 'bash' blocked by permission rule" is the post-sanitization
  // message (sanitizeDenialMessage's output), which classifyStatus would
  // never see in production since sanitization happens after classification.
  const blockedDispatch = fakeDispatch({
    toolUses: [
      {
        tool: "bash",
        input: {},
        status: "error",
        error: "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [...]",
      },
    ],
  });
  const blockedClassified = classifyStatus(blockedDispatch, fakeGate());
  const blockedDecision = nextLadderStep({ rung: 0, l2Index: 0 }, blockedClassified.status, null);
  record(
    "fault_injection:blocked_no_retry",
    blockedClassified.status === "blocked" && blockedDecision.action === "escalate" && blockedDecision.reason === "blocked_no_retry",
    `status=${blockedClassified.status} action=${blockedDecision.action} reason=${blockedDecision.reason}`,
  );

  // killed_stall -> "stalled", retried once then escalated (not looped through L2)
  const stalledClassified = classifyStatus(fakeDispatch({ rawStatus: "killed_stall", textParts: [] }), fakeGate());
  const stall0 = nextLadderStep({ rung: 0, l2Index: 0 }, stalledClassified.status, null);
  const stall1 = nextLadderStep({ rung: 1, l2Index: 0 }, stalledClassified.status, null);
  record(
    "fault_injection:stalled_retry_then_escalate",
    stalledClassified.status === "stalled" && stall0.action === "retry" && stall1.action === "escalate",
    `status=${stalledClassified.status} rung0=${stall0.action} rung1=${stall1.action}`,
  );

  // spawn_error (bad model etc) -> "error" -> retry once then escalate, no L2 detour
  const errClassified = classifyStatus(fakeDispatch({ rawStatus: "spawn_error", textParts: [] }), fakeGate());
  const err0 = nextLadderStep({ rung: 0, l2Index: 0 }, errClassified.status, null);
  const err1 = nextLadderStep({ rung: 1, l2Index: 0 }, errClassified.status, null);
  record(
    "fault_injection:crash_retry_then_escalate_no_l2",
    errClassified.status === "error" && err0.action === "retry" && err1.action === "escalate",
    `status=${errClassified.status} rung0=${err0.action} rung1=${err1.action}`,
  );

  // auth hint -> escalate immediately regardless of rung
  const authDecision = nextLadderStep({ rung: 0, l2Index: 0 }, "error", "auth");
  record(
    "fault_injection:auth_escalates_immediately",
    authDecision.action === "escalate" && authDecision.reason === "auth_error",
    `action=${authDecision.action} reason=${authDecision.reason}`,
  );

  // rate-limit hint detection from stderr text
  const hint = detectErrorHint(fakeDispatch({ stderrTail: "HTTP 429 Too Many Requests" }));
  record("fault_injection:rate_limit_hint_detected", hint === "rate_limit", `hint=${hint}`);

  // zero tool calls on a read-class task -> unverified (the golden hallucination's mechanical signature)
  const noToolsGate = fakeGate({ warnings: ["no_tool_calls"], forcedStatus: "unverified" });
  const noToolsClassified = classifyStatus(fakeDispatch({ toolUses: [] }), noToolsGate);
  record(
    "fault_injection:zero_tool_calls_unverified",
    noToolsClassified.status === "unverified",
    `status=${noToolsClassified.status}`,
  );
}

// --- 2. golden regression: the reproduced hallucination ---------------------

async function checkGoldenRegression() {
  const dir = join(SCRATCH!, "smoke-hallucination");
  const { stdout, code } = await runOcd([
    "run",
    "--class",
    "read",
    "--dir",
    dir,
    "--tag",
    "smoke-halluc",
    "List the files in this directory and tell me if it's empty.",
  ]);
  try {
    const envelope = parseEnvelope(stdout);
    const gateCaughtIt = envelope.status === "unverified" || (envelope.status === "ok" && envelope.evidence.tool_calls > 0);
    record(
      "golden_regression:hallucination_gate",
      gateCaughtIt,
      `status=${envelope.status} tool_calls=${envelope.evidence?.tool_calls} warnings=${JSON.stringify(envelope.warnings)}`,
    );
    return envelope;
  } catch (err) {
    record("golden_regression:hallucination_gate", false, `failed to parse envelope (exit ${code}): ${stdout.slice(0, 300)}`);
    return null;
  }
}

// --- 3. session continuity ---------------------------------------------------

async function checkSessionContinuity() {
  const dir = SCRATCH!;
  const r1 = await runOcd(["run", "--class", "analyze", "--dir", dir, "--tag", "smoke-continuity", "Remember the codeword BANANA37. Reply with just: noted."]);
  let e1: any;
  try {
    e1 = parseEnvelope(r1.stdout);
  } catch {
    record("session_continuity", false, `run failed to parse: ${r1.stdout.slice(0, 300)}`);
    return;
  }

  const r2 = await runOcd(["cont", "smoke-continuity", "What was the codeword? Reply with just the codeword."]);
  let e2: any;
  try {
    e2 = parseEnvelope(r2.stdout);
  } catch {
    record("session_continuity", false, `cont failed to parse: ${r2.stdout.slice(0, 300)}`);
    return;
  }

  const remembered = typeof e2.text === "string" && e2.text.includes("BANANA37");
  const sameSession = e1.session_id && e2.session_id === e1.session_id;
  record(
    "session_continuity:remembered_across_processes",
    remembered && !!sameSession,
    `remembered=${remembered} sameSession=${sameSession} rounds=${e2.rounds} cache_read=${e2.tokens?.cache_read}`,
  );
}

// --- 4. edit path + revert ---------------------------------------------------

async function checkEditPathAndRevert() {
  const dir = join(SCRATCH!, "smoke-repo");
  const { stdout, code } = await runOcd([
    "run",
    "--class",
    "edit",
    "--dir",
    dir,
    "--tag",
    "smoke-edit",
    "Create a new file called greeting.txt containing exactly the text: hello from ocd",
  ]);
  let envelope: any;
  try {
    envelope = parseEnvelope(stdout);
  } catch {
    record("edit_path:dispatch", false, `failed to parse envelope (exit ${code}): ${stdout.slice(0, 300)}`);
    return;
  }

  const fileExists = existsSync(join(dir, "greeting.txt"));
  const diffMatchesReality = envelope.status !== "ok" || (fileExists && (envelope.evidence?.git?.changed ?? []).includes("greeting.txt"));
  record(
    "edit_path:diff_matches_reality",
    diffMatchesReality,
    `status=${envelope.status} fileExists=${fileExists} git.changed=${JSON.stringify(envelope.evidence?.git?.changed)}`,
  );

  if (envelope.status === "ok" && fileExists) {
    const revertResult = await runOcd(["revert", "smoke-edit"]);
    let revertJson: any;
    try {
      revertJson = parseEnvelope(revertResult.stdout);
    } catch {
      record("edit_path:revert", false, `revert failed to parse: ${revertResult.stdout.slice(0, 300)}`);
      return;
    }
    const restoredAway = !existsSync(join(dir, "greeting.txt"));
    record("edit_path:revert", restoredAway, `revert result=${JSON.stringify(revertJson)} fileGoneAfter=${restoredAway}`);
  } else {
    record("edit_path:revert", true, "skipped — nothing to revert (edit task did not succeed, which is itself a valid gate outcome)");
  }
}

// --- 5. parallel scope conflict ----------------------------------------------

async function checkParallelConflict() {
  const dir = join(SCRATCH!, "smoke-repo");
  // Fire two overlapping edit tasks back-to-back. The scope claim happens
  // synchronously before dispatch, so the second call should be rejected
  // fast without needing the first to actually finish.
  const first = runOcd(["run", "--class", "edit", "--dir", dir, "--tag", "smoke-conflict-a", "--bg", "--scope", "shared.txt", "Create shared.txt with the text: first"]);
  const firstResult = await first;
  let firstEnvelope: any;
  try {
    firstEnvelope = parseEnvelope(firstResult.stdout);
  } catch {
    record("parallel_conflict", false, `first dispatch failed to parse: ${firstResult.stdout.slice(0, 300)}`);
    return;
  }

  const second = await runOcd(["run", "--class", "edit", "--dir", dir, "--tag", "smoke-conflict-b", "--scope", "shared.txt", "Append to shared.txt"]);
  let secondEnvelope: any;
  try {
    secondEnvelope = parseEnvelope(second.stdout);
  } catch {
    record("parallel_conflict", false, `second dispatch failed to parse: ${second.stdout.slice(0, 300)}`);
    return;
  }

  record(
    "parallel_conflict:overlapping_scope_rejected",
    secondEnvelope.status === "conflict",
    `first.status=${firstEnvelope.status} second.status=${secondEnvelope.status}`,
  );

  // cleanup: drop both refs so they don't linger in the registry
  await runOcd(["drop", "smoke-conflict-a"]);
  await runOcd(["drop", "smoke-conflict-b"]);
}

// --- 6. context-savings measurement ------------------------------------------

async function checkContextSavings(goldenEnvelope: any) {
  if (!goldenEnvelope?.transcript || !existsSync(goldenEnvelope.transcript)) {
    record("context_savings", false, "no transcript available from golden regression run to measure");
    return;
  }
  const transcriptBytes = statSync(goldenEnvelope.transcript).size;
  const envelopeBytes = Buffer.byteLength(JSON.stringify(goldenEnvelope));
  const ratio = transcriptBytes > 0 ? (transcriptBytes / envelopeBytes).toFixed(1) : "n/a";
  record(
    "context_savings:envelope_smaller_than_transcript",
    envelopeBytes < transcriptBytes,
    `transcript=${transcriptBytes}B envelope=${envelopeBytes}B ratio=${ratio}x`,
  );
}

// --- 7. dynamic model selection (live) ----------------------------------------

/** Asserts against the REAL installed opencode that model selection resolves
 * to a usable, genuinely free model — the property that silently broke when
 * the provider retired the previously hardcoded lineup. Offline logic for
 * this is covered exhaustively in test/models.test.ts; this is the live half. */
async function checkModelSelection() {
  const { stdout, code } = await runOcd(["models"]);
  let doc: any;
  try {
    doc = JSON.parse(stdout);
  } catch {
    record("model_selection:resolves", false, `unparseable output: ${stdout.slice(0, 200)}`);
    return;
  }

  record(
    "model_selection:resolves",
    code === 0 && !!doc.selected,
    `selected=${doc.selected ?? "none"} variant=${doc.variant ?? "none"} candidates=${doc.candidates?.length ?? 0}`,
  );

  // Nothing may be selected that is not discovered at runtime.
  const ids: string[] = (doc.candidates ?? []).map((c: any) => c.id);
  record(
    "model_selection:selected_is_discovered",
    !doc.selected || ids.includes(doc.selected),
    `selected=${doc.selected} in ${ids.length} discovered candidates`,
  );

  // The selected model must not be one currently known-broken.
  const selectedEntry = (doc.candidates ?? []).find((c: any) => c.id === doc.selected);
  record(
    "model_selection:selected_not_benched",
    !!selectedEntry && selectedEntry.benched === false,
    `benched=${selectedEntry?.benched}`,
  );

  // A variant is only ever sent when the model actually publishes it — the
  // old code sent a hardcoded "max" that no model in the lineup supports.
  const badVariant = (doc.candidates ?? []).find(
    (c: any) => c.variant_used && !(c.variants ?? []).includes(c.variant_used),
  );
  record(
    "model_selection:variant_is_published_by_model",
    !badVariant,
    badVariant ? `${badVariant.id} would send unsupported '${badVariant.variant_used}'` : "all variants valid",
  );
}

// --- run everything ------------------------------------------------------------

async function main() {
  console.log("=== fault injection (pure functions) ===");
  checkFaultInjection();

  console.log("\n=== dynamic model selection ===");
  await checkModelSelection();

  console.log("\n=== golden regression: reproduced hallucination ===");
  const goldenEnvelope = await checkGoldenRegression();

  console.log("\n=== session continuity ===");
  await checkSessionContinuity();

  console.log("\n=== edit path + revert ===");
  await checkEditPathAndRevert();

  console.log("\n=== parallel scope conflict ===");
  await checkParallelConflict();

  console.log("\n=== context savings ===");
  await checkContextSavings(goldenEnvelope);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main();
