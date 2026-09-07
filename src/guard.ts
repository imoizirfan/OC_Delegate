#!/usr/bin/env bun
// PreToolUse hook (matcher: "Read"). This is what makes delegation
// *automatic* rather than dependent on Claude choosing to read the
// opencode-delegate skill: it runs deterministically, outside the model's
// judgment, before every Read tool call in every session on this machine.
//
// Contract (Claude Code hooks, PreToolUse): JSON on stdin with at least
// `tool_name` / `tool_input`; a JSON object on stdout with
// `hookSpecificOutput.permissionDecision` either denies the call (with a
// reason Claude sees and can act on) or is omitted entirely to let the
// call proceed untouched. Silence + exit 0 = "not our concern, carry on."
//
// Scope is deliberately narrow (large-file Read only, not Bash/Grep/Glob):
// file size is the one thing this hook can check *before* the read
// happens, with no false-positive risk on the normal case (small source
// files pass through untouched). Bash-output-size and multi-file-sweep
// detection would need heuristics or session state this hook doesn't have
// — left as a documented next step, not guessed at.

import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const MAX_BYTES = Number(process.env.OCD_GUARD_MAX_BYTES) || 50 * 1024;
const DISABLED = process.env.OCD_GUARD_DISABLE === "1";

interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string };
  cwd?: string;
}

function allow(): never {
  // No output, exit 0 — Claude Code treats this as "hook has no opinion".
  process.exit(0);
}

function deny(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  if (DISABLED) allow();

  const raw = await Bun.stdin.text().catch(() => "");
  if (!raw) allow();

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    allow(); // malformed input isn't this hook's problem to fail on
  }

  if (input.tool_name !== "Read") allow();
  const filePath = input.tool_input?.file_path;
  if (!filePath || !isAbsolute(filePath)) allow();

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    allow(); // file doesn't exist / not readable — let the real Read tool report that
  }

  if (size <= MAX_BYTES) allow();

  const dir = dirname(filePath);
  const kb = (size / 1024).toFixed(0);
  deny(
    `${filePath} is ${kb}KB (over the ${(MAX_BYTES / 1024).toFixed(0)}KB OC_Delegate dirty-read ` +
      `threshold) — don't read it directly. Delegate it instead:\n\n` +
      `  ocd run --class read --dir ${dir} --tag <short-tag> "read ${filePath} and <say what you need from it>"\n\n` +
      `Then read only the returned envelope (evidence.files_seen / text), never opencode's raw output. ` +
      `See the opencode-delegate skill for the full ocd CLI surface. If this file genuinely needs a direct ` +
      `read (e.g. you're the one authoring/reviewing it line-by-line), set OCD_GUARD_DISABLE=1 for this ` +
      `session and read it yourself instead of fighting the hook.`,
  );
}

main();
