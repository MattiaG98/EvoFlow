// DOM builders for the home and the lists: session rows, the "Adesso" focus card, the wait meter and
// the 12-hour timeline. Pure construction: behaviour lives in app.js (delegated clicks on data-action).
// A session row keeps the class `card` for scripts and tests.

import { h, icon } from './dom.js';
import {
  ATTENTION,
  STATES,
  agoText,
  clock,
  contextPercent,
  device,
  durationLong,
  elapsedText,
  localizeReason,
  money,
  quietText,
  waitCaption,
} from './format.js';

const CONTEXT_WARN = 80;

/** Stable, attribute-safe id fragment for a session key. */
const domId = (key) => `s-${key.replace(/[^\w-]/g, '_')}`;

/** The status light: decorative, the row's state label carries the meaning in text. */
export const light = (state, extra = '') => h('span', { class: `light light-${state}${extra}`, 'aria-hidden': 'true' });

/**
 * @param s  a DerivedSession from GET /api/sessions
 * @param opts.now       server-clock "now", epoch ms
 * @param opts.expanded  details open
 * @param opts.pending   an archive/restore request for it is in flight
 * @param opts.forgottenMs  the "forgotten" threshold, for the wait meter
 */
export function buildCard(s, { now, expanded, pending, forgottenMs }) {
  const meta = STATES[s.state] ?? STATES.review;
  const id = domId(s.key);
  const dev = device(s.entrypoint, s.source);
  const attention = ATTENTION.has(s.state);
  const reason = s.reason ? localizeReason(s.reason) : '';

  return h(
    'article',
    {
      class: `card card-${s.state}${attention ? ' is-attention' : ''}${expanded ? ' is-expanded' : ''}`,
      'data-key': s.key,
      'aria-labelledby': `${id}-title`,
    },
    light(s.state, s.state === 'working' && !s.quiet ? ' is-pulsing' : ''),
    h(
      'div',
      { class: 'row-main' },
      // Line 1: title + how long it has been in this state, like a sender and a time in Mail.
      h(
        'div',
        { class: 'row-head' },
        h(
          'h3',
          { class: 'card-title', id: `${id}-title` },
          h(
            'button',
            { type: 'button', class: 'row-toggle', 'data-action': 'toggle', 'aria-expanded': String(expanded), 'aria-controls': `${id}-details` },
            s.title,
          ),
        ),
        h(
          'span',
          { class: 'row-time mono' },
          h('span', { class: 'sr-only' }, `${meta.label}, in questo stato da `),
          h('span', { 'data-rel': 'elapsed', 'data-t': s.since }, elapsedText(now - s.since)),
        ),
        icon('disclosure', 'row-chevron'),
      ),
      // Line 2: why it is in this state; for a permission request, also what it wants to run.
      reason && reason !== s.title ? h('p', { class: 'reason' }, reason) : null,
      s.state === 'waiting' && s.activity && s.activity !== s.reason
        ? h('p', { class: 'activity' }, h('span', { class: 'activity-label' }, 'Vuole eseguire'), h('code', {}, s.activity))
        : null,
      hasWait(s) ? waitMeter(s, forgottenMs, now) : null,
      // Line 3: state, device, repository; the quick "Apri" capsule on the right.
      h(
        'div',
        { class: 'row-foot' },
        h(
          'div',
          { class: 'row-meta mono' },
          h(
            'p',
            { class: 'meta-line' },
            h('span', { class: 'state-label' }, meta.label),
            h('span', { class: 'meta-device' }, icon(dev.icon), dev.label),
          ),
          repoLine(s),
        ),
        s.url
          ? h(
              'a',
              { class: 'capsule', href: s.url, target: '_blank', rel: 'noopener' },
              'Apri',
              h('span', { class: 'sr-only' }, ` in Claude: ${s.title} (si apre in una nuova scheda)`),
            )
          : null,
      ),
      badges(s, now),
      details(s, dev, { id, expanded, now, pending }),
    ),
  );
}

