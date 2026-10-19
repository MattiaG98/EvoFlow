// EvoFlow dashboard: login, polling, the home (what to do now), the lists, actions, diary.

import * as api from './api.js';
import { buildCard, buildFocus, light, refreshTimes, timelineView } from './cards.js';
import { h, icon } from './dom.js';
import {
  ATTENTION,
  BAR_ORDER,
  STATES,
  STATE_ORDER,
  calmSummary,
  countPhrase,
  dateTime,
  duration,
  durationLong,
  freshnessText,
  todoUnit,
  workingPhrase,
} from './format.js';

const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const STALE_MS = 20_000;
const TIMELINE_HOURS = 12;
/** The timeline is refetched this often, and at once whenever a session changes state. */
const TIMELINE_MS = 30_000;

const $ = (id) => document.getElementById(id);
const ui = {
  login: $('login'),
  loginForm: $('login-form'),
  password: $('password'),
  loginError: $('login-error'),
  loginSubmit: $('login-submit'),
  dashboard: $('dashboard'),
  topbar: $('topbar'),
  hero: $('hero'),
  freshness: $('freshness'),
  liveLabel: $('live-label'),
  freshnessText: $('freshness-text'),
  offline: $('offline'),
  main: $('main'),
  loading: $('loading'),
  home: $('home'),
  summaryLive: $('summary-live'),
  todo: $('todo'),
  todoNum: $('todo-num'),
  todoUnit: $('todo-unit'),
  todoSentence: $('todo-sentence'),
  tiles: $('tiles'),
  bar: $('bar'),
  barTotal: $('bar-total'),
  focus: $('focus'),
  timelineStat: $('timeline-stat'),
  timelineBody: $('timeline-body'),
  filterNote: $('filter-note'),
  filterLabel: $('filter-label'),
  clearFilter: $('clear-filter'),
  tip: $('tip'),
  empty: $('empty'),
  board: $('board'),
  colAttention: $('col-attention'),
  colRest: $('col-rest'),
  lostBtn: $('lost-btn'),
  lostDialog: $('lost-dialog'),
  lostForm: $('lost-form'),
  lostNote: $('lost-note'),
  lostError: $('lost-error'),
  lostSubmit: $('lost-submit'),
  diaryDialog: $('diary-dialog'),
  diaryList: $('diary-list'),
  toasts: $('toasts'),
};

const state = {
  authed: false,
  /** Last SessionsResponse, possibly with optimistic edits applied. */
  data: null,
  /** Client clock when `data` arrived, and server minus client clock (relative times use the server's). */
  receivedAt: 0,
  offset: 0,
  filter: null,
  doneOpen: false,
  expanded: new Set(),
  /** Archive/restore requests in flight, by session key. */
  pending: new Map(),
  /** Session as it was before we archived it, so "Ripristina" can be shown optimistically. */
  beforeDismiss: new Map(),
  /** Bumped by every mutation: a poll that started before it may carry stale state and is dropped. */
  mutationSeq: 0,
  mutations: 0,
  /** The session shown on the "Adesso" card; "Dopo" moves it along the to-do queue. */
  focusKey: null,
  /** Last TimelineResponse, when it arrived, and the key:state map it was fetched for. */
  timeline: null,
  timelineAt: 0,
  statesSig: '',
};

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

const serverNow = () => Date.now() + state.offset;

// ---------- static structure: list sections, legend toggles, bar segments ----------

const sections = {};
const legend = {};
const segments = {};

for (const st of STATE_ORDER) {
  const meta = STATES[st];
  const count = h('span', { class: 'group-count' });
  const list = h('div', { class: 'cards', id: `cards-${st}` });
  let toggle = null;
  let title;
  if (st === 'done') {
    toggle = h(
      'button',
      { type: 'button', class: 'group-toggle', 'aria-expanded': 'false', 'aria-controls': list.id },
      h('span', {}, meta.heading),
      count,
      icon('disclosure', 'chevron'),
    );
    toggle.addEventListener('click', () => {
      state.doneOpen = !state.doneOpen;
      renderBoard();
    });
    title = h('h2', { class: 'group-title', id: `h-${st}` }, toggle);
  } else {
    title = h('h2', { class: 'group-title', id: `h-${st}` }, h('span', {}, meta.heading), count);
  }
  const section = h('section', { class: `group group-${st}${ATTENTION.has(st) ? ' is-attention' : ''}`, 'aria-labelledby': title.id, hidden: true }, title, list);
  sections[st] = { section, list, count, toggle };
  (ATTENTION.has(st) ? ui.colAttention : ui.colRest).append(section);
}

