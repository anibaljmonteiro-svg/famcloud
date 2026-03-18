/**
 * FamCloud Service Worker v4.0
 * 
 * Estratégia de cache inspirada no Dropbox/Google Photos:
 * 1. Assets Vite (JS/CSS com hash) — cache permanente
 * 2. HTML — network-first com fallback offline
 * 3. Thumbnails/previews — cache 30 dias no SW
 * 4. Background sync — actualiza cache quando online
 */

const SW_VERSION = 'fc-v24';
const CACHE_STATIC = 'fc-static-v24';
const CACHE_THUMBS = 'fc-thumbs-v24';
const CACHE_HTML   = 'fc-html-v24';

// Assets críticos para offline
const PRECACHE = [
  '/famcloud/',
  '/famcloud/index.html',
];

// ── INSTALL — precache crítico ───────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_HTML)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — limpa caches antigas ─────────────────────────────────────────
self.addEventListener('activate', e => {
  const keep = new Set([SW_VERSION, CACHE_STATIC, CACHE_THUMBS, CACHE_HTML]);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Share target POST
  if (e.request.method === 'POST' && url.pathname.includes('/famcloud/')) {
    e.respondWith(handleShareTarget(e.request));
    return;
  }

  if (e.request.method !== 'GET') return;

  // 1. Proxy/Nextcloud — nunca interceptar dados
  if (url.hostname.includes('workers.dev') ||
      url.hostname.includes('your-storageshare.de')) {
    return; // passa directo
  }

  // 2. Thumbnails e previews — cache agressivo 30 dias
  if (url.pathname.includes('/core/preview') ||
      url.pathname.includes('/thumbnail') ||
      url.searchParams.has('fileId')) {
    e.respondWith(cacheFirst(e.request, CACHE_THUMBS, 30 * 24 * 60 * 60));
    return;
  }

  // 3. Assets Vite (com hash no nome — imutáveis)
  if (url.pathname.includes('/assets/') ||
      url.pathname.match(/\.(js|css|woff2?|ttf|eot|png|ico|svg)$/)) {
    e.respondWith(cacheFirst(e.request, CACHE_STATIC, 365 * 24 * 60 * 60));
    return;
  }

  // 4. HTML — stale-while-revalidate
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_HTML));
    return;
  }
});

// ── CACHE STRATEGIES ─────────────────────────────────────────────────────────

// Cache-first: serve do cache, actualiza em background
async function cacheFirst(request, cacheName, maxAgeSeconds) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  if (cached) {
    const dateHeader = cached.headers.get('date');
    if (dateHeader) {
      const age = (Date.now() - new Date(dateHeader).getTime()) / 1000;
      if (age < maxAgeSeconds) return cached;
    } else {
      return cached; // sem date header, serve na mesma
    }
  }

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch(e) {
    return cached || new Response('Offline', { status: 503 });
  }
}

// Stale-while-revalidate: serve cache imediatamente, actualiza em background
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Actualiza em background
  const networkPromise = fetch(request).then(fresh => {
    if (fresh && fresh.status === 200) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  }).catch(() => null);

  return cached || await networkPromise || new Response('Offline', { status: 503 });
}

// ── SHARE TARGET ──────────────────────────────────────────────────────────────
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files');
    const db = await openShareDB();
    const tx = db.transaction('pending', 'readwrite');
    for (const file of files) {
      if (file instanceof File) tx.objectStore('pending').add(file);
    }
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  } catch(e) {}
  return Response.redirect('/famcloud/', 303);
}

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
