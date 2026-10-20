import type { DerivedSession } from './types.ts';

/**
 * Topic colors: four hues, chosen away from the state colors and validated as distinguishable in every pair
 * (more than four cannot be). Projects past the fourth get a neutral band; the name is always written on it.
 */
export const PROJECT_SLOTS = 4;

/** A project keeps its color while it has been active within this window, even with no session open right now. */
const HOLD_MS = 14 * 24 * 3600_000;
/** last_seen is refreshed at most this often, to keep writes rare. */
const TOUCH_MS = 3600_000;

export interface ProjectRow {
  repo: string;
  slot: number | null;
  last_seen: number;
}

/**
 * Gives each repository a stable color slot. Color follows the project, never its rank: a slot is only
 * reassigned after its project has been idle for HOLD_MS, so projects on screen are never repainted.
 * Returns the slot of every known repo and the rows to persist.
 */
export function planProjects(
  existing: ProjectRow[],
  sessions: DerivedSession[],
  now: number,
): { slots: Record<string, number | null>; changed: ProjectRow[] } {
  const rows = new Map(existing.map((r) => [r.repo, { ...r }]));
  const changed = new Map<string, ProjectRow>();
  const active = new Set(sessions.filter((s) => s.repo && s.state !== 'done').map((s) => s.repo!));
  const touch = (r: ProjectRow) => changed.set(r.repo, r);

  const held = (r: ProjectRow) => r.slot != null && (active.has(r.repo) || now - r.last_seen < HOLD_MS);
  const assign = (r: ProjectRow) => {
    const taken = new Set([...rows.values()].filter((o) => o !== r && held(o)).map((o) => o.slot));
    for (let slot = 0; slot < PROJECT_SLOTS; slot++) {
      if (taken.has(slot)) continue;
      // An idle project that still remembers this slot gives it up, so two projects never share a color.
      for (const o of rows.values()) {
        if (o !== r && o.slot === slot) {
          o.slot = null;
          touch(o);
        }
      }
      r.slot = slot;
      touch(r);
      return;
    }
    if (r.slot != null) {
      r.slot = null;
      touch(r);
    }
  };

  for (const s of sessions) {
    if (s.repo && !rows.has(s.repo)) {
      const r = { repo: s.repo, slot: null, last_seen: 0 };
      rows.set(s.repo, r);
      touch(r);
    }
  }
  // Most recently active first, so the projects you are working on get the colors.
  const order = [...active].sort((a, b) => lastActivity(sessions, b) - lastActivity(sessions, a));
  for (const repo of order) {
    const r = rows.get(repo)!;
    if (now - r.last_seen > TOUCH_MS) {
      r.last_seen = now;
      touch(r);
    }
  }
  for (const repo of order) {
    const r = rows.get(repo)!;
    if (r.slot == null || !isSlotUnique(rows, r)) assign(r);
  }

  return { slots: Object.fromEntries([...rows].map(([repo, r]) => [repo, r.slot])), changed: [...changed.values()] };
}

function isSlotUnique(rows: Map<string, ProjectRow>, r: ProjectRow): boolean {
  for (const o of rows.values()) if (o !== r && o.slot === r.slot) return false;
  return true;
}

function lastActivity(sessions: DerivedSession[], repo: string): number {
  return Math.max(...sessions.filter((s) => s.repo === repo).map((s) => s.last_activity_at));
}