// Legend of the status bar, in the bar's order; each item is also the filter toggle for its state.
for (const st of BAR_ORDER) {
  const num = h('span', { class: 'tile-num' });
  const item = h(
    'button',
    { type: 'button', class: `tile tile-${st}`, 'aria-pressed': 'false' },
    light(st, st === 'working' ? ' is-pulsing' : ''),
    h('span', { class: 'tile-label' }, STATES[st].heading),
    num,
  );
  item.addEventListener('click', () => setFilter(state.filter === st ? null : st, { reveal: true }));
  legend[st] = { item, num };
  ui.tiles.append(item);
  if (st === 'done') continue;
  // Part-to-whole bar of the active sessions (done excluded). Pointer-only: the legend is its keyboard twin.
  const seg = h('span', { class: `bar-seg mark-${st}`, 'data-state': st, hidden: true });
  seg.addEventListener('click', (e) => {
    setFilter(state.filter === st ? null : st, { reveal: true });
    if (e.pointerType !== 'mouse') flashTip(seg);
  });
  segments[st] = seg;
  ui.bar.append(seg);
}
ui.clearFilter.addEventListener('click', () => setFilter(null));
ui.lostBtn.append(icon('compass'), h('span', {}, 'Mi sono perso'));

/** Filters the lists; `reveal` scrolls the filtered list into view when it is off screen. */
function setFilter(st, { reveal = false } = {}) {
  state.filter = st;
  renderSummary();
  renderBoard();
  if (!st || !reveal) return;
  const target = sections[st].section;
  if (target.getBoundingClientRect().top > window.innerHeight * 0.75) {
    target.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }
}

// ---------- rendering ----------

function render() {
  const d = state.data;
  ui.loading.hidden = d != null;
  if (!d) {
    ui.home.hidden = ui.board.hidden = ui.empty.hidden = ui.filterNote.hidden = true;
    return;
  }
  const empty = d.sessions.length === 0 && STATE_ORDER.every((st) => !d.counts[st]);
  ui.empty.hidden = !empty;
  ui.home.hidden = ui.board.hidden = empty;
  if (state.filter && !d.counts[state.filter]) state.filter = null;
  renderSummary();
  renderFocus();
  renderBoard();
  updateTitle();
  updateFreshness();
}

/** What needs you, most urgent first: waiting (oldest first), then failed, then forgotten. */
function todoQueue() {
  const order = ['waiting', 'failed', 'forgotten'];
  return order.flatMap((st) => state.data.sessions.filter((s) => s.state === st).sort((a, b) => a.since - b.since));
}

const todoCount = (counts) => (counts.waiting ?? 0) + (counts.failed ?? 0) + (counts.forgotten ?? 0);

/** The hero: one big number (things to do) and the one or two truest facts behind it. */
function renderTodo() {
  const counts = state.data.counts;
  const n = todoCount(counts);
  ui.todo.classList.toggle('is-calm', n === 0);
  setText(ui.todoNum, String(n));
  setText(ui.todoUnit, todoUnit(n));
  const facts = [];
  if (n > 0) {
    // Same priority as the "Adesso" queue: live waits first, then failures, then forgotten sessions.
    const now = serverNow();
    const age = (list) => {
      const oldest = Math.max(...list.map((s) => now - s.since));
      return oldest < 60_000 ? 'pochi secondi' : duration(oldest);
    };
    const waits = state.data.sessions.filter((s) => s.state === 'waiting');
    const forgotten = state.data.sessions.filter((s) => s.state === 'forgotten');
    if (waits.length) {
      facts.push(`${waits.length === 1 ? 'Aspetta' : 'La più vecchia aspetta'} da ${age(waits)}`);
    } else if (counts.failed) {
      facts.push(counts.failed === 1 ? 'Una sessione è fallita' : `${counts.failed} sessioni fallite`);
    } else {
      facts.push(`${forgotten.length === 1 ? 'Ferma' : 'La più vecchia è ferma'} da ${age(forgotten)}`);
    }
    if (counts.working) facts.push(workingPhrase(counts.working));
  } else {
    facts.push(workingPhrase(counts.working ?? 0));
    if (counts.review) facts.push(`${counts.review} da rivedere`);
  }
  // Each fact stays whole; the line may only wrap at a separator.
  const text = facts.join(' · ');
  if (ui.todoSentence.dataset.text === text) return;
  ui.todoSentence.dataset.text = text;
  ui.todoSentence.replaceChildren(...facts.flatMap((f, i) => [i ? ' · ' : '', h('span', { class: 'fact' }, f)]));
}

