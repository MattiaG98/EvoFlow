import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyEvent, applySnapshot, normalizeRemoteId, toolActivity } from '../src/core/ingest.ts';
import { deriveSession } from '../src/core/state.ts';
import type { HookEnvelope, HookPayload, SessionRow } from '../src/core/types.ts';

// Payloads captured from a real Claude Code session (2.1.x), paths and ids anonymized.
const probe: HookPayload[] = readFileSync(new URL('./fixtures/hook-probe.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const envelope = (payload: HookPayload, meta: HookEnvelope['meta'] = {}): HookEnvelope => ({ v: 1, meta, payload });

function replay(payloads: HookPayload[], meta: HookEnvelope['meta'] = {}, upTo = payloads.length) {
  let row: SessionRow | null = null;
  let t = Date.parse('2026-10-19T12:00:00Z');
  const logs = [];
  for (const p of payloads.slice(0, upTo)) {
    const out = applyEvent(row, envelope(p, meta), (t += 1000));
    row = out.row;
    if (out.log) logs.push(out.log);
  }
  return { row: row!, logs, now: t };
}

test('the real event sequence goes working -> review -> done', () => {
  const states = [2, 3, 5, 6].map((n) => {
    const { row, now } = replay(probe, {}, n);
    return deriveSession(row, now).state;
  });
  assert.deepEqual(states, ['working', 'working', 'review', 'done']);
});

test('a real session keeps prompt, last answer and repo info', () => {
  const { row, logs } = replay(probe, { repo: 'demo/probe', branch: 'main', entrypoint: 'cli', host: 'mac' });
  assert.equal(row.key, probe[0].session_id);
  assert.equal(row.source, 'local');
  assert.match(row.first_prompt!, /echo probe/);
  assert.equal(row.last_message, 'done');
  assert.equal(row.repo, 'demo/probe');
  assert.equal(row.end_reason, 'other');
  // Tool calls are not logged; lifecycle events are.
  assert.deepEqual(logs.map((l) => l.event), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
});

test('cloud sessions are keyed by their claude.ai id', () => {
  const { row } = replay(probe.slice(0, 2), { remote_session_id: 'cse_01AbCdEf' });
  assert.equal(row.key, 'session_01AbCdEf');
  assert.equal(row.remote_id, 'session_01AbCdEf');
  assert.equal(row.source, 'cloud');
  assert.equal(normalizeRemoteId('session_01X'), 'session_01X');
  assert.equal(normalizeRemoteId('../evil'), null);
});

test('tool activity never carries command bodies or file contents', () => {
  const bash = toolActivity({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer SECRET" x' } });
  assert.equal(bash, 'Bash');
  const described = toolActivity({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } });
  assert.equal(described, 'Bash · Run tests');
  const edit = toolActivity({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b/c.ts', new_string: 'SECRET' } });
  assert.equal(edit, 'Edit · c.ts');
  assert.equal(toolActivity({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me' }), 'github · get_me');
});

test('an idle "waiting for your input" notification does not change the state', () => {
  const { row } = replay(probe.slice(0, 5));
  const idle = applyEvent(row, envelope({ session_id: row.key, hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }), Date.now());
  assert.equal(idle.row.last_event, 'Stop');
  assert.equal(idle.log, null);
  const perm = applyEvent(row, envelope({ session_id: row.key, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), Date.now());
  assert.equal(perm.row.last_event, 'Notification');
});

test('a subagent finishing after the turn ended does not flip the session back to working', () => {
  const { row } = replay(probe.slice(0, 5));
  const late = applyEvent(row, envelope({ session_id: row.key, hook_event_name: 'SubagentStop' }), Date.now());
  assert.equal(late.row.last_event, 'Stop');
});

test('a snapshot item from the sessions listing is parsed defensively', () => {
  const row = applySnapshot(
    null,
    {
      id: 'session_01Snap',
      title: 'Titolo',
      status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
      updated_at: '2026-09-08T14:46:24.320275Z',
      created_at: '2026-09-04T18:04:59.016680Z',
      origin: 'web_claude_ai',
      unread: true,
      session_context: { outcomes: [{ git_repository: { git_info: { repo: 'demo/pantry', branches: ['claude/x'] } } }] },
      post_turn_summary: { status_category: 'need_input', needs_action: 'run the tests' },
      external_metadata: { context_usage: { used_tokens: 293947, max_tokens: 1000000 }, usage: { cost_usd: 5.6 } },
    },
    Date.now(),
  )!;
  assert.equal(row.key, 'session_01Snap');
  assert.equal(row.repo, 'demo/pantry');
  assert.equal(row.branch, 'claude/x');
  assert.equal(row.snap_needs_action, 'run the tests');
  assert.equal(row.snap_unread, 1);
  assert.equal(row.context_used, 293947);
  assert.equal(applySnapshot(null, { id: 'nope', updated_at: 'x' }, Date.now()), null);
  assert.equal(applySnapshot(null, { id: 42 as unknown as string }, Date.now()), null);
});
