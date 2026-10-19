// Demo backend for the shareable EvoFlow demo: the real ingest and state model (src/core) running
// in the browser over example sessions, with a short scripted timeline so agents change state live.
// Same exports as public/api.js; tools/build-demo.ts swaps it in.
import { applyEvent, applySnapshot, sessionKey } from '../../src/core/ingest.ts';
import { countByState, deriveSession, sortSessions } from '../../src/core/state.ts';
import { buildTimeline } from '../../src/core/timeline.ts';
import { DEFAULT_CONFIG } from '../../src/core/types.ts';
import scenario from '../../tests/fixtures/scenario-demo.json';

export class AuthError extends Error {}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// How long ago each scripted session started, so badges read "da 12 min", "da 2 h"… instead of "adesso".
const STARTED_AGO = {
  'a1111111-0000-5000-8000-000000000001': 26 * MIN,
  'b2222222-0000-5000-8000-000000000002': 41 * MIN,
  'c3333333-0000-4000-8000-000000000003': 2.4 * HOUR,
  'd4444444-0000-5000-8000-000000000004': 58 * MIN,
  'e5555555-0000-4000-8000-000000000005': 20 * HOUR,
};

const meta = (remote, extra) => ({ source: remote ? 'cloud' : 'local', remote_session_id: remote, ...extra });
const A = { id: 'a1111111-0000-5000-8000-000000000001', meta: meta('cse_01DemoWorkingAAAAAAAAAAA', { entrypoint: 'remote_mobile', repo: 'demo/shop-app', branch: 'claude/checkout-refactor-x1y2' }) };
const B = { id: 'b2222222-0000-5000-8000-000000000002', meta: meta('cse_01DemoPermissionBBBBBBBB', { entrypoint: 'remote_web', repo: 'demo/api-server', branch: 'claude/rate-limit-k8s9' }) };
const F = { id: 'f6666666-0000-5000-8000-000000000006', meta: meta('cse_01DemoDocsFFFFFFFFFFFFF', { entrypoint: 'remote_mobile', repo: 'demo/api-server', branch: 'claude/api-docs-m2n3' }) };
const C = { id: 'c3333333-0000-4000-8000-000000000003', meta: meta(undefined, { entrypoint: 'claude-desktop', host: 'MacBook-Pro', repo: 'demo/landing', branch: 'feature/hero-copy' }) };
const D = { id: 'd4444444-0000-5000-8000-000000000004', meta: meta('cse_01DemoReviewDDDDDDDDDDDD', { entrypoint: 'remote_mobile', repo: 'demo/mobile', branch: 'claude/offline-sync-p3q4' }) };
const G = { id: 'g7777777-0000-4000-8000-000000000007', meta: meta(undefined, { entrypoint: 'cli', host: 'MacBook-Pro', repo: 'demo/api-server', branch: 'chore/deps' }) };
const ev = (s, hook_event_name, extra = {}) => ({ v: 1, meta: s.meta, payload: { session_id: s.id, hook_event_name, ...extra } });

// Earlier turns of the same sessions, in minutes ago, so the 12-hour timeline has a story to show.
const HISTORY = [
  [D, 700, 'UserPromptSubmit'],
  [G, 650, 'UserPromptSubmit', { prompt: 'Aggiorna le dipendenze con vulnerabilità note' }],
  [B, 600, 'UserPromptSubmit'],
  [D, 610, 'Stop', { last_assistant_message: 'Schema del database locale pronto.' }],
  [G, 560, 'Stop', { last_assistant_message: 'Aggiornate 7 dipendenze, test verdi.' }],
  [G, 540, 'SessionEnd', { reason: 'prompt_input_exit' }],
  [B, 520, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }],
  [C, 500, 'UserPromptSubmit'],
  [B, 455, 'PostToolUse', { tool_name: 'Bash', tool_input: { description: 'Run migrations' } }],
  [C, 420, 'Stop', { last_assistant_message: 'Hero aggiornata con il nuovo payoff.' }],
  [A, 400, 'UserPromptSubmit'],
  [B, 380, 'Stop', { last_assistant_message: 'Migrazioni applicate. Procedo con il rate limiting?' }],
  [A, 330, 'Stop', { last_assistant_message: 'Ho mappato il flusso di checkout attuale. Vuoi che proceda con il refactor?' }],
  [D, 300, 'UserPromptSubmit'],
  [D, 240, 'Stop', { last_assistant_message: 'Quale strategia di conflitto preferisci?' }],
  [A, 210, 'UserPromptSubmit'],
  [A, 150, 'Stop', { last_assistant_message: 'Analisi completata.' }],
].sort((x, y) => y[1] - x[1]);