function renderSummary() {
  const counts = state.data.counts;
  renderTodo();

  for (const st of BAR_ORDER) {
    const { item, num } = legend[st];
    const n = counts[st] ?? 0;
    setText(num, String(n));
    item.setAttribute('aria-label', countPhrase(st, n));
    item.setAttribute('aria-pressed', String(state.filter === st));
    // Nothing to filter at zero: dimmed and out of the tab order.
    item.disabled = n === 0;
    item.classList.toggle('is-zero', n === 0);
  }

  // Status bar: widths proportional to counts, fixed order, outer ends rounded.
  const active = BAR_ORDER.filter((st) => st !== 'done' && counts[st] > 0);
  const total = active.reduce((sum, st) => sum + counts[st], 0);
  for (const [st, seg] of Object.entries(segments)) {
    const n = counts[st] ?? 0;
    seg.hidden = n === 0;
    seg.style.flexGrow = String(n);
    seg.dataset.tip = countPhrase(st, n);
    seg.classList.toggle('is-first', st === active[0]);
    seg.classList.toggle('is-last', st === active[active.length - 1]);
    seg.classList.toggle('is-dimmed', state.filter != null && state.filter !== st);
  }
  ui.bar.classList.toggle('is-empty', total === 0);
  ui.bar.setAttribute(
    'aria-label',
    total ? `${total} ${total === 1 ? 'sessione attiva' : 'sessioni attive'}: ${active.map((st) => countPhrase(st, counts[st])).join(', ')}` : 'Nessuna sessione attiva',
  );
  setText(ui.barTotal, `${total} ${total === 1 ? 'attiva' : 'attive'}`);

  ui.filterNote.hidden = !state.filter;
  setText(ui.filterLabel, state.filter ? `Solo: ${STATES[state.filter].heading}` : '');

  const n = todoCount(counts);
  const attention = STATE_ORDER.filter((st) => ATTENTION.has(st) && counts[st] > 0);
  setText(ui.summaryLive, n ? `${n} ${todoUnit(n)}: ${attention.map((st) => countPhrase(st, counts[st])).join(', ')}.` : `Tutto in ordine. ${calmSummary(counts)}`);
}

// ---------- "Adesso" focus card ----------

let focusSig = '';

function renderFocus() {
  const queue = todoQueue();
  if (!queue.length) {
    ui.focus.hidden = true;
    ui.focus.replaceChildren();
    focusSig = '';
    state.focusKey = null;
    return;
  }
  let i = queue.findIndex((s) => s.key === state.focusKey);
  if (i < 0) i = 0;
  const s = queue[i];
  state.focusKey = s.key;
  const next = [1, 2].map((k) => queue[(i + k) % queue.length]).filter((n, j, all) => n.key !== s.key && all.indexOf(n) === j);
  ui.focus.hidden = false;
  const sig = JSON.stringify([s, next.map((n) => [n.key, n.state, n.title, n.since]), i, queue.length]);
  if (sig === focusSig) return;
  focusSig = sig;
  const action = ui.focus.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  ui.focus.replaceChildren(buildFocus(s, { now: serverNow(), forgottenMs: state.data.config.forgottenMs, position: i + 1, total: queue.length, next }));
  if (action) ui.focus.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
}

ui.focus.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  const key = ui.focus.querySelector('.focus-card')?.dataset.key;
  if (!el || !key) return;
  const queue = todoQueue();
  const i = queue.findIndex((s) => s.key === key);
  const following = queue.length > 1 ? queue[(i + 1) % queue.length].key : null;
  if (el.dataset.action === 'next') {
    state.focusKey = following;
    renderFocus();
  } else if (el.dataset.action === 'dismiss') {
    state.focusKey = following;
    dismiss(key);
  } else if (el.dataset.action === 'goto') {
    gotoSession(el.dataset.key);
  }
});

// ---------- timeline ----------

let timelineInflight = false;

