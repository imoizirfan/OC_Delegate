#!/usr/bin/env bun
// Merges the ocd-guard pre-read hook into one host's config, leaving every
// other key alone. Run only via `install.sh --with-hooks`; the caller is
// responsible for the pre-write backup, same contract as merge-config.ts.
//
//   usage: merge-hooks.ts <claude|cursor|codex> <config path> <guard path>
//
// Three hosts, three config shapes — verified, not guessed:
//
//   claude  ~/.claude/settings.json
//           { hooks: { PreToolUse: [ { matcher, hooks: [ {type:"command", command} ] } ] } }
//   codex   ~/.codex/hooks.json
//           { hooks: { PreToolUse: [ { command } ] } }        (schema read out of
//           the codex 0.141 binary; hooks are stable/on by default there)
//   cursor  ~/.cursor/hooks.json
//           { version: 1, hooks: { beforeReadFile: [ { command } ] } }
//
// Idempotent by command string: re-running never stacks duplicate entries,
// which matters because install.sh is documented as safe to re-run and a
// stacked hook would run the guard N times per read.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const HOST = process.argv[2];
const PATH_ = process.argv[3];
const GUARD = process.argv[4];

if (!HOST || !PATH_ || !GUARD) {
  console.error("usage: merge-hooks.ts <claude|cursor|codex> <config path> <guard path>");
  process.exit(1);
}

function load(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // Refuse rather than overwrite: this is the user's editor config, and
    // silently replacing an unparseable one would lose real settings.
    console.error(`refusing to modify ${path}: it is not valid JSON (${String(err).slice(0, 120)})`);
    process.exit(1);
  }
}

const config = load(PATH_);
const hooks = (config.hooks as Record<string, unknown> | undefined) ?? {};

/** True when this event already runs our guard — compared on the command
 * string so a re-run updates in place instead of appending a second copy. */
function alreadyPresent(entries: unknown[]): boolean {
  return JSON.stringify(entries).includes(GUARD);
}

let event: string;
let entry: unknown;

if (HOST === "claude") {
  event = "PreToolUse";
  entry = { matcher: "Read", hooks: [{ type: "command", command: GUARD }] };
} else if (HOST === "codex") {
  event = "PreToolUse";
  entry = { command: GUARD };
} else if (HOST === "cursor") {
  event = "beforeReadFile";
  entry = { command: GUARD };
  if (config.version === undefined) config.version = 1;
} else {
  console.error(`unknown host '${HOST}' — expected claude, cursor or codex`);
  process.exit(1);
}

const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
if (alreadyPresent(existing)) {
  console.log(`ocd-guard already wired into ${PATH_} (${event}) — left as is`);
  process.exit(0);
}

hooks[event] = [...existing, entry];
config.hooks = hooks;
writeFileSync(PATH_, JSON.stringify(config, null, 2) + "\n");
console.log(`wired ocd-guard into ${PATH_} (${event})`);
