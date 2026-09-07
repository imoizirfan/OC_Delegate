#!/usr/bin/env bun
// Model-selection tests. These are pure/offline by design — they exercise the
// parsing, filtering, ranking, variant, health and routing logic against
// fixtures captured from real `opencode models --verbose` output and real
// error strings, so the suite stays deterministic and fast. Live probing is
// covered separately by `ocd models --probe`.
//
// State is redirected to a temp dir before anything imports config.ts, since
// config reads OCD_STATE_DIR at module load.

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const TMP = mkdtempSync(join(tmpdir(), "ocd-models-test-"));
process.env.OCD_STATE_DIR = TMP;
process.env.OCD_MODEL = "";
process.env.OCD_MODEL_PREFER = "";

const {
  parseVerboseModels,
  isFreeByCost,
  normalizeModel,
  pickVariant,
  scoreModel,
  rankModels,
  classifyFailure,
  cooldownFor,
  isBenched,
  recordModelResult,
  loadHealth,
  readModelPref,
  writeModelPref,
  resolvePin,
  resolvePrefer,
} = await import("../src/models.ts");
const { nextLadderStep, chainFromIds } = await import("../src/ladder.ts");
const { COOLDOWN_MS, MAX_ALT_MODELS } = await import("../src/config.ts");

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

// --- fixtures --------------------------------------------------------------
// Shapes copied verbatim from real `opencode models opencode --verbose`.

function modelJson(over: Record<string, unknown> = {}): string {
  const base = {
    id: "example-free",
    providerID: "opencode",
    name: "Example",
    family: "example",
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 32000 },
    capabilities: { reasoning: true, toolcall: true },
    release_date: "2026-01-01",
    variants: {},
    ...over,
  };
  return `opencode/${base.id}\n${JSON.stringify(base, null, 2)}\n`;
}

console.log("=== parsing ===");

{
  const doc = modelJson({ id: "a" }) + modelJson({ id: "b" }) + modelJson({ id: "c" });
  const { models, malformed } = parseVerboseModels(doc);
  eq("parse:three_blocks", models.length, 3);
  eq("parse:no_malformed", malformed, 0);
}

{
  // A brace inside a string value must not desynchronize the block scanner.
  const doc = modelJson({ id: "brace", name: 'weird {not a block} name' }) + modelJson({ id: "after" });
  const { models } = parseVerboseModels(doc);
  eq("parse:brace_in_string", models.length, 2);
  eq("parse:brace_in_string_second_id", (models[1] as any).id, "after");
}

{
  // An escaped quote must not terminate string tracking early.
  const doc = modelJson({ id: "esc", name: 'quote \\" here {x}' }) + modelJson({ id: "after2" });
  const { models } = parseVerboseModels(doc);
  eq("parse:escaped_quote", models.length, 2);
}

{
  // One corrupt block must be skipped, not abort the whole list.
  const doc = modelJson({ id: "good1" }) + "opencode/bad\n{ this is not json }\n" + modelJson({ id: "good2" });
  const { models, malformed } = parseVerboseModels(doc);
  eq("parse:tolerates_malformed_count", models.length, 2);
  check("parse:counts_malformed", malformed >= 1, `malformed=${malformed}`);
}

eq("parse:empty_input", parseVerboseModels("").models.length, 0);

console.log("\n=== free-by-cost (never by name) ===");

check("free:all_zero", isFreeByCost(JSON.parse(JSON.stringify({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }))));
check("free:paid_input", !isFreeByCost({ cost: { input: 3, output: 0 } }));
check("free:paid_output", !isFreeByCost({ cost: { input: 0, output: 15 } }));
check("free:paid_cache_read", !isFreeByCost({ cost: { input: 0, output: 0, cache: { read: 1, write: 0 } } }));
// Conservative: unknown price must never be assumed free.
check("free:missing_cost_is_paid", !isFreeByCost({}));
check("free:partial_cost_is_paid", !isFreeByCost({ cost: { input: 0 } }));

{
  // The two real cases that make name-matching wrong in BOTH directions:
  // `big-pickle` is free without a `-free` suffix; a hypothetical renamed
  // model could carry `-free` while being priced.
  const { models } = parseVerboseModels(
    modelJson({ id: "big-pickle", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }) +
      modelJson({ id: "trap-free", cost: { input: 5, output: 10, cache: { read: 0, write: 0 } } }),
  );
  const free = models.filter((m) => isFreeByCost(m as any)).map((m) => (m as any).id);
  eq("free:includes_unsuffixed_zero_cost", free.includes("big-pickle"), true);
  eq("free:excludes_priced_free_named", free.includes("trap-free"), false);
}

