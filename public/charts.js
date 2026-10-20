// Charts: the 12-hour timeline, sessions per project, and the last 7 days of waiting.
// Thin marks, 2px surface gaps, 4px rounded data-ends, hairline gridlines, text in text tokens.
// Every mark has a tooltip (data-tip, shown by app.js) and every chart has a text equivalent.

import { h, light, swatch } from './dom.js';
import { BAR_ORDER, STATES, clock, countPhrase, dayLabel, durationLong, durationTotal, hoursCompact } from './format.js';

const HOUR = 3_600_000;
/** The active states, in the status bar's order (done excluded). */
const ACTIVE = BAR_ORDER.filter((st) => st !== 'done');

// ---------- timeline ----------

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Accessible summary of one lane, most recent first: "al lavoro da 24 min; prima da rivedere 2 h, …". */
function laneSummary(lane, to, topic) {
  const segs = lane.segments;
  const last = segs[segs.length - 1];
  const name = (st) => STATES[st].span.toLowerCase();
  const head = last.to >= to ? `${name(last.state)} da ${durationLong(to - last.from)}` : `${name(last.state)} ${durationLong(last.to - last.from)}, poi chiusa`;
  const before = segs
    .slice(0, -1)
    .reverse()
    .slice(0, 4)
    .map((g) => `${name(g.state)} ${durationLong(g.to - g.from)}`);
  return `${lane.title} (${topic.name}): ${head}${before.length ? `; prima ${before.join(', ')}` : ''}.`;
}

/**
 * The "Ultime 12 ore" chart: one lane per session, segments colored by state, gridlines every 3 h.
 * Lane labels carry the project swatch and short name; the plot itself only shows states.
 */
export function timelineView(t, topicOf) {
  const span = t.to - t.from;
  const hours = Math.round(span / HOUR);
  const pos = (ms) => ((ms - t.from) / span) * 100;
  const tickLabel = (f) => (f === 1 ? 'ora' : `−${Math.round(hours * (1 - f))} h`);

  const lanes = t.lanes.map((lane) => {
    const topic = topicOf(lane.repo);
    const track = h('div', { class: 'lane-track', role: 'img', 'aria-label': laneSummary(lane, t.to, topic) });
    lane.segments.forEach((g, i) => {
      const prev = lane.segments[i - 1];
      const seg = h('span', {
        class: `tl-seg mark-${g.state}${i === 0 ? ' is-start' : ''}${i === lane.segments.length - 1 ? ' is-end' : ''}${prev && prev.to >= g.from ? ' is-adjacent' : ''}`,
        'data-tip': `${STATES[g.state].span} · ${clock(g.from)}–${clock(g.to)} (${durationLong(g.to - g.from)})`,
      });
      seg.style.left = `${pos(g.from)}%`;
      seg.style.width = `${pos(g.to) - pos(g.from)}%`;
      track.append(seg);
    });
    return h(
      'li',
      { class: `lane${lane.state === 'done' ? ' is-done' : ''}` },
      h(
        'button',
        { type: 'button', class: `lane-label tone-${lane.state}`, 'data-action': 'goto', 'data-key': lane.key },
        light(lane.state),
        swatch(topic.slot),
        h('span', { class: 'lane-title' }, lane.title),
        h('span', { class: 'lane-project' }, topic.name),
      ),
      track,
    );
  });

  return h(
    'div',
    { class: 'tl' },
    h(
      'div',
      { class: 'tl-axis mono', 'aria-hidden': 'true' },
      h('span', { class: 'tl-axis-spacer' }),
      h('span', { class: 'tl-ticks' }, TICKS.map((f) => h('span', { class: 'tl-tick', style: `left:${f * 100}%` }, tickLabel(f)))),
    ),
    h(
      'div',
      { class: 'tl-plot' },
      h('div', { class: 'tl-grid', 'aria-hidden': 'true' }, TICKS.map((f) => h('span', { class: `tl-gridline${f === 1 ? ' is-now' : ''}`, style: `left:${f * 100}%` }))),
      h('ol', { class: 'tl-lanes' }, lanes),
    ),
  );
}

// ---------- per project ----------

const MAX_PROJECT_ROWS = 6;

