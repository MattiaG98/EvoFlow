import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyRow, type LogEntry } from '../src/core/ingest.ts';
import { planProjects, type ProjectRow } from '../src/core/projects.ts';
import { deriveSession } from '../src/core/state.ts';
import { dailyStats } from '../src/core/stats.ts';
import { DEFAULT_CONFIG, type SessionRow } from '../src/core/types.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const H = 3600_000;
const DAY = 24 * H;

const session = (key: string, repo: string | null, patch: Partial<SessionRow> = {}) =>
  deriveSession({ ...emptyRow(key, 'cloud', NOW), repo, last_event: 'PreToolUse', last_event_at: NOW - H, ...patch }, NOW);
const ended = (key: string, repo: string) => session(key, repo, { last_event: 'SessionEnd', ended_at: NOW - H });

/** Runs the planner and persists its changes, like the Worker does. */
function plan(rows: ProjectRow[], sessions: ReturnType<typeof session>[], now = NOW) {
  const out = planProjects(rows, sessions, now);
  const byRepo = new Map(rows.map((r) => [r.repo, r]));
  for (const c of out.changed) byRepo.set(c.repo, c);
  return { slots: out.slots, rows: [...byRepo.values()], changed: out.changed };
}

test('active projects get distinct colors; the fifth gets a neutral band', () => {
  const repos = ['a/one', 'a/two', 'a/three', 'a/four', 'a/five'];
  const { slots } = plan([], repos.map((r, i) => session(`s${i}`, r, { last_event_at: NOW - i * 60_000 })));
  assert.deepEqual(Object.values(slots).filter((s) => s != null).sort(), [0, 1, 2, 3]);
  assert.equal(slots['a/five'], null, 'least recently active project folds to neutral');
});

test('a color follows its project: new projects never repaint existing ones', () => {
  let state = plan([], [session('s1', 'a/one'), session('s2', 'a/two')]);
  const before = { ...state.slots };
  state = plan(state.rows, [session('s0', 'a/zero', { last_event_at: NOW }), session('s1', 'a/one'), session('s2', 'a/two')]);
  assert.equal(state.slots['a/one'], before['a/one']);
  assert.equal(state.slots['a/two'], before['a/two']);
  assert.notEqual(state.slots['a/zero'], null);
  assert.equal(new Set(Object.values(state.slots)).size, 3);
  // A quiet second poll writes nothing.
  assert.equal(plan(state.rows, [session('s1', 'a/one'), session('s2', 'a/two')]).changed.length, 0);
});

test('a project idle for two weeks gives its color up, and never shares it when it returns', () => {
  const full = ['a/one', 'a/two', 'a/three', 'a/four'];
  let state = plan([], full.map((r, i) => session(`s${i}`, r)));
  const later = NOW + 15 * DAY;
  // Only three are still active; a new project takes the idle one's slot.
  state = plan(state.rows, [...full.slice(1).map((r, i) => session(`t${i}`, r)), session('n', 'a/new')], later);
  assert.equal(state.slots['a/new'], 0);
  assert.equal(state.slots['a/one'], null);
  // The old project comes back while all four slots are held: it stays neutral rather than clash.
  state = plan(state.rows, [...full.map((r, i) => session(`u${i}`, r)), session('n', 'a/new')], later + H);
  const colored = Object.values(state.slots).filter((s) => s != null);
  assert.equal(colored.length, new Set(colored).size);
});

test('closed sessions keep their project color but do not claim one', () => {
  const { slots } = plan([], [ended('e', 'a/old')]);
  assert.equal(slots['a/old'], null);
  const live = plan([{ repo: 'a/old', slot: 2, last_seen: NOW - H }], [ended('e', 'a/old')]);
  assert.equal(live.slots['a/old'], 2);
});

test('daily stats split waiting time across local days and count your messages', () => {
  // Rome in summer: UTC+2, getTimezoneOffset() = -120.
  const tz = -120;
  const localMidnight = Date.parse('2026-10-18T22:00:00Z'); // 19 Oct 00:00 in Rome
  const log = (key: string, at: number, event: string, summary = ''): LogEntry => ({ key, at, event, summary });
  const events = [
    log('a', localMidnight - 2 * H, 'UserPromptSubmit'),
    log('a', localMidnight - H, 'Notification', 'permesso'), // waits 1 h yesterday + 2 h today
    log('a', localMidnight + 2 * H, 'UserPromptSubmit'),
    log('a', localMidnight + 3 * H, 'Stop', 'Fatto.'),
  ];
  const sessions = [session('a', 'a/one', { last_event: 'Stop', last_event_at: localMidnight + 3 * H })];
  const { days } = dailyStats(events, sessions, NOW, 3, tz, DEFAULT_CONFIG);
  assert.deepEqual(days.map((d) => d.start), [localMidnight - 2 * DAY, localMidnight - DAY, localMidnight]);
  assert.deepEqual(days.map((d) => d.waiting_ms / H), [0, 1, 2]);
  assert.deepEqual(days.map((d) => d.prompts), [0, 1, 1]);
  assert.deepEqual(days.map((d) => d.sessions), [0, 1, 1]);
});
