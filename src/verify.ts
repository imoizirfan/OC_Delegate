import type { Evidence, GitEvidence, TaskClass } from "./types.ts";
import type { ToolUseRecord } from "./dispatch.ts";
import { FILES_SEEN_CAP } from "./config.ts";

async function runGit(dir: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const { exitCode } = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  return exitCode === 0;
}

export async function currentHead(dir: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(dir, ["rev-parse", "HEAD"]);
  return exitCode === 0 ? stdout.trim() : null;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return exitCode === 0 ? stdout.trim() : null;
}

/** Diffstat against baseHead plus untracked new files — this is the ONLY
 * source of truth for "what did an edit task actually change". The model's
 * own claims about what it edited are never trusted (see evaluateGate). */
export async function diffAgainst(dir: string, baseHead: string): Promise<GitEvidence> {
  const changed = new Map<string, { insertions: number; deletions: number }>();

  const numstat = await runGit(dir, ["diff", "--numstat", baseHead]);
  if (numstat.exitCode === 0) {
    for (const line of numstat.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [insStr, delStr, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      const insertions = insStr === "-" ? 0 : Number(insStr) || 0;
      const deletions = delStr === "-" ? 0 : Number(delStr) || 0;
      changed.set(path, { insertions, deletions });
    }
  }

  const untracked = await runGit(dir, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.exitCode === 0) {
    for (const path of untracked.stdout.split("\n")) {
      if (!path.trim() || changed.has(path)) continue;
      changed.set(path, { insertions: 0, deletions: 0 });
    }
  }

  let insertions = 0;
  let deletions = 0;
  for (const v of changed.values()) {
    insertions += v.insertions;
    deletions += v.deletions;
  }

  return { changed: [...changed.keys()], insertions, deletions, base_head: baseHead };
}

function extractPathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const candidates: unknown[] = [obj.filePath, obj.path, obj.file, obj.filePaths];
  const paths: string[] = [];
  for (const c of candidates) {
    if (typeof c === "string") paths.push(c);
    else if (Array.isArray(c)) for (const item of c) if (typeof item === "string") paths.push(item);
  }
  return paths;
}

export function buildEvidence(toolUses: ToolUseRecord[]): Omit<Evidence, "git"> {
  const tools = new Set<string>();
  const files = new Set<string>();
  for (const tu of toolUses) {
    tools.add(tu.tool);
    for (const p of extractPathsFromInput(tu.input)) files.add(p);
  }
  return {
    tool_calls: toolUses.length,
    tools: [...tools],
    files_seen: [...files].slice(0, FILES_SEEN_CAP),
  };
}

/** Parse the mandatory 'EVIDENCE: a, b, c' trailer. Returns null if the
 * model didn't include one (contract not followed — caller decides whether
 * to spend one repair turn on it). */
export function parseEvidenceTrailer(text: string): string[] | null {
  const match = text.match(/EVIDENCE:\s*(.*)$/m);
  if (!match) return null;
  const raw = match[1]!.trim();
  if (/^none$/i.test(raw)) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isReferenced(claimed: string, actualFiles: string[]): boolean {
  for (const actual of actualFiles) {
    if (claimed === actual) return true;
    if (actual.endsWith("/" + claimed) || claimed.endsWith("/" + actual)) return true;
    const claimedBase = claimed.split("/").pop();
    const actualBase = actual.split("/").pop();
    if (claimedBase && actualBase && claimedBase === actualBase) return true;
  }
  return false;
}

/** Files the model cited in its EVIDENCE: trailer that never appear in any
 * real tool_use input — the same failure mode as the golden hallucination
 * case, just partial instead of total. */
export function findPhantomReferences(claimed: string[], actualFiles: string[]): string[] {
  return claimed.filter((c) => !isReferenced(c, actualFiles));
}

export interface GateInput {
  taskClass: TaskClass;
  finalText: string;
  toolUses: ToolUseRecord[];
  git?: GitEvidence;
  scope?: string[];
}

export interface GateResult {
  evidence: Evidence;
  warnings: string[];
  /** Set when the gate itself determines the outcome; null means "no
   * override, fall through to normal ok/empty classification". */
  forcedStatus: "unverified" | null;
}

function normalizeScopeBase(p: string): string {
  const wildcardIdx = p.search(/[*?[]/);
  return (wildcardIdx === -1 ? p : p.slice(0, wildcardIdx)).replace(/\/+$/, "");
}

function withinScope(path: string, scope: string[]): boolean {
  if (!scope.length) return true;
  return scope.some((s) => {
    const base = normalizeScopeBase(s);
    return path === base || path.startsWith(base.endsWith("/") ? base : base + "/") || base === "";
  });
}

/** The evidence gate: three independent, mechanical checks, none of which
 * trust the model's prose. This is deliberately conservative — false
 * positives (an over-cautious "unverified") cost one Claude judgment call;
 * false negatives (a hallucination that slips through) cost silent
 * corruption of Claude's understanding of the filesystem, which is the
 * exact failure this system exists to prevent. */
export function evaluateGate(input: GateInput): GateResult {
  const evidenceBase = buildEvidence(input.toolUses);
  const warnings: string[] = [];
  let forcedStatus: "unverified" | null = null;

  // Deliberately excludes "analyze": read/edit/test are DEFINED by
  // filesystem interaction (you can't read without reading, can't test
  // without running tests), but "analyze" is intentionally broader and can
  // legitimately require zero tool calls — reasoning over context already
  // in the conversation, recalling something from earlier in the same
  // session, plain judgment calls. Forcing this for analyze too was tried
  // and reproduced a real bug: a purely conversational task ("remember a
  // codeword, then recall it") got `unverified` on every correct answer
  // because there was nothing to call a tool FOR, which drove the fallback
  // ladder through 5 real dispatches across different models chasing a
  // problem that didn't exist. analyze tasks that DO reference the
  // filesystem are still protected by the phantom-reference cross-check
  // below, which isn't gated by taskClass.
  const requiresTools = input.taskClass === "read" || input.taskClass === "edit" || input.taskClass === "test";
  if (requiresTools && evidenceBase.tool_calls === 0) {
    warnings.push("no_tool_calls");
    forcedStatus = "unverified";
  }

  const claimed = parseEvidenceTrailer(input.finalText);
  if (claimed === null) {
    warnings.push("missing_evidence_trailer");
  } else if (claimed.length > 0) {
    const phantoms = findPhantomReferences(claimed, evidenceBase.files_seen);
    if (phantoms.length > 0) {
      warnings.push(`phantom_file_reference:${phantoms.join("|")}`);
      if (phantoms.length === claimed.length) forcedStatus = "unverified";
    }
  }

  if (input.taskClass === "edit" && input.git) {
    if (input.git.changed.length === 0) {
      warnings.push("edit_claimed_no_diff");
      forcedStatus = "unverified";
    } else if (input.scope?.length) {
      const outside = input.git.changed.filter((f) => !withinScope(f, input.scope!));
      if (outside.length > 0) warnings.push(`scope_violation:${outside.join("|")}`);
    }
  }

  return {
    evidence: { ...evidenceBase, git: input.git },
    warnings,
    forcedStatus,
  };
}