/**
 * Groups active sessions by project: counts per state, to-dos (waiting + forgotten + failed) and total.
 * Sorted by to-dos, then total; past six rows the rest fold into "Altri (n)".
 */
export function projectRows(sessions, topicOf) {
  const byKey = new Map();
  for (const s of sessions) {
    if (s.state === 'done') continue;
    const topic = topicOf(s.repo);
    if (!byKey.has(topic.key)) byKey.set(topic.key, { topic, counts: Object.fromEntries(ACTIVE.map((st) => [st, 0])), todo: 0, total: 0 });
    const row = byKey.get(topic.key);
    row.counts[s.state]++;
    row.total++;
    if (s.state === 'waiting' || s.state === 'forgotten' || s.state === 'failed') row.todo++;
  }
  const rows = [...byKey.values()].sort((a, b) => b.todo - a.todo || b.total - a.total || a.topic.name.localeCompare(b.topic.name));
  if (rows.length <= MAX_PROJECT_ROWS) return rows;
  const kept = rows.slice(0, MAX_PROJECT_ROWS - 1);
  const rest = rows.slice(MAX_PROJECT_ROWS - 1);
  const other = { topic: { key: null, slot: null, name: `Altri (${rest.length})`, owner: '' }, counts: {}, todo: 0, total: 0, folded: true };
  for (const st of ACTIVE) other.counts[st] = rest.reduce((sum, r) => sum + r.counts[st], 0);
  for (const r of rest) {
    other.todo += r.todo;
    other.total += r.total;
  }
  return [...kept, other];
}

/** One horizontal stacked bar per project, on one shared scale; a row is the project filter toggle. */
export function projectChart(rows, { active }) {
  if (!rows.length) return h('p', { class: 'chart-empty' }, 'Nessuna sessione attiva.');
  const max = Math.max(...rows.map((r) => r.total));
  return h(
    'div',
    { class: 'pc' },
    h(
      'ul',
      { class: 'pc-rows' },
      rows.map((r) => {
        const states = ACTIVE.filter((st) => r.counts[st] > 0);
        const bar = h(
          'span',
          { class: 'pc-bar' },
          states.map((st, i) => {
            const seg = h('span', { class: `pc-seg mark-${st}${i === states.length - 1 ? ' is-end' : ''}`, 'data-tip': `${r.topic.name} · ${countPhrase(st, r.counts[st])}` });
            seg.style.flexGrow = String(r.counts[st]);
            return seg;
          }),
        );
        bar.style.setProperty('--r', String(r.total / max));
        const content = [
          h('span', { class: 'pc-label' }, swatch(r.topic.slot), h('span', { class: 'pc-name' }, r.topic.name)),
          h('span', { class: 'pc-track' }, bar, h('span', { class: 'pc-value mono' }, `${r.todo} da fare · ${r.total}`)),
        ];
        const summary = `${r.topic.name}: ${states.map((st) => countPhrase(st, r.counts[st])).join(', ')}; ${r.todo} da fare su ${r.total}.`;
        if (r.folded) return h('li', {}, h('div', { class: 'pc-row is-folded', role: 'img', 'aria-label': summary }, content));
        return h(
          'li',
          {},
          h(
            'button',
            { type: 'button', class: 'pc-row', 'data-action': 'project', 'data-repo': r.topic.key, 'aria-pressed': String(active === r.topic.key), 'aria-label': `${summary} Mostra solo questo progetto.` },
            content,
          ),
        );
      }),
    ),
    // Two or more series: a legend, in the bar's order. Hidden from AT: each row already reads its counts.
    h(
      'ul',
      { class: 'chart-legend', 'aria-hidden': 'true' },
      ACTIVE.map((st) => h('li', {}, h('span', { class: `legend-dot mark-${st}` }), STATES[st].heading)),
    ),
  );
}

// ---------- last 7 days ----------

