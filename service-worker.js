const CACHE_NAME = 'lingxin-ims-v1';
const ASSETS = [
  './',
  './index.html',
  './lingxin-ims.css',
  './lingxin-ims-app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))),
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(caches.match(event.request).then((resp) => resp || fetch(event.request)));
});