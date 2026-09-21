#!/usr/bin/env bun
// Edit-verification tests. Offline: uses only a throwaway local git repo, no
// model, no credentials.
//
// Regression for a scope bug found on a clean-machine run: git reports
// changed paths relative to the repo root ("src/a.ts"), but the default
// scope is --dir as an absolute path. Comparing the two directly flagged
// every file of every edit task as scope_violation, so a correct edit came
// back `next: send_feedback`. The temp dir used here sits under a macOS
// symlink (/var -> /private/var), which exercises the realpath half of it.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffAgainst, evaluateGate, scopeToRepoPaths, currentHead } from "../src/verify.ts";
import type { ToolUseRecord } from "../src/dispatch.ts";

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

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["git", "-c", "user.name=ocd-test", "-c", "user.email=ocd-test@example.invalid", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

console.log("=== scope path normalization (pure) ===");
eq("scope:dir_itself_is_whole_repo", scopeToRepoPaths(["/r"], "/r", "/r"), [""]);
eq("scope:absolute_subdir", scopeToRepoPaths(["/r/src"], "/r", "/r"), ["src"]);
eq("scope:relative_is_relative_to_dir", scopeToRepoPaths(["src"], "/r/pkg", "/r"), ["pkg/src"]);
eq("scope:wildcard_kept", scopeToRepoPaths(["/r/src/*.ts"], "/r", "/r"), ["src/*.ts"]);
check("scope:outside_repo_stays_outside", scopeToRepoPaths(["/elsewhere"], "/r", "/r")[0]!.startsWith(".."));

console.log("\n=== real git: --dir is a subdirectory of the repo ===");
const root = mkdtempSync(join(tmpdir(), "ocd-verify-"));
try {
  const dir = join(root, "pkg");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(root, "other.txt"), "x\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const base = (await currentHead(dir))!;

  writeFileSync(join(dir, "a.txt"), "two\n");
  writeFileSync(join(dir, "new.txt"), "fresh\n");

  const diff = await diffAgainst(dir, base);
  eq("git:paths_are_repo_relative", [...diff.changed].sort(), ["pkg/a.txt", "pkg/new.txt"]);

  const gitRoot = Bun.spawnSync({ cmd: ["git", "rev-parse", "--show-toplevel"], cwd: dir }).stdout.toString().trim();
  const toolUses: ToolUseRecord[] = [
    { tool: "edit", input: { filePath: join(dir, "a.txt") }, status: "completed" },
    { tool: "write", input: { filePath: join(dir, "new.txt") }, status: "completed" },
  ];
  const text = "Done.\n\nEVIDENCE: pkg/a.txt, pkg/new.txt";

  const inScope = evaluateGate({
    taskClass: "edit",
    finalText: text,
    toolUses,
    git: diff,
    scope: scopeToRepoPaths([dir], dir, gitRoot),
  });
  check(
    "gate:default_scope_no_false_violation",
    !inScope.warnings.some((w) => w.startsWith("scope_violation")),
    JSON.stringify(inScope.warnings),
  );

  writeFileSync(join(root, "other.txt"), "changed outside --dir\n");
  const diff2 = await diffAgainst(dir, base);
  const outOfScope = evaluateGate({
    taskClass: "edit",
    finalText: text,
    toolUses,
    git: diff2,
    scope: scopeToRepoPaths([dir], dir, gitRoot),
  });
  eq(
    "gate:real_violation_still_caught",
    outOfScope.warnings.filter((w) => w.startsWith("scope_violation")),
    ["scope_violation:other.txt"],
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
