import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker/index.ts';
import { createD1 } from '../tools/d1-shim.ts';

const TOKEN = 'test-ingest';
const PASSWORD = 'test-password';

function makeEnv() {
  return {
    DB: createD1(),
    ASSETS: { fetch: async () => new Response('asset') },
    INGEST_TOKEN: TOKEN,
    DASHBOARD_PASSWORD: PASSWORD,
  };
}

function call(env: ReturnType<typeof makeEnv>, method: string, path: string, opts: { body?: unknown; token?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return worker.fetch(new Request(`https://evoflow.test${path}`, { method, headers, body }), env as never);
}

const hook = (session_id: string, hook_event_name: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  v: 1,
  meta,
  payload: { session_id, hook_event_name, ...extra },
});

test('ingest requires the token; data requires login', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/events', { body: hook('s1', 'SessionStart') })).status, 401);
  assert.equal((await call(env, 'POST', '/api/events', { body: hook('s1', 'SessionStart'), token: 'wrong' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/sessions')).status, 401);
  assert.equal((await call(env, 'GET', '/api/sessions', { cookie: 'ef_auth=forged' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/sessions', { token: TOKEN })).status, 401, 'the ingest token is write-only');
  assert.equal((await call(env, 'GET', '/api/health')).status, 200);
  assert.equal(await (await call(env, 'GET', '/')).text(), 'asset');
});

test('login sets a cookie that opens the dashboard data', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: 'nope' } })).status, 401);
  const res = await call(env, 'POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(res.status, 204);
  const setCookie = res.headers.get('Set-Cookie')!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await call(env, 'GET', '/api/sessions', { cookie })).status, 200);
});

test('events become sessions with derived states', async () => {
  const env = makeEnv();
  const post = (b: unknown) => call(env, 'POST', '/api/events', { body: b, token: TOKEN });
  assert.equal((await post(hook('s1', 'UserPromptSubmit', { prompt: 'Fai il deploy' }, { repo: 'demo/app' }))).status, 204);
  assert.equal((await post(hook('s1', 'Notification', { message: 'Claude needs your permission to use Bash' }))).status, 204);
  await post(hook('s2', 'UserPromptSubmit', { prompt: 'Scrivi i test' }));
  await post(hook('s2', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } }));

  const data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.equal(data.counts.waiting, 1);
  assert.equal(data.counts.working, 1);
  assert.deepEqual(data.sessions.map((s: any) => [s.key, s.state]), [['s1', 'waiting'], ['s2', 'working']]);
  assert.equal(data.sessions[0].repo, 'demo/app');
  assert.equal(data.sessions[0].title, 'Fai il deploy');
  assert.equal(data.sessions[1].reason, 'Bash · Run tests');
});

test('malformed or oversized bodies are rejected without storing anything', async () => {
  const env = makeEnv();
  const post = (b: unknown) => call(env, 'POST', '/api/events', { body: b, token: TOKEN });
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ payload: { hook_event_name: 'Stop' } })).status, 400);
  assert.equal((await post(hook('s1', 'Stop', { last_assistant_message: 'x'.repeat(300 * 1024) }))).status, 413);
  const data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.equal(data.sessions.length, 0);
});

test('snapshots add sessions the hooks never saw, and merge with ones they did', async () => {
  const env = makeEnv();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  await call(env, 'POST', '/api/events', { body: hook('cli-1', 'PreToolUse', { tool_name: 'Read' }, { remote_session_id: 'cse_01Live' }), token: TOKEN });
  const res = await call(env, 'POST', '/api/snapshots', {
    token: TOKEN,
    body: {
      sessions: [
        { id: 'session_01Old', title: 'Vecchia', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: tenDaysAgo, post_turn_summary: { needs_action: 'rispondi' } },
        { id: 'session_01Live', title: 'Dal listing', status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: tenDaysAgo },
        { id: 'garbage' },
      ],
    },
  });
  assert.deepEqual(await res.json(), { upserted: 2 });
  const data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  const byKey = Object.fromEntries(data.sessions.map((s: any) => [s.key, s]));
  assert.equal(byKey.session_01Old.state, 'forgotten');
  assert.equal(byKey.session_01Old.reason, 'rispondi');
  assert.equal(byKey.session_01Live.title, 'Dal listing');
  assert.equal(byKey.session_01Live.from_snapshot, false, 'the live hook event is newer than the snapshot');
  assert.equal(data.sessions.length, 2);
});

