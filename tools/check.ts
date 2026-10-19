// Coverage check: is every recent session on the dashboard, in the right state?
// Compares the dashboard with ground truth you hold yourself:
//   - the transcripts of Claude Code sessions on this computer (~/.claude/projects/*/*.jsonl)
//   - optionally, a sessions listing saved from Claude (--listing file.json, the list_sessions output)
//
//   EVOFLOW_URL=https://… EVOFLOW_PASSWORD=<dashboard password> node tools/check.ts [--days 2] [--listing listing.json]
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeBucket } from '../src/core/state.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(opt('days') ?? 2);
const listingFile = opt('listing');
const url = (process.env.EVOFLOW_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const password = process.env.EVOFLOW_PASSWORD ?? 'dev';
const since = Date.now() - days * 24 * 3600_000;

const res = await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${password}` } });
if (!res.ok) {
  console.error(`dashboard: HTTP ${res.status} ${await res.text()}`);
  process.exit(2);
}
const dashboard = (await res.json()) as { sessions: { key: string; state: string; title: string; from_snapshot: boolean }[] };
const byKey = new Map(dashboard.sessions.map((s) => [s.key, s]));
let problems = 0;

// 1. Local transcripts: each recent session file should exist on the dashboard (hooks installed on this computer).
const projects = join(homedir(), '.claude', 'projects');
let local = 0;
for (const dir of await readdir(projects).catch(() => [] as string[])) {
  for (const file of await readdir(join(projects, dir)).catch(() => [] as string[])) {
    if (!file.endsWith('.jsonl')) continue;
    const info = await stat(join(projects, dir, file));
    if (info.mtimeMs < since) continue;
    local++;
    const id = file.replace(/\.jsonl$/, '');
    if (!byKey.has(id)) {
      problems++;
      console.log(`MANCA   locale  ${id}  (${dir}, modificata ${new Date(info.mtimeMs).toLocaleString('it-IT')})`);
    }
  }
}
console.log(`Sessioni locali degli ultimi ${days} giorni: ${local}`);

// 2. Cloud listing: every recent cloud session should be there; a state that disagrees is reported for review.
if (listingFile) {
  const raw = JSON.parse(await readFile(listingFile, 'utf8'));
  const items: any[] = raw.data ?? raw.ccr?.data ?? raw.sessions ?? raw;
  const expected: Record<string, string> = { blocked: 'waiting', failed: 'failed', working: 'working', completed: 'done', review_ready: 'review' };
  let cloud = 0;
  for (const item of items) {
    if (Date.parse(item.updated_at) < since) continue;
    cloud++;
    const shown = byKey.get(item.id);
    const want = expected[normalizeBucket(item.status_bucket)];
    if (!shown) {
      problems++;
      console.log(`MANCA   cloud   ${item.id}  "${item.title}"`);
    } else if (want && shown.state !== want && !(shown.state === 'forgotten' && (want === 'waiting' || want === 'review'))) {
      console.log(`DIVERSO cloud   ${item.id}  "${item.title}": dashboard=${shown.state}, listing=${want} (gli hook possono essere più recenti)`);
    }
  }
  console.log(`Sessioni cloud degli ultimi ${days} giorni nel listing: ${cloud}`);
}

console.log(problems ? `\n${problems} sessioni mancanti.` : '\nNessuna sessione mancante.');
process.exit(problems ? 1 : 0);
