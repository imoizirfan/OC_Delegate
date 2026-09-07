import { TEXT_TRUNCATE } from "./config.ts";
import { isPermissionDenial } from "./dispatch.ts";
import type { LadderRunResult } from "./ladder.ts";
import type { Envelope, NextAction } from "./types.ts";

function deriveNext(status: Envelope["status"], warningCount: number): NextAction {
  if (status === "conflict") return "conflict";
  if (status === "ok") return warningCount === 0 ? "accept" : "send_feedback";
  return "escalate";
}

function buildErrorSummary(status: Envelope["status"], result: LadderRunResult): string | undefined {
  const { dispatchResult } = result;
  if (status === "blocked") {
    const denied = dispatchResult.toolUses.find((tu) => isPermissionDenial(tu) || tu.error?.includes("blocked by permission rule"));
    return denied ? `blocked: ${denied.error}` : "blocked: a tool call was denied by permission policy";
  }
  if (status === "timeout") return "wall-clock timeout exceeded before the task finished";
  if (status === "stalled") return "no output for longer than the stall window — likely hung or rate-limited";
  if (status === "error") {
    // opencode's structured message is far more useful to Claude than a
    // stderr tail, and under `--format json` stderr is usually empty anyway.
    const api = dispatchResult.apiError?.message?.trim();
    if (api) return `error: ${api}`;
    const tail = dispatchResult.stderrTail.trim().slice(-300);
    return tail ? `error: ${tail}` : "error: opencode exited without a usable result";
  }
  return undefined;
}

export function buildEnvelope(params: {
  ref: string;
  ladderResult: LadderRunResult;
  rounds: number;
  transcriptPath: string;
}): Envelope {
  const { ladderResult, ref, rounds, transcriptPath } = params;
  const { dispatchResult, gate, status, level, modelUsed } = ladderResult;

  const rawText = dispatchResult.textParts.at(-1) ?? "";
  const text = rawText.length > TEXT_TRUNCATE ? rawText.slice(0, TEXT_TRUNCATE) + "\n…[truncated, see transcript]" : rawText;

  const warnings = [...gate.warnings];
  if (dispatchResult.malformedLines > 0) warnings.push(`malformed_lines:${dispatchResult.malformedLines}`);

  return {
    ref,
    session_id: dispatchResult.sessionId,
    status,
    level,
    model: modelUsed,
    rounds,
    text,
    evidence: gate.evidence,
    warnings,
    tokens: dispatchResult.tokens,
    cost: dispatchResult.cost,
    duration_ms: dispatchResult.durationMs,
    transcript: transcriptPath,
    next: deriveNext(status, warnings.length),
    error: buildErrorSummary(status, ladderResult),
    ...(ladderResult.modelWarnings?.length ? { model_notes: ladderResult.modelWarnings } : {}),
  };
}
