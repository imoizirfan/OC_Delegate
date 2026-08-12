# OC_Delegate

`ocd` is a deterministic wrapper CLI that lets Claude Code delegate mechanical, context-heavy subtasks to [opencode](https://opencode.ai) running a free model, instead of spending Claude usage on bulk work. Claude only ever reads a small, fixed-shape JSON envelope — never opencode's raw output.

It exists because a bare `opencode run` has three problems that make it unsafe to hand raw output to Claude: `--format json` inflates content instead of compressing it, the free model will confidently hallucinate filesystem facts with zero tool calls behind them, and the exit code is `0` even when a task was denied by policy. `ocd` fixes all three: it strips tool payloads down to a compact envelope, runs an evidence gate that never trusts the model's prose, and derives status from the real event stream.

Personal, single-user tool — paths default under `$HOME`, not published to any package registry.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [The envelope](#the-envelope)
- [Task classes](#task-classes)
- [Fallback ladder](#fallback-ladder)
- [Safety model](#safety-model)
- [Configuration](#configuration)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Testing](#testing)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 — the CLI runs directly as TypeScript, no build step.
- [opencode](https://opencode.ai) CLI, authenticated against OpenCode Zen (`opencode auth login`) so the free models are reachable.
- `git`, on `PATH`.
- macOS or Linux. Built and tested against opencode `1.18.16` and bun `1.3.14`; the permission-schema findings this system depends on (see [Safety model](#safety-model)) were confirmed against that opencode version specifically and should be re-checked with `ocd doctor` after any opencode upgrade.

## Install

```bash
git clone git@github.com:imoizirfan/OC_Delegate.git ~/OC_Delegate
cd ~/OC_Delegate
./install.sh
```

`install.sh` is idempotent and backs up anything it would overwrite before touching it:

1. `bun install` in the repo.
2. Creates `~/.local/state/ocd/{transcripts,jobs}`.
3. Backs up `~/.config/opencode/opencode.jsonc` (if present) to `opencode.jsonc.bak-<timestamp>`, then merges the `ocd-delegate` agent definition from [`config/agent.ocd-delegate.jsonc`](config/agent.ocd-delegate.jsonc) into it. Every other key in that file — including a pre-existing `delegate` agent, MCP servers, etc. — is left untouched.
4. Symlinks [`skill/SKILL.md`](skill/SKILL.md) to `~/.claude/skills/opencode-delegate/SKILL.md` (backing up a real file there first, if one exists and isn't already a symlink).
5. Symlinks `bin/ocd` to `~/.local/bin/ocd` and warns if `~/.local/bin` isn't on `PATH`.
6. Runs `ocd doctor` and fails the install (non-zero exit) if any check fails.

If `ocd doctor` fails at the end, fix whatever it flagged (see [`ocd doctor`](#ocd-doctor)) before delegating real work — the install itself will have still completed.

## Usage

A full example: delegate a mechanical rename, review it, and undo it.

```bash
ocd run --class edit --dir /path/to/project --tag rename-vars --bg \
  "Rename all instances of oldName to newName in src/"

ocd poll rename-vars --wait 30
ocd result rename-vars --with-diff

# not quite right — ask for one more pass on the same session
ocd cont rename-vars "You missed src/legacy/old.ts, do that one too."

# reject it entirely
ocd revert rename-vars
```

### `ocd run`

```
ocd run --class <read|analyze|edit|test> --dir <abs-path> --tag <name> [--bg] [--scope a,b] "<task>"
```

Dispatches a new task under a fresh session tagged `<name>`, used to resume it later via `cont`/`poll`/`result`.

| Flag | Required | Meaning |
|---|---|---|
| `--class` | yes | `read` \| `analyze` \| `edit` \| `test`. Drives timeouts and what the evidence gate demands — see [Task classes](#task-classes). |
| `--dir` | yes | Absolute path that must already exist. opencode cannot read or write outside it (`external_directory` is denied). |
| `--tag` | yes | The ref used to resume this task. Fails if the tag already has a background task running. |
| `--scope` | no | Comma-separated paths. Used for edit-class conflict detection between parallel tasks and to flag `scope_violation` if the model edits outside it. Defaults to `--dir` for edit tasks. |
| `--bg` | no | Dispatch in a detached background worker and return immediately with a `pid`; poll with `ocd poll`. Without it, `ocd run` blocks until the task finishes, fails, or times out. |

For `--class edit`, `--dir` must already be a clean git repository (`git status --porcelain` empty) — refused otherwise, since the resulting diff can only be verified against a known base. `ocd` records the current `HEAD` and creates (but never checks out) a bookmark branch `ocd/<tag>-<hash>` at that commit, so edits land directly on whatever branch was already checked out, exactly like an uncommitted change a human would make.

**Exit code:** a pre-dispatch failure (tag already running, scope conflict, concurrency cap reached, dirty working tree for `--class edit`) exits `1`, or `2` specifically for a conflict — before any dispatch happens, regardless of `--bg`. Otherwise: a synchronous run exits `0` for `status: ok` and `1` for anything else; a `--bg` run exits `0` as soon as the background worker is confirmed dispatched — the real outcome comes later via `ocd poll` / `ocd result`.

### `ocd cont`

```
ocd cont <ref> "<feedback>"
```

Sends follow-up feedback into an existing session — this is the two-way "chat ID" loop. `<ref>` is the `--tag` from `ocd run`, or a raw `session_id`. Capped at 3 rounds per ref (`MAX_ROUNDS`); past that, `ocd` returns `next: escalate` without dispatching anything, so a stuck task can't turn into an unbounded Claude↔opencode ping-pong.

### `ocd poll`

```
ocd poll <ref> [--wait <sec>]
```

Checks a `--bg` task. Without `--wait`, returns immediately (`status: running` if still in flight, with `next: poll_again`). With `--wait <sec>`, blocks up to that many seconds — polling once a second — and returns the final envelope as soon as the task finishes.

### `ocd result`

```
ocd result <ref> [--with-diff]
```

Re-prints the last envelope for a ref without dispatching anything new. `--with-diff` (edit-class only) appends the real `git diff` against the recorded base head, truncated to 20,000 characters.

### `ocd list`

Lists every ref in the registry: class, dir, model, status, round/turn counts, and timestamps.

### `ocd drop`

```
ocd drop <ref>
```

Removes a ref from the registry. If it has a background task still running, sends `SIGTERM` first. Does not touch any files the task changed — run `ocd revert` first if you need that.

### `ocd revert`

```
ocd revert <ref>
```

Undoes an edit-class task's changes: restores files that existed at the recorded base head via `git checkout`, deletes files the task newly created (a plain `checkout` can't restore something with no history), and removes the bookmark branch. Never `git reset --hard`. No-op if the task made no recorded changes; refuses for non-edit refs or refs with no recorded base.

### `ocd doctor`

```
ocd doctor [--live]
```

Health check, run after install and whenever something looks wrong:

| Check | Verifies |
|---|---|
| `opencode_binary` | `opencode --version` succeeds. |
| `git_binary` | `git --version` succeeds. |
| `opencode_zen_auth` | `opencode providers list` shows real credentials. |
| `agent_permissions` | The `ocd-delegate` agent's **live, resolved** permission rules — not just the source jsonc — actually deny the operations this system depends on for safety (see [Safety model](#safety-model)). Resolved config is a flat rules array with base-then-override entries per `(permission, pattern)`; this check takes the *last* matching entry, since that's the one that actually wins. |
| `registry_writable` | The state directory can be written to. |
| `live_dispatch` | Only with `--live`: one real round-trip dispatch (`"Reply with exactly the word OK"`), to confirm the whole path works end-to-end, not just its preconditions. |

## The envelope

`ocd run` and `ocd cont` each print exactly one JSON object. This is the only thing Claude should ever read.

```json
{
  "ref": "rename-vars",
  "session_id": "ses_abc123",
  "status": "ok",
  "level": 0,
  "model": "opencode/deepseek-v4-flash-free",
  "rounds": 0,
  "text": "Renamed oldName to newName in 3 files.\n\nEVIDENCE: src/a.ts, src/b.ts, src/c.ts",
  "evidence": {
    "tool_calls": 6,
    "tools": ["read", "edit"],
    "files_seen": ["src/a.ts", "src/b.ts", "src/c.ts"],
    "git": {
      "changed": ["src/a.ts", "src/b.ts", "src/c.ts"],
      "insertions": 9,
      "deletions": 9,
      "branch": "ocd/rename-vars-3f9a1c02",
      "base_head": "e4a1c9f0..."
    }
  },
  "warnings": [],
  "tokens": { "input": 221, "output": 340, "cache_read": 27136, "cache_write": 0 },
  "cost": 0,
  "duration_ms": 8412,
  "transcript": "/home/you/.local/state/ocd/transcripts/rename-vars.ndjson",
  "next": "accept"
}
```

| Field | Meaning |
|---|---|
| `status` | `ok` \| `empty` \| `blocked` \| `stalled` \| `timeout` \| `unverified` \| `error` \| `conflict`. Only `ok` means "trust this." |
| `next` | `accept` \| `send_feedback` \| `escalate` \| `conflict` — `ocd`'s own recommendation for what to do next; default to following it rather than re-deriving the mechanics. |
| `evidence` | The only independently-verified part of the envelope: a real tool-call count/names, files actually touched, and — for edits — a real `git diff` summary. Cite this, not `text`, when reporting what a delegated task found. |
| `warnings` | Machine-readable reasons behind `status` — see table below. |
| `text` | The model's final reply, truncated to 4000 characters. Useful context, not a source of truth about the filesystem. |
| `level` | Which fallback-ladder rung (0–3) produced this result. |
| `rounds` | How many `cont` calls have landed on this ref so far. |
| `tokens` / `cost` | Usage for this call. `cost` is always `0` — only free models are used. |
| `transcript` | Path to the full raw NDJSON on disk, for the rare case deeper inspection is needed. |

### Warnings

| Warning | Meaning |
|---|---|
| `no_tool_calls` | A `read`/`edit`/`test` task answered without calling any tool. Forces `status: unverified`. |
| `missing_evidence_trailer` | The model didn't include the required trailing `EVIDENCE:` line. |
| `phantom_file_reference:<files>` | The model cited files in `EVIDENCE:` that no real tool call ever touched. Forces `unverified` if *every* cited file is phantom. |
| `edit_claimed_no_diff` | An edit-class task produced no real git diff. Forces `unverified`. |
| `scope_violation:<files>` | An edit-class task changed files outside the declared `--scope`. |

`status: blocked` means a permission rule denied a tool call mid-task; `ocd` has already stripped the raw ruleset dump out of the message before it reaches the envelope. Don't retry a blocked task — the policy isn't going to change between attempts.

## Task classes

| Class | Mutation expected | Tool calls required | Notes |
|---|---|---|---|
| `read` | No | Yes | Gate forces `unverified` if the model answers without calling a tool. |
| `analyze` | No | No | Pure reasoning is valid here — e.g. recalling something from earlier in the same session. Still checked for phantom file references if it does cite any. |
| `edit` | Yes | Yes | Requires a clean git tree in `--dir` up front; verified against a real `git diff`, never the model's claim. Never auto-commits, never pushes. |
| `test` | Possibly (test artifacts) | Yes | Expected to actually run the project's test command and report real output, not a guessed summary. |

`analyze` deliberately does not require tool calls — `read`/`edit`/`test` are defined by filesystem interaction (you can't read without reading), but forcing the same requirement on `analyze` reproduced a real bug during development: a purely conversational task got `unverified` on every correct answer, burning real calls across the whole fallback ladder chasing a problem that didn't exist.

## Fallback ladder

Free models only — this system never spends money, it escalates to Claude instead.

| Rung | Model | Advances here when |
|---|---|---|
| L0 | `deepseek-v4-flash-free` (`--variant max`) | Starting point for every fresh task. |
| L1 | same model, same session | L0 came back `empty` / `unverified` / `timeout` / `stalled` / `error` — one retry with a sharpened prompt. |
| L2 | `nemotron-3-ultra-free` → `mimo-v2.5-free` → `hy3-free`, tried in order | `empty`/`unverified` persisting past L1, or a detected rate-limit. Drops the session — a different model has no shared history — and resends the full task contract. |
| L3 | — | Ladder gives up. `ocd` returns the last result with `next: escalate` for Claude to take over. |

Exceptions to the table above: a `blocked` result (permission denial) never retries — it escalates immediately, since the policy won't change on retry. A detected auth failure also escalates immediately, regardless of rung. A crash (`error` status) gets one retry at L1 but skips straight to escalate after that, with no L2 detour — unlike `empty`/`unverified`/`timeout`, which walk the full L2 list first.

Session continuity (the "chat ID") is model-bound: a session only survives a retry that stays on the same model (L0→L1). The moment the ladder switches models, the old session is dropped and the new one starts from the full initial contract.

## Safety model

The `ocd-delegate` opencode agent ([`config/agent.ocd-delegate.jsonc`](config/agent.ocd-delegate.jsonc)) runs headless with these permissions:

| Permission | Rule |
|---|---|
| `bash` | Allowed, except `git push*`, `git push --force*`, `git reset --hard*`, `rm -rf*`, `sudo*`, and `npm`/`yarn`/`pnpm` `publish*`/`unpublish*` — all denied. |
| `edit` | Allowed everywhere within `--dir`. The real backstop for edits is the git-diff-truth check in the evidence gate, not this rule. |
| `read` | Allowed everywhere, except `*.env` / `*.env.*` (asked, not denied outright) and `*.env.example` (allowed). |
| `webfetch` | Denied. |
| `external_directory` | Denied — the agent cannot touch anything outside `--dir`. |
| `doom_loop` | Denied. |
| `question` | Denied — headless, there's no one to answer an interactive prompt. |
| `plan_enter` / `plan_exit` | Denied. |

`ocd doctor`'s `agent_permissions` check re-asserts these against the **live, resolved** config on every run rather than trusting the source file — getting this wrong once (misreading an early, non-winning entry in the resolved rules array instead of the last one) already produced a false conclusion during development. See the header comment in `config/agent.ocd-delegate.jsonc` for the full account.

Two of opencode's permission keys reject a pattern-map form outright and only accept a bare string (`webfetch`, `doom_loop`, `question` — confirmed against opencode `1.18.16`'s config validator; `bash`/`edit`/`read`/`external_directory`/`plan_enter`/`plan_exit` accept pattern-map fine). Getting this wrong doesn't just misconfigure `ocd-delegate` — an invalid agent section fails opencode's *entire* config file, breaking every other agent too. If you add or change a permission key here, verify with `opencode debug agent ocd-delegate` before trusting it.

Edit-class tasks add a second, independent layer on top of agent permissions: a clean-tree requirement before dispatch, a real `git diff` (never the model's claim) as the source of truth for what changed, and `ocd revert` to undo it. Nothing is ever auto-committed or pushed.

## Configuration

Two environment variables, read at startup:

| Variable | Default | Purpose |
|---|---|---|
| `OCD_OPENCODE_BIN` | `opencode` (resolved via `PATH`) | Override which `opencode` binary to spawn. |
| `OCD_STATE_DIR` | `~/.local/state/ocd` | Registry, lock file, and transcripts live here. |

Everything else is a constant in [`src/config.ts`](src/config.ts) — there's no build step, so editing it takes effect on the next invocation:

| Constant | Value | Meaning |
|---|---|---|
| `MODEL_L0` / `MODEL_L1` | `opencode/deepseek-v4-flash-free` | Model used at ladder rungs 0 and 1. |
| `MODELS_L2` | `nemotron-3-ultra-free`, `mimo-v2.5-free`, `hy3-free` | Alternate free models, tried in this order at rung 2. |
| `VARIANT` | `max` | opencode reasoning-effort variant. |
| `MAX_ROUNDS` | `3` | `cont` calls allowed per ref before forced `escalate`. |
| `MAX_LADDER` | `4` | Number of rungs (L0..L3). |
| `CONCURRENCY_CAP` | `4` | Max simultaneous `--bg` dispatches, to stay under free-tier rate limits. |
| `SESSION_TTL_MS` | 24 hours | Sessions older than this are auto-retired. |
| `SESSION_TURN_CAP` | `40` | Sessions past this many turns are auto-retired. |
| `TEXT_TRUNCATE` | `4000` chars | Envelope `text` field truncation. |
| `FILES_SEEN_CAP` | `50` | Envelope `evidence.files_seen` truncation. |

Per-class timeouts (`TIMEOUTS_MS`):

| Class | Wall timeout | Stall timeout (no event) |
|---|---|---|
| `analyze` | 120s | 45s |
| `read` | 600s | 90s |
| `edit` | 900s | 120s |
| `test` | 900s | 120s |

The wall timeout is a hard cap on total run time; the stall timeout kills a task earlier if it goes silent (no NDJSON event at all) for that long — the real failure mode observed during development was a silent hang, not a slow-but-active task, so the stall watchdog matters as much as the wall clock.

## Updating

```bash
cd ~/OC_Delegate
git pull
./install.sh
```

`install.sh` is safe to re-run: it backs up the live `opencode.jsonc` and any real (non-symlink) `SKILL.md` before touching them, then re-merges and re-links.

One caveat: the config merge re-serializes the entire live `~/.config/opencode/opencode.jsonc` as plain JSON on every run. If you've hand-added `//` or `/* */` comments to that file outside of what `ocd` manages, they will be dropped (a warning is printed when this happens) — recover them from the timestamped `.bak-<timestamp>` file if needed.

## Uninstalling

Nothing here is registered with a package manager — it's three symlinks, one merged config key, and a state directory:

```bash
rm ~/.local/bin/ocd
rm ~/.claude/skills/opencode-delegate/SKILL.md   # then restore SKILL.md.bak-<timestamp> if one exists
rm -rf ~/.local/state/ocd                         # registry + transcripts; optional
```

Then remove the `"ocd-delegate"` key under `.agent` in `~/.config/opencode/opencode.jsonc` by hand, or restore the pre-install backup (`opencode.jsonc.bak-<timestamp>`) if you haven't made other changes to that file since installing.

## Testing

```bash
mkdir -p /tmp/ocd-smoke/smoke-hallucination
echo probe > /tmp/ocd-smoke/smoke-hallucination/probe.txt

mkdir -p /tmp/ocd-smoke/smoke-repo
git -C /tmp/ocd-smoke/smoke-repo init -q
git -C /tmp/ocd-smoke/smoke-repo commit -q --allow-empty -m init

OCD_TEST_SCRATCH=/tmp/ocd-smoke bun test/smoke.ts
```

[`test/smoke.ts`](test/smoke.ts) is not a mocked unit-test suite — most checks dispatch real tasks through the real, installed `ocd` (`OCD_TEST_BIN` can override the binary path) against `OCD_TEST_SCRATCH`, so they cost real free-tier calls and take real wall-clock time. Run `ocd doctor` first; a failing precondition there will just show up as confusing test failures. It covers: fault injection against the pure ladder/gate functions (no dispatch), the golden hallucination regression, session continuity across two separate process invocations, an edit-plus-revert round trip, parallel scope-conflict detection, and a context-savings measurement (raw transcript bytes vs. envelope bytes).

## Repo layout

```
bin/ocd                            shim: resolves symlinks, execs `bun src/cli.ts`
install.sh                         idempotent installer
install/merge-config.ts            JSONC-aware config merge, used by install.sh
config/agent.ocd-delegate.jsonc    opencode agent definition, merged into opencode.jsonc
skill/SKILL.md                     Claude Code skill, symlinked into ~/.claude/skills/
src/cli.ts                         CLI entry point and subcommands
src/config.ts                      tunables — models, timeouts, caps, paths
src/types.ts                       shared type definitions (Envelope, SessionEntry, ...)
src/contract.ts                    prompt templates sent to opencode
src/dispatch.ts                    process spawn, NDJSON streaming, timeouts
src/registry.ts                    session/tag registry, file locking, scope claims
src/verify.ts                      evidence gate + git diff verification
src/ladder.ts                      fallback ladder decision logic
src/envelope.ts                    ladder result -> envelope JSON
test/smoke.ts                      end-to-end + fault-injection test suite
```

## Known limitations

- **Rate-limit and auth detection is a keyword heuristic**, not verified against a real 401/429 from OpenCode Zen (doing so would require breaking working auth or exhausting the free tier). See `detectErrorHint` in [`src/ladder.ts`](src/ladder.ts).
- **Ladder position doesn't persist across separate CLI invocations.** If a `cont` resumes a session that had already fallen back to an L2 alternate model, and that `cont` itself needs to retry, it re-walks the L2 list from the start rather than remembering which alternates were already tried. `MAX_ROUNDS` bounds the resulting damage, and this got much less frequent once the evidence gate stopped over-triggering on `analyze` tasks. See the doc comment on `runWithLadder` in [`src/ladder.ts`](src/ladder.ts).
