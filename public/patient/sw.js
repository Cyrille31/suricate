'use strict';

/* Service worker minimal : met en cache la coque de l'application pour
   qu'elle s'ouvre même sans réseau. Les appels API ne sont jamais mis en
   cache (la synchronisation hors-ligne est gérée côté app.js par une file
   d'attente). */

const CACHE = 'suricate-patient-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Ne jamais mettre l'API en cache.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
