import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  STATE_DIR,
  REGISTRY_PATH,
  LOCK_PATH,
  TRANSCRIPT_DIR,
  LOCK_STALE_MS,
  LOCK_RETRY_MS,
  LOCK_MAX_WAIT_MS,
  SESSION_TTL_MS,
  SESSION_TURN_CAP,
} from "./config.ts";
import type { RegistryFile, SessionEntry } from "./types.ts";

export function ensureStateDirs(): void {
  for (const dir of [STATE_DIR, TRANSCRIPT_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Atomic directory-based lock (mkdir is atomic on POSIX). Breaks stale locks
 * left behind by a killed process so a crashed `ocd` invocation can't wedge
 * the registry forever. */
async function acquireLock(): Promise<void> {
  ensureStateDirs();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH);
      writeFileSync(join(LOCK_PATH, "owner"), String(process.pid));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isLockStale()) {
        breakLock();
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`registry lock held for >${LOCK_MAX_WAIT_MS}ms, giving up (${LOCK_PATH})`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function isLockStale(): boolean {
  try {
    const st = statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
    const ownerPath = join(LOCK_PATH, "owner");
    if (existsSync(ownerPath)) {
      const pid = Number(readFileSync(ownerPath, "utf8").trim());
      if (pid && isPidAlive(pid)) return false;
    }
    return true;
  } catch {
    // Lock dir vanished between the EEXIST and this check — treat as gone.
    return true;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function breakLock(): void {
  try {
    rmSync(LOCK_PATH, { recursive: true, force: true });
  } catch {
    // Another process already broke it — fine, we'll just retry acquiring.
  }
}

function releaseLock(): void {
  try {
    rmSync(LOCK_PATH, { recursive: true, force: true });
  } catch {
    // Already gone; nothing to do.
  }
}

function loadRegistryRaw(): RegistryFile {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, entries: {} };
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    if (raw && raw.version === 1 && raw.entries) return raw as RegistryFile;
    return { version: 1, entries: {} };
  } catch {
    // Corrupt registry file (e.g. killed mid-write before we added atomic
    // rename below) — don't crash every future call, start clean.
    return { version: 1, entries: {} };
  }
}

function saveRegistryRaw(reg: RegistryFile): void {
  ensureStateDirs();
  const tmp = `${REGISTRY_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  // Atomic on POSIX: no window where a reader can observe a partial file.
  renameSync(tmp, REGISTRY_PATH);
}

/** Run `fn` with the registry lock held, read-modify-write. Use this for
 * every registry mutation so concurrent --bg dispatches can't race. */
export async function withRegistry<T>(fn: (reg: RegistryFile) => T): Promise<T> {
  await acquireLock();
  try {
    const reg = loadRegistryRaw();
    const result = fn(reg);
    saveRegistryRaw(reg);
    return result;
  } finally {
    releaseLock();
  }
}

export async function readRegistry(): Promise<RegistryFile> {
  await acquireLock();
  try {
    return loadRegistryRaw();
  } finally {
    releaseLock();
  }
}

/** ref may be a --tag (primary key) or a raw opencode session_id. */
export function resolveRefSync(reg: RegistryFile, ref: string): SessionEntry | undefined {
  const byTag = reg.entries[ref];
  if (byTag) return byTag;
  for (const entry of Object.values(reg.entries)) {
    if (entry.session_id === ref) return entry;
  }
  return undefined;
}

export async function resolveRef(ref: string): Promise<SessionEntry | undefined> {
  const reg = await readRegistry();
  return resolveRefSync(reg, ref);
}

function isExpired(entry: SessionEntry, now: number): boolean {
  return now - entry.last_used_at > SESSION_TTL_MS || entry.turn_count >= SESSION_TURN_CAP;
}

/** Drop sessions past TTL or turn cap so conversation history doesn't grow
 * unbounded and stale scope claims don't block new edit tasks forever. */
export function retireStale(reg: RegistryFile): string[] {
  const now = Date.now();
  const retired: string[] = [];
  for (const [tag, entry] of Object.entries(reg.entries)) {
    if (isExpired(entry, now) && entry.bg_status !== "running") {
      delete reg.entries[tag];
      retired.push(tag);
    }
  }
  return retired;
}

function normalizeScopePath(p: string): string {
  // Strip glob wildcards down to a base directory for a conservative
  // containment check — no minimatch dependency, and false positives
  // (over-flagging a conflict) are the safe failure direction here.
  const wildcardIdx = p.search(/[*?[]/);
  const base = wildcardIdx === -1 ? p : p.slice(0, wildcardIdx);
  return base.replace(/\/+$/, "");
}

function scopePathsOverlap(a: string, b: string): boolean {
  const na = normalizeScopePath(a);
  const nb = normalizeScopePath(b);
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export interface ScopeClaimResult {
  ok: boolean;
  conflictWith?: string;
  conflictPath?: string;
}

/** For --class edit: refuse to hand out overlapping file scope to two
 * concurrently-running tasks in the same dir. Read/analyze tasks are
 * unrestricted (they don't mutate anything, nothing to protect). */
export function claimScope(
  reg: RegistryFile,
  tag: string,
  dir: string,
  scope: string[],
): ScopeClaimResult {
  const now = Date.now();
  for (const [otherTag, entry] of Object.entries(reg.entries)) {
    if (otherTag === tag) continue;
    if (entry.class !== "edit") continue;
    if (entry.dir !== dir) continue;
    if (entry.bg_status !== "running") continue;
    if (isExpired(entry, now)) continue;
    for (const mine of scope) {
      for (const theirs of entry.scope) {
        if (scopePathsOverlap(mine, theirs)) {
          return { ok: false, conflictWith: otherTag, conflictPath: theirs };
        }
      }
    }
  }
  return { ok: true };
}

export function upsertEntry(reg: RegistryFile, entry: SessionEntry): void {
  reg.entries[entry.tag] = entry;
}

export function dropEntry(reg: RegistryFile, ref: string): boolean {
  const entry = resolveRefSync(reg, ref);
  if (!entry) return false;
  delete reg.entries[entry.tag];
  return true;
}

export function listEntries(reg: RegistryFile): SessionEntry[] {
  return Object.values(reg.entries).sort((a, b) => b.last_used_at - a.last_used_at);
}
