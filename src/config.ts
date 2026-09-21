import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskClass } from "./types.ts";

export const OPENCODE_BIN = process.env.OCD_OPENCODE_BIN || "opencode";
export const AGENT_NAME = "ocd-delegate";

export const STATE_DIR = process.env.OCD_STATE_DIR || join(homedir(), ".local", "state", "ocd");
export const REGISTRY_PATH = join(STATE_DIR, "registry.json");
export const LOCK_PATH = join(STATE_DIR, ".registry.lock");
export const TRANSCRIPT_DIR = join(STATE_DIR, "transcripts");

// --- model selection -------------------------------------------------------
//
// No model id is hardcoded anywhere. The provider rotates its free lineup
// often enough that a pinned id is a guaranteed future outage: the original
// L0 model ("opencode/deepseek-v4-flash-free") and one of its three L2
// alternates were both delisted within weeks of being written down, which
// left the tool dispatching to a model that no longer existed. Models are now
// discovered from `opencode models --verbose` at runtime, filtered to
// zero-cost + tool-calling, ranked, and health-checked. See models.ts.

/** Provider to enumerate. Empty string lists every authenticated provider. */
export const MODEL_PROVIDER = process.env.OCD_MODEL_PROVIDER ?? "opencode";

/** Escape hatch: pin one model, skipping discovery and health routing.
 * This is the ENV layer only — `ocd models --pin` persists the same override
 * to MODEL_PREF_PATH, and models.ts resolves the two with env winning. */
export const MODEL_PIN_ENV = process.env.OCD_MODEL || "";

/** Substrings that bias ranking toward specific models, highest priority
 * first. The ENV layer only; see MODEL_PREF_PATH and DEFAULT_MODEL_PREFER. */
export const MODEL_PREFER_ENV = (process.env.OCD_MODEL_PREFER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Built-in preference, used only when neither OCD_MODEL_PREFER nor a saved
 * `ocd models --prefer` is set. Substrings, deliberately not provider/model
 * ids: this biases the ranking, it does not pin. Every entry still has to
 * be discovered, free, tool-calling and healthy, and if none of them is,
 * selection falls back to normal ranking — so a delisted entry degrades
 * into "no preference", never into an outage.
 *
 * Chosen from a head-to-head run (2026-09-22, opencode 1.18.31) of every
 * free model the provider offered, on identical read and edit tasks: all
 * answered correctly, but these three did it in 7–23s, while the two
 * nemotron models took 46–288s on some runs and one timed out on a probe.
 * Revisit when the lineup changes; `ocd models --probe --all` shows the
 * current state. */
export const DEFAULT_MODEL_PREFER = ["ling-3.0-flash", "big-pickle", "mimo-v2.5"];

export const MODELS_CACHE_PATH = join(STATE_DIR, "models-cache.json");
export const MODEL_HEALTH_PATH = join(STATE_DIR, "model-health.json");

/** Persisted model override, written by `ocd models --pin/--prefer`.
 *
 * Exists because the env vars are the only override this tool had, and an
 * env var does not survive a new shell — telling a teammate "export OCD_MODEL
 * before every session" is not a usable answer to "make it use this model".
 * Env still wins over the file so a one-off `OCD_MODEL=... ocd run` overrides
 * a saved setting without having to unset it. NOTE: no model id is stored in
 * the repo by this mechanism — the file lives in STATE_DIR, on the machine.
 */
export const MODEL_PREF_PATH = join(STATE_DIR, "model-pref.json");

/** Re-enumerate models at most this often. Discovery reads opencode's own
 * on-disk cache and costs ~0.5s, so this is about avoiding repeated spawns
 * inside one ladder walk, not about avoiding a network call. */
export const MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Wall clock for a single health probe. Generous enough for a cold start on
 * a slow free model (observed: 15s to first token), short enough that walking
 * a handful of dead candidates stays bearable. */
export const PROBE_TIMEOUT_MS = 45_000;

/** How long a failing model sits on the bench before it is retried. */
export const COOLDOWN_MS = {
  first: 15 * 60 * 1000,
  second: 60 * 60 * 1000,
  third: 6 * 60 * 60 * 1000,
  /** `disabled` / `missing` — will not self-heal within a work session. */
  structural: 24 * 60 * 60 * 1000,
};

export const TIMEOUTS_MS: Record<TaskClass, { wall: number; stall: number }> = {
  analyze: { wall: 120_000, stall: 45_000 },
  // Research is network-bound, not compute-bound: several search round trips
  // plus page fetches. Wider than analyze, but nowhere near the edit class —
  // a search that has gone quiet for 90s is stuck, not thinking.
  search: { wall: 300_000, stall: 90_000 },
  read: { wall: 600_000, stall: 90_000 },
  edit: { wall: 900_000, stall: 120_000 },
  test: { wall: 900_000, stall: 120_000 },
};

// Ping-pong cap per ref exchange (Claude <-> opencode feedback rounds).
export const MAX_ROUNDS = 3;
// L0..L3 rungs on the fallback ladder.
export const MAX_LADDER = 4;
/** Most alternate models the ladder will walk before escalating to Claude.
 *
 * Bounds worst-case latency, which discovery would otherwise make unbounded:
 * the rung counter stays at 2 while walking alternates, so without this cap a
 * lineup of N free models could cost N sequential dispatches, and at the edit
 * class's 120s stall window that is many minutes of hanging before Claude is
 * ever told. Three matches the original fixed L2 list length — past that,
 * handing back to Claude beats trying yet another free model. */
export const MAX_ALT_MODELS = 3;
// Global concurrent-process cap so parallel --bg dispatch doesn't trip free-tier rate limits.
export const CONCURRENCY_CAP = 4;

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TURN_CAP = 40;

export const TEXT_TRUNCATE = 4000;
export const FILES_SEEN_CAP = 50;
/** How many `sources` survive into the envelope.
 *
 * Much tighter than FILES_SEEN_CAP because a search retrieves far more URLs
 * than a read touches files: a real 4-call search produced 50 unique URLs,
 * which was 54% of the entire envelope by bytes — for a tool whose whole
 * premise is that the envelope stays small. The evidence gate still checks
 * cited URLs against the COMPLETE set (truncating before the check would
 * manufacture phantoms); only the reported list is trimmed, and the envelope
 * says so when it happens. */
export const SOURCES_REPORTED_CAP = 12;

export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_MAX_WAIT_MS = 10_000;

// Stall-checker poll interval (independent of per-class stall threshold above).
export const STALL_POLL_MS = 2_000;
// Grace period between SIGTERM and SIGKILL when a dispatch is killed.
export const KILL_GRACE_MS = 5_000;
