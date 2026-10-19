import {
  DEFAULT_CONFIG,
  STATE_ORDER,
  type DerivedSession,
  type SessionRow,
  type State,
  type StateConfig,
} from './types.ts';

interface Base {
  state: State;
  reason: string;
  since: number;
}

const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PreCompact']);

/**
 * The single place that decides what a session needs from you.
 * Pure: depends only on the stored row, the clock and the thresholds.
 */
export function deriveSession(row: SessionRow, now: number, cfg: StateConfig = DEFAULT_CONFIG): DerivedSession {
  const hookAt = row.last_event_at ?? 0;
  const snapActivityAt = row.snap_updated_at ?? 0;
  const lastActivity = Math.max(hookAt, snapActivityAt, row.started_at ?? 0);
  // The periodic snapshot only wins when it reflects activity newer than the last live event.
  const fromSnapshot = row.snap_bucket != null && snapActivityAt > hookAt;

  let base = fromSnapshot ? fromSnapshotFields(row) : fromHookFields(row);

  const dismissed = row.dismissed_at != null && row.dismissed_at >= lastActivity;
  if (dismissed && base.state !== 'working') {
    base = { state: 'done', reason: 'Archiviata da te', since: row.dismissed_at! };
  }

  if ((base.state === 'waiting' || base.state === 'review') && now - base.since > cfg.forgottenMs) {
    base = { ...base, state: 'forgotten' };
  }

  return {
    key: row.key,
    state: base.state,
    reason: base.reason,
    since: base.since,
    last_activity_at: lastActivity,
    quiet: base.state === 'working' && now - lastActivity > cfg.quietMs,
    from_snapshot: fromSnapshot,
    dismissed,
    title: titleOf(row),
    source: row.source,
    entrypoint: row.entrypoint,
    host: row.host,
    repo: row.repo,
    branch: row.branch,
    url: row.remote_id ? `https://claude.ai/code/${row.remote_id}` : null,
    last_prompt: row.last_prompt,
    last_message: row.last_message,
    activity: row.activity,
    context_used: row.context_used,
    context_max: row.context_max,
    cost_usd: row.cost_usd,
    unread: row.snap_unread === 1,
  };
}

function fromHookFields(row: SessionRow): Base {
  const at = row.last_event_at ?? row.started_at ?? row.updated_at;
  switch (row.last_event) {
    case 'SessionEnd':
      return { state: 'done', reason: 'Sessione chiusa', since: row.ended_at ?? at };
    case 'Notification':
      return { state: 'waiting', reason: row.notification || 'Claude ti aspetta', since: at };
    case 'Stop': {
      const question = trailingQuestion(row.last_message);
      return question
        ? { state: 'waiting', reason: question, since: at }
        : { state: 'review', reason: excerpt(row.last_message) || 'Turno finito', since: at };
    }
    case 'SessionStart':
      return { state: 'review', reason: 'Aperta, in attesa del primo messaggio', since: at };
    default:
      if (row.last_event && WORKING_EVENTS.has(row.last_event)) {
        return { state: 'working', reason: row.activity || 'Al lavoro', since: row.last_prompt_at ?? at };
      }
      return { state: 'review', reason: 'Stato sconosciuto', since: at };
  }
}

function fromSnapshotFields(row: SessionRow): Base {
  const since = row.snap_updated_at!;
  const bucket = normalizeBucket(row.snap_bucket);
  const detail = row.snap_detail || row.snap_recent_action || '';
  if (row.snap_needs_action || bucket === 'blocked') {
    return { state: 'waiting', reason: row.snap_needs_action || detail || 'Bloccata', since };
  }
  switch (bucket) {
    case 'failed':
      return { state: 'failed', reason: detail || 'Ultimo turno fallito', since };
    case 'working':
      return { state: 'working', reason: detail || 'Al lavoro', since };
    case 'completed':
      return { state: 'done', reason: detail || 'Completata', since };
    default:
      return { state: 'review', reason: detail || 'Da rivedere', since };
  }
}

/** 'SESSION_STATUS_BUCKET_REVIEW_READY' -> 'review_ready' */
export function normalizeBucket(bucket: string | null): string {
  return (bucket ?? '').replace(/^SESSION_STATUS_BUCKET_/, '').toLowerCase();
}

/**
 * Heuristic: a turn that ends on a question is waiting on you, not just finished.
 * Returns the question (last line ending in '?') or null.
 */
export function trailingQuestion(message: string | null): string | null {
  if (!message) return null;
  const lines = message
    .split('\n')
    .map((l) => l.replace(/[*_`>#\s]+$/g, '').replace(/^[\s>*\-#]+/, '').trim())
    .filter(Boolean);
  const tail = lines.slice(-3);
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].endsWith('?')) return excerpt(tail[i]);
  }
  return null;
}

export function excerpt(text: string | null, max = 220): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

function titleOf(row: SessionRow): string {
  if (row.title) return row.title;
  if (row.first_prompt) return excerpt(row.first_prompt, 80);
  const repoName = row.repo?.split('/').pop();
  return repoName ? `Sessione su ${repoName}` : 'Sessione senza titolo';
}

/** Sort: state priority, then the longest wait first for states that need you, most recent first otherwise. */
export function sortSessions(list: DerivedSession[]): DerivedSession[] {
  const rank = (s: State) => STATE_ORDER.indexOf(s);
  return [...list].sort((a, b) => {
    const r = rank(a.state) - rank(b.state);
    if (r !== 0) return r;
    const oldestFirst = a.state === 'waiting' || a.state === 'failed' || a.state === 'forgotten' || a.state === 'review';
    return oldestFirst ? a.since - b.since : b.last_activity_at - a.last_activity_at;
  });
}

export function countByState(list: DerivedSession[]): Record<State, number> {
  const counts = Object.fromEntries(STATE_ORDER.map((s) => [s, 0])) as Record<State, number>;
  for (const s of list) counts[s.state]++;
  return counts;
}
