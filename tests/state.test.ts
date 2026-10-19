import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyRow } from '../src/core/ingest.ts';
import { countByState, deriveSession, sortSessions, trailingQuestion } from '../src/core/state.ts';
import { DEFAULT_CONFIG, type SessionRow } from '../src/core/types.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const H = 3600_000;

function row(patch: Partial<SessionRow>): SessionRow {
  return { ...emptyRow('k', 'cloud', NOW), started_at: NOW - H, ...patch };
}

test('a live permission request means the session waits on you', () => {
  const s = deriveSession(row({ last_event: 'Notification', last_event_at: NOW - 60_000, notification: 'Claude needs your permission to use Bash' }), NOW);
  assert.equal(s.state, 'waiting');
  assert.equal(s.reason, 'Claude needs your permission to use Bash');
});

test('a finished turn is review; one ending on a question is waiting', () => {
  const done = deriveSession(row({ last_event: 'Stop', last_event_at: NOW, last_message: 'Fatto: 14 test verdi.' }), NOW);
  assert.equal(done.state, 'review');
  const asks = deriveSession(row({ last_event: 'Stop', last_event_at: NOW, last_message: 'Ho tre varianti.\n\nQuale preferisci?\n' }), NOW);
  assert.equal(asks.state, 'waiting');
  assert.equal(asks.reason, 'Quale preferisci?');
});

test('waiting or review for longer than 48 h becomes forgotten', () => {
  const at = NOW - DEFAULT_CONFIG.forgottenMs - 1;
  assert.equal(deriveSession(row({ last_event: 'Stop', last_event_at: at, last_message: 'ok' }), NOW).state, 'forgotten');
  assert.equal(deriveSession(row({ last_event: 'Notification', last_event_at: at }), NOW).state, 'forgotten');
  assert.equal(deriveSession(row({ last_event: 'Stop', last_event_at: at + 2 }), NOW).state, 'review');
});

test('working since the prompt, flagged quiet after 15 min of silence', () => {
  const live = deriveSession(row({ last_event: 'PreToolUse', last_event_at: NOW - 60_000, last_prompt_at: NOW - 10 * 60_000, activity: 'Bash · Run tests' }), NOW);
  assert.equal(live.state, 'working');
  assert.equal(live.since, NOW - 10 * 60_000);
  assert.equal(live.reason, 'Bash · Run tests');
  assert.equal(live.quiet, false);
  const silent = deriveSession(row({ last_event: 'PreToolUse', last_event_at: NOW - 16 * 60_000 }), NOW);
  assert.equal(silent.quiet, true);
});

test('a newer snapshot wins over older hook data, and needs_action means waiting', () => {
  const s = deriveSession(
    row({
      last_event: 'Stop', last_event_at: NOW - 2 * H,
      snap_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', snap_updated_at: NOW - H,
      snap_needs_action: 'esegui i test in locale',
    }),
    NOW,
  );
  assert.equal(s.from_snapshot, true);
  assert.equal(s.state, 'waiting');
  assert.equal(s.reason, 'esegui i test in locale');
});

test('a live hook event wins over an older snapshot', () => {
  const s = deriveSession(
    row({ last_event: 'PreToolUse', last_event_at: NOW, snap_bucket: 'SESSION_STATUS_BUCKET_COMPLETED', snap_updated_at: NOW - H }),
    NOW,
  );
  assert.equal(s.from_snapshot, false);
  assert.equal(s.state, 'working');
});

test('snapshot buckets map to states', () => {
  const at = NOW - H;
  const state = (bucket: string) => deriveSession(row({ snap_bucket: `SESSION_STATUS_BUCKET_${bucket}`, snap_updated_at: at }), NOW).state;
  assert.equal(state('FAILED'), 'failed');
  assert.equal(state('WORKING'), 'working');
  assert.equal(state('COMPLETED'), 'done');
  assert.equal(state('REVIEW_READY'), 'review');
  assert.equal(state('BLOCKED'), 'waiting');
});

test('archiving lasts until the session does something new', () => {
  const base = { last_event: 'Stop', last_event_at: NOW - H, last_message: 'Vuoi che continui?' };
  const archived = deriveSession(row({ ...base, dismissed_at: NOW - 30 * 60_000 }), NOW);
  assert.equal(archived.state, 'done');
  assert.equal(archived.dismissed, true);
  const resumed = deriveSession(row({ ...base, last_event_at: NOW - 60_000, dismissed_at: NOW - 30 * 60_000 }), NOW);
  assert.equal(resumed.state, 'waiting');
  assert.equal(resumed.dismissed, false);
  const working = deriveSession(row({ last_event: 'PreToolUse', last_event_at: NOW - H, dismissed_at: NOW }), NOW);
  assert.equal(working.state, 'working');
  assert.equal(working.dismissed, false, 'a working session is never shown as archived');
});

test('session links point to claude.ai only for cloud sessions', () => {
  assert.equal(deriveSession(row({ remote_id: 'session_01Abc' }), NOW).url, 'https://claude.ai/code/session_01Abc');
  assert.equal(deriveSession(row({ source: 'local' }), NOW).url, null);
});

test('sorting: what needs you first, longest wait first', () => {
  const list = [
    deriveSession(row({ key: 'working', last_event: 'PreToolUse', last_event_at: NOW }), NOW),
    deriveSession(row({ key: 'wait-new', last_event: 'Notification', last_event_at: NOW - 60_000 }), NOW),
    deriveSession(row({ key: 'done', last_event: 'SessionEnd', last_event_at: NOW, ended_at: NOW }), NOW),
    deriveSession(row({ key: 'wait-old', last_event: 'Notification', last_event_at: NOW - H }), NOW),
  ];
  assert.deepEqual(sortSessions(list).map((s) => s.key), ['wait-old', 'wait-new', 'working', 'done']);
  assert.deepEqual(countByState(list), { waiting: 2, failed: 0, forgotten: 0, review: 0, working: 1, done: 1 });
});

test('question detection ignores markdown and only looks at the end', () => {
  assert.equal(trailingQuestion('**Procedo con il merge?**'), 'Procedo con il merge?');
  assert.equal(trailingQuestion('Perché? Perché sì.\nUno\nDue\nTre\nFatto.'), null);
  assert.equal(trailingQuestion(null), null);
});
