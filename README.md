# OC_Delegate

`ocd` is a deterministic wrapper CLI that lets a coding agent — Claude Code, Cursor, Codex, or anything else with shell access — delegate mechanical, context-heavy subtasks to [opencode](https://opencode.ai) running a free model, instead of spending its own usage on bulk work. The calling agent only ever reads a small, fixed-shape JSON envelope — never opencode's raw output.

That covers bulk file reading, mechanical edits, running tests, and (since v0.2.0) **web research**: `--class search` replaces the calling agent's own web search with the free model's, under the same evidence gate. A [pre-read hook](#editor-integration) makes delegation automatic rather than a judgment call the model has to remember to make.

It exists because a bare `opencode run` has three problems that make it unsafe to hand raw output to Claude: `--format json` inflates content instead of compressing it, the free model will confidently hallucinate filesystem facts with zero tool calls behind them, and the exit code is `0` even when a task was denied by policy. `ocd` fixes all three: it strips tool payloads down to a compact envelope, runs an evidence gate that never trusts the model's prose, and derives status from the real event stream.

Single-user tool — paths default under `$HOME`, not published to any package registry. Installed per machine from this repo.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [The envelope](#the-envelope)
- [Task classes](#task-classes)
- [Web search](#web-search)
- [Model selection](#model-selection)
- [Fallback ladder](#fallback-ladder)
- [Choosing the model yourself](#choosing-the-model-yourself)
- [Safety model](#safety-model)
- [Editor integration](#editor-integration)
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
- macOS or Linux. Built and tested against opencode `1.18.29` and bun `1.3.14`; the permission-schema findings this system depends on (see [Safety model](#safety-model)) were confirmed against opencode `1.18.16`–`1.18.29` and should be re-checked with `ocd doctor` after any opencode upgrade.
- Optional, for [editor integration](#editor-integration): Claude Code, Cursor, or Codex CLI ≥ `0.114` (hooks are stable and on by default as of `0.141`).

Model availability is **not** a requirement you need to check by hand — `ocd` discovers free models at runtime and routes around broken ones. See [Model selection](#model-selection).

**That list is the whole dependency surface.** `ocd` shells out to exactly three binaries — `opencode` (all model work, including web search), `git` (edit verification), and `bun` (its own background worker) — and has two dev dependencies, `bun-types` and `typescript` (for `bun run typecheck`). There is no second model provider, no research CLI, no API key beyond the one `opencode auth login` already manages, and no npm runtime dependencies. If a change would add a fourth binary or a second provider, that is a change to what this tool *is*, not an implementation detail.

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
5. Symlinks `bin/ocd` and `bin/ocd-guard` to `~/.local/bin/` and warns if `~/.local/bin` isn't on `PATH`.
6. Probes the free models once so the health file starts warm — without this, the first real task pays to discover that the top-ranked model is disabled or geo-blocked.
7. Runs `ocd doctor` and fails the install (non-zero exit) if any check fails.

Pass `--with-hooks` to also wire the pre-read hook into Claude Code, Cursor and Codex — see [Editor integration](#editor-integration). Without that flag, nothing outside opencode's config, `~/.claude/skills/`, and `~/.local/bin/` is touched.

```bash
./install.sh --with-hooks
```

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
ocd run --class <read|analyze|edit|test|search> --dir <abs-path> --tag <name> [--bg] [--scope a,b] "<task>"
```

Dispatches a new task under a fresh session tagged `<name>`, used to resume it later via `cont`/`poll`/`result`.

| Flag | Required | Meaning |
|---|---|---|
| `--class` | yes | `read` \| `analyze` \| `edit` \| `test` \| `search`. Drives timeouts and what the evidence gate demands — see [Task classes](#task-classes). |
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

### `ocd models`

```
ocd models [--refresh] [--probe] [--all]
ocd models --pin <provider/model> | --prefer <substr,substr> | --unpin
```

Shows which model would be chosen and why — the inspection surface for [model selection](#model-selection). Prints the ranked candidate chain with each model's score breakdown, context window, published variants, bench state, and last recorded health result.

| Flag | Effect |
|---|---|
| `--refresh` | Re-enumerate from `opencode models --refresh`, bypassing the 6-hour cache. Use after the provider changes its lineup. |
| `--probe` | Send a real request to candidates and record the outcome in the health file. Stops at the first healthy model. |
| `--all` | With `--probe`, probe every candidate instead of stopping at the first healthy one. |
| `--pin <id>` | Save a model pin to `~/.local/state/ocd/model-pref.json`. Requires a provider-qualified id. |
| `--prefer <a,b>` | Save a preference order (comma-separated substrings, highest priority first). |
| `--unpin` | Clear both the saved pin and the saved preference. |

Exits `0` if at least one usable model is available, `1` otherwise.

To override which model gets picked, see [Choosing the model yourself](#choosing-the-model-yourself).

### `ocd doctor`

```
ocd doctor [--live] [--probe] [--refresh]
```

Health check, run after install and whenever something looks wrong:

| Check | Verifies |
|---|---|
| `opencode_binary` | `opencode --version` succeeds. |
| `git_binary` | `git --version` succeeds. |
| `opencode_zen_auth` | `opencode providers list` shows real credentials. |
| `agent_has_no_pinned_model` | The installed agent carries no model id of its own. This is how the tool broke before: a pinned id in the agent config, delisted by the provider, unnoticed. `ocd` passes `--model` per dispatch, so the correct value here is *none*, and anything else means a stale install. |
| `agent_permissions` | The `ocd-delegate` agent's **live, resolved** permission rules — not just the source jsonc — actually deny the operations this system depends on for safety, **and allow** the two web tools `--class search` needs (see [Safety model](#safety-model)). Resolved config is a flat rules array with base-then-override entries per `(permission, pattern)`; this check takes the *last* matching entry, since that's the one that actually wins. |
| `registry_writable` | The state directory can be written to. |
| `model_available` | At least one free, tool-calling model resolves and is not benched. With `--probe` or `--live`, candidates are probed for real rather than trusted from metadata — which is the only way to catch a model that reports itself as active but is disabled, geo-blocked, or hanging. |
| `live_dispatch` | Only with `--live`: one real round-trip dispatch (`"Reply with exactly the word OK"`) against the model selection actually chose, to confirm the whole path works end-to-end, not just its preconditions. |

## The envelope

`ocd run` and `ocd cont` each print exactly one JSON object. This is the only thing Claude should ever read.

```json
{
  "ref": "rename-vars",
  "session_id": "ses_abc123",
  "status": "ok",
  "level": 0,
  "model": "opencode/<whichever-free-model-was-selected>",
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
| `model_notes` | Present only when non-empty. Non-fatal remarks about *how the model was chosen* (stale cache, a pinned model, an empty lineup). Deliberately separate from `warnings` and excluded from the `next` decision — a discovery note says nothing about whether the work is trustworthy. |

The `model` field records which model actually produced the result. It is **not stable across runs** — see [Model selection](#model-selection).

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
| `search` | No | Yes, **web** ones | Research against the live web. Requires `websearch`/`webfetch` specifically — local tool calls don't count. Cited URLs are cross-checked against ones actually retrieved. See [Web search](#web-search). |

`analyze` deliberately does not require tool calls — `read`/`edit`/`test` are defined by filesystem interaction (you can't read without reading), but forcing the same requirement on `analyze` reproduced a real bug during development: a purely conversational task got `unverified` on every correct answer, burning real calls across the whole fallback ladder chasing a problem that didn't exist.

## Web search

`ocd run --class search` delegates web research the same way the other classes delegate file work. The point is identical: a research question typically costs the calling agent several search-result blobs and a couple of full page fetches to produce three useful sentences. `--class search` moves that whole sweep to the free model and returns one envelope.

```bash
ocd run --class search --dir "$PWD" --tag bun-version \
  "What is the latest stable release of the Bun runtime, and when was it released? Cite sources."
```

```json
{
  "status": "ok",
  "next": "accept",
  "text": "The latest stable release of Bun is v1.4.2, released on September 5, 2026 …",
  "evidence": {
    "tool_calls": 3,
    "tools": ["websearch", "webfetch"],
    "queries": ["Bun JavaScript runtime latest stable release version release date 2026"],
    "sources": ["https://github.com/oven-sh/bun/releases", "https://bun.sh/blog/bun-v1.4.2", "…"]
  },
  "warnings": []
}
```

It uses opencode's own native `websearch` tool (Exa-backed) plus `webfetch`, both on the free tier — there is no extra API key to configure and no separate account.

**`sources` and `queries` are the verified part**, exactly as `files_seen` is for a read task. They are built from real tool calls, not from the model's prose:

- `queries` comes from the `query` field of each real `websearch` call.
- `sources` is the union of every `webfetch` URL and every http(s) URL found in a web tool's **output** — search results carry their URLs in the result body, not in the input, so without scraping the output an honest search would appear to have retrieved nothing. Only the URLs are kept, never the bodies.
- The envelope reports at most 12 sources, with `evidence.sources_truncated` giving the real total when it trimmed. The gate always cross-checks against the **complete** set — trimming before the check would turn an honest citation of the 30th result into a phantom. A real four-call search produced 50 unique URLs, which was 54% of the envelope by bytes; for a tool whose entire premise is that the envelope stays small, that had to be capped.

The gate is stricter for `search` than for any other non-mutating class, because the failure mode is worse — a confidently wrong answer sourced from stale training data looks exactly like a correct one:

| Situation | Result |
|---|---|
| Zero tool calls | `unverified`, warning `no_tool_calls` |
| Tool calls, but none of them `websearch`/`webfetch` (e.g. it grepped the repo instead) | `unverified`, warning `no_web_tool_calls` |
| Every cited URL is one it never retrieved | `unverified`, warning `phantom_source_reference:<urls>` |
| Some cited URLs are invented | `ok` with `phantom_source_reference` warning → `next: send_feedback` |

URL matching requires an **exact host** and treats the path as a prefix. Reusing the file-path matcher would have been wrong in an obvious way: it compares trailing path segments, so two unrelated sites both serving `/releases` would have counted as the same source.

`--dir` is still required and still sandboxes the agent, even though a search task shouldn't touch the filesystem — pass the project the question is about, or `$PWD`. The contract also tells the model not to edit, write, or run shell commands during a search task.

> **Read [Safety model](#safety-model) before turning teammates loose on this.** Enabling web access is not free of consequences: it is the same agent that has `bash` and `edit` allowed.

## Model selection

**No model id is hardcoded anywhere.** The provider rotates its free lineup often enough that any written-down id is a scheduled outage. Models are discovered at runtime, filtered, ranked, and health-checked.

Inspect the current decision at any time:

```bash
ocd models
```

Selection runs in four stages:

1. **Discover** — `opencode models <provider> --verbose` is parsed for the full catalogue.
2. **Filter** — a candidate must be *priced at exactly zero* (`cost.input`, `cost.output`, and both cache rates), support **tool calls**, and be marked `active`. Price is read from the metadata, never inferred from the name: the lineup contains a zero-cost model with no `-free` suffix, so name-matching would be wrong in both directions. A model with a missing or partial `cost` block is treated as **paid** — an unknown price is never assumed free.
3. **Rank** — there is no quality field in the metadata, so the score is derived from what is actually published, weighted for what this tool does: context window (log-scaled, dominant — `ocd` exists to absorb bulk file reading), release recency, reasoning support, and variant support. Every score is shown with its breakdown in `ocd models`.
4. **Health-gate** — models that recently failed are sunk to the bottom of the chain.

### Why health-gating is not optional

Published metadata does not tell you whether a model works. Of the six models that passed every static filter during testing, **three were unusable**: one disabled server-side, one geo-restricted, and one that accepted requests and never responded. All three reported `status: active`, `toolcall: true`, and a price of zero — and the two *highest-ranked* candidates by metadata score were among them. Ranking alone would confidently pick a dead model every time.

`ocd models --probe` sends a real request to candidates and records the outcome, and `install.sh` runs it once so a fresh install starts warm. Failures are also recorded automatically from real task dispatches, so the chain self-corrects during normal use.

Benched models are **sorted down, never removed**. If every free model is failing, the ladder still has something to attempt, still produces a real error, and still escalates to Claude with evidence — rather than failing before it starts.

| Failure | Classified as | Bench duration |
|---|---|---|
| "Model is disabled" | `disabled` | 24h |
| "not available in your country" | `geo` | 24h |
| model not found / unknown model | `missing` | 24h |
| No response within the wall/stall window | `unresponsive` | 15m → 1h → 6h |
| 429 / rate limit / capacity | `rate_limit` | 15m → 1h → 6h |
| 401 / unauthorized | `auth` | **never benched** |

`auth` is deliberately exempt: a bad credential is a global problem, and benching each model as it fails would silently empty the entire candidate list over one expired login.

Health tracks **reachability only**. A `blocked` result is permission policy, and `empty` / `unverified` mean the model answered badly — benching on those would evict a working model over a bad prompt and make the health file track quality, which it cannot measure.

### Fallback ladder

Free models only — this system never spends money, it escalates to Claude instead. If discovery yields no free model, `ocd` **fails rather than dispatching**: without an explicit `--model`, opencode would fall back to its own default, which is very likely paid.

| Rung | Model | Advances here when |
|---|---|---|
| L0 | Best-ranked healthy model, at its highest published effort variant | Starting point for every fresh task. |
| L1 | Same model, same session | L0 came back `empty` / `unverified` / `timeout` / `stalled` / `error` — one retry with a sharpened prompt. |
| L2 | Next-ranked model, walked in order (up to `MAX_ALT_MODELS`) | Failure persisting past L1, or a detected rate-limit. Drops the session — a different model has no shared history — and resends the full task contract. |
| L3 | — | Ladder gives up. `ocd` returns the last result with `next: escalate` for Claude to take over. |

Effort variant is resolved **per model** from what that model publishes (`xhigh` → `max` → `high` → `medium` → `low` → `minimal`), and omitted entirely for models that publish none.

Exceptions: a `blocked` result (permission denial) never retries — the policy won't change on a second attempt. A detected auth failure escalates immediately regardless of rung. A repeated `stalled` or `error` moves to a **different model** rather than escalating, because the most common cause in practice is a model that has been disabled or geo-blocked server-side, where retrying the same one is guaranteed to fail.

When the failure is provably structural — the provider says the model is disabled, geo-blocked, or delisted — the ladder **skips the L1 same-model retry entirely** and goes straight to a different model, since retrying is guaranteed to fail identically. Detecting this requires reading opencode's structured error event: under `--format json` a provider failure arrives as an NDJSON event on stdout (leaving stderr empty), so a run that is actually a dead model otherwise looks merely `empty`. That event reports `statusCode: 401` even for a plain model outage, so classification reads its `message` field only — treating the status code as authoritative would misfile a routine model outage as an expired login and escalate instead of switching.

Session continuity (the "chat ID") is model-bound: a session only survives a retry that stays on the same model (L0→L1). The moment the ladder switches models, the old session is dropped and the new one starts from the full initial contract.

### Choosing the model yourself

Automatic selection is the default, not a constraint. There are two ways to override it, and the difference between them is the important part:

| | prefer | pin |
|---|---|---|
| What it does | Biases the ranking toward models you name | Forces exactly one model |
| Free-cost + tool-call filter | still applied | **bypassed** |
| Health-gating | still applied | **bypassed** |
| Falls back if the model breaks | yes, to the next-best model | no, straight to Claude |
| Use it for | making a preference stick day to day | debugging one specific model |
| Per command | `OCD_MODEL_PREFER=a,b` | `OCD_MODEL=<id>` |
| Persistently | `ocd models --prefer a,b` | `ocd models --pin <id>` |

Start by getting the exact ids — never type one from memory, since the lineup rotates:

```bash
ocd models
```

#### Making it stick — `ocd models --pin` / `--prefer`

Both overrides have an env-var form and a saved form. The saved form exists because an env var does not survive a new shell, and "export this before every session" is not a usable answer to "make it use that model" — particularly when handing the tool to someone else.

```bash
ocd models --prefer mimo,ling      # saved preference order
ocd models --pin opencode/<exact-id-from-ocd-models>
ocd models --unpin                 # clear both
```

These write `~/.local/state/ocd/model-pref.json`. **Environment beats file**, so a one-off `OCD_MODEL=… ocd run …` still overrides a saved setting without you having to unset it. The two preference lists are not merged for the same reason — a merged list would leave no way to temporarily override a saved one.

`ocd models` reports what is actually in effect and where it came from, under `override`:

```json
"override": {
  "pin": { "id": "opencode/<id>", "from": "file" },
  "prefer": null,
  "path": "/Users/you/.local/state/ocd/model-pref.json"
}
```

That `from` field is the point of the whole feature being visible rather than silent: from inside a run that picked a surprising model, a pin saved weeks ago in another shell is indistinguishable from no pin at all. A file-sourced preference also shows up in the envelope's `model_notes`.

`--pin` requires a provider-qualified id (`<provider>/<model>`) and rejects a bare name, since a bare name is almost always a `--prefer` substring typed into the wrong flag.

#### Bias the ranking — `OCD_MODEL_PREFER`

This is the one to reach for. Comma-separated substrings, **highest priority first**, matched against the model id, so a fragment like `mimo` is enough:

```bash
export OCD_MODEL_PREFER=mimo,ling
ocd models
```

A match adds a bonus big enough to be decisive rather than advisory — `+1000` for the first entry, `+900` for the second, and so on, floored at `+100`. That is deliberate: an earlier version added a flat small bonus, and the metadata score (context window, recency) routinely outvoted it, so the documented "highest priority first" ordering quietly didn't hold. You can see the bonus applied in the `why` breakdown:

```
"why": "ctx=200000(+53.0) age=129d(+9.9) reasoning(+3) prefer[0]:mimo(+1000)"
```

Everything else still applies: a preferred model must still be free and tool-calling to be a candidate at all, it is still health-gated, and if it breaks mid-task the ladder still walks on to the next-best model. If nothing matches your substrings — most likely because the model was delisted — selection silently falls back to normal ranking, which is the intended behaviour: your preference degrades into "no preference", not into a failure.

Put the `export` in your shell profile to make it permanent, or use `ocd models --prefer` above and skip the env var entirely.

#### Pin exactly one — `OCD_MODEL`

An escape hatch, honoured verbatim: no discovery, no filtering, no health-gating, no alternates.

```bash
OCD_MODEL=opencode/<exact-id-from-ocd-models> ocd run --class read --dir "$PWD" --tag probe-one "..."
```

Prefer setting it per command rather than exporting it (or saving it with `ocd models --pin`) — a standing pin disables the entire mechanism that keeps this tool working across a lineup rotation, which is the exact failure this system was built to remove. Two consequences:

- **A pin is the one path that can cost money.** It bypasses the zero-cost filter, so a paid model id will be dispatched to without complaint.
- **A typo is not caught.** Nothing checks a pinned id against the catalogue, so `ocd models` will report a model that doesn't exist as `selected`, with `ok: true`. Verify a pin with a real request before trusting it:

  ```bash
  OCD_MODEL=opencode/whatever ocd models --probe
  ```

  and read `probe.healthy` — `null` means the pinned model never answered. The top-level `ok` only says a pin is set, not that it works.

#### Other levers

| Lever | Effect |
|---|---|
| `OCD_MODEL_PROVIDER` | Which provider to enumerate; defaults to `opencode`. Set it to an empty string to enumerate **every** authenticated provider, which widens the candidate pool if you're authed elsewhere. Candidates from other providers still have to pass the free-cost and tool-call filters. |
| `ocd models --refresh` | Force re-enumeration when the lineup changed and the 6-hour cache hasn't expired yet. |
| `ocd models --probe --all` | Re-test every candidate now and rewrite the health file, instead of waiting for real dispatches to discover what's broken. |
| `~/.local/state/ocd/model-health.json` | Delete the file — or just one model's entry — to clear the bench and retry a model immediately instead of waiting out its cooldown. A missing or corrupt file is handled: it's rebuilt empty. |
| `~/.local/state/ocd/models-cache.json` | Deleting it forces re-discovery on the next call; same effect as `--refresh`. |
| `~/.local/state/ocd/model-pref.json` | The saved pin/preference. `ocd models --unpin` clears it; deleting the file does the same. A corrupt file is ignored rather than fatal — selection falls back to discovery. |

There is deliberately **no `--model` flag on `ocd run`**. Model choice is environment-level so that a Claude-driven delegation can't pick one per task — [`skill/SKILL.md`](skill/SKILL.md) instructs Claude not to name a model and not to treat the one in an envelope as stable. Overriding is a decision you make about your machine, not one the orchestrator makes about a task.

## Safety model

The `ocd-delegate` opencode agent ([`config/agent.ocd-delegate.jsonc`](config/agent.ocd-delegate.jsonc)) runs headless with these permissions:

| Permission | Rule |
|---|---|
| `bash` | Allowed, except `git push*`, `git push --force*`, `git reset --hard*`, `rm -rf*`, `sudo*`, and `npm`/`yarn`/`pnpm` `publish*`/`unpublish*` — all denied. |
| `edit` | Allowed everywhere within `--dir`. The real backstop for edits is the git-diff-truth check in the evidence gate, not this rule. |
| `read` | Allowed everywhere, except `*.env` / `*.env.*` (asked, not denied outright) and `*.env.example` (allowed). |
| `webfetch` | **Allowed** — required by `--class search`. Was denied before v0.2.0. |
| `websearch` | **Allowed** — required by `--class search`. |
| `external_directory` | Denied — the agent cannot touch anything outside `--dir`. |
| `doom_loop` | Denied. |
| `question` | Denied — headless, there's no one to answer an interactive prompt. |
| `plan_enter` / `plan_exit` | Denied. |

`ocd doctor`'s `agent_permissions` check re-asserts these against the **live, resolved** config on every run rather than trusting the source file — getting this wrong once (misreading an early, non-winning entry in the resolved rules array instead of the last one) already produced a false conclusion during development. See the header comment in `config/agent.ocd-delegate.jsonc` for the full account.

Some of opencode's permission keys reject a pattern-map form outright and only accept a bare string (`webfetch`, `websearch`, `doom_loop`, `question` — confirmed against opencode `1.18.16`'s config validator and re-checked against `1.18.29`'s published schema; `bash`/`edit`/`read`/`external_directory`/`plan_enter`/`plan_exit` accept pattern-map fine). Getting this wrong doesn't just misconfigure `ocd-delegate` — an invalid agent section fails opencode's *entire* config file, breaking every other agent too. If you add or change a permission key here, verify with `opencode debug agent ocd-delegate` before trusting it.

Edit-class tasks add a second, independent layer on top of agent permissions: a clean-tree requirement before dispatch, a real `git diff` (never the model's claim) as the source of truth for what changed, and `ocd revert` to undo it. Nothing is ever auto-committed or pushed.

### The web-access tradeoff (read this before rolling it out)

`--class search` requires `webfetch` and `websearch`, and `ocd` uses **one agent** for every class. So the agent that reads attacker-controllable web pages is the same agent that has `bash` and `edit` allowed. That is a real exposure, deliberately accepted, and it is stated here rather than buried:

- A fetched page, a README, a search snippet, or a code sample can contain text addressed to an AI agent — telling it to run a command, modify a file, or ignore its instructions. Nothing in this design makes that impossible.
- The **hard** backstop is the permission deny-list: `git push`, `git reset --hard`, `rm -rf`, `sudo`, and the publish commands are denied at the opencode layer, so they fail regardless of what a page says. `external_directory` is denied, so nothing outside `--dir` is reachable.
- The **soft** backstop is the search contract in [`src/contract.ts`](src/contract.ts): retrieved content is data, never instructions; do not edit, write, or run shell commands during a search task. A prompt rule is a mitigation, not a guarantee.
- The **detective** control is the envelope: `evidence.tools` and `evidence.git.changed` show what a task actually did. A search task that somehow edited files shows up there, because that block is derived from real tool calls and a real `git diff`.

If that trade isn't acceptable for your use, the clean fix is to split the agent — define a second opencode agent with `websearch`/`webfetch` allowed and `bash`/`edit`/`write`/`task` denied, and route `--class search` to it via `dispatch()`'s existing `agent` option (already plumbed through, currently unused). That closes the browse-to-execute path entirely at the cost of a second agent definition to keep in sync.

Two habits reduce the exposure a lot in practice, whatever you decide: keep `--dir` pointed at the specific project a task concerns (never `$HOME` or `/`), and don't run `--class search` and `--class edit` under the same tag.

## Editor integration

`ocd` is a plain CLI, so any agent that can run a shell command can use it. The difference between "available" and "actually used" is two things: telling the agent *when* to delegate, and a **hook** that makes it delegate whether or not it feels like it.

The hook is [`bin/ocd-guard`](bin/ocd-guard). It runs before a file read, and if the file is over 50KB it blocks the read and hands the agent the `ocd run --class read` command to use instead. That takes delegation out of the model's judgment, which is the only way it happens consistently.

Install the hook for every host found on this machine:

```bash
./install.sh --with-hooks
```

Each config is backed up to `<file>.bak-<timestamp>` first, and re-running never stacks duplicate entries. To wire one host by hand instead, use the per-host sections below.

**Escape hatches** (all hosts): `OCD_GUARD_DISABLE=1` turns the hook off for a session; `OCD_GUARD_MAX_BYTES` changes the threshold.

### Claude Code

**1. The skill** — `install.sh` already symlinks it to `~/.claude/skills/opencode-delegate/SKILL.md`. It tells Claude when delegating is the right call and how to read an envelope.

**2. The hook** — in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "~/.local/bin/ocd-guard" }]
      }
    ]
  }
}
```

**3. Skip the permission prompt** on `ocd` itself, so delegating isn't slower than not delegating — also in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(ocd:*)"]
  }
}
```

**Verify:** start a session and ask Claude to read a file larger than 50KB. It should come back with the guard's message naming an `ocd run` command instead of the file contents.

### Cursor

**1. The hook** — in `~/.cursor/hooks.json` (or `<project>/.cursor/hooks.json` for one repo only):

```json
{
  "version": 1,
  "hooks": {
    "beforeReadFile": [{ "command": "~/.local/bin/ocd-guard" }]
  }
}
```

Cursor's payload is flat (`file_path` at the top level) and it expects a different denial shape than Claude Code — the guard detects which host called it and answers in the right dialect, so the same binary serves both.

**2. The rule** — Cursor has no skills directory, so the guidance goes in an always-applied rule at `.cursor/rules/ocd.mdc`:

```markdown
---
description: Delegate context-heavy work to the ocd CLI
alwaysApply: true
---

Before reading a large log, digesting many files just to summarize them, or
doing a mechanical multi-file edit, delegate it to `ocd` instead of doing it
inline:

    ocd run --class <read|analyze|edit|test|search> --dir <abs path> --tag <name> "<task>"

Use `--class search` instead of your own web search for any research question
that would take more than one query.

`ocd` prints one small JSON envelope. Read only that — never the raw output of
the underlying tool. Trust `evidence` (derived from real tool calls and a real
git diff), not `text`. Follow the `next` field: accept | send_feedback |
escalate. Send a correction with `ocd cont <tag> "<feedback>"`.
```

**Verify:** `cat ~/.cursor/hooks.json` parses, then ask the agent to read a >50KB file.

### Codex CLI

Codex hooks first shipped in `0.114` and are stable and on by default as of `0.141`; check with `codex features list | grep hooks`.

**1. The hook** — in `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [{ "command": "~/.local/bin/ocd-guard" }]
  }
}
```

Codex's `PreToolUse` wire format is identical to Claude Code's — same `tool_name` / `tool_input` on stdin, same `hookSpecificOutput.permissionDecision` on stdout — so the guard needs no Codex-specific handling.

> **Coverage on Codex is best-effort.** Codex reads most files through `shell` (`cat`, `sed`), not through a named read tool, and the guard cannot size-check a shell command without parsing shell. It fires reliably on named read tools and passes shell reads through untouched. The `AGENTS.md` guidance below is doing more of the work here than the hook is.

**2. The guidance** — Codex reads `AGENTS.md` from the repo root. Add:

```markdown
**Delegating heavy work**

Before reading a large log, digesting many files just to summarize them, or
running a mechanical multi-file edit, delegate it:

    ocd run --class <read|analyze|edit|test|search> --dir <abs path> --tag <name> "<task>"

For research, `ocd run --class search` replaces doing your own web searching.

`ocd` returns one small JSON envelope. Read only that. `evidence` is verified
(real tool calls, real git diff); `text` is not. Follow `next`. Iterate with
`ocd cont <tag> "<feedback>"`, and check `ocd doctor` if everything fails.
```

**Verify:** `codex features list | grep hooks` shows `stable true`, and `~/.codex/hooks.json` parses.

### Any other agent

There is nothing Claude-specific in the CLI. Give the agent shell access to `ocd`, plus the three rules that matter: pick `--class` honestly, read only the envelope, and trust `evidence` over `text`. [`skill/SKILL.md`](skill/SKILL.md) is the canonical version of that briefing and is short enough to paste into any system prompt.

## Configuration

Environment variables, read at startup:

| Variable | Default | Purpose |
|---|---|---|
| `OCD_OPENCODE_BIN` | `opencode` (resolved via `PATH`) | Override which `opencode` binary to spawn. |
| `OCD_STATE_DIR` | `~/.local/state/ocd` | Registry, lock file, transcripts, model cache, and health file live here. |
| `OCD_MODEL_PROVIDER` | `opencode` | Provider to enumerate models from. Empty string enumerates every authenticated provider. |
| `OCD_MODEL` | *(unset)* | Escape hatch: pin one model id, bypassing discovery **and** health routing. Intended for debugging a specific model. |
| `OCD_MODEL_PREFER` | *(empty)* | Comma-separated substrings that bias ranking toward specific models, highest priority first. Empty by default, so nothing is favoured by name out of the box. |
| `OCD_GUARD_MAX_BYTES` | `51200` (50KB) | File-size threshold above which the [editor hook](#editor-integration) blocks a direct read. |
| `OCD_GUARD_DISABLE` | *(unset)* | Set to `1` to turn the editor hook off for a session. |

The `OCD_MODEL*` variables are how you override model choice by hand — see [Choosing the model yourself](#choosing-the-model-yourself) for which one to use, what each gives up, and how to make an override persist without an env var at all.

One state file is worth knowing about by name: `~/.local/state/ocd/model-pref.json`, written by `ocd models --pin` / `--prefer`. Env vars take precedence over it, so a one-off `OCD_MODEL=… ocd run …` overrides a saved setting without unsetting anything.

Everything else is a constant in [`src/config.ts`](src/config.ts) — there's no build step, so editing it takes effect on the next invocation:

| Constant | Value | Meaning |
|---|---|---|
| `MODELS_CACHE_TTL_MS` | 6 hours | How long the discovered model list is reused before re-enumerating. |
| `PROBE_TIMEOUT_MS` | `45000` | Wall clock for a single `--probe` health check. |
| `COOLDOWN_MS` | 15m / 1h / 6h / 24h | Bench durations: escalating for transient failures, 24h for structural ones (`disabled`, `geo`, `missing`). |
| `MAX_ALT_MODELS` | `3` | Most alternate models the ladder walks before escalating. Bounds worst-case latency — without it, a large discovered lineup could mean many sequential dispatches, each able to burn a full stall window. |
| `MAX_ROUNDS` | `3` | `cont` calls allowed per ref before forced `escalate`. |
| `MAX_LADDER` | `4` | Number of rungs (L0..L3). |
| `CONCURRENCY_CAP` | `4` | Max simultaneous `--bg` dispatches, to stay under free-tier rate limits. |
| `SESSION_TTL_MS` | 24 hours | Sessions older than this are auto-retired. |
| `SESSION_TURN_CAP` | `40` | Sessions past this many turns are auto-retired. |
| `TEXT_TRUNCATE` | `4000` chars | Envelope `text` field truncation. |
| `FILES_SEEN_CAP` | `50` | Envelope `evidence.files_seen` truncation. |
| `SOURCES_REPORTED_CAP` | `12` | Envelope `evidence.sources` truncation. The evidence gate still checks against the full, untrimmed set. |

Per-class timeouts (`TIMEOUTS_MS`):

| Class | Wall timeout | Stall timeout (no event) |
|---|---|---|
| `analyze` | 120s | 45s |
| `search` | 300s | 90s |
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
rm ~/.local/bin/ocd ~/.local/bin/ocd-guard
rm ~/.claude/skills/opencode-delegate/SKILL.md   # then restore SKILL.md.bak-<timestamp> if one exists
rm -rf ~/.local/state/ocd                         # registry, transcripts, model pin; optional
```

If you ran `install.sh --with-hooks`, also remove the `ocd-guard` entry from whichever of `~/.claude/settings.json`, `~/.cursor/hooks.json` and `~/.codex/hooks.json` it was added to — or restore each file's `.bak-<timestamp>`.

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

[`test/smoke.ts`](test/smoke.ts) is not a mocked unit-test suite — most checks dispatch real tasks through the real, installed `ocd` (`OCD_TEST_BIN` can override the binary path) against `OCD_TEST_SCRATCH`, so they cost real free-tier calls and take real wall-clock time. Run `ocd doctor` first; a failing precondition there will just show up as confusing test failures. It covers: fault injection against the pure ladder/gate functions (no dispatch), live model selection, the golden hallucination regression, session continuity across two separate process invocations, an edit-plus-revert round trip, parallel scope-conflict detection, and a context-savings measurement (raw transcript bytes vs. envelope bytes).

```bash
bun test/models.test.ts
```

```bash
bun test/models.test.ts    # model selection, ranking, health, ladder routing
bun test/search.test.ts    # search gate, URL evidence, contract rules
bun test/guard.test.ts     # editor hook, all three host dialects
```

The three offline suites need no credentials, make no API calls, and redirect state to a temp dir — run them first, since a failure there is a real bug rather than a flaky free model.

[`test/search.test.ts`](test/search.test.ts) covers [`--class search`](#web-search): the gate's `no_web_tool_calls` and `phantom_source_reference` paths, host-exact URL matching, tool-output URL scraping, and the assertion that search rules never leak into other classes. [`test/guard.test.ts`](test/guard.test.ts) round-trips the real `bin/ocd-guard` binary as a subprocess against Claude Code, Codex and Cursor payloads — the bytes on stdout and the exit code are all a host ever sees — and asserts every fail-open path.

[`test/models.test.ts`](test/models.test.ts) covers [model selection](#model-selection) and is fully offline and deterministic — it runs against fixtures captured from real `opencode models --verbose` output and real provider error strings, so it needs no credentials and makes no API calls. It redirects state to a temp dir, so it will not disturb your real registry or health file. Notably it includes a guard that **fails the build if any concrete `provider/model` id appears in anything the installer ships** — `src/`, `config/`, `install/`, `bin/`, `install.sh`, `package.json`. That scan originally covered only `src/`, and the gap was a real bug: `config/agent.ocd-delegate.jsonc` went on pinning a delisted model for weeks while the suite reported green.

## Repo layout

```
bin/ocd                            shim: resolves symlinks, execs `bun src/cli.ts`
bin/ocd-guard                      shim for the pre-read hook, execs `bun src/guard.ts`
install.sh                         idempotent installer (--with-hooks for editor hooks)
install/merge-config.ts            JSONC-aware config merge, used by install.sh
install/merge-hooks.ts             per-host hook config merge, used by --with-hooks
config/agent.ocd-delegate.jsonc    opencode agent definition, merged into opencode.jsonc
skill/SKILL.md                     Claude Code skill, symlinked into ~/.claude/skills/
src/cli.ts                         CLI entry point and subcommands
src/config.ts                      tunables — timeouts, caps, cooldowns, paths
src/types.ts                       shared type definitions (Envelope, SessionEntry, ...)
src/contract.ts                    prompt templates sent to opencode
src/dispatch.ts                    process spawn, NDJSON streaming, timeouts
src/models.ts                      model discovery, ranking, health, variants
src/registry.ts                    session/tag registry, file locking, scope claims
src/verify.ts                      evidence gate + git diff verification
src/ladder.ts                      fallback ladder decision logic
src/envelope.ts                    ladder result -> envelope JSON
src/guard.ts                       pre-read hook: Claude Code / Cursor / Codex
test/smoke.ts                      end-to-end + fault-injection test suite (live)
test/models.test.ts                model-selection test suite (offline)
test/search.test.ts                search gate + URL evidence test suite (offline)
test/guard.test.ts                 editor-hook test suite (offline)
```

## Known limitations

- **Rate-limit detection is partly a keyword heuristic.** When opencode emits a structured error event the reason is read from its `message` field directly; otherwise the fallback is a keyword scan of stderr, which has not been verified against a real 429 from OpenCode Zen (doing so would mean deliberately exhausting the free tier). See `detectErrorHint` in [`src/ladder.ts`](src/ladder.ts).
- **Ranking is a heuristic, because the provider publishes no quality signal.** Context window, recency, and reasoning support are proxies for capability, not measurements of it — a newly listed model could rank first and simply be worse at the work. Health-gating catches models that are *broken*, not models that are merely *bad*. If you find a model that consistently produces better results, bias toward it with `OCD_MODEL_PREFER` rather than editing the scoring.
- **A model that fails only under load looks healthy to `--probe`.** Probes use a trivial prompt; a model can answer that instantly and still stall on a real task. Such a model gets benched when it actually fails a dispatch, so the system self-corrects — but the first task to hit it pays the timeout. One free model was observed hanging on two probes and then completing normally on a third, which is why `unresponsive` gets a short escalating cooldown rather than the 24-hour structural one.
- **The search agent is the same agent as the edit agent.** Enabling `websearch`/`webfetch` puts attacker-controllable text in front of an agent that also has `bash` and `edit`. Mitigated, not eliminated — see [the web-access tradeoff](#the-web-access-tradeoff-read-this-before-rolling-it-out) for what actually stops what, and for the two-agent split if you need the stronger guarantee.
- **The editor hook only sees named read tools.** It checks file size before a read, which is the one thing it can know in advance with no false positives. It does not catch a large `Bash`/`shell` read (`cat`, `sed`), a grep over a huge tree, or a sweep of many small files — those need heuristics or session state the hook doesn't have. This matters most on Codex, which routes most file reads through `shell`.
- **Ladder position doesn't persist across separate CLI invocations.** If a `cont` resumes a session that had already fallen back to an L2 alternate model, and that `cont` itself needs to retry, it re-walks the L2 list from the start rather than remembering which alternates were already tried. `MAX_ROUNDS` bounds the resulting damage, and this got much less frequent once the evidence gate stopped over-triggering on `analyze` tasks. See the doc comment on `runWithLadder` in [`src/ladder.ts`](src/ladder.ts).
