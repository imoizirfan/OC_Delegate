import { dispatch, isPermissionDenial, sanitizeDenialMessage, type DispatchResult } from "./dispatch.ts";
import { evaluateGate, diffAgainst, type GateResult } from "./verify.ts";
import { buildSharpenedRetryPrompt } from "./contract.ts";
import { MODEL_L0, MODEL_L1, MODELS_L2, MAX_LADDER } from "./config.ts";
import type { Status, TaskClass, GitEvidence } from "./types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ErrorHint = "auth" | "rate_limit" | null;

/** Best-effort keyword classification of stderr/text for auth and rate-limit
 * failures. NOT empirically verified against a real 401/429 from OpenCode
 * Zen (doing so would require breaking working auth or exhausting the free
 * tier) — treat this as a heuristic that may need tuning once a real one is
 * observed in practice, not a ground-truthed signature like the permission
 * denial detection in dispatch.ts. */
export function detectErrorHint(dispatchResult: DispatchResult): ErrorHint {
  const haystack = (dispatchResult.stderrTail + " " + dispatchResult.textParts.join(" ")).toLowerCase();
  if (/\b401\b|unauthorized|authentication (failed|error)|invalid api key|not logged in/.test(haystack)) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|too many requests|over capacity|quota exceeded/.test(haystack)) {
    return "rate_limit";
  }
  return null;
}

export interface RungState {
  rung: 0 | 1 | 2 | 3;
  l2Index: number;
}

export interface LadderDecision {
  action: "accept" | "retry" | "escalate";
  next: RungState;
  model: string | null;
  reason: string;
}

/** Pure decision table — kept separate from the dispatch loop so fault
 * injection (plan verification item 4) can test routing without spawning a
 * real process: bad model -> error -> escalate; denylisted command ->
 * blocked -> no retry; forced stall -> stalled -> retry-then-escalate. */
export function nextLadderStep(state: RungState, status: Status, errorHint: ErrorHint): LadderDecision {
  if (status === "ok") {
    return { action: "accept", next: state, model: null, reason: "ok" };
  }

  if (status === "blocked") {
    return { action: "escalate", next: state, model: null, reason: "blocked_no_retry" };
  }

  if (errorHint === "auth") {
    return { action: "escalate", next: state, model: null, reason: "auth_error" };
  }

  if (state.rung >= MAX_LADDER - 1) {
    return { action: "escalate", next: state, model: null, reason: "max_ladder_reached" };
  }

  if (errorHint === "rate_limit") {
    const next: RungState = { rung: 2, l2Index: state.l2Index };
    const model = MODELS_L2[Math.min(state.l2Index, MODELS_L2.length - 1)]!;
    return { action: "retry", next: { rung: 2, l2Index: next.l2Index + 1 }, model, reason: "rate_limited_alt_model" };
  }

  if (status === "empty" || status === "unverified") {
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: MODEL_L1, reason: "sharpen_retry" };
    }
    if (state.rung === 1 || (state.rung === 2 && state.l2Index < MODELS_L2.length)) {
      const idx = state.l2Index;
      if (idx < MODELS_L2.length) {
        return { action: "retry", next: { rung: 2, l2Index: idx + 1 }, model: MODELS_L2[idx]!, reason: "alt_model_retry" };
      }
    }
    return { action: "escalate", next: state, model: null, reason: "exhausted_free_models" };
  }

  if (status === "timeout" || status === "stalled") {
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: MODEL_L1, reason: "retry_after_timeout" };
    }
    return { action: "escalate", next: state, model: null, reason: "timeout_after_retry" };
  }

  if (status === "error") {
    // Matches the plan's routing table exactly: crash/parse -> L1 -> L3.
    // No L2 detour here (unlike empty/unverified) — a crash on the same
    // free model once already earned one retry; walking three more free
    // models one at a time is a poor trade against just handing back to
    // Claude quickly.
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: MODEL_L1, reason: "retry_after_crash" };
    }
    return { action: "escalate", next: state, model: null, reason: "crash_after_retry" };
  }

  return { action: "escalate", next: state, model: null, reason: "unhandled_status" };
}

export function classifyStatus(
  dispatchResult: DispatchResult,
  gate: GateResult,
): { status: Status; deniedTool?: string } {
  if (dispatchResult.rawStatus === "killed_wall") return { status: "timeout" };
  if (dispatchResult.rawStatus === "killed_stall") return { status: "stalled" };
  if (dispatchResult.rawStatus === "spawn_error") return { status: "error" };

  const denial = dispatchResult.toolUses.find((tu) => isPermissionDenial(tu));
  if (denial) return { status: "blocked", deniedTool: denial.tool };

  if (gate.forcedStatus === "unverified") return { status: "unverified" };

  if (dispatchResult.textParts.length === 0) return { status: "empty" };

  return { status: "ok" };
}

