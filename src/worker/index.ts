import {
  applyEvent,
  applySnapshot,
  normalizeRemoteId,
  sessionKey,
  validateEnvelope,
  type SnapshotItem,
} from '../core/ingest.ts';
import { countByState, deriveSession, sortSessions } from '../core/state.ts';
import { DEFAULT_CONFIG, type HookEnvelope, type SessionsResponse, type StateConfig } from '../core/types.ts';
import {
  addDiary,
  ensureSchema,
  getSession,
  listDiary,
  listSessions,
  logStatement,
  prune,
  setDismissed,
  upsertStatement,
} from './db.ts';
import type { Env, ScheduledController } from './env.ts';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_DONE_SESSIONS = 50;
const DAY = 24 * 3600_000;
const EVENT_RETENTION_MS = 30 * DAY;
/** Sessions silent for longer than this drop off the dashboard, and are deleted after twice as long. */
const SESSION_WINDOW_MS = 60 * DAY;
const COOKIE = 'ef_auth';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env.DB);
      return await route(request, url, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env.DB);
    const now = Date.now();
    await prune(env.DB, now - EVENT_RETENTION_MS, now - 2 * SESSION_WINDOW_MS);
  },
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function route(request: Request, url: URL, env: Env): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  const now = Date.now();

  if (pathname === '/api/health') return json({ ok: true, now });

  if (pathname === '/api/events' && method === 'POST') {
    await requireIngest(request, env);
    const body = await readJson(request);
    const problem = validateEnvelope(body);
    if (problem) throw new HttpError(400, problem);
    const envelope = body as HookEnvelope;
    const prev = await getSession(env.DB, sessionKey(envelope));
    const { row, log } = applyEvent(prev, envelope, now);
    const statements = [upsertStatement(env.DB, row)];
    if (log) statements.push(logStatement(env.DB, log));
    await env.DB.batch(statements);
    return new Response(null, { status: 204 });
  }

  if (pathname === '/api/snapshots' && method === 'POST') {
    await requireIngest(request, env);
    const body = (await readJson(request)) as { sessions?: unknown };
    if (!Array.isArray(body?.sessions)) throw new HttpError(400, 'expected {"sessions": [...]}');
    if (body.sessions.length > 500) throw new HttpError(413, 'too many sessions');
    const statements = [];
    for (const item of body.sessions as SnapshotItem[]) {
      const key = normalizeRemoteId(typeof item?.id === 'string' ? item.id : null);
      if (!key) continue;
      const row = applySnapshot(await getSession(env.DB, key), item, now);
      if (row) statements.push(upsertStatement(env.DB, row));
    }
    if (statements.length) await env.DB.batch(statements);
    return json({ upserted: statements.length });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (!env.DASHBOARD_PASSWORD) throw new HttpError(503, 'DASHBOARD_PASSWORD non configurata');
    const body = (await readJson(request)) as { password?: unknown };
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!(await safeEqual(password, env.DASHBOARD_PASSWORD))) throw new HttpError(401, 'Password errata');
    return new Response(null, {
      status: 204,
      headers: { 'Set-Cookie': `${COOKIE}=${await authCookieValue(env)}; ${cookieAttrs(url)}; Max-Age=31536000` },
    });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return new Response(null, { status: 204, headers: { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs(url)}; Max-Age=0` } });
  }

  // Everything below is the dashboard's own data.
  await requireViewer(request, env);

  if (pathname === '/api/sessions' && method === 'GET') {
    return json(await sessionsResponse(env, now));
  }

  const dismiss = /^\/api\/sessions\/([^/]+)\/(dismiss|restore)$/.exec(pathname);
  if (dismiss && method === 'POST') {
    const key = decodeURIComponent(dismiss[1]);
    const ok = await setDismissed(env.DB, key, dismiss[2] === 'dismiss' ? now : null);
    if (!ok) throw new HttpError(404, 'sessione non trovata');
    return new Response(null, { status: 204 });
  }

  if (pathname === '/api/diary' && method === 'GET') {
    return json({ entries: await listDiary(env.DB, 200) });
  }

  if (pathname === '/api/diary' && method === 'POST') {
    const body = (await readJson(request)) as { note?: unknown };
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    const { counts } = await sessionsResponse(env, now);
    return json(await addDiary(env.DB, note, counts, now), 201);
  }

  throw new HttpError(404, 'not found');
}

async function sessionsResponse(env: Env, now: number): Promise<SessionsResponse> {
  const config = configFrom(env);
  const derived = sortSessions((await listSessions(env.DB, now - SESSION_WINDOW_MS)).map((r) => deriveSession(r, now, config)));
  const counts = countByState(derived);
  let done = 0;
  const sessions = derived.filter((s) => s.state !== 'done' || ++done <= MAX_DONE_SESSIONS);
  return { now, config, counts, sessions };
}

function configFrom(env: Env): StateConfig {
  const hours = Number(env.FORGOTTEN_HOURS);
  return hours > 0 ? { ...DEFAULT_CONFIG, forgottenMs: hours * 3600_000 } : DEFAULT_CONFIG;
}

// ---------- auth ----------

async function requireIngest(request: Request, env: Env): Promise<void> {
  if (!env.INGEST_TOKEN) throw new HttpError(503, 'INGEST_TOKEN non configurato');
  if (!(await safeEqual(bearer(request), env.INGEST_TOKEN))) throw new HttpError(401, 'unauthorized');
}

/**
 * The dashboard cookie, or the password as a Bearer token (for scripts such as tools/check.ts).
 * The ingest token is deliberately write-only: it lives in every cloud session and must not read other projects' prompts.
 */
async function requireViewer(request: Request, env: Env): Promise<void> {
  if (!env.DASHBOARD_PASSWORD) throw new HttpError(503, 'DASHBOARD_PASSWORD non configurata');
  const token = bearer(request);
  if (token && (await safeEqual(token, env.DASHBOARD_PASSWORD))) return;
  const cookie = readCookie(request, COOKIE);
  if (!cookie || !(await safeEqual(cookie, await authCookieValue(env)))) throw new HttpError(401, 'login richiesto');
}

function bearer(request: Request): string {
  const h = request.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookieAttrs(url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict${secure}`;
}

/** Changing the password invalidates every existing login. */
async function authCookieValue(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.DASHBOARD_PASSWORD!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('evoflow-dashboard-v1'));
  return hex(sig);
}

/** Compares digests, so neither length nor content leaks through timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length > 0;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- io ----------

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