console.log("\n=== normalize ===");

{
  const { models } = parseVerboseModels(
    modelJson({ id: "v", variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} } }),
  );
  const m = normalizeModel(models[0] as any)!;
  eq("normalize:qualified_id", m.id, "opencode/v");
  eq("normalize:context", m.contextLimit, 200000);
  eq("normalize:toolcall", m.toolcall, true);
  eq("normalize:variants", m.variants.length, 5);
}

{
  const { models } = parseVerboseModels(modelJson({ id: "notool", capabilities: { toolcall: false } }));
  const m = normalizeModel(models[0] as any)!;
  eq("normalize:toolcall_false", m.toolcall, false);
}

eq("normalize:rejects_idless", normalizeModel({ providerID: "opencode" }), null);

console.log("\n=== variant selection ===");

function mk(over: Partial<any> = {}): any {
  return {
    id: "opencode/x",
    name: "x",
    family: "x",
    status: "active",
    contextLimit: 200000,
    outputLimit: 32000,
    releaseDate: "2026-01-01",
    reasoning: true,
    toolcall: true,
    variants: [],
    ...over,
  };
}

eq("variant:none_when_unsupported", pickVariant(mk({ variants: [] })), undefined);
eq("variant:picks_xhigh", pickVariant(mk({ variants: ["minimal", "low", "medium", "high", "xhigh"] })), "xhigh");
eq("variant:picks_high_when_no_xhigh", pickVariant(mk({ variants: ["low", "medium", "high"] })), "high");
eq("variant:picks_low_when_only_low", pickVariant(mk({ variants: ["low"] })), "low");
// Regression: the old code sent a hardcoded "max" to every model, a value no
// model in the live lineup publishes.
eq("variant:never_invents_max", pickVariant(mk({ variants: ["low", "high"] })) === "max", false);
eq("variant:honours_real_max", pickVariant(mk({ variants: ["low", "max"] })), "max");

console.log("\n=== ranking ===");

{
  const big = mk({ id: "opencode/big", contextLimit: 1_000_000 });
  const small = mk({ id: "opencode/small", contextLimit: 100_000 });
  check("rank:bigger_context_scores_higher", scoreModel(big).score > scoreModel(small).score);
}

{
  const now = Date.parse("2026-08-31");
  const fresh = mk({ id: "opencode/fresh", releaseDate: "2026-08-01" });
  const old = mk({ id: "opencode/old", releaseDate: "2024-01-01" });
  check("rank:newer_scores_higher", scoreModel(fresh, now).score > scoreModel(old, now).score);
}

{
  const now = Date.now();
  const a = mk({ id: "opencode/a", contextLimit: 1_000_000 });
  const b = mk({ id: "opencode/b", contextLimit: 200_000 });
  const health = {
    version: 1 as const,
    models: {
      // `a` would rank first on metadata alone, but it is benched.
      "opencode/a": { ok: false, kind: "disabled" as const, at: now, consecutiveFailures: 1 },
    },
  };
  const ranked = rankModels([a, b], health, now);
  eq("rank:benched_sinks_below_healthy", ranked[0]!.model.id, "opencode/b");
  eq("rank:benched_still_present", ranked.length, 2);
  eq("rank:benched_flagged", ranked[1]!.benched, true);
}

{
  // All-benched must still yield a non-empty chain, so the ladder has
  // something to attempt and can escalate with a real error.
  const now = Date.now();
  const a = mk({ id: "opencode/a" });
  const health = {
    version: 1 as const,
    models: { "opencode/a": { ok: false, kind: "geo" as const, at: now, consecutiveFailures: 1 } },
  };
  eq("rank:all_benched_not_empty", rankModels([a], health, now).length, 1);
}

