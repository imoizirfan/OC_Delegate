#!/usr/bin/env bun
// Guard-hook tests. Offline: no model, no network, no opencode.
//
// These round-trip the real `bin/ocd-guard` as a subprocess rather than only
// calling the exported helpers, because the thing that actually matters is
// the bytes on stdout and the exit code — a host reads nothing else. Every
// unexpected condition must fail OPEN (empty stdout, exit 0); a hook that
// blocks work because it could not parse its own input is worse than no hook.
//
// Payload shapes are the real ones: Claude Code's and Codex's PreToolUse
// (identical, per the schema embedded in the codex 0.141 binary) and Cursor's
// flat beforeReadFile.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, denialPayload } from "../src/guard.ts";

const TMP = mkdtempSync(join(tmpdir(), "ocd-guard-test-"));
const BIG = join(TMP, "big.txt");
const SMALL = join(TMP, "small.txt");
writeFileSync(BIG, "x".repeat(200 * 1024));
writeFileSync(SMALL, "small");

const GUARD = join(import.meta.dir, "..", "bin", "ocd-guard");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? `${a}` : `got ${a}, want ${e}`);
}

async function run(payload: string, env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn({
    cmd: [GUARD],
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const code = await proc.exited;
  return { out, code };
}

/** A host treats "no output, exit 0" as "the hook has no opinion". */
async function allows(payload: string, env: Record<string, string> = {}): Promise<boolean> {
  const { out, code } = await run(payload, env);
  return out.trim() === "" && code === 0;
}

const claude = (p: string, tool = "Read") => JSON.stringify({ tool_name: tool, tool_input: { file_path: p } });
const codex = (p: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: p } });
const cursor = (p: string) => JSON.stringify({ hook_event_name: "beforeReadFile", file_path: p, conversation_id: "c1" });

console.log("=== input normalization (three host dialects, one hook) ===");

eq("norm:claude_nested", normalize({ tool_name: "Read", tool_input: { file_path: "/a" } }), { host: "claude", filePath: "/a" });
eq("norm:codex_path_key", normalize({ tool_name: "read_file", tool_input: { path: "/a" } }), { host: "claude", filePath: "/a" });
eq("norm:cursor_flat", normalize({ hook_event_name: "beforeReadFile", file_path: "/a" }), { host: "cursor", filePath: "/a" });
eq("norm:tab_read_is_cursor", normalize({ hook_event_name: "beforeTabFileRead", file_path: "/a" }), { host: "cursor", filePath: "/a" });
eq("norm:non_read_tool_ignored", normalize({ tool_name: "Bash", tool_input: { command: "cat /a" } }), null);
eq("norm:codex_shell_ignored", normalize({ tool_name: "shell", tool_input: { command: ["cat", "/a"] } }), null);
eq("norm:no_path_ignored", normalize({ tool_name: "Read", tool_input: {} }), null);
eq("norm:unknown_event_ignored", normalize({ hook_event_name: "SessionStart" }), null);

console.log("\n=== deny payload dialects ===");

{
  const c = denialPayload("claude", "why") as { hookSpecificOutput: Record<string, string> };
  eq("payload:claude_event_name", c.hookSpecificOutput.hookEventName, "PreToolUse");
  eq("payload:claude_decision", c.hookSpecificOutput.permissionDecision, "deny");
  eq("payload:claude_reason", c.hookSpecificOutput.permissionDecisionReason, "why");

  const u = denialPayload("cursor", "why") as Record<string, string>;
  eq("payload:cursor_permission", u.permission, "deny");
  // Cursor shows user_message to the human and hands agent_message to the
  // model, so the actionable ocd command has to be in agent_message.
  eq("payload:cursor_agent_message_carries_reason", u.agent_message, "why");
  check("payload:cursor_has_user_message", typeof u.user_message === "string" && u.user_message.length > 0);
  check("payload:cursor_has_no_claude_shape", !("hookSpecificOutput" in u));
}

console.log("\n=== blocking a large read, per host ===");

for (const [name, payload, expectDeny] of [
  ["claude", claude(BIG), "hookSpecificOutput"],
  ["codex", codex(BIG), "hookSpecificOutput"],
  ["cursor", cursor(BIG), "permission"],
] as const) {
  const { out, code } = await run(payload);
  const parsed = out ? JSON.parse(out) : null;
  check(`block:${name}_denies`, parsed !== null && expectDeny in parsed, out.slice(0, 60));
  eq(`block:${name}_exit_zero`, code, 0);
  // Exit 0 is deliberate even on a deny: the decision travels in the JSON,
  // and a non-zero exit reads as "the hook itself broke" on these hosts.
  check(`block:${name}_names_ocd`, out.includes("ocd run --class read"));
}

console.log("\n=== fail-open paths (a confused hook must never block) ===");

check("open:small_file", await allows(claude(SMALL)));
check("open:small_file_cursor", await allows(cursor(SMALL)));
check("open:nonexistent_file", await allows(claude(join(TMP, "nope.txt"))));
check("open:relative_path", await allows(claude("big.txt")));
check("open:unrelated_tool", await allows(claude(BIG, "Bash")));
check("open:malformed_json", await allows("not json at all"));
check("open:empty_stdin", await allows(""));
check("open:unknown_event", await allows(JSON.stringify({ hook_event_name: "SessionStart" })));

console.log("\n=== escape hatches ===");

check("hatch:disable_allows_big_file", await allows(claude(BIG), { OCD_GUARD_DISABLE: "1" }));
{
  // Threshold is tunable in both directions — lowering it must make an
  // otherwise-fine file blocked, which proves the env var is really read.
  const { out } = await run(claude(SMALL), { OCD_GUARD_MAX_BYTES: "3" });
  check("hatch:max_bytes_lowers_threshold", out.includes('"deny"'), out.slice(0, 60));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
