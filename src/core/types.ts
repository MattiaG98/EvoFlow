// Shared shapes between the Worker, the state model and the tests.
// The browser client (public/app.js) consumes `SessionsResponse` as JSON.

export type State = 'waiting' | 'failed' | 'forgotten' | 'review' | 'working' | 'done';

/** Display/priority order: what needs you first. */
export const STATE_ORDER: readonly State[] = ['waiting', 'failed', 'forgotten', 'review', 'working', 'done'];

export type Source = 'cloud' | 'local';

/** One row of the `sessions` table: everything we know about a session, as stored. */
export interface SessionRow {
  key: string;
  cli_session_id: string | null;
  remote_id: string | null;
  source: Source;
  entrypoint: string | null;
  host: string | null;
  repo: string | null;
  branch: string | null;
  title: string | null;
  first_prompt: string | null;
  last_prompt: string | null;
  last_prompt_at: number | null;
  last_message: string | null;
  activity: string | null;
  notification: string | null;
  last_event: string | null;
  last_event_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  snap_bucket: string | null;
  snap_status_category: string | null;
  snap_detail: string | null;
  snap_needs_action: string | null;
  snap_recent_action: string | null;
  snap_updated_at: number | null;
  snap_at: number | null;
  snap_unread: number | null;
  context_used: number | null;
  context_max: number | null;
  cost_usd: number | null;
  dismissed_at: number | null;
  updated_at: number;
}

/** What the dashboard renders for one session. Times are epoch milliseconds. */
export interface DerivedSession {
  key: string;
  state: State;
  /** Why it is in this state, in the user's language: the agent's question, the permission it needs, what it is doing. */
  reason: string;
  /** When the current state began. */
  since: number;
  /** Last time anything happened in the session. */
  last_activity_at: number;
  /** Working, but nothing heard for a while: the container may have died or a command may be hanging. */
  quiet: boolean;
  /** The state came from the periodic snapshot rather than a live hook event. */
  from_snapshot: boolean;
  dismissed: boolean;
  title: string;
  source: Source;
  entrypoint: string | null;
  host: string | null;
  repo: string | null;
  branch: string | null;
  url: string | null;
  last_prompt: string | null;
  last_message: string | null;
  activity: string | null;
  context_used: number | null;
  context_max: number | null;
  cost_usd: number | null;
  unread: boolean;
}

export interface StateConfig {
  /** A session waiting on you (or ready for review) longer than this is "forgotten". */
  forgottenMs: number;
  /** A working session silent for longer than this is flagged `quiet`. */
  quietMs: number;
}

export const DEFAULT_CONFIG: StateConfig = {
  forgottenMs: 48 * 3600_000,
  quietMs: 15 * 60_000,
};

export interface SessionsResponse {
  now: number;
  config: StateConfig;
  counts: Record<State, number>;
  sessions: DerivedSession[];
}

export interface DiaryEntry {
  id: number;
  created_at: number;
  note: string;
  /** Counts per state at the moment of the entry, for the before/after comparison. */
  context: Partial<Record<State, number>> | null;
}

/** Body the hook script POSTs to /api/events. `payload` is Claude Code's hook input, verbatim. */
export interface HookEnvelope {
  v: 1;
  meta: {
    source?: string;
    remote_session_id?: string;
    entrypoint?: string;
    host?: string;
    repo?: string;
    branch?: string;
  };
  payload: HookPayload;
}

export interface HookPayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [k: string]: unknown;
}
