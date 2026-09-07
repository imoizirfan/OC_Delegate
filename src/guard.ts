#!/usr/bin/env bun
// Pre-tool-use hook. This is what makes delegation *automatic* rather than
// dependent on the agent choosing to read the opencode-delegate skill: it
// runs deterministically, outside the model's judgment, before every file
// read in every session on this machine.
//
// One binary serves three hosts, because their wire formats turned out to be
// close enough that three scripts would be duplication, not separation:
//
//   Claude Code  PreToolUse       stdin {tool_name, tool_input:{file_path}}
//   Codex CLI    PreToolUse       stdin {tool_name, tool_input:{...}}  ← identical
//   Cursor       beforeReadFile   stdin {hook_event_name, file_path}   ← flat
//
// The Claude Code / Codex identity is not an assumption: it was read out of
// the schema embedded in the codex 0.141 binary, which defines the same
// `hook_event_name` / `tool_name` / `tool_input` input and the same
// `hookSpecificOutput.permissionDecision` output. Cursor differs in both
// directions and gets its own reply shape.
//
// Scope is deliberately narrow (large-file reads only, not Bash/Grep/Glob):
// file size is the one thing this hook can check *before* the read happens,
// with no false-positive risk on the normal case (small source files pass
// through untouched). Bash-output-size and multi-file-sweep detection would
// need heuristics or session state this hook doesn't have — left as a
// documented next step, not guessed at.
//
// Every unexpected condition fails OPEN. A hook that blocks work because it
// could not parse its own input is worse than no hook at all.

import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const MAX_BYTES = Number(process.env.OCD_GUARD_MAX_BYTES) || 50 * 1024;
const DISABLED = process.env.OCD_GUARD_DISABLE === "1";

/** Which reply dialect to answer in. */
export type Host = "claude" | "cursor";

interface HookInput {
  // Claude Code / Codex
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Cursor
  hook_event_name?: string;
  file_path?: string;
}

/** Tool names, across hosts, that read one file at a path in their input.
 *
 * Codex reads most files through `shell` (`cat`/`sed`) rather than a named
 * read tool, so coverage there is best-effort by construction — a shell
 * command is not something this hook can size-check without parsing shell,
 * which is exactly the kind of guessing the rest of this file avoids. */
const READ_TOOLS = new Set(["read", "read_file", "view", "view_image"]);

/** Normalize the three input dialects to (host, filePath). Returns null when
 * this event is not a single-file read we can reason about. */
export function normalize(input: HookInput): { host: Host; filePath: string } | null {
  // Cursor: flat payload, its own event name.
  if (input.hook_event_name === "beforeReadFile" || input.hook_event_name === "beforeTabFileRead") {
    return typeof input.file_path === "string" ? { host: "cursor", filePath: input.file_path } : null;
  }

  // Claude Code / Codex: nested tool_input.
  const tool = input.tool_name;
  if (!tool || !READ_TOOLS.has(tool.toLowerCase())) return null;
  const ti = input.tool_input ?? {};
  const candidate = ti["file_path"] ?? ti["filePath"] ?? ti["path"];
  return typeof candidate === "string" ? { host: "claude", filePath: candidate } : null;
}

export function denialMessage(filePath: string, size: number): string {
  const dir = dirname(filePath);
  const kb = (size / 1024).toFixed(0);
  return (
    `${filePath} is ${kb}KB (over the ${(MAX_BYTES / 1024).toFixed(0)}KB OC_Delegate dirty-read ` +
    `threshold) — don't read it directly. Delegate it instead:\n\n` +
    `  ocd run --class read --dir ${dir} --tag <short-tag> "read ${filePath} and <say what you need from it>"\n\n` +
    `Then read only the returned envelope (evidence.files_seen / text), never opencode's raw output. ` +
    `See the opencode-delegate skill for the full ocd CLI surface. If this file genuinely needs a direct ` +
    `read (e.g. you're the one authoring/reviewing it line-by-line), set OCD_GUARD_DISABLE=1 for this ` +
    `session and read it yourself instead of fighting the hook.`
  );
}

/** The deny payload each host understands.
 *
 * Claude Code and Codex share `hookSpecificOutput.permissionDecision`.
 * Cursor uses a flat `permission` with separate messages for the human and
 * the agent — it shows `user_message` in the UI and hands `agent_message` to
 * the model, so the actionable ocd command belongs in the latter. */
export function denialPayload(host: Host, reason: string): unknown {
  if (host === "cursor") {
    return {
      permission: "deny",
      user_message: "OC_Delegate: large file blocked, delegate the read to ocd instead.",
      agent_message: reason,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allow(): never {
  // No output, exit 0 — every supported host reads this as "hook has no
  // opinion, carry on".
  process.exit(0);
}

function deny(payload: unknown): never {
  process.stdout.write(JSON.stringify(payload));
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

  const target = normalize(input);
  if (!target) allow();
  if (!isAbsolute(target.filePath)) allow();

  let size: number;
  try {
    size = statSync(target.filePath).size;
  } catch {
    allow(); // missing / unreadable — let the real read tool report that
  }

  if (size <= MAX_BYTES) allow();

  deny(denialPayload(target.host, denialMessage(target.filePath, size)));
}

// Skip execution when imported by the test suite, which exercises the pure
// helpers above directly rather than round-tripping a subprocess.
if (import.meta.main) await main();
