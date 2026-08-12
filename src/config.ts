import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskClass } from "./types.ts";

export const OPENCODE_BIN = process.env.OCD_OPENCODE_BIN || "opencode";
export const AGENT_NAME = "ocd-delegate";

export const STATE_DIR = process.env.OCD_STATE_DIR || join(homedir(), ".local", "state", "ocd");
export const REGISTRY_PATH = join(STATE_DIR, "registry.json");
export const LOCK_PATH = join(STATE_DIR, ".registry.lock");
export const TRANSCRIPT_DIR = join(STATE_DIR, "transcripts");

// L0/L1 use the same free model (L1 = same model, sharpened prompt on retry).
// L2 is the alternate-free-model rung, tried in order. L3 is "give up, tell Claude".
export const MODEL_L0 = "opencode/deepseek-v4-flash-free";
export const MODEL_L1 = "opencode/deepseek-v4-flash-free";
export const MODELS_L2 = [
  "opencode/nemotron-3-ultra-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
] as const;

export const VARIANT = "max";

export const TIMEOUTS_MS: Record<TaskClass, { wall: number; stall: number }> = {
  analyze: { wall: 120_000, stall: 45_000 },
  read: { wall: 600_000, stall: 90_000 },
  edit: { wall: 900_000, stall: 120_000 },
  test: { wall: 900_000, stall: 120_000 },
};

// Ping-pong cap per ref exchange (Claude <-> opencode feedback rounds).
export const MAX_ROUNDS = 3;
// L0..L3 rungs on the fallback ladder.
export const MAX_LADDER = 4;
// Global concurrent-process cap so parallel --bg dispatch doesn't trip free-tier rate limits.
export const CONCURRENCY_CAP = 4;

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TURN_CAP = 40;

export const TEXT_TRUNCATE = 4000;
export const FILES_SEEN_CAP = 50;

export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_MAX_WAIT_MS = 10_000;

// Stall-checker poll interval (independent of per-class stall threshold above).
export const STALL_POLL_MS = 2_000;
// Grace period between SIGTERM and SIGKILL when a dispatch is killed.
export const KILL_GRACE_MS = 5_000;
