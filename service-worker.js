const CACHE_NAME = 'lingxin-ims-v16';
const ASSETS = [
  './',
  './index.html',
  './lingxin-ims.css',
  './lingxin-ims-app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

/** HTML / JS / CSS：网络优先，避免旧缓存导致“按钮在、逻辑没有” */
function isShellAssetGet(req) {
  if (req.method !== 'GET') return false;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return false;
  }
  if (!sameOrigin(url)) return false;
  const path = url.pathname;
  return (
    path.endsWith('/') ||
    path.endsWith('/index.html') ||
    path.endsWith('lingxin-ims.css') ||
    path.endsWith('tailwind.css') ||
    path.endsWith('lingxin-ims-app.js') ||
    path.endsWith('manifest.webmanifest') ||
    path.includes('/icons/')
  );
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {})),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k)))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isShellAssetGet(req)) {
    event.respondWith(fetch(req));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((networkResp) => {
        if (networkResp && networkResp.ok) {
          const copy = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return networkResp;
      })
      .catch(() => caches.match(req).then((cached) => cached || fetch(req))),
  );
});