function repoLine(s) {
  if (!s.repo && !s.branch) return null;
  return h(
    'p',
    { class: 'repo' },
    s.repo ? h('span', { class: 'repo-name', title: s.repo }, s.repo) : null,
    s.repo && s.branch ? h('span', { class: 'repo-sep', 'aria-hidden': 'true' }, '·') : null,
    s.branch ? h('span', { class: 'repo-branch', title: s.branch }, s.branch) : null,
  );
}

/** Compact mono flags: only what deserves attention without opening the row. */
function badges(s, now) {
  const items = [];
  if (s.quiet) {
    items.push(h('span', { class: 'flag flag-warn' }, icon('alert'), h('span', { 'data-rel': 'quiet', 'data-t': s.last_activity_at }, quietText(now - s.last_activity_at))));
  }
  const pct = contextPercent(s.context_used, s.context_max);
  if (pct != null && pct >= CONTEXT_WARN) items.push(h('span', { class: 'flag flag-warn' }, icon('alert'), `Contesto ${pct}%, quasi pieno`));
  if (s.unread) items.push(h('span', { class: 'flag' }, 'Non letta'));
  if (s.from_snapshot) items.push(h('span', { class: 'flag' }, icon('snapshot'), 'dato non in tempo reale'));
  return items.length ? h('div', { class: 'flags mono' }, items) : null;
}

function details(s, dev, { id, expanded, now, pending }) {
  const blocks = [];
  if (s.last_prompt) {
    blocks.push(h('div', { class: 'qa' }, h('p', { class: 'qa-label' }, 'Hai chiesto:'), h('p', { class: 'qa-text' }, s.last_prompt)));
  }
  if (s.last_message) {
    blocks.push(
      h(
        'div',
        { class: 'qa' },
        h('p', { class: 'qa-label', id: `${id}-msg` }, 'Claude ha risposto:'),
        h('div', { class: 'qa-text qa-scroll', tabindex: '0', role: 'region', 'aria-labelledby': `${id}-msg` }, richText(s.last_message)),
      ),
    );
  }
  if (!blocks.length) {
    blocks.push(h('p', { class: 'muted' }, 'Nessun testo della conversazione: questa sessione è nota solo dalla sincronizzazione periodica.'));
  }

  // Spec sheet, in mono: the technical numbers.
  const specs = [];
  const pct = contextPercent(s.context_used, s.context_max);
  if (pct != null) {
    const high = pct >= CONTEXT_WARN;
    const fill = h('span', { class: 'ctx-fill' });
    fill.style.width = `${pct}%`;
    specs.push(['Contesto', h('span', { class: `ctx${high ? ' ctx-high' : ''}` }, h('span', {}, `${pct}%${high ? ', quasi pieno' : ''}`), h('span', { class: 'ctx-bar', 'aria-hidden': 'true' }, fill))]);
  }
  if (s.cost_usd != null) specs.push(['Costo', money(s.cost_usd)]);
  specs.push(['Host', s.host ?? (s.source === 'cloud' ? 'cloud' : '—')]);
  specs.push(['Dispositivo', s.entrypoint ? `${dev.label} (${s.entrypoint})` : dev.label]);
  specs.push(['Ultima attività', h('span', { 'data-rel': 'ago', 'data-t': s.last_activity_at }, agoText(now - s.last_activity_at))]);
  blocks.push(h('dl', { class: 'specs mono' }, specs.map(([k, v]) => h('div', { class: 'spec' }, h('dt', {}, k), h('dd', {}, v)))));

  if (s.from_snapshot) {
    blocks.push(
      h('p', { class: 'hint' }, icon('snapshot'), 'Stato ricavato dalla sincronizzazione periodica con claude.ai, non da un evento in diretta: può essere indietro di qualche minuto.'),
    );
  }
  blocks.push(actions(s, dev, pending));
  return h('div', { class: 'details', id: `${id}-details`, hidden: !expanded }, blocks);
}