// What happens after the page opens, in seconds.
const TIMELINE = [
  [8, ev(A, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/checkout/installments.test.ts' } })],
  [15, ev(B, 'PostToolUse', { tool_name: 'Bash', tool_input: { description: 'Deploy to staging' } })],
  [24, ev(A, 'Stop', { last_assistant_message: 'Refactor completato: pagamento in 3 rate supportato, 22 test verdi.\n\nVuoi che apra la PR?' })],
  [33, ev(F, 'SessionStart', { source: 'startup' })],
  [34, ev(F, 'UserPromptSubmit', { prompt: 'Scrivi la documentazione delle API pubbliche con esempi curl' })],
  [36, ev(F, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/routes/public.ts' } })],
  [45, ev(B, 'Stop', { last_assistant_message: 'Deploy su staging completato. Rate limit attivo: 100 richieste al minuto per chiave, risposta 429 con header Retry-After.' })],
  [54, ev(F, 'PreToolUse', { tool_name: 'WebFetch', tool_input: { url: 'https://docs.stripe.com/api/errors' } })],
  [56, ev(F, 'Notification', { message: 'Claude needs your permission to use WebFetch', notification_type: 'permission_prompt' })],
];

let rows;
let logs;
let diary;
let loggedIn;
let timers = [];

function put(row) {
  if (row) rows.set(row.key, row);
}

function ingest(envelope, at) {
  const out = applyEvent(rows.get(sessionKey(envelope)) ?? null, envelope, at);
  put(out.row);
  if (out.log) logs.push(out.log);
}

/** Loads the example sessions with realistic ages, then schedules the live timeline. */
export function resetDemo() {
  timers.forEach(clearTimeout);
  rows = new Map();
  logs = [];
  diary = [];
  loggedIn = true;
  const now = Date.now();
  for (const [s, minutesAgo, event, extra] of HISTORY) ingest(ev(s, event, extra), now - minutesAgo * MIN);
  const step = new Map();
  for (const s of scenario.steps) {
    if (s.event) {
      const id = s.event.payload.session_id;
      const n = step.get(id) ?? 0;
      step.set(id, n + 1);
      // Events of one session a couple of minutes apart; the last one a few minutes before now.
      const start = now - (STARTED_AGO[id] ?? 30 * MIN);
      ingest(s.event, Math.min(start + n * 2.5 * MIN, now - 60_000));
    } else {
      for (const item of s.snapshot) {
        const { updated_hours_ago = 0, created_hours_ago, ...rest } = item;
        const snap = {
          ...rest,
          updated_at: new Date(now - updated_hours_ago * HOUR).toISOString(),
          created_at: new Date(now - (created_hours_ago ?? updated_hours_ago) * HOUR).toISOString(),
        };
        put(applySnapshot(rows.get(item.id) ?? null, snap, now));
      }
    }
  }
  timers = TIMELINE.map(([sec, envelope]) => setTimeout(() => ingest(envelope, Date.now()), sec * 1000));
}

resetDemo();

const delay = (v) => new Promise((r) => setTimeout(() => r(v), 120));

function guard() {
  if (!loggedIn) throw new AuthError('login richiesto');
}

function sessionsResponse() {
  const now = Date.now();
  const derived = sortSessions([...rows.values()].map((r) => deriveSession(r, now, DEFAULT_CONFIG)));
  let done = 0;
  return {
    now,
    config: DEFAULT_CONFIG,
    counts: countByState(derived),
    sessions: derived.filter((s) => s.state !== 'done' || ++done <= 50),
  };
}

export const getSessions = async () => (guard(), delay(sessionsResponse()));

export async function login(password) {
  if (!password) throw new AuthError('Password errata');
  loggedIn = true;
  return delay(null);
}

export async function logout() {
  loggedIn = false;
  return delay(null);
}

function setDismissed(key, at) {
  guard();
  const row = rows.get(key);
  if (!row) throw new HttpError(404, 'sessione non trovata');
  rows.set(key, { ...row, dismissed_at: at });
  return delay(null);
}

export const dismiss = async (key) => setDismissed(key, Date.now());
export const restore = async (key) => setDismissed(key, null);
export async function getTimeline(hours = 12) {
  guard();
  const now = Date.now();
  const derived = [...rows.values()].map((r) => deriveSession(r, now, DEFAULT_CONFIG));
  return delay(buildTimeline(logs, derived, now - hours * HOUR, now, DEFAULT_CONFIG));
}

export const getDiary = async () => (guard(), delay({ entries: [...diary].reverse() }));

export async function addDiary(note) {
  guard();
  const entry = { id: diary.length + 1, created_at: Date.now(), note: String(note ?? '').trim(), context: sessionsResponse().counts };
  diary.push(entry);
  return delay(entry);
}
