import { excerpt, trailingQuestion } from './state.ts';
import type { HookEnvelope, HookPayload, SessionRow, Source } from './types.ts';

/** One line of the event log: lifecycle events and state changes, the source of the timeline. Routine tool calls are not logged. */
export interface LogEntry {
  key: string;
  at: number;
  event: string;
  summary: string;
}

const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PreCompact']);

/** Cloud sessions expose `cse_…` inside the container and `session_…` in claude.ai URLs: same suffix. */
export function normalizeRemoteId(id: string | undefined | null): string | null {
  if (!id) return null;
  const m = /^(?:cse_|session_)([A-Za-z0-9]+)$/.exec(id.trim());
  return m ? `session_${m[1]}` : null;
}

export function sessionKey(env: HookEnvelope): string {
  return normalizeRemoteId(env.meta?.remote_session_id) ?? env.payload.session_id;
}

export function emptyRow(key: string, source: Source, now: number): SessionRow {
  return {
    key,
    cli_session_id: null,
    remote_id: null,
    source,
    entrypoint: null,
    host: null,
    repo: null,
    branch: null,
    title: null,
    first_prompt: null,
    last_prompt: null,
    last_prompt_at: null,
    last_message: null,
    activity: null,
    notification: null,
    last_event: null,
    last_event_at: null,
    started_at: null,
    ended_at: null,
    end_reason: null,
    snap_bucket: null,
    snap_status_category: null,
    snap_detail: null,
    snap_needs_action: null,
    snap_recent_action: null,
    snap_updated_at: null,
    snap_at: null,
    snap_unread: null,
    context_used: null,
    context_max: null,
    cost_usd: null,
    dismissed_at: null,
    updated_at: now,
  };
}

/** Validates the untrusted body of POST /api/events. Returns an error message, or null when usable. */
export function validateEnvelope(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const p = (body as HookEnvelope).payload;
  if (!p || typeof p !== 'object') return 'missing payload';
  if (typeof p.session_id !== 'string' || !p.session_id) return 'payload.session_id missing';
  if (typeof p.hook_event_name !== 'string' || !p.hook_event_name) return 'payload.hook_event_name missing';
  return null;
}

/**
 * Folds one hook event into the session row. Only short, display-ready fields are kept:
 * tool inputs and outputs are reduced to a one-line activity and never stored.
 */
export function applyEvent(
  prev: SessionRow | null,
  env: HookEnvelope,
  now: number,
): { row: SessionRow; log: LogEntry | null } {
  const p = env.payload;
  const meta = env.meta ?? {};
  const key = sessionKey(env);
  const remoteId = normalizeRemoteId(meta.remote_session_id);
  const source: Source = remoteId ? 'cloud' : 'local';
  const row: SessionRow = { ...(prev ?? emptyRow(key, source, now)) };

  row.cli_session_id = p.session_id;
  row.remote_id = remoteId ?? row.remote_id;
  row.source = row.remote_id ? 'cloud' : source;
  row.entrypoint = clean(meta.entrypoint, 40) ?? row.entrypoint;
  row.host = clean(meta.host, 80) ?? row.host;
  row.repo = clean(meta.repo, 120) ?? row.repo;
  row.branch = clean(meta.branch, 120) ?? row.branch;
  row.started_at ??= now;
  row.updated_at = now;

  const event = p.hook_event_name;
  let summary: string | null = null;
  const mark = (name: string) => {
    row.last_event = name;
    row.last_event_at = now;
  };

  switch (event) {
    case 'SessionStart':
      row.ended_at = null;
      row.end_reason = null;
      if (p.source === 'compact') {
        mark('PreCompact');
      } else {
        mark('SessionStart');
        summary = str(p.source) || 'startup';
      }
      break;
    case 'UserPromptSubmit': {
      const prompt = trim(str(p.prompt), 1000);
      row.last_prompt = prompt || row.last_prompt;
      row.first_prompt ??= prompt || null;
      row.last_prompt_at = now;
      row.activity = null;
      row.notification = null;
      mark(event);
      summary = excerpt(prompt, 160);
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse': {
      // Tool calls are logged only when they change the state (e.g. work resuming after a permission prompt).
      const wasWorking = row.last_event != null && WORKING_EVENTS.has(row.last_event);
      row.activity = toolActivity(p);
      row.notification = null;
      mark(event);
      if (!wasWorking) summary = row.activity;
      break;
    }
    case 'Notification': {
      if (isIdleNotification(p)) {
        // "Claude is waiting for your input" after a finished turn: the Stop already says so.
        return { row: prev ? { ...prev } : row, log: null };
      }
      row.notification = trim(str(p.message), 500) || 'Claude ti aspetta';
      mark(event);
      summary = row.notification;
      break;
    }
    case 'Stop':
      row.last_message = trim(str(p.last_assistant_message), 4000) || row.last_message;
      row.activity = null;
      row.notification = null;
      mark(event);
      // Keep the question itself when the turn ends on one: the timeline reads it back to tell waiting from review.
      summary = trailingQuestion(row.last_message) ?? excerpt(row.last_message, 160);
      break;
    case 'SubagentStop':
      // A background agent can finish after the main turn ended: that must not flip the session back to working.
      if (row.last_event && WORKING_EVENTS.has(row.last_event)) mark(event);
      summary = 'subagent';
      break;
    case 'SessionEnd':
      row.ended_at = now;
      row.end_reason = trim(str(p.reason), 60) || null;
      mark(event);
      summary = row.end_reason ?? '';
      break;
    default:
      summary = '';
  }

  const log = summary === null ? null : { key, at: now, event, summary };
  return { row, log };
}

