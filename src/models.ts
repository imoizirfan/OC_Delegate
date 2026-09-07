import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  OPENCODE_BIN,
  STATE_DIR,
  MODEL_PROVIDER,
  MODEL_PIN_ENV,
  MODEL_PREFER_ENV,
  MODEL_PREF_PATH,
  MODELS_CACHE_PATH,
  MODEL_HEALTH_PATH,
  MODELS_CACHE_TTL_MS,
  COOLDOWN_MS,
} from "./config.ts";

/** Local mkdir rather than registry.ts's ensureStateDirs, purely to keep
 * models.ts free of any dependency on the registry (which the ladder already
 * pulls in) — model resolution must stay usable from `ocd doctor` and
 * `ocd models` without touching session state. */
function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** A single candidate model, normalized from `opencode models --verbose`. */
export interface ModelInfo {
  /** Provider-qualified, e.g. `<provider>/<model>`. Intentionally not
   * illustrated with a real id — every concrete id in this codebase has a
   * short shelf life, and test/models.test.ts fails the build if one appears
   * in src/. */
  id: string;
  name: string;
  family: string;
  status: string;
  contextLimit: number;
  outputLimit: number;
  releaseDate: string;
  reasoning: boolean;
  toolcall: boolean;
  variants: string[];
}

export type FailureKind =
  | "disabled" // provider says the model is turned off
  | "missing" // model no longer exists
  | "geo" // not licensed in this region
  | "auth" // global credential problem, NOT the model's fault
  | "rate_limit" // transient capacity
  | "unresponsive" // hung / stalled / timed out
  | "error"; // anything else

export interface HealthEntry {
  ok: boolean;
  kind?: FailureKind;
  detail?: string;
  at: number;
  consecutiveFailures: number;
}

export interface HealthFile {
  version: 1;
  models: Record<string, HealthEntry>;
}

// --- verbose-output parsing -----------------------------------------------

/** `opencode models <provider> --verbose` emits a bare `provider/id` line
 * followed by a pretty-printed JSON object, repeated. There is no JSON-array
 * mode, so the blocks have to be sliced apart by brace depth. Depth counting
 * is string-aware because a future field value containing a brace would
 * otherwise desynchronize the whole scan. Blocks that still fail to parse are
 * skipped and counted rather than throwing — same tolerant-parser stance as
 * the NDJSON reader in dispatch.ts, so one malformed entry can't take the
 * whole model list down. */
export function parseVerboseModels(stdout: string): { models: unknown[]; malformed: number } {
  const models: unknown[] = [];
  let malformed = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = stdout.slice(start, i + 1);
        try {
          models.push(JSON.parse(block));
        } catch {
          malformed++;
        }
        start = -1;
      } else if (depth < 0) {
        // Stray closer — resynchronize rather than going negative forever.
        depth = 0;
        start = -1;
      }
    }
  }
  return { models, malformed };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** True only when every published price is exactly zero.
 *
 * Deliberately conservative: a model with a missing or partial `cost` block
 * is treated as PAID. `ocd`'s entire premise is that delegated work costs
 * nothing, so an unknown price must never be assumed free — the failure mode
 * of guessing wrong is spending real money silently.
 *
 * Note this is a price check, not a name check. `opencode/big-pickle` is
 * priced at zero without carrying a `-free` suffix, and conversely a
 * `-free` name is just a naming convention the provider is free to break.
 * Matching on the name would be wrong in both directions. */
export function isFreeByCost(raw: Record<string, unknown>): boolean {
  const cost = raw["cost"];
  if (!cost || typeof cost !== "object") return false;
  const c = cost as Record<string, unknown>;
  if (typeof c["input"] !== "number" || typeof c["output"] !== "number") return false;
  if (c["input"] !== 0 || c["output"] !== 0) return false;
  const cache = c["cache"];
  if (cache && typeof cache === "object") {
    const cc = cache as Record<string, unknown>;
    for (const k of ["read", "write"]) {
      if (typeof cc[k] === "number" && cc[k] !== 0) return false;
    }
  }
  return true;
}

