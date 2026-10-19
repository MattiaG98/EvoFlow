// Italian copy and formatting: state labels, plurals, relative times, money, devices.

/** Same order as STATE_ORDER in src/core/types.ts: what needs you first. */
export const STATE_ORDER = ['waiting', 'failed', 'forgotten', 'review', 'working', 'done'];

/** The states that need the user now. */
export const ATTENTION = new Set(['waiting', 'failed', 'forgotten']);

export const STATES = {
  waiting: { label: 'Ti aspetta', heading: 'Ti aspettano', one: 'ti aspetta', many: 'ti aspettano', past: ['ti aspettava', 'ti aspettavano'] },
  failed: { label: 'Fallita', heading: 'Fallite', one: 'fallita', many: 'fallite' },
  forgotten: { label: 'Dimenticata', heading: 'Dimenticate', one: 'dimenticata', many: 'dimenticate' },
  review: { label: 'Da rivedere', heading: 'Da rivedere', one: 'da rivedere', many: 'da rivedere' },
  working: { label: 'Al lavoro', heading: 'Al lavoro', one: 'al lavoro', many: 'al lavoro' },
  done: { label: 'Chiusa', heading: 'Chiuse', one: 'chiusa', many: 'chiuse' },
};

/** "1 fallita", "2 ti aspettano". */
export function countPhrase(state, n, { past = false } = {}) {
  const s = STATES[state];
  const [one, many] = past && s.past ? s.past : [s.one, s.many];
  return `${n} ${n === 1 ? one : many}`;
}

/** The calm line shown when nobody needs the user. */
export function calmSummary(counts) {
  const working = counts.working ?? 0;
  const parts = [working === 0 ? 'Nessun agente al lavoro.' : `${working} ${working === 1 ? 'agente' : 'agenti'} al lavoro.`];
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
