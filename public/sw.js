const CACHE_NAME = 'fc-v22';
const ASSETS = [
  '/famcloud/',
  '/famcloud/index.html',
  '/famcloud/manifest.json',
  '/famcloud/icon-192.png',
  '/famcloud/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache strategy: Network-first para API, Cache-first para assets estáticos
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

  // Share target — abre a app
  if (e.request.method === 'POST' && url.pathname.includes('/famcloud/')) {
    e.respondWith(
      (async () => {
        const formData = await e.request.formData();
        const files = formData.getAll('files');
        const db = await openShareDB();
        const tx = db.transaction('pending', 'readwrite');
        for (const file of files) {
          if (file instanceof File) tx.objectStore('pending').add(file);
        }
        await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
        return Response.redirect('/famcloud/', 303);
      })()
    );
    return;
  }

  // Assets estáticos: cache-first
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        });
        return cached || network;
      })
    );
  }
});

async function openShareDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fc-share', 1);
    r.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('pending'))
        e.target.result.createObjectStore('pending', { autoIncrement: true });
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e);
  });
}