function actions(s, dev, pending) {
  const open = s.url
    ? h(
        'a',
        { class: 'btn btn-filled', href: s.url, target: '_blank', rel: 'noopener' },
        'Apri in Claude',
        icon('external'),
        h('span', { class: 'sr-only' }, '(si apre in una nuova scheda)'),
      )
    : h('p', { class: 'local-note' }, icon(dev.icon), s.host ? `Sessione locale su ${s.host}` : 'Sessione locale');

  let archive = null;
  if (s.dismissed) {
    archive = h('button', { type: 'button', class: 'btn btn-plain', 'data-action': 'restore', disabled: pending }, icon('restore'), pending ? 'Ripristino…' : 'Ripristina');
  } else if (s.state !== 'working' && s.state !== 'done') {
    archive = h('button', { type: 'button', class: 'btn btn-plain', 'data-action': 'dismiss', disabled: pending }, icon('archive'), 'Archivia');
  }
  return h('div', { class: 'row-actions' }, open, archive);
}

// ---------- wait meter ----------

const HOUR = 3_600_000;
const hasWait = (s) => s.state === 'waiting' || s.state === 'forgotten';

/** Meter geometry and text for a wait that began at `since`. */
function waitValues(since, forgottenMs, now) {
  const age = Math.max(0, now - since);
  const over = age >= forgottenMs;
  return {
    pct: Math.min(100, (age / forgottenMs) * 100),
    over,
    hours: Math.min(forgottenMs, age) / HOUR,
    caption: waitCaption(age, forgottenMs),
  };
}

/**
 * Thin meter of the wait age toward the "forgotten" threshold. The fill carries severity (waiting tint,
 * forgotten tint past the threshold); the track is a lighter step of the same hue. Kept live by refreshTimes.
 */
export function waitMeter(s, forgottenMs, now, size = 'row') {
  const v = waitValues(s.since, forgottenMs, now);
  const fill = h('span', { class: 'meter-fill' });
  fill.style.width = `${v.pct}%`;
  return h(
    'div',
    { class: `wait wait-${size}${v.over ? ' is-over' : ''}`, 'data-wait': s.since, 'data-max': forgottenMs },
    h(
      'div',
      {
        class: 'meter',
        role: 'meter',
        'aria-label': 'Attesa',
        'aria-valuemin': '0',
        'aria-valuemax': String(Math.round(forgottenMs / HOUR)),
        'aria-valuenow': v.hours.toFixed(1),
        'aria-valuetext': v.caption,
      },
      fill,
    ),
    h('p', { class: 'wait-caption mono' }, v.caption),
  );
}

// ---------- "Adesso" focus card ----------

/**
 * The single most urgent session, large: what it asks, how long it has waited, and what to do.
 * @param opts.position  1-based index in the to-do queue; opts.total its length
 * @param opts.next      up to two sessions that come after it
 */
