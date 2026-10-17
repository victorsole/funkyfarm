/* This cache contains public application files only. Farm API responses and
   original documents always go directly to the server. */
const CACHE = 'funkyfarm-public-shell-v6';
const PUBLIC_FILES = ['/offline.html', '/manifest.webmanifest', '/assets/funkyfarmers-logo.png', '/assets/caceres-pnoa-2026.jpg', '/data/spain-sigpac-caceres.geojson', '/data/spain-sigpac-caceres.NOTICE.txt'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PUBLIC_FILES);
    const response = await fetch('/', { cache: 'reload', credentials: 'omit' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
    const html = await response.clone().text();
    await cache.put('/', response);
    const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(match => match[1]);
    await cache.addAll([...new Set(assets)].slice(0, 30));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('funkyfarm-public-shell-') && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    if (!(url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/login' || url.pathname === '/register' || url.pathname === '/app' || url.pathname.startsWith('/app/'))) return;
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch {
        return await caches.match('/') ?? await caches.match('/offline.html') ?? new Response('Reconnect to open Funkyfarmers.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }
  const isPublicAsset = PUBLIC_FILES.includes(url.pathname) || (url.pathname.startsWith('/assets/') && /\.(?:js|css|png|svg|webp|woff2?)$/.test(url.pathname));
  if (!isPublicAsset || url.search) return;
  event.respondWith((async () => {
    const stored = await caches.match(request);
    if (stored) return stored;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