export function normalizeModel(raw: Record<string, unknown>): ModelInfo | null {
  const id = typeof raw["id"] === "string" ? raw["id"] : null;
  const providerID = typeof raw["providerID"] === "string" ? raw["providerID"] : null;
  if (!id || !providerID) return null;

  const caps = (raw["capabilities"] ?? {}) as Record<string, unknown>;
  const limit = (raw["limit"] ?? {}) as Record<string, unknown>;
  const variants = raw["variants"];

  return {
    id: `${providerID}/${id}`,
    name: typeof raw["name"] === "string" ? raw["name"] : id,
    family: typeof raw["family"] === "string" ? raw["family"] : id,
    status: typeof raw["status"] === "string" ? raw["status"] : "unknown",
    contextLimit: num(limit["context"]),
    outputLimit: num(limit["output"]),
    releaseDate: typeof raw["release_date"] === "string" ? raw["release_date"] : "",
    reasoning: caps["reasoning"] === true,
    toolcall: caps["toolcall"] === true,
    variants: variants && typeof variants === "object" ? Object.keys(variants as object) : [],
  };
}

// --- discovery -------------------------------------------------------------

export interface DiscoveryResult {
  models: ModelInfo[];
  warnings: string[];
  /** Where the list came from, for `ocd models` / doctor output. */
  source: "live" | "cache";
  fetchedAt: number;
}

