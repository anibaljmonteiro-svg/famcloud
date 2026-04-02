/**
 * FamCloud Service Worker v6.0
 * 
 * 3 caches independentes (diagrama 2):
 *   fc-shell-v3   — HTML/JS/CSS/fontes (stale-while-revalidate)
 *   fc-thumbs-v3  — Thumbnails Nextcloud (cache-first, max 1000)
 *   fc-photos-v3  — Fotos completas vistas (cache-first, max 200 / ~500MB)
 * 
 * Mensagens do main.js:
 *   SET_AUTH    — actualiza credenciais para fetches autenticados
 *   CLEAR_AUTH  — limpa credenciais (logout)
 *   CACHE_THUMBS — pré-cacheia array de URLs de thumbnails
 *   CACHE_PHOTOS — pré-cacheia fotos adjacentes na galeria
 */

const SW_VERSION   = 'fc-v26';
const CACHE_SHELL  = 'fc-shell-v3';
const CACHE_THUMBS = 'fc-thumbs-v3';
const CACHE_PHOTOS = 'fc-photos-v3';

const MAX_THUMBS = 1000;
const MAX_PHOTOS = 200;

const PRECACHE = [
  '/famcloud/',
  '/famcloud/index.html',
];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — limpa caches antigos ──────────────────────────────────────────
self.addEventListener('activate', e => {
  const keep = new Set([CACHE_SHELL, CACHE_THUMBS, CACHE_PHOTOS]);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
let _auth = null;

self.addEventListener('message', async e => {
  if (e.data?.type === 'SET_AUTH') {
    _auth = e.data.auth;
  }
  if (e.data?.type === 'CLEAR_AUTH') {
    _auth = null;
  }

  // Pré-cacheia thumbnails em background (diagrama 2: renderFiles → SW)
  if (e.data?.type === 'CACHE_THUMBS' && Array.isArray(e.data.urls)) {
    cacheUrls(e.data.urls, CACHE_THUMBS, MAX_THUMBS).catch(() => {});
  }

  // Pré-cacheia fotos adjacentes na galeria (diagrama 2: galleryNav → SW)
  if (e.data?.type === 'CACHE_PHOTOS' && Array.isArray(e.data.urls)) {
    cacheUrls(e.data.urls, CACHE_PHOTOS, MAX_PHOTOS).catch(() => {});
  }
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

  // Video/audio streaming via SW proxy
  if (url.pathname === '/famcloud/stream' && url.searchParams.has('path')) {
    e.respondWith(handleStream(e.request, url));
    return;
  }

  // Assets estáticos Vite → shell cache (stale-while-revalidate)
  if (url.pathname.includes('/assets/') ||
      url.pathname.match(/\.(js|css|woff2?|ttf|eot|png|ico|svg)$/)) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_SHELL));
    return;
  }

  // Thumbnails Nextcloud → cache-first 30 dias
  if (url.pathname.includes('/core/preview') || url.searchParams.has('fileId')) {
    e.respondWith(cacheFirst(e.request, CACHE_THUMBS));
    return;
  }

  // Fotos completas WebDAV → cache-first (offline real)
  if (url.pathname.includes('/remote.php/dav/') && !url.pathname.includes('/trashbin/')) {
    e.respondWith(cacheFirst(e.request, CACHE_PHOTOS));
    return;
  }

  // HTML → stale-while-revalidate
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_SHELL));
    return;
  }
});

// ── CACHE STRATEGIES ─────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  // Não está em cache — fetch com auth se disponível
  try {
    const fetchReq = _auth
      ? new Request(request, { headers: authHeaders(request.headers) })
      : request;
    const fresh = await fetch(fetchReq);
    if (fresh && (fresh.status === 200 || fresh.status === 206)) {
      await cache.put(request, fresh.clone());
      await enforceLimit(cache, cacheName === CACHE_THUMBS ? MAX_THUMBS : MAX_PHOTOS);
    }
    return fresh;
  } catch(e) {
    // Offline e não em cache → 503 com header especial para main.js mostrar toast
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-FC-Offline': '1' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(fresh => {
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || await networkPromise || new Response('Offline', { status: 503 });
}

// ── PRÉ-CACHE EM BACKGROUND ──────────────────────────────────────────────────
// Chamado por CACHE_THUMBS e CACHE_PHOTOS do main.js
async function cacheUrls(urls, cacheName, maxEntries) {
  if (!_auth || !urls.length) return;
  const cache = await caches.open(cacheName);
  // Processa em paralelo limitado (3 de cada vez)
  const CONCURRENCY = 3;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async url => {
      try {
        const already = await cache.match(url);
        if (already) return; // já está em cache — skip
        const r = await fetch(new Request(url, { headers: authHeaders() }));
        if (r && (r.status === 200 || r.status === 206)) {
          await cache.put(url, r);
        }
      } catch(_) {}
    }));
  }
  await enforceLimit(cache, maxEntries);
}

// ── EVICTION FIFO ─────────────────────────────────────────────────────────────
async function enforceLimit(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Remove as entradas mais antigas (FIFO — primeiras inseridas)
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(k => cache.delete(k)));
}

// ── AUTH HEADERS ──────────────────────────────────────────────────────────────
function authHeaders(existingHeaders) {
  const h = new Headers(existingHeaders || {});
  if (_auth) h.set('Authorization', _auth);
  return h;
}

// ── VIDEO STREAMING ───────────────────────────────────────────────────────────
async function handleStream(request, url) {
  const targetPath = url.searchParams.get('path');
  const proxyBase  = url.searchParams.get('proxy') || 'https://famcloud.famcloud.workers.dev/nextcloud';
  const targetUrl  = proxyBase + targetPath;
  const authHeader = _auth || request.headers.get('X-FC-Auth');
  if (!authHeader) return new Response('Auth required', { status: 401 });

  const headers = new Headers();
  headers.set('Authorization', authHeader);
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) headers.set('Range', rangeHeader);

  try {
    const response = await fetch(targetUrl, { headers, method: 'GET' });
    const respHeaders = new Headers(response.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  } catch(e) {
    return new Response('Stream error: ' + e.message, { status: 502 });
  }
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
    r.onerror   = e => rej(e);
  });
}
