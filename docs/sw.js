'use strict';

/*
 * Service worker: bewaart de app-bestanden op de iPad, zodat de app offline start.
 * De opnames zelf staan in IndexedDB en lopen hier niet doorheen.
 *
 * Verhoog VERSIE hier én in app.js bij elke wijziging. Anders haalt de iPad de nieuwe versie niet op.
 */

const VERSIE = '1.1.2';
const CACHE = `studio1400-${VERSIE}`;
const BESTANDEN = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './iconen/icoon-180.png',
  './iconen/icoon-192.png',
  './iconen/icoon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' slaat de HTTP-cache over, zodat we echt de nieuwe bestanden krijgen.
    await cache.addAll(BESTANDEN.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const namen = await caches.keys();
    await Promise.all(namen
      .filter((naam) => naam.startsWith('studio1400-') && naam !== CACHE)
      .map((naam) => caches.delete(naam)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(request, { ignoreSearch: true })) || fetch(request);
  })());
});
