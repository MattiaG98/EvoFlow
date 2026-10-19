// Italian copy and formatting: state labels, plurals, relative times, money, devices.

/** Same order as STATE_ORDER in src/core/types.ts: what needs you first. */
export const STATE_ORDER = ['waiting', 'failed', 'forgotten', 'review', 'working', 'done'];

/** The states that need the user now. */
export const ATTENTION = new Set(['waiting', 'failed', 'forgotten']);

/** Order of the part-to-whole bar and its legend. Forgotten (indigo) must not sit next to review (blue): that pair fails CVD separation. */
export const BAR_ORDER = ['waiting', 'forgotten', 'failed', 'review', 'working', 'done'];

export const STATES = {
  // `span`: the state as a stretch of time, for the timeline ("In attesa · 14:05–14:47").
  waiting: { label: 'Ti aspetta', heading: 'Ti aspettano', one: 'ti aspetta', many: 'ti aspettano', past: ['ti aspettava', 'ti aspettavano'], span: 'In attesa' },
  failed: { label: 'Fallita', heading: 'Fallite', one: 'fallita', many: 'fallite', span: 'Fallita' },
  forgotten: { label: 'Dimenticata', heading: 'Dimenticate', one: 'dimenticata', many: 'dimenticate', span: 'Dimenticata' },
  review: { label: 'Da rivedere', heading: 'Da rivedere', one: 'da rivedere', many: 'da rivedere', span: 'Da rivedere' },
  working: { label: 'Al lavoro', heading: 'Al lavoro', one: 'al lavoro', many: 'al lavoro', span: 'Al lavoro' },
  done: { label: 'Chiusa', heading: 'Chiuse', one: 'chiusa', many: 'chiuse', span: 'Chiusa' },
};

/** "1 fallita", "2 ti aspettano". */
export function countPhrase(state, n, { past = false } = {}) {
  const s = STATES[state];
  const [one, many] = past && s.past ? s.past : [s.one, s.many];
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 cose da fare" */
export const todoUnit = (n) => (n === 1 ? 'cosa da fare' : 'cose da fare');

/** "1 agente al lavoro", "Nessun agente al lavoro". */
export const workingPhrase = (n) => (n === 0 ? 'Nessun agente al lavoro' : `${n} ${n === 1 ? 'agente' : 'agenti'} al lavoro`);

/** The calm line shown when nobody needs the user. */
export function calmSummary(counts) {
  const parts = [`${workingPhrase(counts.working ?? 0)}.`];
  if (counts.review) parts.push(`${counts.review} da rivedere.`);
  return parts.join(' ');
}

// ---------- time ----------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "3 min", "2 h", "6 giorni". */
export function duration(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  const days = Math.floor(ms / DAY);
  return days === 1 ? '1 giorno' : `${days} giorni`;
}

/** "12 min": how long a state has lasted, as the trailing time of a row (iOS Mail style). */
export const elapsedText = (ms) => (ms < MIN ? 'adesso' : duration(ms));

/** "3 min fa". */
export const agoText = (ms) => (ms < MIN ? 'adesso' : `${duration(ms)} fa`);

export const quietText = (ms) => `Nessun segnale da ${duration(ms)}`;

/** "42 min", "3 h 10 min": a measured span, for tooltips and totals. */
export function durationLong(ms) {
  if (ms < MIN) return 'meno di 1 min';
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min`;
  if (ms < DAY) {
    const m = Math.floor((ms % HOUR) / MIN);
    return `${Math.floor(ms / HOUR)} h${m ? ` ${m} min` : ''}`;
  }
  return duration(ms);
}

/**
 * Wait meter caption: age toward the "forgotten" threshold.
 * "da 2 h · dimenticata tra 46 h", or past it "da 3 giorni · dimenticata da 1 giorno".
 */
export function waitCaption(ageMs, forgottenMs) {
  // Hours up to three days ("tra 46 h" reads better than "tra 1 giorno" against a 48 h threshold).
  const span = (ms) => (ms >= HOUR && ms < 3 * DAY ? `${Math.floor(ms / HOUR)} h` : duration(ms));
  const age = ageMs < MIN ? 'da adesso' : `da ${span(ageMs)}`;
  return ageMs >= forgottenMs ? `${age} · dimenticata da ${span(ageMs - forgottenMs)}` : `${age} · dimenticata tra ${span(forgottenMs - ageMs)}`;
}

const CLOCK_FMT = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });

/** "14:05" */
export const clock = (ms) => CLOCK_FMT.format(new Date(ms));

export function freshnessText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 3) return 'aggiornato adesso';
  if (s < 60) return `aggiornato ${s} s fa`;
  return `aggiornato ${agoText(ms)}`;
}

const DATE_FMT = new Intl.DateTimeFormat('it-IT', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** "lun 19 ott, 14:32" */
export const dateTime = (ms) => DATE_FMT.format(new Date(ms));

// ---------- numbers ----------

const TWO_DECIMALS = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$4,20" */
export const money = (usd) => `$${TWO_DECIMALS.format(usd)}`;

/** Context window fill, 0-100, or null when unknown. */
export function contextPercent(used, max) {
  if (used == null || !(max > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

// ---------- sessions ----------

/** Maps Claude Code's entrypoint to a short device label and an icon name. */
export function device(entrypoint, source) {
  const e = (entrypoint ?? '').toLowerCase();
  if (e.includes('android')) return { label: 'Android', icon: 'phone' };
  if (/mobile|ios|iphone/.test(e)) return { label: 'iPhone', icon: 'phone' };
  if (e.includes('desktop')) return { label: 'Desktop', icon: 'desktop' };
  if (/web|claude_ai|browser/.test(e)) return { label: 'Web', icon: 'web' };
  if (/vscode|jetbrains|ide/.test(e)) return { label: 'Editor', icon: 'terminal' };
  if (/cli|sdk|terminal/.test(e)) return { label: 'Terminale', icon: 'terminal' };
  return source === 'local' ? { label: 'Locale', icon: 'desktop' } : { label: 'Cloud', icon: 'cloud' };
}

// Claude Code's notification texts arrive verbatim, in English.
const REASONS = [
  [/^Claude needs your permission to use (.+?)\.?$/i, (m) => `Serve il tuo permesso per usare ${m[1]}`],
  [/^Claude is waiting for your input\.?$/i, () => 'Claude aspetta una tua risposta'],
];

export function localizeReason(text) {
  for (const [re, fn] of REASONS) {
    const m = re.exec(text);
    if (m) return fn(m);
  }
  return text;
}
