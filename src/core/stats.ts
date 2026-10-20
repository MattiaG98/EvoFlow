import type { LogEntry } from './ingest.ts';
import { isWaiting, sessionLanes } from './timeline.ts';
import type { DerivedSession, StateConfig, StatsResponse } from './types.ts';

const DAY = 24 * 3600_000;

/**
 * Daily totals for the last `days` local calendar days (today included).
 * `tzOffsetMin` is the client's Date#getTimezoneOffset(): minutes to add to local time to get UTC.
 */
export function dailyStats(
  events: LogEntry[],
  sessions: DerivedSession[],
  now: number,
  days: number,
  tzOffsetMin: number,
  cfg: StateConfig,
): StatsResponse {
  const offset = tzOffsetMin * 60_000;
  const today = Math.floor((now - offset) / DAY) * DAY + offset;
  const starts = Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY);
  const lanes = sessionLanes(events, sessions, starts[0], now, cfg);

  return {
    days: starts.map((start) => {
      const end = Math.min(start + DAY, now);
      let waiting = 0;
      let active = 0;
      for (const lane of lanes) {
        let worked = false;
        for (const seg of lane.segments) {
          const overlap = Math.min(seg.to, end) - Math.max(seg.from, start);
          if (overlap <= 0) continue;
          if (isWaiting(seg)) waiting += overlap;
          if (seg.state === 'working') worked = true;
        }
        if (worked) active++;
      }
      const prompts = events.filter((e) => e.event === 'UserPromptSubmit' && e.at >= start && e.at < end).length;
      return { start, waiting_ms: waiting, prompts, sessions: active };
    }),
  };
}