async function refreshTimeline() {
  if (!state.authed || timelineInflight) return;
  timelineInflight = true;
  try {
    const t = await api.getTimeline(TIMELINE_HOURS);
    if (!state.authed) return;
    state.timeline = t;
    state.timelineAt = Date.now();
    renderTimeline();
  } catch (err) {
    if (err instanceof api.AuthError) showLogin();
    // Otherwise keep showing the last timeline; the sessions poll reports connection problems.
  } finally {
    timelineInflight = false;
  }
}

function renderTimeline() {
  const t = state.timeline;
  if (!t) return;
  setText(ui.timelineStat, t.waiting_ms >= 60_000 ? `ti hanno aspettato ${durationLong(t.waiting_ms)}` : 'nessuna attesa');
  const focused = ui.timelineBody.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  ui.timelineBody.replaceChildren(
    t.lanes.length ? timelineView(t) : h('p', { class: 'timeline-empty' }, 'La cronologia appare quando arrivano gli eventi degli hook.'),
  );
  if (focused) ui.timelineBody.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

ui.timelineBody.addEventListener('click', (e) => {
  const lane = e.target.closest('[data-action="goto"]');
  if (lane) return gotoSession(lane.dataset.key);
  const seg = e.target.closest('[data-tip]');
  if (seg && e.pointerType !== 'mouse') flashTip(seg);
});

/** From the focus card or a timeline lane to the session's row: shown, expanded, scrolled to, focused. */
function gotoSession(key) {
  const s = findSession(key);
  if (!s) return;
  if (state.filter && state.filter !== s.state) setFilter(null);
  if (s.state === 'done') state.doneOpen = true;
  state.expanded.add(key);
  renderBoard();
  const card = cardCache.get(key)?.el;
  if (!card?.isConnected) return;
  setExpanded(card, key, true);
  card.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  card.querySelector('[data-action="toggle"]').focus({ preventScroll: true });
}

// ---------- tooltip for chart marks ----------

let tipTimer = 0;

function showTip(el, x) {
  const text = el.dataset.tip;
  if (!text) return;
  setText(ui.tip, text);
  ui.tip.hidden = false;
  const r = el.getBoundingClientRect();
  const cx = x ?? r.left + r.width / 2;
  const left = Math.min(window.innerWidth - ui.tip.offsetWidth - 8, Math.max(8, cx - ui.tip.offsetWidth / 2));
  const above = r.top - ui.tip.offsetHeight - 8;
  ui.tip.style.left = `${left}px`;
  ui.tip.style.top = `${above < 8 ? r.bottom + 8 : above}px`;
}

const hideTip = () => {
  ui.tip.hidden = true;
};

/** Touch has no hover: a tap shows the tooltip for a moment. */
function flashTip(el) {
  showTip(el);
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 2_500);
}

document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el, e.clientX);
  else if (!ui.tip.hidden) hideTip();
});
window.addEventListener('scroll', hideTip, { passive: true });

/** Card elements are reused while their session is unchanged, so focus and scroll survive each poll. */
const cardCache = new Map();

function cardFor(s, now) {
  const pending = state.pending.has(s.key);
  const sig = JSON.stringify(s) + (pending ? '|pending' : '');
  const hit = cardCache.get(s.key);
  if (hit?.sig === sig) return hit.el;
  const el = buildCard(s, { now, expanded: state.expanded.has(s.key), pending, forgottenMs: state.data.config.forgottenMs });
  cardCache.set(s.key, { sig, el });
  return el;
}

function renderBoard() {
  const d = state.data;
  const now = serverNow();
  const focus = rememberFocus();
  const byState = Object.fromEntries(STATE_ORDER.map((st) => [st, []]));
  for (const s of d.sessions) byState[s.state]?.push(s);

  const seen = new Set();
  for (const st of STATE_ORDER) {
    const { section, list, count, toggle } = sections[st];
    const total = Math.max(d.counts[st] ?? 0, byState[st].length);
    section.hidden = total === 0 || (state.filter != null && state.filter !== st);
    count.textContent = String(total);
    const open = st !== 'done' || state.doneOpen || state.filter === 'done';
    toggle?.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    if (section.hidden || !open) {
      list.replaceChildren();
      continue;
    }

    const els = byState[st].map((s) => {
      seen.add(s.key);
      return cardFor(s, now);
    });
    // The server returns at most the 50 most recent closed sessions.
    if (total > byState[st].length) els.push(h('p', { class: 'more-note' }, `Mostro le ${byState[st].length} più recenti su ${total}.`));
    syncChildren(list, els);
  }
  for (const key of cardCache.keys()) if (!seen.has(key)) cardCache.delete(key);

  const attentionShown = [...ATTENTION].some((st) => !sections[st].section.hidden);
  const restShown = STATE_ORDER.some((st) => !ATTENTION.has(st) && !sections[st].section.hidden);
  ui.colAttention.hidden = !attentionShown;
  ui.colRest.hidden = !restShown;
  // Two columns on wide screens ("needs you" | "everything else") only when both have something.
  ui.board.classList.toggle('split', attentionShown && restShown);
  restoreFocus(focus);
}

