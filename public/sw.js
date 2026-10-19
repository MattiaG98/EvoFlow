// EvoFlow service worker: keeps the app shell available for offline launch.
// It never touches /api/*: session data must always come live from the server.

const CACHE = 'evoflow-shell-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'api.js',
  'cards.js',
  'dom.js',
  'format.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // straight to the network, never cached
  const isShell = request.mode === 'navigate' || SHELL_PATHS.has(url.pathname);
  if (!isShell) return;

  // Network first, so a deploy shows up on the next load; the cached copy only when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && SHELL_PATHS.has(url.pathname)) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        return cached ?? (request.mode === 'navigate' ? caches.match('./') : Response.error());
      }),
  );
});
