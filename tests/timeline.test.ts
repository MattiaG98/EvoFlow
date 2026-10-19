import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyRow, type LogEntry } from '../src/core/ingest.ts';
import { deriveSession } from '../src/core/state.ts';
import { buildTimeline } from '../src/core/timeline.ts';
import { DEFAULT_CONFIG } from '../src/core/types.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60_000;
const H = 60 * MIN;
const log = (key: string, minutesAgo: number, event: string, summary = ''): LogEntry => ({ key, at: NOW - minutesAgo * MIN, event, summary });
const session = (key: string, last_event: string) =>
  deriveSession({ ...emptyRow(key, 'cloud', NOW), title: key, last_event, last_event_at: NOW - MIN }, NOW);

test('lifecycle events become colored segments, clipped to the window', () => {
  const events = [
    log('a', 300, 'UserPromptSubmit'), // before the window: work already under way at its left edge
    log('a', 100, 'Notification', 'needs permission'),
    log('a', 90, 'PostToolUse', 'Bash'), // work resumes after the permission
    log('a', 30, 'Stop', 'Quale preferisci?'),
  ];
  const t = buildTimeline(events, [session('a', 'Stop')], NOW - 2 * H, NOW, DEFAULT_CONFIG);
  assert.deepEqual(
    t.lanes[0].segments.map((s) => [s.state, (s.from - (NOW - 2 * H)) / MIN, (s.to - (NOW - 2 * H)) / MIN]),
    [
      ['working', 0, 20],
      ['waiting', 20, 30],
      ['working', 30, 90],
      ['waiting', 90, 120],
    ],
  );
  assert.equal(t.waiting_ms, 40 * MIN);
});

test('an ended session stops at SessionEnd; a long wait turns forgotten after the threshold', () => {
  const events = [
    log('ended', 50, 'UserPromptSubmit'),
    log('ended', 40, 'Stop', 'Fatto.'),
    log('ended', 20, 'SessionEnd'),
    log('old', 49 * 60, 'Notification', 'permesso'),
  ];
  const t = buildTimeline(events, [session('ended', 'SessionEnd'), session('old', 'Notification')], NOW - 2 * H, NOW, DEFAULT_CONFIG);
  const lane = (k: string) => t.lanes.find((l) => l.key === k)!.segments.map((s) => s.state);
  assert.deepEqual(lane('ended'), ['working', 'review']);
  assert.equal(t.lanes.find((l) => l.key === 'ended')!.segments.at(-1)!.to, NOW - 20 * MIN);
  assert.deepEqual(lane('old'), ['waiting', 'forgotten']);
});

test('lanes are ordered by what needs you first; sessions without a log get no lane', () => {
  const events = [log('working', 10, 'UserPromptSubmit'), log('waiting', 10, 'Notification')];
  const t = buildTimeline(events, [session('working', 'PreToolUse'), session('waiting', 'Notification'), session('snapshot-only', 'Stop')], NOW - H, NOW, DEFAULT_CONFIG);
  assert.deepEqual(t.lanes.map((l) => l.key), ['waiting', 'working']);
});

test('a long answer ending on a question is logged as that question, so the timeline shows waiting', async () => {
  const { applyEvent } = await import('../src/core/ingest.ts');
  const long = 'Ho preparato tre varianti in `src/hero.tsx`:\n\n' + '1. **Una variante piuttosto lunga del titolo**\n'.repeat(5) + '\nQuale preferisci?';
  const { log: entry } = applyEvent(null, { v: 1, meta: {}, payload: { session_id: 'q', hook_event_name: 'Stop', last_assistant_message: long } }, NOW - 10 * MIN);
  const t = buildTimeline([log('q', 20, 'UserPromptSubmit'), entry!], [session('q', 'Stop')], NOW - H, NOW, DEFAULT_CONFIG);
  assert.deepEqual(t.lanes[0].segments.map((s) => s.state), ['working', 'waiting']);
});

test('a session resumed mid-history keeps its state instead of flashing idle', () => {
  const events = [log('r', 50, 'UserPromptSubmit'), log('r', 40, 'SessionStart'), log('r', 30, 'Stop', 'Fatto.')];
  const t = buildTimeline(events, [session('r', 'Stop')], NOW - H, NOW, DEFAULT_CONFIG);
  assert.deepEqual(t.lanes[0].segments.map((s) => s.state), ['working', 'review']);
});