export function isIdleNotification(p: HookPayload): boolean {
  if (p.notification_type) return p.notification_type === 'idle_prompt';
  return /waiting for your input/i.test(str(p.message));
}

/** One line describing what the agent is doing, without command bodies or file contents. */
export function toolActivity(p: HookPayload): string {
  const tool = str(p.tool_name) || 'Strumento';
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const desc = str(input.description);
  let detail = '';
  switch (tool) {
    case 'Bash':
      detail = desc;
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = basename(str(input.file_path) || str(input.notebook_path));
      break;
    case 'Agent':
    case 'Task':
      return trim(`Agente · ${desc || str(input.subagent_type)}`, 120);
    case 'Grep':
    case 'Glob':
      detail = str(input.pattern);
      break;
    case 'WebFetch':
      detail = hostOf(str(input.url));
      break;
    case 'WebSearch':
      detail = str(input.query);
      break;
    default:
      if (tool.startsWith('mcp__')) return trim(tool.split('__').slice(1).join(' · '), 120);
  }
  return trim(detail ? `${tool} · ${detail}` : tool, 120);
}

/** A record from the Claude Code sessions listing, as the reconciliation task forwards it. Untrusted. */
export interface SnapshotItem {
  id?: unknown;
  title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  origin?: unknown;
  status_bucket?: unknown;
  unread?: unknown;
  session_context?: any;
  post_turn_summary?: any;
  external_metadata?: any;
}

export function applySnapshot(prev: SessionRow | null, s: SnapshotItem, now: number): SessionRow | null {
  const key = normalizeRemoteId(str(s.id));
  const updatedAt = Date.parse(str(s.updated_at));
  if (!key || Number.isNaN(updatedAt)) return null;

  const row: SessionRow = { ...(prev ?? emptyRow(key, 'cloud', now)) };
  const ctx = s.session_context ?? {};
  const meta = s.external_metadata ?? {};
  const summary = s.post_turn_summary ?? meta.post_turn_summary ?? {};
  const outcome = ctx.outcomes?.[0]?.git_repository?.git_info ?? {};

  row.remote_id = key;
  row.source = 'cloud';
  row.title = clean(s.title, 200) ?? row.title;
  row.entrypoint ??= clean(s.origin, 40);
  row.repo = clean(outcome.repo, 120) ?? repoFromUrl(str(ctx.sources?.[0]?.git_repository?.url)) ?? row.repo;
  row.branch = clean(outcome.branches?.[0], 120) ?? clean(meta.current_branches?.[''], 120) ?? row.branch;
  const created = Date.parse(str(s.created_at));
  if (!Number.isNaN(created)) row.started_at = Math.min(row.started_at ?? created, created);

  row.snap_bucket = clean(s.status_bucket, 60);
  row.snap_status_category = clean(summary.status_category, 40);
  row.snap_detail = clean(summary.status_detail, 500);
  row.snap_needs_action = clean(summary.needs_action, 500);
  row.snap_recent_action = clean(summary.recent_action, 500);
  row.snap_updated_at = updatedAt;
  row.snap_at = now;
  row.snap_unread = s.unread === true ? 1 : 0;
  row.context_used = num(meta.context_usage?.used_tokens) ?? row.context_used;
  row.context_max = num(meta.context_usage?.max_tokens) ?? row.context_max;
  row.cost_usd = num(meta.usage?.cost_usd) ?? row.cost_usd;
  row.updated_at = now;
  return row;
}

function repoFromUrl(url: string): string | null {
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  return m ? m[1] : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function trim(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function clean(v: unknown, max: number): string | null {
  const t = trim(str(v), max);
  return t ? t : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