{
  // The preference list is documented as highest-priority-first, so an
  // earlier entry must outrank a later one — and any preference must outrank
  // a model that merely scores well on metadata. This used to be untestable
  // (the list was read from module state at import time, so it could not be
  // varied mid-process); scoreModel now takes it as a parameter, which is
  // what makes these three assertions possible at all.
  const first = mk({ id: "opencode/alpha", contextLimit: 100_000 });
  const second = mk({ id: "opencode/beta", contextLimit: 100_000 });
  const unlisted = mk({ id: "opencode/gamma", contextLimit: 1_000_000 });
  const now = Date.now();

  check("rank:no_prefer_means_metadata_decides", scoreModel(unlisted, now, []).score > scoreModel(first, now, []).score);
  eq("rank:equal_models_score_equal", scoreModel(first, now, []).score, scoreModel(second, now, []).score);

  const prefer = ["alpha", "beta"];
  check(
    "rank:prefer_beats_bigger_context",
    scoreModel(first, now, prefer).score > scoreModel(unlisted, now, prefer).score,
  );
  check(
    "rank:earlier_prefer_entry_outranks_later",
    scoreModel(first, now, prefer).score > scoreModel(second, now, prefer).score,
  );
  // Only the first matching entry may score — otherwise a model whose id
  // happens to contain two listed substrings would stack bonuses and jump
  // the queue ahead of the model the user actually listed first.
  const both = mk({ id: "opencode/alpha-beta", contextLimit: 100_000 });
  eq(
    "rank:prefer_bonus_does_not_stack",
    scoreModel(both, now, prefer).score,
    scoreModel(first, now, prefer).score,
  );
}

console.log("\n=== persisted model override (ocd models --pin/--prefer) ===");

{
  // Env must beat the file: a one-off `OCD_MODEL=x ocd run ...` has to
  // override a saved setting without the user unsetting it first. The suite
  // sets both env vars to "" at the top, so the file layer is what's live.
  eq("pref:empty_by_default", JSON.stringify(readModelPref()), JSON.stringify({ version: 1 }));
  eq("pref:no_pin_by_default", resolvePin(), null);
  eq("pref:no_prefer_by_default", resolvePrefer(), null);

  writeModelPref({ version: 1, pin: "opencode/pinned-x", prefer: ["aa", "bb"] });
  eq("pref:pin_round_trips", resolvePin()?.id, "opencode/pinned-x");
  eq("pref:pin_reports_file_source", resolvePin()?.from, "file");
  eq("pref:prefer_round_trips", JSON.stringify(resolvePrefer()?.list), JSON.stringify(["aa", "bb"]));

  // Empty fields are dropped rather than persisted as "" / [], so an unpin
  // leaves a file that reads as "no override" instead of "override to
  // nothing" — which resolution would otherwise have to special-case.
  writeModelPref({ version: 1, pin: "", prefer: [] });
  eq("pref:unpin_clears_pin", resolvePin(), null);
  eq("pref:unpin_clears_prefer", resolvePrefer(), null);
  eq("pref:unpin_leaves_clean_file", JSON.stringify(readModelPref()), JSON.stringify({ version: 1 }));

  // A corrupt override file must never break dispatch — the whole point of
  // the tool is that it degrades to "discover a model" rather than throwing.
  writeFileSync(join(TMP, "model-pref.json"), "{ not json");
  eq("pref:corrupt_file_is_ignored", resolvePin(), null);
  writeModelPref({ version: 1 });
}

console.log("\n=== failure classification (ground-truthed strings) ===");

eq("classify:disabled", classifyFailure("Error: Model is disabled"), "disabled");
eq("classify:geo", classifyFailure("Error: This model is not available in your country."), "geo");
eq("classify:missing", classifyFailure("model not found: opencode/gone"), "missing");
eq("classify:auth_401", classifyFailure("HTTP 401 Unauthorized"), "auth");
eq("classify:rate_limit_429", classifyFailure("429 too many requests"), "rate_limit");
eq("classify:unknown_is_error", classifyFailure("something odd happened"), "error");

console.log("\n=== cooldowns ===");

eq("cooldown:auth_never_benches", cooldownFor("auth", 3), 0);
eq("cooldown:disabled_structural", cooldownFor("disabled", 1), COOLDOWN_MS.structural);
eq("cooldown:geo_structural", cooldownFor("geo", 1), COOLDOWN_MS.structural);
eq("cooldown:missing_structural", cooldownFor("missing", 1), COOLDOWN_MS.structural);
eq("cooldown:first_transient", cooldownFor("error", 1), COOLDOWN_MS.first);
eq("cooldown:escalates", cooldownFor("error", 2), COOLDOWN_MS.second);
check("cooldown:caps", cooldownFor("error", 99) === COOLDOWN_MS.third);

