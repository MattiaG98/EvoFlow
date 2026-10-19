// Local server: runs the Worker under Node with an SQLite-backed D1 and serves public/.
//   npm run dev                      -> http://localhost:8787, password "dev", ingest token "dev-ingest"
//   EVOFLOW_DB=evoflow.sqlite npm run dev   keeps data across restarts
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import worker from '../src/worker/index.ts';
import { createD1 } from './d1-shim.ts';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.sh': 'text/plain; charset=utf-8',
};

const assets = {
  async fetch(request: Request): Promise<Response> {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(PUBLIC_DIR, path));
    if (!file.startsWith(PUBLIC_DIR)) return new Response('forbidden', { status: 403 });
    try {
      return new Response(await readFile(file), {
        headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

const env = {
  DB: createD1(process.env.EVOFLOW_DB ?? ':memory:'),
  ASSETS: assets,
  INGEST_TOKEN: process.env.INGEST_TOKEN ?? 'dev-ingest',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD ?? 'dev',
  FORGOTTEN_HOURS: process.env.FORGOTTEN_HOURS,
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await worker.fetch(request, env as never);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`EvoFlow dev: http://localhost:${PORT}  (password "${env.DASHBOARD_PASSWORD}", ingest token "${env.INGEST_TOKEN}")`);
});
