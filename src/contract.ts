import type { TaskClass } from "./types.ts";

// Ground-truthed failure mode: asked to list files in a directory containing
// a known file, the model replied "The directory is empty" with zero tool
// calls. Forcing "you MUST call a tool" produced a correct read. This
// contract is the first of three independent layers against that failure —
// verify.ts's tool-call census and EVIDENCE cross-check are the other two,
// and they don't trust the model to have followed this prompt correctly.
const BASE_RULES = [
  "You are operating headlessly. No human can answer questions or approve anything — never ask for clarification or wait for confirmation; make the most reasonable assumption and proceed.",
  "You MUST use your tools to establish any fact about this filesystem, this codebase, or its contents before stating it. Never assert a file's existence, a file's contents, a directory listing, or a search result from memory or assumption. If you have not called a tool for a fact in this conversation, you do not know it — say so instead of guessing.",
  "If a tool call is denied or errors, do not retry the same call in a loop. Note the failure in your final answer and continue with whatever you can still accomplish.",
];

const EDIT_RULES = [
  "Only modify files within the task's stated scope. Do not touch unrelated files.",
  "Never run git push, git push --force, git reset --hard, or any other destructive or publishing command.",
  "Do not commit. Leave changes unstaged/uncommitted for review.",
];

const TEST_RULES = [
  "Run the relevant tests with the project's real test runner and report pass/fail counts verbatim from its output. Do not summarize or guess a result you did not observe.",
];

const EVIDENCE_TRAILER =
  "End your final reply with a line starting exactly with 'EVIDENCE:' followed by a comma-separated list of every file path you actually opened, read, or wrote via a tool call in this conversation. If you used no files, write 'EVIDENCE: none'. This list will be checked against your actual tool calls, so do not list a file you did not open.";

export function buildInitialPrompt(taskClass: TaskClass, task: string, scope?: string[]): string {
  const rules = [...BASE_RULES];
  if (taskClass === "edit") {
    rules.push(...EDIT_RULES);
    if (scope?.length) rules.push(`Scope for this task: ${scope.join(", ")}`);
  }
  if (taskClass === "test") rules.push(...TEST_RULES);
  rules.push(EVIDENCE_TRAILER);
  return [...rules, "", "TASK:", task].join("\n");
}

/** Continuation turns skip the full contract (cheap on a warm cache anyway)
 * but keep the two rules that matter most for a follow-up: still verify,
 * still cite evidence. */
export function buildContinuationPrompt(feedback: string): string {
  return [
    "Continuing the same task. Still verify any filesystem/codebase fact with a tool call before stating it — do not rely on what you said earlier without re-checking if the feedback below implies something may have changed.",
    EVIDENCE_TRAILER,
    "",
    "FEEDBACK:",
    feedback,
  ].join("\n");
}

/** One repair turn when the model ignored the EVIDENCE: trailer contract —
 * cheap on a warm cache, so worth one retry before treating it as unverified. */
export function buildRepairPrompt(): string {
  return [
    "Your previous reply did not end with a line starting 'EVIDENCE:' as required.",
    "Reply again with the same information, ending with the EVIDENCE: line listing every file you actually opened via a tool call (or 'EVIDENCE: none').",
  ].join("\n");
}

/** Rung 0->1 same-model, same-session retry after the gate rejected the
 * first attempt (no tool calls, empty output, or a crash). Deliberately
 * generic rather than reason-specific — keeps this from becoming a large
 * branching prompt library for what is meant to be a single cheap nudge. */
export function buildSharpenedRetryPrompt(reason: string): string {
  return [
    `Your previous attempt did not produce a usable result (reason: ${reason}).`,
    "Try again. You MUST call your tools to verify any fact before stating it — do not answer from assumption.",
    EVIDENCE_TRAILER,
  ].join("\n");
}