async function runOpencodeModels(refresh: boolean): Promise<{ stdout: string; code: number; stderr: string }> {
  const args = ["models"];
  if (MODEL_PROVIDER) args.push(MODEL_PROVIDER);
  args.push("--verbose");
  if (refresh) args.push("--refresh");
  const proc = Bun.spawn({ cmd: [OPENCODE_BIN, ...args], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

/** Every zero-cost, tool-calling, active model the installed opencode knows
 * about right now. Nothing here is hardcoded — the set is whatever the
 * provider currently publishes, so models appearing or disappearing between
 * weeks needs no code change. */
export async function discoverFreeModels(refresh = false): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const { stdout, stderr, code } = await runOpencodeModels(refresh);

  if (code !== 0) {
    warnings.push(`opencode models exited ${code}: ${stderr.trim().slice(0, 200)}`);
  }

  const { models: rawList, malformed } = parseVerboseModels(stdout);
  if (malformed > 0) warnings.push(`${malformed} model entr${malformed === 1 ? "y" : "ies"} failed to parse`);

  const free: ModelInfo[] = [];
  let skippedPaid = 0;
  let skippedNoTool = 0;
  let skippedInactive = 0;

  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (!isFreeByCost(rec)) {
      skippedPaid++;
      continue;
    }
    const m = normalizeModel(rec);
    if (!m) continue;
    // A model that cannot call tools is useless to ocd specifically: the
    // evidence gate proves work happened by counting real tool calls, so a
    // text-only model would be permanently `unverified`.
    if (!m.toolcall) {
      skippedNoTool++;
      continue;
    }
    if (m.status !== "active") {
      skippedInactive++;
      continue;
    }
    free.push(m);
  }

  if (free.length === 0) {
    warnings.push(
      `no free tool-calling models found (${rawList.length} listed, ${skippedPaid} paid, ` +
        `${skippedNoTool} without toolcall, ${skippedInactive} inactive)`,
    );
  }

  return { models: free, warnings, source: "live", fetchedAt: Date.now() };
}

// --- cache -----------------------------------------------------------------

interface ModelsCacheFile {
  version: 1;
  fetchedAt: number;
  models: ModelInfo[];
}

function readModelsCache(): ModelsCacheFile | null {
  try {
    if (!existsSync(MODELS_CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCacheFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeModelsCache(models: ModelInfo[], fetchedAt: number): void {
  try {
    ensureStateDir();
    writeFileSync(MODELS_CACHE_PATH, JSON.stringify({ version: 1, fetchedAt, models } satisfies ModelsCacheFile, null, 2));
  } catch {
    // A read-only state dir shouldn't break dispatch; we just re-discover.
  }
}

// --- persisted model override ----------------------------------------------

/** Shape of MODEL_PREF_PATH. Both fields optional: a user may pin without
 * expressing a preference order, or vice versa. */
export interface ModelPrefFile {
  version: 1;
  /** Exact model id to force, bypassing discovery and health routing. */
  pin?: string;
  /** Substrings biasing ranking, highest priority first. */
  prefer?: string[];
}

export function readModelPref(): ModelPrefFile {
  try {
    if (existsSync(MODEL_PREF_PATH)) {
      const parsed = JSON.parse(readFileSync(MODEL_PREF_PATH, "utf8")) as ModelPrefFile;
      if (parsed?.version === 1) return parsed;
    }
  } catch {
    /* a corrupt override file must not break dispatch — fall through to discovery */
  }
  return { version: 1 };
}

export function writeModelPref(pref: ModelPrefFile): void {
  ensureStateDir();
  // Drop empty fields rather than persisting `"pin": ""`, so `--unpin`
  // leaves a file that reads as "no override" instead of "override to
  // nothing", which the resolution below would have to special-case.
  const out: ModelPrefFile = { version: 1 };
  if (pref.pin) out.pin = pref.pin;
  if (pref.prefer?.length) out.prefer = pref.prefer;
  writeFileSync(MODEL_PREF_PATH, JSON.stringify(out, null, 2) + "\n");
}

export type OverrideSource = "env" | "file";

/** The pin actually in effect, and where it came from.
 *
 * Env beats file so a one-off `OCD_MODEL=x ocd run ...` overrides a saved
 * setting without the user having to unset it first. Reporting the source
 * matters: "pinned" and "pinned by something you configured three weeks ago
 * in another shell" are very different things to debug. */
export function resolvePin(): { id: string; from: OverrideSource } | null {
  if (MODEL_PIN_ENV) return { id: MODEL_PIN_ENV, from: "env" };
  const file = readModelPref();
  if (file.pin) return { id: file.pin, from: "file" };
  return null;
}

/** The preference list actually in effect. Same env-over-file precedence;
 * the two are NOT concatenated, since a merged list would give a user no way
 * to temporarily override a saved preference at all. */
export function resolvePrefer(): { list: string[]; from: OverrideSource } | null {
  if (MODEL_PREFER_ENV.length) return { list: MODEL_PREFER_ENV, from: "env" };
  const file = readModelPref();
  if (file.prefer?.length) return { list: file.prefer, from: "file" };
  return null;
}

// --- health ----------------------------------------------------------------

export function loadHealth(): HealthFile {
  try {
    if (existsSync(MODEL_HEALTH_PATH)) {
      const parsed = JSON.parse(readFileSync(MODEL_HEALTH_PATH, "utf8")) as HealthFile;
      if (parsed?.version === 1 && parsed.models) return parsed;
    }
  } catch {
    /* fall through to empty */
  }
  return { version: 1, models: {} };
}

function saveHealth(h: HealthFile): void {
  try {
    ensureStateDir();
    writeFileSync(MODEL_HEALTH_PATH, JSON.stringify(h, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** Map a failure to a kind.
 *
 * Every pattern here except `rate_limit` was ground-truthed against a real
 * response from a real zero-cost model during testing — these are not
 * guessed signatures:
 *   "Model is disabled"                      -> big-pickle
 *   "This model is not available in your country" -> muse-spark-1.2-contributor-free
 * Both of those models list as `status: active` with `toolcall: true` and a
 * price of zero, which is precisely why static metadata cannot be trusted on
 * its own and this classification has to exist. */
export function classifyFailure(text: string): FailureKind {
  const t = text.toLowerCase();
  if (/not available in your (country|region)|unavailable in your (country|region)|geo.?restricted/.test(t)) return "geo";
  if (/model is disabled|model .*is disabled/.test(t)) return "disabled";
  if (/model not found|unknown model|no such model|unsupported model|invalid model/.test(t)) return "missing";
  if (/\b401\b|unauthorized|authentication (failed|error)|invalid api key|not logged in/.test(t)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|over capacity|quota exceeded/.test(t)) return "rate_limit";
  return "error";
}

/** How long a model stays benched after a failure. Structural failures
 * (disabled/missing/geo) get a long bench because they will not fix
 * themselves within a work session — a geo restriction in particular is a
 * property of where the user is, not a transient blip. Transient failures get
 * a short bench that escalates only if they keep repeating. `auth`
 * deliberately has no cooldown: a bad credential is a global problem, and
 * benching each model as it fails would silently empty the entire candidate
 * list over one expired login. */
export function cooldownFor(kind: FailureKind, consecutiveFailures: number): number {
  if (kind === "auth") return 0;
  if (kind === "disabled" || kind === "missing" || kind === "geo") return COOLDOWN_MS.structural;
  const steps = [COOLDOWN_MS.first, COOLDOWN_MS.second, COOLDOWN_MS.third];
  return steps[Math.min(consecutiveFailures, steps.length) - 1] ?? COOLDOWN_MS.third;
}

export function isBenched(entry: HealthEntry | undefined, now = Date.now()): boolean {
  if (!entry || entry.ok) return false;
  const cd = cooldownFor(entry.kind ?? "error", entry.consecutiveFailures);
  if (cd === 0) return false;
  return now - entry.at < cd;
}

/** Record the outcome of a real dispatch so the next run can route around a
 * model that is currently broken. This is what makes "switch when one stops
 * working" survive across separate `ocd` invocations rather than only within
 * a single ladder walk. */
export function recordModelResult(
  modelId: string,
  ok: boolean,
  detail = "",
  kindOverride?: FailureKind,
): void {
  if (!modelId) return;
  const h = loadHealth();
  const prev = h.models[modelId];
  if (ok) {
    h.models[modelId] = { ok: true, at: Date.now(), consecutiveFailures: 0 };
  } else {
    const kind = kindOverride ?? classifyFailure(detail);
    // An auth failure says nothing about this model, so don't let it
    // accumulate against the model's own failure count.
    if (kind === "auth") {
      saveHealth(h);
      return;
    }
    h.models[modelId] = {
      ok: false,
      kind,
      detail: detail.slice(0, 200),
      at: Date.now(),
      consecutiveFailures: (prev && !prev.ok ? prev.consecutiveFailures : 0) + 1,
    };
  }
  saveHealth(h);
}

// --- active probing --------------------------------------------------------

export interface ProbeOutcome {
  model: string;
  ok: boolean;
  kind?: FailureKind;
  detail: string;
  durationMs: number;
}

/** Send a trivial prompt to one model and record whether it actually answers.
 *
 * This exists because the published metadata demonstrably lies about
 * usability: during testing, three of six zero-cost `status: active`
 * `toolcall: true` models were unusable — one disabled server-side, one
 * geo-restricted, and one that simply never responded. The two highest-ranked
 * models by pure metadata score (largest context windows) were both among the
 * broken ones, so without a live probe the picker would confidently choose a
 * dead model every time.
 *
 * Probes run WITHOUT `--agent` on purpose: the question being answered is
 * "does this model respond at all", and involving the ocd-delegate agent
 * would conflate model health with agent-config problems (and would fail
 * outright before install.sh has ever run). The prompt needs no tools, so
 * agent permissions are irrelevant to the result. */
export async function probeModel(modelId: string, timeoutMs: number): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [OPENCODE_BIN, "run", "--model", modelId, "Reply with exactly the word OK and nothing else."],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (err) {
    const outcome: ProbeOutcome = {
      model: modelId,
      ok: false,
      kind: "error",
      detail: String(err).slice(0, 200),
      durationMs: Date.now() - startedAt,
    };
    recordModelResult(modelId, false, outcome.detail, outcome.kind);
    return outcome;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    await proc.exited;
  } catch {
    /* killed mid-read; fall through with whatever we captured */
  }
  clearTimeout(timer);

  const durationMs = Date.now() - startedAt;

  if (timedOut) {
    const outcome: ProbeOutcome = {
      model: modelId,
      ok: false,
      kind: "unresponsive",
      detail: `no response within ${timeoutMs}ms`,
      durationMs,
    };
    recordModelResult(modelId, false, outcome.detail, outcome.kind);
    return outcome;
  }

  const combined = `${stdout}\n${stderr}`;
  // opencode prints a banner line even on success, so presence of the token
  // is the signal — not exit code, which is unreliable here (it is 0 even for
  // a refused request, the same reason dispatch.ts never trusts it either).
  const ok = /\bOK\b/i.test(stdout) && !/error:/i.test(stderr);

  if (ok) {
    recordModelResult(modelId, true);
    return { model: modelId, ok: true, detail: "responded", durationMs };
  }

  const detail = (stderr.trim() || stdout.trim() || "no output")
    // strip ANSI so the recorded reason stays readable in JSON output
    .replace(/\[[0-9;]*m/g, "")
    .slice(0, 200);
  const kind = classifyFailure(combined);
  recordModelResult(modelId, false, detail, kind);
  return { model: modelId, ok: false, kind, detail, durationMs };
}

/** Probe candidates in rank order, stopping at the first healthy one.
 * Returns every outcome so `ocd models --probe` / `ocd doctor` can show the
 * whole picture, not just the winner. */
export async function probeChain(
  chain: ScoredModel[],
  timeoutMs: number,
  opts: { all?: boolean } = {},
): Promise<{ outcomes: ProbeOutcome[]; healthy: string | null }> {
  const outcomes: ProbeOutcome[] = [];
  let healthy: string | null = null;
  for (const c of chain) {
    const outcome = await probeModel(c.model.id, timeoutMs);
    outcomes.push(outcome);
    if (outcome.ok && !healthy) {
      healthy = outcome.model;
      if (!opts.all) break;
    }
  }
  return { outcomes, healthy };
}

// --- ranking ---------------------------------------------------------------

export interface ScoredModel {
  model: ModelInfo;
  score: number;
  benched: boolean;
  reason: string;
}

/** Score a model for ocd's specific workload.
 *
 * There is no quality field in the provider metadata, so "best" has to be
 * derived from what is actually published. The weights reflect what this tool
 * does rather than generic model quality:
 *
 *  - context window dominates, log-scaled. ocd exists to absorb bulk file
 *    reading and log digestion, so headroom is the single most useful
 *    property; log scaling keeps a 1M-token model ahead of a 200k one without
 *    letting it outrank everything on that axis alone.
 *  - recency is a weak capability proxy, capped so a brand-new but tiny model
 *    can't leapfrog a much larger established one.
 *  - reasoning support is a small bonus; the delegated work is mechanical but
 *    the evidence contract asks for structured output.
 *  - the resolved preference list (OCD_MODEL_PREFER, or `ocd models --prefer`)
 *    contributes a large, explicit, user-controlled bonus. It defaults to
 *    empty, so out of the box nothing is favoured by name. Passed in rather
 *    than read from module state so a caller — and the test suite — can score
 *    against an arbitrary list without re-importing the module. */
export function scoreModel(
  m: ModelInfo,
  now = Date.now(),
  prefer: string[] = resolvePrefer()?.list ?? [],
): { score: number; reason: string } {
  const parts: string[] = [];
  let score = 0;

  const ctx = Math.max(m.contextLimit, 1);
  const ctxScore = Math.log10(ctx) * 10;
  score += ctxScore;
  parts.push(`ctx=${ctx}(+${ctxScore.toFixed(1)})`);

  if (m.releaseDate) {
    const ts = Date.parse(m.releaseDate);
    if (Number.isFinite(ts)) {
      const ageDays = (now - ts) / 86_400_000;
      // Full 12 points at release, decaying to 0 across two years.
      const rec = Math.max(0, 12 * (1 - ageDays / 730));
      score += rec;
      parts.push(`age=${Math.round(ageDays)}d(+${rec.toFixed(1)})`);
    }
  }

  if (m.reasoning) {
    score += 3;
    parts.push("reasoning(+3)");
  }
  if (m.variants.length > 0) {
    score += 2;
    parts.push("variants(+2)");
  }

  // Earlier entries in the preference list outrank later ones, and any listed
  // model outranks any unlisted one. The stride is deliberately far larger
  // than the whole metadata range (which tops out around 80) so the user's
  // stated order is decisive rather than merely a nudge that a slightly
  // larger context window can overturn — an explicit preference is a
  // decision, not a hint. The floor keeps the ordering sane for long lists.
  for (let i = 0; i < prefer.length; i++) {
    const pref = prefer[i]!;
    if (pref && m.id.includes(pref)) {
      const bonus = Math.max(1000 - i * 100, 100);
      score += bonus;
      parts.push(`prefer[${i}]:${pref}(+${bonus})`);
      break;
    }
  }

  return { score, reason: parts.join(" ") };
}

/** Order candidates best-first, sinking (never deleting) benched models.
 *
 * Benched models stay in the list on purpose. If every free model is
 * currently failing, returning an empty chain would make `ocd` fail before it
 * even tries, whereas a fully-benched chain still gets attempted, still
 * produces a real error, and still escalates to Claude with evidence. Sorting
 * rather than filtering keeps the "always have a next thing to try" property
 * without ever preferring a known-broken model over a working one. */
export function rankModels(
  models: ModelInfo[],
  health: HealthFile,
  now = Date.now(),
  prefer: string[] = resolvePrefer()?.list ?? [],
): ScoredModel[] {
  return models
    .map((model) => {
      const { score, reason } = scoreModel(model, now, prefer);
      const benched = isBenched(health.models[model.id], now);
      const entry = health.models[model.id];
      return {
        model,
        score,
        benched,
        reason: benched ? `BENCHED(${entry?.kind ?? "error"}) ${reason}` : reason,
      };
    })
    .sort((a, b) => {
      if (a.benched !== b.benched) return a.benched ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.model.id.localeCompare(b.model.id);
    });
}

// --- variants --------------------------------------------------------------

/** Highest-effort variant a model actually publishes, or undefined when it
 * publishes none.
 *
 * The previous implementation sent a hardcoded `--variant max` to every
 * model. No model currently publishes a `max` variant at all, so that flag
 * was at best ignored and at worst sent an unsupported value to a model that
 * had a perfectly good `high` available. Reading the variant off the model
 * keeps the "run at maximum effort" intent working as names change. */
export function pickVariant(m: ModelInfo): string | undefined {
  const order = ["xhigh", "max", "high", "medium", "low", "minimal"];
  for (const want of order) {
    const hit = m.variants.find((v) => v.toLowerCase() === want);
    if (hit) return hit;
  }
  return m.variants[0];
}

// --- top-level resolution --------------------------------------------------

export interface ModelChain {
  chain: ScoredModel[];
  warnings: string[];
  source: DiscoveryResult["source"];
  fetchedAt: number;
  /** Set when OCD_MODEL pins a specific model, bypassing discovery. */
  pinned: string | null;
}

/** The ordered list of models the ladder should walk, best first.
 *
 * Uses a short-lived on-disk cache so a multi-rung ladder walk doesn't shell
 * out repeatedly, but re-discovers automatically when the cache is stale or
 * when every cached candidate is benched — which is exactly the situation
 * that arises when the provider rotates its free lineup mid-week. */
export async function resolveModelChain(opts: { refresh?: boolean } = {}): Promise<ModelChain> {
  const warnings: string[] = [];

  const pin = resolvePin();
  if (pin) {
    // An explicit pin is an escape hatch: honour it verbatim, no discovery,
    // no health gating, so a user debugging a specific model always gets it.
    // The source is reported because a pin from a file written weeks ago in
    // another shell looks identical, from inside a failing run, to no pin at
    // all — and "why is it using that model" is the question this answers.
    const via = pin.from === "env" ? "OCD_MODEL" : `${MODEL_PREF_PATH} (ocd models --pin)`;
    const pinned: ModelInfo = {
      id: pin.id,
      name: pin.id,
      family: pin.id,
      status: "active",
      contextLimit: 0,
      outputLimit: 0,
      releaseDate: "",
      reasoning: false,
      toolcall: true,
      variants: [],
    };
    return {
      chain: [{ model: pinned, score: 0, benched: false, reason: `pinned via ${via}` }],
      warnings: [`model pinned to ${pin.id} via ${via} — discovery and health routing disabled`],
      source: "live",
      fetchedAt: Date.now(),
      pinned: pin.id,
    };
  }

  // A preference from the pref file is not an error, but it IS something the
  // envelope should say out loud: it silently reorders the chain, so a run
  // that picked an unexpected model has a documented reason in model_notes.
  const preferred = resolvePrefer();
  if (preferred?.from === "file") {
    warnings.push(`model preference ${JSON.stringify(preferred.list)} applied from ${MODEL_PREF_PATH} (ocd models --prefer)`);
  }

  let models: ModelInfo[] = [];
  let source: DiscoveryResult["source"] = "cache";
  let fetchedAt = 0;

  const cached = readModelsCache();
  const cacheFresh = cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS;

  if (!opts.refresh && cacheFresh && cached!.models.length > 0) {
    models = cached!.models;
    fetchedAt = cached!.fetchedAt;
  } else {
    const disc = await discoverFreeModels(opts.refresh === true);
    warnings.push(...disc.warnings);
    models = disc.models;
    source = "live";
    fetchedAt = disc.fetchedAt;
    if (models.length > 0) writeModelsCache(models, fetchedAt);
    else if (cached && cached.models.length > 0) {
      // Discovery came back empty (offline, provider hiccup) — a stale list is
      // strictly better than no list, since the ladder can still try it.
      warnings.push("discovery returned no models; falling back to stale cache");
      models = cached.models;
      source = "cache";
      fetchedAt = cached.fetchedAt;
    }
  }

  const health = loadHealth();
  let chain = rankModels(models, health);

  // If everything on a cached list is benched, the lineup has probably
  // rotated — spend the ~0.5s to re-discover before giving up on it.
  if (source === "cache" && chain.length > 0 && chain.every((c) => c.benched) && !opts.refresh) {
    const disc = await discoverFreeModels(true);
    if (disc.models.length > 0) {
      warnings.push("all cached models benched; re-discovered live");
      writeModelsCache(disc.models, disc.fetchedAt);
      chain = rankModels(disc.models, health);
      source = "live";
      fetchedAt = disc.fetchedAt;
    }
  }

  if (chain.length === 0) warnings.push("no usable free model found");

  return { chain, warnings, source, fetchedAt, pinned: null };
}

/** Convenience for callers that just need ids in priority order. */
export function chainIds(chain: ScoredModel[]): string[] {
  return chain.map((c) => c.model.id);
}
