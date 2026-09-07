export type TaskClass = "read" | "analyze" | "edit" | "test" | "search";

export type Status =
  | "ok"
  | "empty"
  | "blocked"
  | "stalled"
  | "timeout"
  | "unverified"
  | "error"
  | "conflict";

export type NextAction = "accept" | "send_feedback" | "escalate" | "conflict";

export interface GitEvidence {
  changed: string[];
  insertions: number;
  deletions: number;
  branch?: string;
  base_head?: string;
}

export interface Evidence {
  tool_calls: number;
  tools: string[];
  files_seen: string[];
  git?: GitEvidence;
  /** URLs the model actually fetched, from real webfetch tool inputs. The
   * web-side counterpart to files_seen, and the only verified part of a
   * search result — kept separate from files_seen so the phantom-reference
   * check never compares a URL against a filesystem path. Omitted when
   * empty, so non-search envelopes are unchanged. */
  sources?: string[];
  /** Search queries actually issued, from real websearch tool inputs. */
  queries?: string[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Envelope {
  ref: string;
  session_id: string | null;
  status: Status;
  level: number;
  model: string | null;
  rounds: number;
  text: string;
  evidence: Evidence;
  warnings: string[];
  tokens: TokenUsage;
  cost: number;
  duration_ms: number;
  transcript: string;
  next: NextAction;
  error?: string;
  /** Non-fatal notes about how the model was chosen (stale cache, pinned
   * model, empty lineup). Deliberately separate from `warnings`, which are
   * evidence-gate findings and drive `next` — a discovery note says nothing
   * about whether the work itself is trustworthy. Omitted when empty. */
  model_notes?: string[];
}

export interface SessionEntry {
  tag: string;
  session_id: string | null;
  dir: string;
  agent: string;
  class: TaskClass;
  model: string;
  /** Original task text from `ocd run`. Kept so a `cont` whose ladder falls
   * back to a fresh session on an alt model can rebuild a full contract
   * prompt with real task context, not just the follow-up feedback text. */
  initial_task: string;
  created_at: number;
  last_used_at: number;
  rounds: number;
  turn_count: number;
  scope: string[];
  branch?: string;
  base_head?: string;
  bg: boolean;
  pid?: number;
  bg_status?: "running" | "done" | "failed";
  transcript_path: string;
  last_envelope?: Envelope;
}

export interface RegistryFile {
  version: 1;
  entries: Record<string, SessionEntry>;
}

// --- Raw opencode NDJSON event shapes (only the fields we rely on) ---

export interface RawToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  time?: { start: number; end?: number };
}

export interface RawPart {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: RawToolState;
  reason?: string;
  tokens?: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { write: number; read: number };
  };
  cost?: number;
}

/** A `type: "error"` NDJSON event. Under `--format json` opencode reports
 * provider-level failures here on STDOUT rather than on stderr, which is why
 * a failing dispatch can otherwise look merely `empty`. */
export interface RawErrorEvent {
  name?: string;
  data?: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
  };
}

export interface RawEvent {
  type: string;
  timestamp: number;
  sessionID?: string;
  part?: RawPart;
  error?: RawErrorEvent;
}
