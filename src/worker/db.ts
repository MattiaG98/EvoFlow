import type { LogEntry } from '../core/ingest.ts';
import type { ProjectRow } from '../core/projects.ts';
import type { DiaryEntry, SessionRow } from '../core/types.ts';
import type { D1Database } from './env.ts';

// The schema is applied lazily on the first request of each isolate, so deploying needs no migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    cli_session_id TEXT, remote_id TEXT, source TEXT NOT NULL, entrypoint TEXT, host TEXT,
    repo TEXT, branch TEXT, title TEXT,
    first_prompt TEXT, last_prompt TEXT, last_prompt_at INTEGER, last_message TEXT,
    activity TEXT, notification TEXT, last_event TEXT, last_event_at INTEGER,
    started_at INTEGER, ended_at INTEGER, end_reason TEXT,
    snap_bucket TEXT, snap_status_category TEXT, snap_detail TEXT, snap_needs_action TEXT,
    snap_recent_action TEXT, snap_updated_at INTEGER, snap_at INTEGER, snap_unread INTEGER,
    context_used INTEGER, context_max INTEGER, cost_usd REAL,
    dismissed_at INTEGER, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, summary TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS events_at ON events (at)`,
  `CREATE TABLE IF NOT EXISTS projects (
    repo TEXT PRIMARY KEY, slot INTEGER, last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL, note TEXT NOT NULL, context TEXT
  )`,
];

export const SESSION_COLUMNS = [
  'key', 'cli_session_id', 'remote_id', 'source', 'entrypoint', 'host', 'repo', 'branch', 'title',
  'first_prompt', 'last_prompt', 'last_prompt_at', 'last_message', 'activity', 'notification',
  'last_event', 'last_event_at', 'started_at', 'ended_at', 'end_reason',
  'snap_bucket', 'snap_status_category', 'snap_detail', 'snap_needs_action', 'snap_recent_action',
  'snap_updated_at', 'snap_at', 'snap_unread', 'context_used', 'context_max', 'cost_usd',
  'dismissed_at', 'updated_at',
] as const satisfies readonly (keyof SessionRow)[];

const UPSERT_SQL = `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS.join(', ')})
  VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`;

const schemaReady = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        schemaReady.delete(db);
        throw err;
      });
    schemaReady.set(db, ready);
  }
  return ready;
}

export async function getSession(db: D1Database, key: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM sessions WHERE key = ?').bind(key).first<SessionRow>();
}

/** Sessions with any activity since `since`. Keeps every poll's read cost bounded as history grows. */
export async function listSessions(db: D1Database, since: number): Promise<SessionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sessions
       WHERE COALESCE(last_event_at, 0) > ?1 OR COALESCE(snap_updated_at, 0) > ?1 OR COALESCE(started_at, 0) > ?1`,
    )
    .bind(since)
    .all<SessionRow>();
  return results;
}

export function upsertStatement(db: D1Database, row: SessionRow) {
  return db.prepare(UPSERT_SQL).bind(...SESSION_COLUMNS.map((c) => row[c] ?? null));
}

export function logStatement(db: D1Database, log: LogEntry) {
  return db
    .prepare('INSERT INTO events (key, at, event, summary) VALUES (?, ?, ?, ?)')
    .bind(log.key, log.at, log.event, log.summary);
}

export async function listEvents(db: D1Database, since: number): Promise<LogEntry[]> {
  const { results } = await db
    .prepare('SELECT key, at, event, summary FROM events WHERE at >= ? ORDER BY at LIMIT 20000')
    .bind(since)
    .all<LogEntry>();
  return results;
}

export async function listProjects(db: D1Database): Promise<ProjectRow[]> {
  const { results } = await db.prepare('SELECT repo, slot, last_seen FROM projects').all<ProjectRow>();
  return results;
}

export function projectStatement(db: D1Database, p: ProjectRow) {
  return db.prepare('INSERT OR REPLACE INTO projects (repo, slot, last_seen) VALUES (?, ?, ?)').bind(p.repo, p.slot, p.last_seen);
}

export async function setDismissed(db: D1Database, key: string, at: number | null): Promise<boolean> {
  const res = await db.prepare('UPDATE sessions SET dismissed_at = ? WHERE key = ?').bind(at, key).run();
  return Number(res.meta?.changes ?? 0) > 0;
}

export async function addDiary(db: D1Database, note: string, context: unknown, at: number): Promise<DiaryEntry> {
  const row = await db
    .prepare('INSERT INTO diary (created_at, note, context) VALUES (?, ?, ?) RETURNING id')
    .bind(at, note, context == null ? null : JSON.stringify(context))
    .first<{ id: number }>();
  return { id: row!.id, created_at: at, note, context: (context as DiaryEntry['context']) ?? null };
}

export async function listDiary(db: D1Database, limit: number): Promise<DiaryEntry[]> {
  const { results } = await db
    .prepare('SELECT id, created_at, note, context FROM diary ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<{ id: number; created_at: number; note: string; context: string | null }>();
  return results.map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
}

export async function prune(db: D1Database, eventsBefore: number, sessionsBefore: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM events WHERE at < ?').bind(eventsBefore),
    db
      .prepare(
        `DELETE FROM sessions
         WHERE COALESCE(last_event_at, 0) < ?1 AND COALESCE(snap_updated_at, 0) < ?1 AND COALESCE(started_at, 0) < ?1`,
      )
      .bind(sessionsBefore),
  ]);
}