/** Clean hour ticks: the smallest step that needs at most four intervals. */
function hourStep(maxHours) {
  return [1, 2, 3, 4, 6, 8, 12, 24].find((s) => maxHours / s <= 4) ?? 24;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "oggi 9 h · media 3 h 10 min": today against the average of the days before (omitted when all zero). */
export function weekStat(days) {
  const today = days[days.length - 1];
  const before = days.slice(0, -1);
  const parts = [`oggi ${durationTotal(today.waiting_ms)}`];
  if (before.some((d) => d.waiting_ms > 0)) parts.push(`media ${durationTotal(before.reduce((s, d) => s + d.waiting_ms, 0) / before.length)}`);
  return parts.join(' · ');
}

/**
 * Columns of time spent waiting on you, one per day. Emphasis form: today in the waiting mark color,
 * the other days in the de-emphasis gray. Value labels on today's cap, and on the max when it is another day.
 */
export function weekChart(days, { showTable, tableId }) {
  const hours = days.map((d) => d.waiting_ms / HOUR);
  const maxH = Math.max(0, ...hours);
  const step = hourStep(maxH);
  const top = Math.max(step, Math.ceil(maxH / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const today = days.length - 1;
  const maxIdx = hours.indexOf(maxH);
  const label = (v) => (v === 0 ? '0' : `${v} h`);
  const tip = (d) => `${dayLabel(d.start)} · ${durationTotal(d.waiting_ms)} di attesa · ${plural(d.prompts, 'messaggio', 'messaggi')} · ${plural(d.sessions, 'sessione', 'sessioni')}`;

  const cols = days.map((d, i) => {
    const pct = (hours[i] / top) * 100;
    const bar = h('span', { class: 'wk-bar' });
    bar.style.height = `${pct}%`;
    const showValue = i === today || (i === maxIdx && maxH > 0);
    const value = showValue ? h('span', { class: 'wk-value mono' }, hoursCompact(d.waiting_ms)) : null;
    if (value) value.style.bottom = `calc(${pct}% + 4px)`;
    return h('span', { class: `wk-col${i === today ? ' is-today' : ''}`, 'data-tip': tip(d) }, bar, value);
  });

  const summary = `Tempo di attesa per giorno, ultimi ${days.length} giorni: ${days.map((d, i) => `${i === today ? 'oggi' : dayLabel(d.start)} ${durationTotal(d.waiting_ms)}`).join(', ')}.`;
  return h(
    'div',
    { class: 'wk' },
    h(
      'div',
      { class: 'wk-plot', role: 'img', 'aria-label': summary },
      h('span', { class: 'wk-yaxis mono', 'aria-hidden': 'true' }, ticks.map((v) => h('span', { class: 'wk-tick', style: `bottom:${(v / top) * 100}%` }, label(v)))),
      h(
        'span',
        { class: 'wk-area' },
        ticks.map((v) => h('span', { class: `wk-grid${v === 0 ? ' is-base' : ''}`, style: `bottom:${(v / top) * 100}%` })),
        h('span', { class: 'wk-cols' }, cols),
      ),
    ),
    h(
      'div',
      { class: 'wk-xaxis mono', 'aria-hidden': 'true' },
      h('span', { class: 'wk-yspacer' }),
      h(
        'span',
        { class: 'wk-days' },
        days.map((d, i) => {
          const [wd, n] = dayLabel(d.start).split(' ');
          return h('span', { class: `wk-day${i === today ? ' is-today' : ''}` }, h('span', {}, wd), h('span', {}, n));
        }),
      ),
    ),
    h(
      'table',
      { class: 'wk-table', id: tableId, hidden: !showTable },
      h('caption', { class: 'sr-only' }, 'Attesa, messaggi e sessioni per giorno'),
      h('thead', {}, h('tr', {}, ['Giorno', 'Attesa', 'Messaggi', 'Sessioni'].map((c) => h('th', { scope: 'col' }, c)))),
      h(
        'tbody',
        {},
        days.map((d, i) =>
          h(
            'tr',
            { class: i === today ? 'is-today' : null },
            h('th', { scope: 'row' }, i === today ? `oggi (${dayLabel(d.start)})` : dayLabel(d.start)),
            h('td', { class: 'mono' }, durationTotal(d.waiting_ms)),
            h('td', { class: 'mono' }, String(d.prompts)),
            h('td', { class: 'mono' }, String(d.sessions)),
          ),
        ),
      ),
    ),
  );
}