/** Moves only the children that changed position; untouched nodes keep focus and scroll. */
function syncChildren(parent, els) {
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > els.length) parent.lastElementChild.remove();
}

function rememberFocus() {
  const el = document.activeElement;
  const card = el?.closest?.('.card');
  return card ? { key: card.dataset.key, action: el.dataset.action } : null;
}

function restoreFocus(focus) {
  if (!focus || (document.activeElement && document.activeElement !== document.body)) return;
  const card = cardCache.get(focus.key)?.el;
  if (!card?.isConnected) return;
  const target = (focus.action && card.querySelector(`[data-action="${focus.action}"]:not([disabled])`)) || card.querySelector('[data-action="toggle"]');
  target?.focus({ preventScroll: true });
}

function updateTitle() {
  const n = state.data?.counts.waiting ?? 0;
  document.title = n ? `(${n}) EvoFlow` : 'EvoFlow';
  // Home-screen badge where supported (installed PWA on iOS 16.4+, Chromium).
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

/** The status line under the title: "● LIVE · AGGIORNATO 3 S FA"; the light turns red offline, grey when stale. */
function updateFreshness() {
  const offline = ui.freshness.classList.contains('is-offline');
  const label = offline ? 'Offline' : state.data ? 'Live' : 'Collegamento';
  if (ui.liveLabel.textContent !== label) ui.liveLabel.textContent = label;
  if (!state.data) return;
  const age = Date.now() - state.receivedAt;
  const text = freshnessText(age);
  if (ui.freshnessText.textContent !== text) ui.freshnessText.textContent = text;
  ui.freshness.classList.toggle('is-stale', age > STALE_MS);
}

function setOffline(offline) {
  const text = offline ? 'Connessione persa, riprovo…' : '';
  if (ui.offline.textContent !== text) ui.offline.textContent = text;
  ui.freshness.classList.toggle('is-offline', offline);
  ui.loading.textContent = offline ? 'Le sessioni compaiono appena torna la connessione.' : 'Carico le sessioni…';
  updateFreshness();
}

// iOS large title: the compact title and the bar material appear once the large title scrolls away.
if ('IntersectionObserver' in window) {
  // A hidden dashboard reports a zero-size title: that is not "scrolled away".
  new IntersectionObserver(([entry]) => ui.topbar.classList.toggle('is-scrolled', !entry.isIntersecting && entry.boundingClientRect.height > 0), {
    rootMargin: '-56px 0px 0px 0px',
  }).observe(ui.hero.querySelector('.large-title'));
}

// Bottom sheets stay above the on-screen keyboard (iOS does not resize the layout viewport).
if (window.visualViewport) {
  const vv = window.visualViewport;
  const syncKeyboard = () =>
    document.documentElement.style.setProperty('--keyboard', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', syncKeyboard);
  vv.addEventListener('scroll', syncKeyboard);
}

// Relative times and wait meters move on their own between polls.
setInterval(() => {
  if (!state.data || document.visibilityState !== 'visible') return;
  updateFreshness();
  renderTodo();
  refreshTimes(ui.main, serverNow());
}, 1_000);

// ---------- polling ----------

let timer = 0;
let inflight = null;
let again = false;
let failures = 0;

function apply(data) {
  state.data = data;
  state.receivedAt = Date.now();
  state.offset = data.now - state.receivedAt;
  render();
  // The timeline follows the sessions: refetched when any state changes, otherwise every TIMELINE_MS.
  const statesSig = data.sessions.map((s) => `${s.key}:${s.state}`).join('|');
  if (statesSig !== state.statesSig || Date.now() - state.timelineAt > TIMELINE_MS) {
    state.statesSig = statesSig;
    refreshTimeline();
  }
}

async function refresh() {
  if (!state.authed) return;
  if (inflight) {
    again = true;
    return inflight;
  }
  clearTimeout(timer);
  const seq = state.mutationSeq;
  inflight = (async () => {
    try {
      const data = await api.getSessions();
      failures = 0;
      setOffline(false);
      if (seq === state.mutationSeq && state.mutations === 0) apply(data);
    } catch (err) {
      if (err instanceof api.AuthError) return showLogin();
      failures++;
      setOffline(true);
    }
  })();
  await inflight;
  inflight = null;
  if (again) {
    again = false;
    return refresh();
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if (!state.authed || document.visibilityState !== 'visible') return;
  const delay = failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1)) : POLL_MS;
  timer = setTimeout(refresh, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
  else clearTimeout(timer);
});
window.addEventListener('focus', () => {
  if (Date.now() - state.receivedAt > 1_000) refresh();
});
window.addEventListener('online', () => refresh());
window.addEventListener('pageshow', (e) => e.persisted && refresh());

// ---------- card actions ----------

ui.board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const key = card.dataset.key;
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle') return setExpanded(card, key, !state.expanded.has(key));
  if (action === 'dismiss') return dismiss(key);
  if (action === 'restore') return restore(key);
  // Anywhere else on the card toggles too, except inside controls, the details, or while selecting text.
  if (e.target.closest('a, button, .details')) return;
  if (window.getSelection()?.toString()) return;
  setExpanded(card, key, !state.expanded.has(key));
});

