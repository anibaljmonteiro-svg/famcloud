const CACHE_NAME = 'fc-v23';
const CACHE_STATIC = 'fc-static-v23';

// Assets estáticos que mudam raramente
const STATIC_ASSETS = [
  '/famcloud/',
  '/famcloud/index.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
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

  // Share target — recebe ficheiros de outras apps
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

  if (e.request.method !== 'GET') return;

  // Assets do Vite (JS/CSS com hash) — cache agressivo stale-while-revalidate
  const isViteAsset = url.pathname.includes('/assets/') ||
    url.pathname.match(/\.(js|css|woff2?|ttf|eot)$/);

  if (isViteAsset) {
    e.respondWith(
      caches.open(CACHE_STATIC).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached; // Cache hit — instantâneo
        const fresh = await fetch(e.request);
        if (fresh && fresh.status === 200) {
          cache.put(e.request, fresh.clone());
        }
        return fresh;
      })
    );
    return;
  }

  // HTML e outros — network-first com fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
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
