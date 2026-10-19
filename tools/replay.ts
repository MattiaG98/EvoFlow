// Replays a scenario of hook events and snapshots against an EvoFlow server.
//   node tools/replay.ts tests/fixtures/scenario-demo.json [--url http://localhost:8787] [--token dev-ingest] [--fast]
// Scenario format: { "steps": [ { "delay_ms"?, "event"?: HookEnvelope, "snapshot"?: SnapshotItem[] } ] }
// In snapshot items, "updated_hours_ago" / "created_hours_ago" are turned into ISO timestamps relative to now.
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const url = opt('url', process.env.EVOFLOW_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const token = opt('token', process.env.EVOFLOW_TOKEN ?? 'dev-ingest');
const fast = args.includes('--fast');

if (!file) {
  console.error('usage: node tools/replay.ts <scenario.json> [--url URL] [--token TOKEN] [--fast]');
  process.exit(2);
}

const scenario = JSON.parse(await readFile(file, 'utf8')) as { steps: any[] };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

for (const [i, step] of scenario.steps.entries()) {
  if (step.delay_ms && !fast) await new Promise((r) => setTimeout(r, step.delay_ms));
  const [path, body] = step.event
    ? ['/api/events', step.event]
    : [
        '/api/snapshots',
        {
          sessions: step.snapshot.map((s: any) => {
            const { updated_hours_ago, created_hours_ago, ...rest } = s;
            return {
              ...rest,
              updated_at: rest.updated_at ?? hoursAgo(updated_hours_ago ?? 0),
              created_at: rest.created_at ?? hoursAgo(created_hours_ago ?? updated_hours_ago ?? 0),
            };
          }),
        },
      ];
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const label = step.event ? `${step.event.payload.hook_event_name} ${step.event.payload.session_id}` : 'snapshot';
  console.log(`${String(i + 1).padStart(2)} ${res.status} ${label}`);
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }
}