{
  const now = 1_000_000_000_000;
  check("benched:ok_never_benched", !isBenched({ ok: true, at: now, consecutiveFailures: 0 }, now));
  check("benched:undefined_not_benched", !isBenched(undefined, now));
  check(
    "benched:within_cooldown",
    isBenched({ ok: false, kind: "error", at: now, consecutiveFailures: 1 }, now + 60_000),
  );
  check(
    "benched:expires_after_cooldown",
    !isBenched({ ok: false, kind: "error", at: now, consecutiveFailures: 1 }, now + COOLDOWN_MS.first + 1),
  );
  check(
    "benched:auth_never",
    !isBenched({ ok: false, kind: "auth", at: now, consecutiveFailures: 1 }, now + 1),
  );
}

console.log("\n=== health persistence ===");

{
  recordModelResult("opencode/testmodel", false, "Model is disabled");
  let h = loadHealth();
  eq("health:records_failure", h.models["opencode/testmodel"]?.ok, false);
  eq("health:classifies_on_record", h.models["opencode/testmodel"]?.kind, "disabled");

  recordModelResult("opencode/testmodel", false, "Model is disabled");
  h = loadHealth();
  eq("health:increments_consecutive", h.models["opencode/testmodel"]?.consecutiveFailures, 2);

  recordModelResult("opencode/testmodel", true);
  h = loadHealth();
  eq("health:success_clears", h.models["opencode/testmodel"]?.ok, true);
  eq("health:success_resets_count", h.models["opencode/testmodel"]?.consecutiveFailures, 0);

  // An auth failure is global, not the model's fault — it must not bench.
  recordModelResult("opencode/authcase", false, "401 Unauthorized");
  h = loadHealth();
  eq("health:auth_not_recorded_against_model", h.models["opencode/authcase"], undefined);

  check("health:file_written", existsSync(join(TMP, "model-health.json")));
}

console.log("\n=== ladder routing over a dynamic chain ===");

const chain3 = chainFromIds(["m0", "m1", "m2"]);
const chain1 = chainFromIds(["only"]);

