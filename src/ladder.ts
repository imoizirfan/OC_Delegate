import { dispatch, isPermissionDenial, sanitizeDenialMessage, type DispatchResult } from "./dispatch.ts";
import { evaluateGate, diffAgainst, type GateResult } from "./verify.ts";
import { buildSharpenedRetryPrompt } from "./contract.ts";
import { MAX_LADDER, MAX_ALT_MODELS } from "./config.ts";
import {
  recordModelResult,
  resolveModelChain,
  pickVariant,
  classifyFailure,
  type ScoredModel,
  type FailureKind,
} from "./models.ts";
import type { Status, TaskClass, GitEvidence } from "./types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ErrorHint = "auth" | "rate_limit" | "model_dead" | null;

/** Best-effort keyword classification of stderr/text for auth and rate-limit
 * failures. NOT empirically verified against a real 401/429 from OpenCode
 * Zen (doing so would require breaking working auth or exhausting the free
 * tier) — treat this as a heuristic that may need tuning once a real one is
 * observed in practice, not a ground-truthed signature like the permission
 * denial detection in dispatch.ts. */
export function detectErrorHint(dispatchResult: DispatchResult): ErrorHint {
  // Prefer opencode's own structured error message when there is one. It is
  // the authoritative, clean reason and it is what makes dead-model routing
  // work at all: under `--format json` these failures arrive as an NDJSON
  // error event on stdout, so stderr is empty and a text scan finds nothing.
  //
  // Only `message` is examined, never the surrounding event. The event
  // carries `statusCode: 401` even for a model that is merely disabled, so
  // regexing the raw JSON would classify a routine model outage as an
  // expired login — escalating to Claude instead of switching models, which
  // is precisely the wrong move.
  const apiMessage = dispatchResult.apiError?.message ?? "";
  if (apiMessage) {
    const kind = classifyFailure(apiMessage);
    if (kind === "disabled" || kind === "geo" || kind === "missing") return "model_dead";
    if (kind === "auth") return "auth";
    if (kind === "rate_limit") return "rate_limit";
  }

  const haystack = (dispatchResult.stderrTail + " " + dispatchResult.textParts.join(" ")).toLowerCase();
  if (/\b401\b|unauthorized|authentication (failed|error)|invalid api key|not logged in/.test(haystack)) {
    return "auth";
  }
  // Scanned against stderr ONLY, never the model's own text: a provider
  // error never appears in the model's reply, whereas a delegated task that
  // summarizes an ML error log could easily contain a phrase like "model not
  // found" and would otherwise bench a perfectly healthy model.
  const stderrKind = classifyFailure(dispatchResult.stderrTail);
  if (stderrKind === "disabled" || stderrKind === "geo" || stderrKind === "missing") return "model_dead";
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

/** The models this ladder may use, best-first, as resolved by models.ts.
 * `primary` is the L0/L1 model; `alternates` are the L2 rung, walked in
 * order. Passing the chain in (rather than reading module constants) is what
 * keeps this function pure and testable, and is also what lets the whole
 * lineup change week to week without touching this file. */
export interface ModelChainRef {
  primary: string;
  alternates: string[];
}

/** Build a chain ref from a ranked id list, capping how many alternates the
 * ladder may walk (see MAX_ALT_MODELS — bounds worst-case latency now that
 * the lineup size is discovered rather than fixed). */
export function chainFromIds(ids: string[], maxAlternates = MAX_ALT_MODELS): ModelChainRef {
  return { primary: ids[0] ?? "", alternates: ids.slice(1, 1 + Math.max(0, maxAlternates)) };
}

/** Pure decision table — kept separate from the dispatch loop so fault
 * injection (plan verification item 4) can test routing without spawning a
 * real process: bad model -> error -> escalate; denylisted command ->
 * blocked -> no retry; forced stall -> stalled -> retry-then-escalate.
 *
 * `chain` defaults to an empty lineup so existing callers that only care
 * about the no-alternate routing (blocked/auth/timeout/crash paths) can omit
 * it; when there are no alternates the L2 rung is simply skipped and the
 * ladder escalates, which is the correct behaviour when discovery has turned
 * up exactly one usable free model. */
export function nextLadderStep(
  state: RungState,
  status: Status,
  errorHint: ErrorHint,
  chain: ModelChainRef = { primary: "", alternates: [] },
  currentModel?: string,
): LadderDecision {
  const alts = chain.alternates;
  // The same-model retry must stay on whatever model is actually in use, not
  // snap back to the top-ranked one. A `cont` resuming a session that had
  // already fallen back to an alternate starts on that alternate; returning
  // `chain.primary` here would switch models mid-retry and silently discard
  // the session, which is the one thing the sharpened retry exists to keep.
  const sameModel = currentModel || chain.primary;

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

  // Rate limiting is a property of the endpoint, and a dead model is a
  // property of the model — in both cases the prompt is irrelevant and the
  // only useful move is a different model, skipping the same-model retry
  // rung entirely. With no alternate left there is nothing to switch to and
  // Claude should take over.
  if (errorHint === "rate_limit" || errorHint === "model_dead") {
    const tag = errorHint === "model_dead" ? "model_dead" : "rate_limited";
    if (state.l2Index >= alts.length) {
      return { action: "escalate", next: state, model: null, reason: `${tag}_no_alternates` };
    }
    const model = alts[state.l2Index]!;
    return { action: "retry", next: { rung: 2, l2Index: state.l2Index + 1 }, model, reason: `${tag}_alt_model` };
  }

  if (status === "empty" || status === "unverified") {
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: sameModel, reason: "sharpen_retry" };
    }
    const idx = state.l2Index;
    if (idx < alts.length) {
      return { action: "retry", next: { rung: 2, l2Index: idx + 1 }, model: alts[idx]!, reason: "alt_model_retry" };
    }
    return { action: "escalate", next: state, model: null, reason: "exhausted_free_models" };
  }

  if (status === "timeout" || status === "stalled") {
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: sameModel, reason: "retry_after_timeout" };
    }
    // A model that stalled once and then stalled again on a sharpened retry
    // is not merely slow, it is unusable right now — so unlike the original
    // routing, fall through to a different model rather than escalating
    // straight to Claude. This is the exact failure mode observed on a
    // real free model that hung indefinitely while advertising itself as
    // active, and burning the whole task on it is the thing to avoid.
    const idx = state.l2Index;
    if (idx < alts.length) {
      return { action: "retry", next: { rung: 2, l2Index: idx + 1 }, model: alts[idx]!, reason: "alt_model_after_timeout" };
    }
    return { action: "escalate", next: state, model: null, reason: "timeout_after_retry" };
  }

  if (status === "error") {
    // Crash/parse -> L1 (same model, sharpened) -> then an alternate if one
    // exists, else escalate. The original routing skipped the alternate rung
    // entirely on the theory that walking several models is a poor trade
    // against handing back to Claude quickly; that reasoning no longer holds
    // now that the most common `error` in practice is a model that has been
    // disabled or geo-blocked server-side, where every retry on the same
    // model is guaranteed to fail and a different model is guaranteed to be
    // the only thing that can help.
    if (state.rung === 0) {
      return { action: "retry", next: { rung: 1, l2Index: 0 }, model: sameModel, reason: "retry_after_crash" };
    }
    const idx = state.l2Index;
    if (idx < alts.length) {
      return { action: "retry", next: { rung: 2, l2Index: idx + 1 }, model: alts[idx]!, reason: "alt_model_after_crash" };
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

  // A provider error must outrank `empty`. opencode exits having emitted an
  // error event and no text part, so without this a disabled or geo-blocked
  // model reads as "the model said nothing" — which routes into a pointless
  // same-model retry instead of switching to a model that actually works.
  if (dispatchResult.apiError) return { status: "error" };

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
   * same model, not reset to the current best. Defaults to the top-ranked
   * model from discovery for fresh runs. */
  startModel?: string;
  transcriptPath: string;
  scope?: string[];
  baseHead?: string; // for edit class diff-truth
  /** Pre-resolved candidate chain. Injected by tests and by callers that
   * already resolved it; omitted in normal use, where it is discovered. */
  modelChain?: ScoredModel[];
}

export interface LadderRunResult {
  dispatchResult: DispatchResult;
  gate: GateResult;
  status: Status;
  level: number;
  modelUsed: string;
  attempts: number;
  ladderLog: string[];
  /** Non-fatal notes from model discovery (stale cache, empty lineup, pin in
   * effect) so they can ride out in the envelope rather than being lost. */
  modelWarnings: string[];
}

/** Whether a run outcome says anything about the MODEL's health, as opposed
 * to the prompt or the permission policy.
 *
 * Only reachability counts. `blocked` is policy, and `empty`/`unverified`
 * generally mean the model answered but answered badly — benching on those
 * would evict a perfectly reachable model over a bad prompt, and would make
 * the health file track quality (which it cannot measure) instead of
 * availability (which it can). */
function healthSignal(
  status: Status,
  stderrTail: string,
  apiError: DispatchResult["apiError"],
): { record: boolean; ok: boolean; detail: string; kind?: FailureKind } {
  if (status === "ok") return { record: true, ok: true, detail: "" };
  if (status === "blocked") return { record: false, ok: false, detail: "" };

  // opencode's own structured message is both the cleanest reason to store
  // and the only place a disabled/geo-blocked/delisted model announces
  // itself under `--format json`. Classify from `message` alone — the event
  // reports `statusCode: 401` even for a plain model outage.
  const source = apiError?.message || stderrTail;
  const kind = classifyFailure(source);
  if (kind === "disabled" || kind === "geo" || kind === "missing") {
    return { record: true, ok: false, detail: source.trim().slice(-300), kind };
  }

  if (status === "timeout" || status === "stalled") {
    return { record: true, ok: false, detail: `dispatch ${status}`, kind: "unresponsive" };
  }
  if (status === "error") return { record: true, ok: false, detail: source.trim().slice(-300) };
  return { record: false, ok: false, detail: "" };
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
  const modelWarnings: string[] = [];
  let scored: ScoredModel[];
  if (opts.modelChain) {
    scored = opts.modelChain;
  } else {
    const resolved = await resolveModelChain();
    scored = resolved.chain;
    modelWarnings.push(...resolved.warnings);
  }

  const infoById = new Map(scored.map((s) => [s.model.id, s.model]));
  const chain = chainFromIds(scored.map((s) => s.model.id));

  let state: RungState = { rung: 0, l2Index: 0 };
  let model: string = opts.startModel || chain.primary;

  // Refuse to dispatch without an explicit model. opencode would otherwise
  // fall back to its own configured default, which is very likely a PAID
  // model — silently spending real money is a far worse outcome than a clean
  // failure that tells Claude to handle the task itself.
  if (!model) {
    throw new Error(
      "no free model available: " +
        (modelWarnings.join("; ") || "discovery returned an empty list") +
        ". Run `ocd models --probe` to inspect, or set OCD_MODEL to pin one.",
    );
  }

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

    const info = infoById.get(model);
    lastDispatch = await dispatch({
      dir: opts.dir,
      prompt,
      taskClass: opts.taskClass,
      transcriptPath: opts.transcriptPath,
      sessionId,
      model,
      // Variant is a property of the specific model, not a global constant:
      // models publish different effort ladders (some none at all), so it is
      // resolved per model and omitted entirely when unsupported.
      variant: info ? (pickVariant(info) ?? "") : "",
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

    // Persist what this attempt proved about the model itself, so a model
    // that is disabled/geo-blocked/hanging today gets skipped by the NEXT
    // `ocd` invocation too, not just by the rest of this ladder walk.
    const signal = healthSignal(lastStatus, lastDispatch.stderrTail, lastDispatch.apiError);
    if (signal.record && errorHint !== "auth") {
      recordModelResult(model, signal.ok, signal.detail, signal.kind);
    }

    const decision = nextLadderStep(state, lastStatus, errorHint, chain, model);
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
    modelWarnings,
  };
}
