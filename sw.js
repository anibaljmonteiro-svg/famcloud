const CACHE = 'famcloud-v17';
const BASE = '/famcloud';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Nunca interceptar chamadas ao proxy/Nextcloud
  if (url.hostname.includes('workers.dev') ||
      url.hostname.includes('your-storageshare.de') ||
      url.pathname.includes('/nextcloud/') ||
      url.pathname.includes('/remote.php/') ||
      url.pathname.includes('/ocs/')) {
    return;
  }

  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
