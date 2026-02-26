const CACHE = 'famcloud-v15';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
  
  // Nunca cachear chamadas ao proxy/Nextcloud
  if (url.hostname.includes('workers.dev') || 
      url.hostname.includes('your-storageshare.de') ||
      url.pathname.includes('/nextcloud/') ||
      url.pathname.includes('/remote.php/') ||
      url.pathname.includes('/ocs/')) {
    return;
  }
  
  // App shell: cache first, network fallback
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok && e.request.url.startsWith(self.location.origin)) {
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