function setExpanded(card, key, open) {
  if (open) state.expanded.add(key);
  else state.expanded.delete(key);
  card.classList.toggle('is-expanded', open);
  card.querySelector('.details').hidden = !open;
  card.querySelector('[data-action="toggle"]').setAttribute('aria-expanded', String(open));
}

const findSession = (key) => state.data?.sessions.find((s) => s.key === key);

/** Applies a local edit to one session and re-renders, keeping counts and section order consistent. */
function replaceSession(key, next) {
  const d = state.data;
  const prev = findSession(key);
  if (!prev) return;
  const rank = (st) => STATE_ORDER.indexOf(st);
  // Stable sort: within a state the server's order is kept.
  const sessions = d.sessions.map((s) => (s.key === key ? next : s)).sort((a, b) => rank(a.state) - rank(b.state));
  const counts = { ...d.counts, [prev.state]: d.counts[prev.state] - 1 };
  counts[next.state] = (counts[next.state] ?? 0) + 1;
  state.data = { ...d, sessions, counts };
  render();
}

async function dismiss(key) {
  await state.pending.get(key);
  const s = findSession(key);
  if (!s || s.dismissed) return;
  state.beforeDismiss.set(key, s);
  replaceSession(key, { ...s, state: 'done', reason: 'Archiviata da te', since: serverNow(), dismissed: true });
  toast('Archiviata', { label: 'Annulla', run: () => restore(key) });
  await mutate(key, () => api.dismiss(key), 'Non sono riuscito ad archiviarla. Riprova.');
}

async function restore(key) {
  // "Annulla" can be tapped while the archive request is still on its way.
  await state.pending.get(key);
  const s = findSession(key);
  if (!s || !s.dismissed) return;
  const before = state.beforeDismiss.get(key);
  if (before) replaceSession(key, before);
  await mutate(key, () => api.restore(key), 'Non sono riuscito a ripristinarla. Riprova.');
  state.beforeDismiss.delete(key);
}

function mutate(key, call, failure) {
  const run = (async () => {
    state.mutationSeq++;
    state.mutations++;
    try {
      await call();
    } catch (err) {
      if (err instanceof api.AuthError) return showLogin();
      toast(failure);
    } finally {
      state.mutations--;
      state.mutationSeq++;
      state.pending.delete(key);
    }
    // The server's answer is the truth: it also undoes the optimistic edit if the call failed.
    await refresh();
  })();
  state.pending.set(key, run);
  if (state.data) renderBoard();
  return run;
}

// ---------- toasts ----------

function toast(text, action) {
  const el = h('div', { class: 'toast' }, h('span', {}, text));
  let timeout = setTimeout(() => el.remove(), action ? 6_000 : 3_500);
  if (action) {
    el.append(
      h('button', { type: 'button', class: 'toast-action' }, action.label),
    );
    el.lastChild.addEventListener('click', () => {
      clearTimeout(timeout);
      el.remove();
      action.run();
    });
  }
  // Keep at most two on screen.
  while (ui.toasts.children.length >= 2) ui.toasts.firstElementChild.remove();
  ui.toasts.append(el);
}

