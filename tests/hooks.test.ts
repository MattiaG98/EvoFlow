// Runs the real shell scripts: installer against a throwaway HOME, hook against a local HTTP receiver.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const HOOKS = new URL('../public/hooks/', import.meta.url).pathname;
const BASE_ENV = { PATH: process.env.PATH!, LANG: 'C' };

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'evoflow-home-'));
  mkdirSync(join(home, '.claude'));
  return home;
}

test('installer merges into existing settings, is idempotent, and uninstalls cleanly', () => {
  const home = tempHome();
  const settings = join(home, '.claude', 'settings.json');
  const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  writeFileSync(settings, JSON.stringify(original));
  const env = { ...BASE_ENV, HOME: home, EVOFLOW_URL: 'http://127.0.0.1:9', EVOFLOW_TOKEN: 'tok' };

  execFileSync('sh', [join(HOOKS, 'install.sh')], { env, stdio: 'pipe' });
  execFileSync('sh', [join(HOOKS, 'install.sh')], { env, stdio: 'pipe' });
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2, 'existing Stop hook kept, ours added once');
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
  assert.equal(Object.keys(s.hooks).length, 8);
  assert.ok(existsSync(join(home, '.claude/evoflow/hook.sh')));
  assert.match(readFileSync(join(home, '.claude/evoflow/env'), 'utf8'), /EVOFLOW_TOKEN=tok/);

  execFileSync('sh', [join(HOOKS, 'install.sh'), '--uninstall'], { env, stdio: 'pipe' });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), original);
  assert.ok(!existsSync(join(home, '.claude/evoflow')));
});

test('installer refuses to touch a settings file it cannot parse', () => {
  const home = tempHome();
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, '{ broken');
  const r = spawnSync('sh', [join(HOOKS, 'install.sh')], { env: { ...BASE_ENV, HOME: home }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(settings, 'utf8'), '{ broken');
});

test('the hook forwards the event with repo metadata and returns immediately', async () => {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const repo = mkdtempSync(join(tmpdir(), 'evoflow-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'feature/x'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://user:secret@github.com/demo/app.git'], { cwd: repo });

  const payload = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'Riga 1\n"citata" e \\ barra' });
  const started = Date.now();
  const r = spawnSync('sh', [join(HOOKS, 'evoflow-hook.sh')], {
    input: payload,
    env: { ...BASE_ENV, HOME: tempHome(), EVOFLOW_URL: `http://127.0.0.1:${port}/`, EVOFLOW_TOKEN: 'tok', CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01Abc', CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' },
  });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 2000, 'hook must not wait for the upload');

  for (let i = 0; i < 50 && !received.length; i++) await new Promise((res) => setTimeout(res, 50));
  server.close();
  assert.equal(received.length, 1);
  const { auth, url, body } = received[0];
  assert.equal(auth, 'Bearer tok');
  assert.equal(url, '/api/events');
  assert.deepEqual(body.meta, { source: 'cloud', remote_session_id: 'cse_01Abc', entrypoint: 'remote_mobile', host: body.meta.host, repo: 'demo/app', branch: 'feature/x' });
  assert.equal(body.payload.last_assistant_message, 'Riga 1\n"citata" e \\ barra');
  assert.ok(!JSON.stringify(body).includes('secret'), 'credentials in the remote URL are never sent');
});

test('the hook is a silent no-op when not configured or the dashboard is down', () => {
  const quiet = (extra: Record<string, string>) =>
    spawnSync('sh', [join(HOOKS, 'evoflow-hook.sh')], { input: '{"session_id":"s","hook_event_name":"Stop"}', env: { ...BASE_ENV, HOME: tempHome(), ...extra }, encoding: 'utf8' });
  const unconfigured = quiet({});
  assert.equal(unconfigured.status, 0);
  assert.equal(unconfigured.stdout + unconfigured.stderr, '');
  const down = quiet({ EVOFLOW_URL: 'http://127.0.0.1:9', EVOFLOW_TOKEN: 'tok' });
  assert.equal(down.status, 0);
  assert.equal(down.stdout + down.stderr, '');
});
