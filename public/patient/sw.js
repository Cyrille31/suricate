'use strict';

/* Service worker de l'app patient.
   Stratégie : RÉSEAU D'ABORD, repli sur le cache.
   - Connecté  -> on sert toujours la dernière version (et on rafraîchit le cache).
   - Hors-ligne -> on sert la dernière version mise en cache.
   Les appels API ne sont jamais mis en cache (la synchro hors-ligne est gérée
   par la file d'attente dans app.js). */

const CACHE = 'suricate-patient-v3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting(); // active la nouvelle version sans attendre
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim(); // prend le contrôle des onglets déjà ouverts
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // jamais en cache
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Met à jour le cache au passage (pour le prochain accès hors-ligne).
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request)) // hors-ligne : on sert le cache
  );
});
