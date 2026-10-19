// Builds one session row of an inset grouped list. Pure DOM construction: behaviour lives in app.js
// (delegated clicks on data-action). The row keeps the class `card` for scripts and tests.

import { h, icon } from './dom.js';
import {
  ATTENTION,
  STATES,
  agoText,
  contextPercent,
  device,
  elapsedText,
  localizeReason,
  money,
  quietText,
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
 */
export function buildCard(s, { now, expanded, pending }) {
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

/** Re-renders every relative time under `root` against the given server-clock now. */
export function refreshTimes(root, now) {
  for (const el of root.querySelectorAll('[data-rel]')) {
    const ms = now - Number(el.dataset.t);
    const text = el.dataset.rel === 'elapsed' ? elapsedText(ms) : el.dataset.rel === 'quiet' ? quietText(ms) : agoText(ms);
    if (el.textContent !== text) el.textContent = text;
  }
}