// ---------- diary ----------

ui.lostBtn.addEventListener('click', () => {
  ui.lostNote.value = '';
  ui.lostError.textContent = '';
  ui.lostDialog.showModal();
});

ui.lostForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  ui.lostSubmit.disabled = true;
  ui.lostError.textContent = '';
  try {
    await api.addDiary(ui.lostNote.value.trim());
    ui.lostDialog.close();
    toast('Annotato');
  } catch (err) {
    if (err instanceof api.AuthError) return showLogin();
    ui.lostError.textContent = 'Non sono riuscito a salvare. Riprova.';
  } finally {
    ui.lostSubmit.disabled = false;
  }
});

async function openDiary() {
  ui.lostDialog.close();
  ui.diaryList.replaceChildren(h('p', { class: 'muted' }, 'Carico il diario…'));
  ui.diaryDialog.showModal();
  try {
    const { entries } = await api.getDiary();
    ui.diaryList.replaceChildren(
      entries.length
        ? h('ol', { class: 'diary' }, entries.map(diaryEntry))
        : h('p', { class: 'muted' }, 'Ancora nessuna annotazione. Quando perdi il filo, tocca «Mi sono perso».'),
    );
  } catch (err) {
    if (err instanceof api.AuthError) return showLogin();
    ui.diaryList.replaceChildren(h('p', { class: 'form-error' }, 'Non riesco a caricare il diario. Riprova tra poco.'));
  }
}

function diaryEntry(entry) {
  const ctx = entry.context ?? {};
  const moment = STATE_ORDER.filter((st) => ctx[st] > 0 && st !== 'done').map((st) => countPhrase(st, ctx[st], { past: true }));
  return h(
    'li',
    { class: 'diary-entry' },
    h('time', { datetime: new Date(entry.created_at).toISOString() }, dateTime(entry.created_at)),
    entry.note ? h('p', { class: 'diary-note' }, entry.note) : h('p', { class: 'diary-note muted' }, 'Nessuna nota'),
    moment.length ? h('p', { class: 'diary-context' }, `In quel momento: ${moment.join(' · ')}`) : null,
  );
}

$('diary-btn').addEventListener('click', openDiary);
for (const el of document.querySelectorAll('[data-open-diary]')) el.addEventListener('click', openDiary);
for (const el of document.querySelectorAll('[data-close]')) el.addEventListener('click', () => el.closest('dialog').close());
// A tap on the backdrop closes the sheet.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
}

// ---------- login / logout ----------

function showLogin() {
  state.authed = false;
  clearTimeout(timer);
  state.data = null;
  state.expanded.clear();
  state.focusKey = null;
  state.timeline = null;
  state.timelineAt = 0;
  state.statesSig = '';
  focusSig = '';
  cardCache.clear();
  for (const { list } of Object.values(sections)) list.replaceChildren();
  ui.focus.replaceChildren();
  ui.timelineBody.replaceChildren();
  setText(ui.timelineStat, '');
  hideTip();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  setOffline(false);
  document.title = 'EvoFlow';
  ui.dashboard.hidden = true;
  ui.login.hidden = false;
  ui.password.focus();
}

function showDashboard() {
  state.authed = true;
  ui.login.hidden = true;
  ui.dashboard.hidden = false;
  render();
}

ui.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = ui.password.value;
  ui.loginError.textContent = '';
  if (!password) {
    ui.loginError.textContent = 'Inserisci la password.';
    return ui.password.focus();
  }
  ui.loginSubmit.disabled = true;
  ui.loginSubmit.textContent = 'Entro…';
  try {
    await api.login(password);
    ui.password.value = '';
    showDashboard();
    await refresh();
  } catch (err) {
    ui.loginError.textContent =
      err instanceof api.AuthError
        ? 'Password errata. Riprova.'
        : err instanceof api.HttpError
          ? `Il server ha risposto: ${err.message}`
          : 'Server non raggiungibile. Riprova tra poco.';
    ui.password.select();
  } finally {
    ui.loginSubmit.disabled = false;
    ui.loginSubmit.textContent = 'Entra';
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    // The cookie dies with the server's answer; offline we just show the login again.
  }
  showLogin();
});

// ---------- boot ----------

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Assume a valid cookie and let the first poll decide: 401 shows the login, anything else the dashboard
// (offline included, with the banner).
state.authed = true;
refresh().then(() => state.authed && showDashboard());