test('archive and restore', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/events', { body: hook('s1', 'Stop', { last_assistant_message: 'Fatto.' }), token: TOKEN });
  assert.equal((await call(env, 'POST', '/api/sessions/s1/dismiss', { token: PASSWORD })).status, 204);
  let data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.equal(data.sessions[0].state, 'done');
  assert.equal(data.sessions[0].dismissed, true);
  assert.equal((await call(env, 'POST', '/api/sessions/s1/restore', { token: PASSWORD })).status, 204);
  data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.equal(data.sessions[0].state, 'review');
  assert.equal((await call(env, 'POST', '/api/sessions/missing/dismiss', { token: PASSWORD })).status, 404);
});

test('diary entries record the moment with the current counts', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/events', { body: hook('s1', 'Notification', { message: 'permesso' }), token: TOKEN });
  const created = await call(env, 'POST', '/api/diary', { token: PASSWORD, body: { note: 'Non trovavo la sessione del deploy' } });
  assert.equal(created.status, 201);
  const { entries } = await (await call(env, 'GET', '/api/diary', { token: PASSWORD })).json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].note, 'Non trovavo la sessione del deploy');
  assert.equal(entries[0].context.waiting, 1);
});

test('sessions silent for more than 60 days drop off the dashboard', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/snapshots', {
    token: TOKEN,
    body: {
      sessions: [
        { id: 'session_01Ancient', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: new Date(Date.now() - 61 * 86400_000).toISOString(), created_at: new Date(Date.now() - 70 * 86400_000).toISOString() },
        { id: 'session_01Recent', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: new Date(Date.now() - 59 * 86400_000).toISOString() },
      ],
    },
  });
  const data = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.deepEqual(data.sessions.map((s: any) => s.key), ['session_01Recent']);
});

test('the timeline endpoint reconstructs recent history from the event log', async () => {
  const env = makeEnv();
  const post = (b: unknown) => call(env, 'POST', '/api/events', { body: b, token: TOKEN });
  await post(hook('s1', 'UserPromptSubmit', { prompt: 'Deploy' }));
  await post(hook('s1', 'PreToolUse', { tool_name: 'Bash' }));
  await post(hook('s1', 'Notification', { message: 'Claude needs your permission to use Bash' }));
  assert.equal((await call(env, 'GET', '/api/timeline?hours=6', { token: TOKEN })).status, 401, 'reads need the password');
  const t = await (await call(env, 'GET', '/api/timeline?hours=6', { token: PASSWORD })).json();
  assert.equal(t.to - t.from, 6 * 3600_000);
  assert.equal(t.lanes.length, 1);
  assert.equal(t.lanes[0].title, 'Deploy');
  assert.deepEqual(t.lanes[0].segments.map((s: any) => s.state), ['working', 'waiting']);
});

test('sessions carry stable project colors; stats cover the requested days', async () => {
  const env = makeEnv();
  const post = (b: unknown) => call(env, 'POST', '/api/events', { body: b, token: TOKEN });
  await post(hook('s1', 'UserPromptSubmit', { prompt: 'a' }, { repo: 'demo/one' }));
  await post(hook('s2', 'Notification', { message: 'permesso' }, { repo: 'demo/two' }));
  const first = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.deepEqual(Object.keys(first.projects).sort(), ['demo/one', 'demo/two']);
  assert.notEqual(first.projects['demo/one'], first.projects['demo/two']);
  const again = await (await call(env, 'GET', '/api/sessions', { token: PASSWORD })).json();
  assert.deepEqual(again.projects, first.projects);

  const stats = await (await call(env, 'GET', '/api/stats?days=7&tz=-120', { token: PASSWORD })).json();
  assert.equal(stats.days.length, 7);
  assert.equal(stats.days.at(-1).prompts, 1);
  assert.equal((await call(env, 'GET', '/api/stats', { token: TOKEN })).status, 401);
});
