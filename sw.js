const CACHE = 'famcloud-v19';
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

// ── SHARE TARGET — intercept POST de ficheiros partilhados do Android ────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Intercepta o share target POST
  if (e.request.method === 'POST' && url.pathname === BASE + '/share-target') {
    e.respondWith(handleShareTarget(e.request));
    return;
  }

  // Nunca interceptar chamadas ao proxy/Nextcloud
  if (url.hostname.includes('workers.dev') ||
      url.hostname.includes('your-storageshare.de') ||
      url.pathname.includes('/nextcloud/') ||
      url.pathname.includes('/remote.php/') ||
      url.pathname.includes('/ocs/')) {
    return;
  }

  if (e.request.method === 'GET') {
    const reqUrl = new URL(e.request.url);
    const isHtml = reqUrl.pathname.endsWith('/') || reqUrl.pathname.endsWith('.html');

    if (isHtml) {
      // index.html — network-first: garante código sempre actualizado
      // Fallback para cache se offline
      e.respondWith(
        fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => caches.match(e.request))
      );
    } else {
      // Assets (icons, manifest) — cache-first: mais rápido
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
  }
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('media');

    if (files && files.length > 0) {
      // Guarda os ficheiros em cache IndexedDB para a app os ir buscar
      const db = await openShareDB();
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');

      for (const file of files) {
        if (file instanceof File) {
          const buf = await file.arrayBuffer();
          store.add({ name: file.name, type: file.type, data: buf, ts: Date.now() });
        }
      }
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    }
  } catch(e) {
    console.error('Share target error:', e);
  }

  // Redireciona para a app — ela vai detectar os ficheiros pendentes
  return Response.redirect(BASE + '/?shared=1', 303);
}

function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('famcloud-share', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('pending', { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
