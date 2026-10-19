// Builds one session card. Pure DOM construction: behaviour lives in app.js (delegated clicks on data-action).

import { h, icon } from './dom.js';
import {
  ATTENTION,
  STATES,
  agoText,
  contextPercent,
  device,
  localizeReason,
  money,
  quietText,
  sinceText,
} from './format.js';

const CONTEXT_WARN = 80;

/** Stable, attribute-safe id fragment for a session key. */
const domId = (key) => `s-${key.replace(/[^\w-]/g, '_')}`;

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

  const card = h(
    'article',
    {
      class: `card card-${s.state}${attention ? ' card-attention' : ''}${s.quiet ? ' card-quiet-warn' : ''}${expanded ? ' is-expanded' : ''}`,
      'data-key': s.key,
      'aria-labelledby': `${id}-title`,
    },
    h(
      'div',
      { class: 'card-head' },
      h(
        'span',
        { class: 'badge' },
        icon(s.state),
        h('span', { class: 'badge-label' }, meta.label),
        h('span', { class: 'badge-time', 'data-rel': 'since', 'data-t': s.since }, sinceText(now - s.since)),
      ),
      h('span', { class: 'device' }, icon(dev.icon), dev.label),
    ),
    h('h3', { class: 'card-title', id: `${id}-title` }, s.title),
    reason && reason !== s.title ? h('p', { class: 'reason' }, reason) : null,
    // For a permission request, what it wants to run is the actionable detail.
    s.state === 'waiting' && s.activity && s.activity !== s.reason
      ? h('p', { class: 'activity' }, h('span', { class: 'activity-label' }, 'Vuole eseguire'), h('span', { class: 'mono' }, s.activity))
      : null,
    s.quiet
      ? h('p', { class: 'warn' }, icon('alert'), h('span', { 'data-rel': 'quiet', 'data-t': s.last_activity_at }, quietText(now - s.last_activity_at)))
      : null,
    repoLine(s),
    statsRow(s),
    actions(s, dev, { id, expanded, pending }),
    details(s, dev, { id, expanded, now }),
  );
  return card;
}

function repoLine(s) {
  if (!s.repo && !s.branch) return null;
  return h(
    'p',
    { class: 'repo mono' },
    s.repo ? h('span', { class: 'repo-name', title: s.repo }, s.repo) : null,
    s.repo && s.branch ? h('span', { class: 'repo-sep', 'aria-hidden': 'true' }, '·') : null,
    s.branch ? h('span', { class: 'repo-branch', title: s.branch }, s.branch) : null,
  );
}

function statsRow(s) {
  const items = [];
  const pct = contextPercent(s.context_used, s.context_max);
  if (pct != null) {
    const high = pct >= CONTEXT_WARN;
    const fill = h('span', { class: 'ctx-fill' });
    fill.style.width = `${pct}%`;
    items.push(
      h(
        'span',
        { class: `ctx${high ? ' ctx-high' : ''}` },
        high ? icon('alert') : null,
        h('span', {}, `Contesto ${pct}%${high ? ', quasi pieno' : ''}`),
        h('span', { class: 'ctx-bar', 'aria-hidden': 'true' }, fill),
      ),
    );
  }
  if (s.cost_usd != null) items.push(h('span', { class: 'cost' }, h('span', { class: 'sr-only' }, 'Costo '), money(s.cost_usd)));
  if (s.unread) items.push(h('span', { class: 'tag tag-unread' }, 'Non letta'));
  if (s.from_snapshot) items.push(h('span', { class: 'hint' }, icon('snapshot'), 'dato non in tempo reale'));
  return items.length ? h('div', { class: 'stats' }, items) : null;
}

function actions(s, dev, { id, expanded, pending }) {
  // Strong "Apri" only where the user is expected to act; quieter on working/done cards.
  const strong = s.state !== 'working' && s.state !== 'done';
  const open = s.url
    ? h(
        'a',
        { class: `btn ${strong ? 'btn-primary' : 'btn-secondary'}`, href: s.url, target: '_blank', rel: 'noopener' },
        'Apri in Claude',
        icon('external'),
        h('span', { class: 'sr-only' }, '(si apre in una nuova scheda)'),
      )
    : h('span', { class: 'local-note' }, icon(dev.icon), s.host ? `Sessione locale su ${s.host}` : 'Sessione locale');

  let archive = null;
  if (s.dismissed) {
    archive = h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'restore', disabled: pending }, icon('restore'), pending ? 'Ripristino…' : 'Ripristina');
  } else if (s.state !== 'working' && s.state !== 'done') {
    archive = h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'dismiss', disabled: pending }, icon('archive'), 'Archivia');
  }

  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-icon toggle',
      'data-action': 'toggle',
      'aria-expanded': String(expanded),
      'aria-controls': `${id}-details`,
      'aria-label': 'Dettagli',
      title: 'Dettagli',
    },
    icon('chevron'),
  );
  return h('div', { class: 'actions' }, h('div', { class: 'actions-main' }, open, archive), toggle);
}

function details(s, dev, { id, expanded, now }) {
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

  const facts = [
    ['Host', s.host ?? (s.source === 'cloud' ? 'cloud' : '—')],
    ['Dispositivo', s.entrypoint ? `${dev.label} (${s.entrypoint})` : dev.label],
    ['Ultima attività', h('span', { 'data-rel': 'ago', 'data-t': s.last_activity_at }, agoText(now - s.last_activity_at))],
  ];
  blocks.push(h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));

  if (s.from_snapshot) {
    blocks.push(
      h('p', { class: 'hint hint-block' }, icon('snapshot'), 'Stato ricavato dalla sincronizzazione periodica con claude.ai, non da un evento in diretta: può essere indietro di qualche minuto.'),
    );
  }
  return h('div', { class: 'details', id: `${id}-details`, hidden: !expanded }, blocks);
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
    const text = el.dataset.rel === 'since' ? sinceText(ms) : el.dataset.rel === 'quiet' ? quietText(ms) : agoText(ms);
    if (el.textContent !== text) el.textContent = text;
  }
}
