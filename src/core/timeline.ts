import type { LogEntry } from './ingest.ts';
import { trailingQuestion } from './state.ts';
import { STATE_ORDER, type DerivedSession, type State, type StateConfig, type TimelineResponse, type TimelineSegment } from './types.ts';

const MAX_LANES = 10;

/** The state a lifecycle event leaves the session in, or null when it changes nothing. */
function stateAfter(entry: LogEntry): State | null {
  switch (entry.event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';
    case 'Notification':
      return 'waiting';
    case 'Stop':
      return trailingQuestion(entry.summary) ? 'waiting' : 'review';
    case 'SessionStart':
      return 'review';
    case 'SessionEnd':
      return 'done';
    default:
      return null;
  }
}

/**
 * Rebuilds each session's recent history from the event log: one lane per session, one segment per state.
 * Waiting and review stretches turn "forgotten" past the threshold, as on the dashboard.
 * Sessions known only from snapshots have no log and get no lane.
 */
export function buildTimeline(
  events: LogEntry[],
  sessions: DerivedSession[],
  from: number,
  to: number,
  cfg: StateConfig,
): TimelineResponse {
  const byKey = new Map<string, LogEntry[]>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key)!.push(e);
  }
  const info = new Map(sessions.map((s) => [s.key, s]));

  const lanes = [];
  let waitingMs = 0;
  for (const [key, entries] of byKey) {
    const session = info.get(key);
    if (!session) continue;
    const raw: TimelineSegment[] = [];
    let current = null as { state: State; from: number } | null;
    for (const e of entries) {
      // A resume or /clear mid-history doesn't change what the session was doing.
      if (e.event === 'SessionStart' && current) continue;
      const next = stateAfter(e);
      if (!next || next === current?.state) continue;
      if (current) raw.push({ state: current.state, from: current.from, to: e.at });
      current = next === 'done' ? null : { state: next, from: e.at };
    }
    if (current) raw.push({ state: current.state, from: current.from, to });

    const segments: TimelineSegment[] = [];
    for (const seg of raw.flatMap((s) => splitForgotten(s, cfg))) {
      const clipped = { ...seg, from: Math.max(seg.from, from), to: Math.min(seg.to, to) };
      if (clipped.to <= clipped.from) continue;
      segments.push(clipped);
      if (clipped.state === 'waiting' || clipped.state === 'forgotten') waitingMs += clipped.to - clipped.from;
    }
    if (segments.length) {
      lanes.push({ key, title: session.title, state: session.state, last: segments[segments.length - 1].to, segments });
    }
  }

  lanes.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.last - a.last);
  return {
    from,
    to,
    waiting_ms: waitingMs,
    lanes: lanes.slice(0, MAX_LANES).map(({ last: _last, ...lane }) => lane),
  };
}

function splitForgotten(seg: TimelineSegment, cfg: StateConfig): TimelineSegment[] {
  if (seg.state !== 'waiting' && seg.state !== 'review') return [seg];
  const turn = seg.from + cfg.forgottenMs;
  if (seg.to <= turn) return [seg];
  return [
    { state: seg.state, from: seg.from, to: turn },
    { state: 'forgotten', from: turn, to: seg.to },
  ];
}