export function buildFocus(s, { now, forgottenMs, position, total, next }) {
  const dev = device(s.entrypoint, s.source);
  const reason = s.reason ? localizeReason(s.reason) : '';
  const open = s.url
    ? h('a', { class: 'btn btn-filled btn-large btn-block', href: s.url, target: '_blank', rel: 'noopener' }, 'Apri in Claude', icon('external'), h('span', { class: 'sr-only' }, '(si apre in una nuova scheda)'))
    : h('p', { class: 'local-note focus-local' }, icon(dev.icon), s.host ? `Sessione locale su ${s.host}` : 'Sessione locale');
  return h(
    'div',
    { class: `focus-card tone-${s.state}`, 'data-key': s.key },
    h(
      'p',
      { class: 'focus-eyebrow mono' },
      light(s.state),
      h('span', { class: 'focus-now' }, 'Adesso'),
      h('span', { class: 'focus-state' }, STATES[s.state].label),
      total > 1 ? h('span', { class: 'focus-pos' }, `${position} di ${total}`) : null,
    ),
    h('h3', { class: 'focus-title' }, s.title),
    reason && reason !== s.title ? h('p', { class: 'focus-reason' }, reason) : null,
    s.state === 'waiting' && s.activity && s.activity !== s.reason
      ? h('p', { class: 'activity' }, h('span', { class: 'activity-label' }, 'Vuole eseguire'), h('code', {}, s.activity))
      : null,
    hasWait(s)
      ? waitMeter(s, forgottenMs, now, 'focus')
      : h('p', { class: 'wait-caption mono' }, `${STATES[s.state].label} `, h('span', { 'data-rel': 'ago', 'data-t': s.since }, agoText(now - s.since))),
    open,
    h(
      'div',
      { class: 'focus-actions' },
      total > 1 ? h('button', { type: 'button', class: 'btn btn-tinted', 'data-action': 'next' }, 'Dopo', icon('disclosure')) : null,
      h('button', { type: 'button', class: 'btn btn-plain', 'data-action': 'dismiss' }, icon('archive'), 'Archivia'),
    ),
    next.length
      ? h(
          'div',
          { class: 'focus-next' },
          h('p', { class: 'focus-next-label mono' }, 'Poi:'),
          h(
            'ul',
            {},
            next.map((n) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', class: `next-row tone-${n.state}`, 'data-action': 'goto', 'data-key': n.key },
                  light(n.state),
                  h('span', { class: 'next-title' }, n.title),
                  h('span', { class: 'sr-only' }, `, ${STATES[n.state].label.toLowerCase()} da `),
                  h('span', { class: 'next-time mono', 'data-rel': 'elapsed', 'data-t': n.since }, elapsedText(now - n.since)),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

// ---------- timeline ----------

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Accessible summary of one lane, most recent first: "al lavoro da 24 min; prima da rivedere 2 h, …". */
function laneSummary(lane, to) {
  const segs = lane.segments;
  const last = segs[segs.length - 1];
  const name = (st) => STATES[st].span.toLowerCase();
  const head = last.to >= to ? `${name(last.state)} da ${durationLong(to - last.from)}` : `${name(last.state)} ${durationLong(last.to - last.from)}, poi chiusa`;
  const before = segs
    .slice(0, -1)
    .reverse()
    .slice(0, 4)
    .map((g) => `${name(g.state)} ${durationLong(g.to - g.from)}`);
  return `${lane.title}: ${head}${before.length ? `; prima ${before.join(', ')}` : ''}.`;
}

/** The "Ultime 12 ore" chart: one lane per session, segments colored by state, gridlines every 3 h. */
export function timelineView(t) {
  const span = t.to - t.from;
  const hours = Math.round(span / HOUR);
  const pos = (ms) => ((ms - t.from) / span) * 100;
  const tickLabel = (f) => (f === 1 ? 'ora' : `\u2212${Math.round(hours * (1 - f))} h`);

  const lanes = t.lanes.map((lane) => {
    const track = h('div', { class: 'lane-track', role: 'img', 'aria-label': laneSummary(lane, t.to) });
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
        h('span', { class: 'lane-title' }, lane.title),
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

/** Message text with line breaks kept; **bold** and `code` rendered, everything else literal. */
function richText(text) {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)
    .filter(Boolean)
    .map((part) => {
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h('strong', {}, part.slice(2, -2));
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return h('code', {}, part.slice(1, -1));
      return part;
    });
}

/** Re-renders every relative time and wait meter under `root` against the given server-clock now. */
export function refreshTimes(root, now) {
  for (const el of root.querySelectorAll('[data-rel]')) {
    const ms = now - Number(el.dataset.t);
    const text = el.dataset.rel === 'elapsed' ? elapsedText(ms) : el.dataset.rel === 'quiet' ? quietText(ms) : agoText(ms);
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of root.querySelectorAll('[data-wait]')) {
    const v = waitValues(Number(el.dataset.wait), Number(el.dataset.max), now);
    const caption = el.querySelector('.wait-caption');
    if (caption.textContent === v.caption) continue;
    caption.textContent = v.caption;
    el.classList.toggle('is-over', v.over);
    el.querySelector('.meter-fill').style.width = `${v.pct}%`;
    const meter = el.querySelector('.meter');
    meter.setAttribute('aria-valuenow', v.hours.toFixed(1));
    meter.setAttribute('aria-valuetext', v.caption);
  }
}
