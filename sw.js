// Service worker minimal : nécessaire pour déclencher le prompt d'installation PWA.
// Met en cache le strict minimum pour fonctionner hors-ligne.

const CACHE_NAME = 'tapis-ljj-v2';
const ASSETS = [
  './',
  './index.html',
  './treadmill-core.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Stratégie : réseau d'abord (les mises à jour GitHub Pages arrivent tout de
  // suite), cache en secours hors-ligne.
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok && new URL(e.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