export interface LadderRunOptions {
  dir: string;
  taskClass: TaskClass;
  /** Full contract prompt — used on attempt 1 of a fresh `run`, and again
   * (unmodified) any time the ladder must start a brand-new session on a
   * different model, since that session has no conversation history. */
  initialPrompt: string;
  /** Used on attempt 1 instead of initialPrompt when this is a `cont`
   * (continuing an existing session with feedback rather than starting). */
  continuationPrompt?: string;
  /** Existing session to continue on attempt 1, if any. */
  sessionId?: string;
  /** Model the session (if any) was actually created on — a `cont` on a
   * session that previously fell back to an alt model must resume on that
   * same model, not reset to MODEL_L0. Defaults to MODEL_L0 for fresh runs. */
  startModel?: string;
  transcriptPath: string;
  scope?: string[];
  baseHead?: string; // for edit class diff-truth
}

export interface LadderRunResult {
  dispatchResult: DispatchResult;
  gate: GateResult;
  status: Status;
  level: number;
  modelUsed: string;
  attempts: number;
  ladderLog: string[];
}

/** Walks L0 -> L1 -> L2(a,b,c) -> escalate within a single ocd invocation,
 * spawning a fresh dispatch() per rung/model. Escalation just means "stop
 * retrying and return the last result" — cli.ts/envelope.ts turn that into
 * next="escalate" so Claude picks up from there instead of us guessing.
 *
 * Session continuity is model-bound: a session lives on whichever
 * model/provider created it, so a retry only carries sessionId forward
 * while staying on the SAME model (rung 0->1, same free model, sharpened
 * prompt). The moment the ladder switches models (rung ->2, an alt free
 * model), it must drop sessionId and resend the full initial contract —
 * the new model has no memory of the conversation so far.
 *
 * Known limitation: RungState always starts fresh ({rung:0, l2Index:0}) on
 * every call, even when `startModel` is already an L2 alternate (i.e. a
 * `cont` resuming a session that previously fell back). If that `cont` also
 * needs to retry, it re-walks the L2 list from the beginning rather than
 * picking up where a prior, separate runWithLadder call left off — it can
 * redundantly re-try a model already known bad for this task. Not fixed:
 * doing so needs the rung/l2Index to persist in the registry across calls,
 * which is real added state for a cost that shrank a lot once the gate
 * stopped over-triggering retries in the first place (see verify.ts's
 * requiresTools comment) — most `cont` calls now succeed on attempt 1 and
 * never reach this path. MAX_ROUNDS still bounds the total damage per ref. */
export async function runWithLadder(opts: LadderRunOptions): Promise<LadderRunResult> {
  let state: RungState = { rung: 0, l2Index: 0 };
  let model: string = opts.startModel ?? MODEL_L0;
  let sessionId = opts.sessionId;
  let attempts = 0;
  const ladderLog: string[] = [];

  let lastDispatch: DispatchResult;
  let lastGate: GateResult;
  let lastStatus: Status;
  let lastReason = "";

  for (;;) {
    attempts++;
    let prompt: string;
    if (attempts === 1) {
      prompt = opts.continuationPrompt ?? opts.initialPrompt;
    } else if (sessionId) {
      prompt = buildSharpenedRetryPrompt(lastReason);
    } else {
      prompt = opts.initialPrompt;
    }

    lastDispatch = await dispatch({
      dir: opts.dir,
      prompt,
      taskClass: opts.taskClass,
      transcriptPath: opts.transcriptPath,
      sessionId,
      model,
    });

    // A denial mid-task doesn't carry the ruleset dump forward — scrub it
    // before it can end up anywhere near Claude's context.
    for (const tu of lastDispatch.toolUses) {
      if (isPermissionDenial(tu)) tu.error = sanitizeDenialMessage(tu.tool);
    }

    if (lastDispatch.sessionId) sessionId = lastDispatch.sessionId;

    let git: GitEvidence | undefined;
    if (opts.taskClass === "edit" && opts.baseHead) {
      git = await diffAgainst(opts.dir, opts.baseHead);
    }

    lastGate = evaluateGate({
      taskClass: opts.taskClass,
      finalText: lastDispatch.textParts.at(-1) ?? "",
      toolUses: lastDispatch.toolUses,
      git,
      scope: opts.scope,
    });

    const classified = classifyStatus(lastDispatch, lastGate);
    lastStatus = classified.status;

    const errorHint = detectErrorHint(lastDispatch);
    const decision = nextLadderStep(state, lastStatus, errorHint);
    ladderLog.push(`rung=${state.rung} model=${model} status=${lastStatus} -> ${decision.action}(${decision.reason})`);
    lastReason = decision.reason;

    if (decision.action !== "retry") break;

    if (errorHint === "rate_limit") {
      // Free-tier capacity errors benefit from not hammering the same
      // endpoint immediately; every other retry path is switching prompt
      // or model, which doesn't need a delay.
      await sleep(2000 + Math.floor(Math.random() * 2000));
    }

    if (decision.model !== model) {
      // Switching models — the old session can't be resumed under a
      // different backend, so drop it and let the next iteration use the
      // full initial contract instead of a short sharpened nudge.
      sessionId = undefined;
    }
    state = decision.next;
    model = decision.model!;
  }

  return {
    dispatchResult: lastDispatch!,
    gate: lastGate!,
    status: lastStatus!,
    level: state.rung,
    modelUsed: model,
    attempts,
    ladderLog,
  };
}