{
  // Worst-case latency must stay bounded now that the lineup size is
  // discovered rather than fixed: the rung counter stays at 2 while walking
  // alternates, so an unbounded list would mean N sequential dispatches.
  const many = chainFromIds(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  eq("ladder:caps_alternates", many.alternates.length, MAX_ALT_MODELS);
  eq("ladder:cap_keeps_best_first", many.alternates[0], "m1");
  eq("ladder:cap_zero_leaves_none", chainFromIds(["m0", "m1"], 0).alternates.length, 0);
  eq("ladder:empty_ids_yield_empty_primary", chainFromIds([]).primary, "");
}

{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "unverified", null, chain3);
  eq("ladder:rung0_sharpens_on_primary", [d.action, d.model], ["retry", "m0"]);
}
{
  // A `cont` resuming a session that had already fallen back to an alternate
  // must sharpen-retry on THAT model. Snapping back to the top-ranked model
  // would switch backends and silently discard the session the retry exists
  // to preserve.
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "unverified", null, chain3, "m2");
  eq("ladder:sharpen_stays_on_current_model", [d.action, d.model], ["retry", "m2"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "stalled", null, chain3, "m2");
  eq("ladder:timeout_retry_stays_on_current_model", [d.action, d.model], ["retry", "m2"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "error", null, chain3, "m2");
  eq("ladder:crash_retry_stays_on_current_model", [d.action, d.model], ["retry", "m2"]);
}
{
  const d = nextLadderStep({ rung: 1, l2Index: 0 }, "unverified", null, chain3);
  eq("ladder:rung1_switches_to_first_alt", [d.action, d.model], ["retry", "m1"]);
}
{
  const d = nextLadderStep({ rung: 2, l2Index: 1 }, "unverified", null, chain3);
  eq("ladder:walks_to_second_alt", [d.action, d.model], ["retry", "m2"]);
}
{
  const d = nextLadderStep({ rung: 2, l2Index: 2 }, "unverified", null, chain3);
  eq("ladder:exhausts_alternates", [d.action, d.reason], ["escalate", "exhausted_free_models"]);
}
{
  // A single-model lineup must escalate rather than loop on the only model.
  const d = nextLadderStep({ rung: 1, l2Index: 0 }, "unverified", null, chain1);
  eq("ladder:single_model_escalates", [d.action, d.reason], ["escalate", "exhausted_free_models"]);
}
{
  // Regression for the hanging-model case: a repeated stall must move to a
  // DIFFERENT model, not escalate straight to Claude.
  const d = nextLadderStep({ rung: 1, l2Index: 0 }, "stalled", null, chain3);
  eq("ladder:repeat_stall_switches_model", [d.action, d.model, d.reason], ["retry", "m1", "alt_model_after_timeout"]);
}
{
  // Regression for the disabled/geo-blocked case: an error on the retry must
  // reach a different model, since the same one is guaranteed to fail again.
  const d = nextLadderStep({ rung: 1, l2Index: 0 }, "error", null, chain3);
  eq("ladder:repeat_error_switches_model", [d.action, d.model, d.reason], ["retry", "m1", "alt_model_after_crash"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "error", "rate_limit", chain3);
  eq("ladder:rate_limit_switches_model", [d.action, d.model], ["retry", "m1"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "error", "rate_limit", chain1);
  eq("ladder:rate_limit_no_alternates_escalates", [d.action, d.reason], ["escalate", "rate_limited_no_alternates"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "blocked", null, chain3);
  eq("ladder:blocked_never_retries", [d.action, d.reason], ["escalate", "blocked_no_retry"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "error", "auth", chain3);
  eq("ladder:auth_escalates_immediately", [d.action, d.reason], ["escalate", "auth_error"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "ok", null, chain3);
  eq("ladder:ok_accepts", d.action, "accept");
}
{
  // Back-compat: callers that omit the chain still route correctly.
  const d = nextLadderStep({ rung: 1, l2Index: 0 }, "error", null);
  eq("ladder:no_chain_escalates", [d.action, d.reason], ["escalate", "crash_after_retry"]);
}

console.log("\n=== dead-model detection (the `empty` trap) ===");

{
  const { detectErrorHint } = await import("../src/ladder.ts");
  const base = {
    rawStatus: "completed" as const,
    exitCode: 0,
    sessionId: null,
    textParts: [] as string[],
    toolUses: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    durationMs: 0,
    malformedLines: 0,
  };

  // The exact shape of a geo-blocked model: opencode exits 0, emits no text
  // part (so status is `empty`, not `error`), and puts the reason on stderr.
  eq(
    "dead:geo_detected_from_stderr",
    detectErrorHint({ ...base, stderrTail: "Error: This model is not available in your country." } as any),
    "model_dead",
  );
  eq(
    "dead:disabled_detected_from_stderr",
    detectErrorHint({ ...base, stderrTail: "Error: Model is disabled" } as any),
    "model_dead",
  );

  // False-positive guard: a delegated task that summarizes an ML error log
  // must not bench a healthy model just because its OUTPUT says so.
  eq(
    "dead:ignores_model_own_text",
    detectErrorHint({
      ...base,
      stderrTail: "",
      textParts: ["The log shows: model not found — this model is disabled in prod."],
    } as any),
    null,
  );

  // Auth outranks a dead-model signature, since it is a global problem.
  eq(
    "dead:auth_wins_over_model_dead",
    detectErrorHint({ ...base, stderrTail: "401 Unauthorized: Model is disabled" } as any),
    "auth",
  );

  eq("dead:clean_run_has_no_hint", detectErrorHint({ ...base, stderrTail: "" } as any), null);

  // --- the structured-error path -------------------------------------------
  // Under `--format json` opencode reports provider failures as an NDJSON
  // error event on STDOUT, leaving stderr empty. Captured verbatim from a
  // real run against a disabled model.
  eq(
    "apierr:disabled_detected_with_empty_stderr",
    detectErrorHint({
      ...base,
      stderrTail: "",
      apiError: { message: "Model is disabled", statusCode: 401, isRetryable: false },
    } as any),
    "model_dead",
  );

  // The trap: that event carries statusCode 401 even though nothing is wrong
  // with the credentials. Classifying it as `auth` would escalate to Claude
  // instead of switching models — the exact opposite of the right move.
  eq(
    "apierr:401_on_disabled_is_not_auth",
    detectErrorHint({
      ...base,
      stderrTail: "",
      apiError: { message: "Model is disabled", statusCode: 401 },
    } as any) === "auth",
    false,
  );

  // A genuine auth failure still classifies as auth.
  eq(
    "apierr:real_auth_still_auth",
    detectErrorHint({
      ...base,
      stderrTail: "",
      apiError: { message: "Unauthorized: invalid api key", statusCode: 401 },
    } as any),
    "auth",
  );

  eq(
    "apierr:rate_limit_detected",
    detectErrorHint({
      ...base,
      stderrTail: "",
      apiError: { message: "Rate limit exceeded", statusCode: 429 },
    } as any),
    "rate_limit",
  );
}

{
  const { classifyStatus } = await import("../src/ladder.ts");
  const base = {
    rawStatus: "completed" as const,
    exitCode: 1,
    sessionId: null,
    textParts: [] as string[],
    toolUses: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    durationMs: 0,
    stderrTail: "",
    malformedLines: 0,
    apiError: null,
  };
  const gate = { warnings: [], evidence: { tool_calls: 0, tools: [], files_seen: [] } } as any;

  // Without the api-error field this case reads as `empty`, which routes into
  // a same-model retry that is guaranteed to fail again.
  eq(
    "apierr:status_is_error_not_empty",
    classifyStatus({ ...base, apiError: { message: "Model is disabled", statusCode: 401 } } as any, gate).status,
    "error",
  );
  eq("apierr:genuinely_empty_still_empty", classifyStatus(base as any, gate).status, "empty");
  eq(
    "apierr:text_present_is_ok",
    classifyStatus({ ...base, textParts: ["hi"] } as any, gate).status,
    "ok",
  );
}

{
  // A dead model must skip the same-model retry entirely — retrying it is
  // provably useless — and go straight to an alternate.
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "empty", "model_dead", chain3);
  eq("dead:skips_same_model_retry", [d.action, d.model, d.reason], ["retry", "m1", "model_dead_alt_model"]);
}
{
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "empty", "model_dead", chain1);
  eq("dead:no_alternates_escalates", [d.action, d.reason], ["escalate", "model_dead_no_alternates"]);
}
{
  // Without the dead-model hint, `empty` still gets its normal sharpen-retry
  // on the same model (a bad prompt deserves a second try; a dead model does not).
  const d = nextLadderStep({ rung: 0, l2Index: 0 }, "empty", null, chain3);
  eq("dead:plain_empty_still_retries_same_model", [d.action, d.model], ["retry", "m0"]);
}

console.log("\n=== no hardcoded model ids anywhere in the repo ===");

{
  // The guarantee this whole change exists to provide. A literal
  // `provider/model` id anywhere shippable is a future outage: the previous
  // lineup was written down once and three of its four entries were dead
  // within weeks.
  //
  // This originally scanned only src/*.ts, and that gap was a real bug —
  // config/agent.ocd-delegate.jsonc went on pinning a delisted model for
  // weeks while this test reported green, because the installed opencode
  // agent is just as much a place an id can rot as the TypeScript is. The
  // scan now covers every file the installer actually ships. Test fixtures
  // (this file, test/smoke.ts) and the OCD_MODEL pin escape hatch are
  // exempt by construction: neither is in the scanned set.
  const repoRoot = join(import.meta.dir, "..");
  const scanned: string[] = [];
  const offenders: string[] = [];
  // Matches a quoted "opencode/<something>" style provider-qualified id.
  const idPattern = /["'`](opencode|anthropic|openai|google|deepseek)\/[a-z0-9][a-z0-9.\-]*["'`]/gi;

  const targets: { dir: string; keep: (f: string) => boolean }[] = [
    { dir: "src", keep: (f) => f.endsWith(".ts") },
    { dir: "config", keep: (f) => f.endsWith(".jsonc") || f.endsWith(".json") },
    { dir: "install", keep: (f) => f.endsWith(".ts") },
    { dir: "bin", keep: () => true },
  ];

  const files: string[] = ["package.json", "install.sh"];
  for (const t of targets) {
    for (const f of readdirSync(join(repoRoot, t.dir))) {
      if (t.keep(f)) files.push(join(t.dir, f));
    }
  }

  for (const rel of files) {
    const body = readFileSync(join(repoRoot, rel), "utf8");
    scanned.push(rel);
    // Strip comments — documenting a dead id in prose is fine and useful,
    // and both the jsonc agent fragment and the .ts sources do exactly that.
    // `#` covers the shell scripts in bin/ and install.sh.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*#.*$/gm, "");
    const hits = code.match(idPattern);
    if (hits) offenders.push(`${rel}: ${hits.join(", ")}`);
  }

  check(
    "source:no_hardcoded_model_ids",
    offenders.length === 0,
    offenders.length ? offenders.join(" | ") : `none across ${scanned.length} shipped files`,
  );
}

// --- summary ---------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
