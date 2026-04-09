/**
 * FamCloud Service Worker v6.0
 * Melhorias: Streaming Retry, Push Notifications, Cache API Otimizado
 */
const SW_VERSION = 'fc-v60';
const CACHE_SHELL  = 'fc-shell-v6';
const CACHE_THUMBS = 'fc-thumbs-v6';
const CACHE_PHOTOS = 'fc-photos-v6';

// Cache Shell: HTML, CSS, JS da aplicação
const PRECACHE = [
  '/famcloud/',
  '/famcloud/index.html',
];

let _auth = null;

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  const keep = new Set([SW_VERSION, CACHE_SHELL, CACHE_THUMBS, CACHE_PHOTOS]);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── MESSAGES ─────────────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SET_AUTH') {
    _auth = e.data.auth;
  }
  if (e.data?.type === 'CLEAR_AUTH') {
    _auth = null;
  }
  // Pré-cacheia thumbnails (enviado por renderFiles no main.js)
  if (e.data?.type === 'CACHE_THUMBS' && Array.isArray(e.data.urls)) {
    cacheUrls(e.data.urls, CACHE_THUMBS, 1000).catch(() => {});
  }
  // Pré-cacheia fotos adjacentes na galeria (enviado por galleryNav)
  if (e.data?.type === 'CACHE_PHOTOS' && Array.isArray(e.data.urls)) {
    cacheUrls(e.data.urls, CACHE_PHOTOS, 200).catch(() => {});
  }
  // Alias legacy
  if (e.data?.type === 'CACHE_URLS' && Array.isArray(e.data.urls)) {
    cacheUrls(e.data.urls, e.data.cacheName || CACHE_THUMBS, 1000).catch(() => {});
  }
});

// ── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Share Target (Upload de ficheiros partilhados)
  if (e.request.method === 'POST' && url.pathname.includes('/famcloud/')) {
    e.respondWith(handleShareTarget(e.request));
    return;
  }

  if (e.request.method !== 'GET') return;

  // Streaming de Vídeo/Áudio
  if (url.pathname === '/famcloud/stream' && url.searchParams.has('path')) {
    e.respondWith(handleStream(e.request, url));
    return;
  }

  // Assets Estáticos (HTML, CSS, JS)
  if (url.pathname.includes('/assets/') || 
      url.pathname.match(/\.(js|css|woff2?|ttf|eot|png|ico|svg)$/)) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_SHELL));
    return;
  }

  // Thumbnails Nextcloud
  if (url.pathname.includes('/core/preview') || url.searchParams.has('fileId')) {
    e.respondWith(cacheFirst(e.request, CACHE_THUMBS));
    return;
  }

  // HTML / Raiz
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_SHELL));
    return;
  }
});

// ── STREAMING HANDLER (COM RETRY) ────────────────────────────────────────────
async function handleStream(request, url) {
  const targetPath = url.searchParams.get('path');
  const proxyBase  = url.searchParams.get('proxy') || 'https://famcloud.famcloud.workers.dev/nextcloud';
  const targetUrl  = proxyBase + targetPath;
  
  const authHeader = _auth || request.headers.get('X-FC-Auth');
  if (!authHeader) return new Response('Auth required', { status: 401 });

  // Copia headers originais (Range requests para seek de vídeo)
  const headers = new Headers();
  headers.set('Authorization', authHeader);
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  // Retry Logic: Tenta 3 vezes se falhar (redes móveis instáveis)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(targetUrl, { headers, method: 'GET' });
      
      if (response.ok || response.status === 206) {
        const respHeaders = new Headers(response.headers);
        respHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      }
    } catch (err) {
      // Se falhou e ainda há tentativas, espera um bocado
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  return new Response('Stream error after retries', { status: 502 });
}

// ── CACHE STRATEGIES ─────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fetchReq = _auth ? new Request(request, { headers: authHeaders(request.headers) }) : request;
    const fresh = await fetch(fetchReq);
    if (fresh && (fresh.status === 200 || fresh.status === 206)) {
      await cache.put(request, fresh.clone());
      enforceLimit(cache, 1000); // Limita a 1000 thumbs
    }
    return fresh;
  } catch(e) {
    return new Response(JSON.stringify({ offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'X-FC-Offline': '1' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchReq = _auth ? new Request(request, { headers: authHeaders(request.headers) }) : request;
  
  const networkPromise = fetch(fetchReq).then(fresh => {
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);

  return cached || await networkPromise || new Response('Offline', { status: 503 });
}

// ── PRE-CACHE BATCH ──────────────────────────────────────────────────────────
async function cacheUrls(urls, cacheName) {
  if (!urls.length) return;
  const cache = await caches.open(cacheName);
  
  for (let i = 0; i < urls.length; i += 5) {
    const batch = urls.slice(i, i + 5);
    await Promise.all(batch.map(async url => {
      try {
        if (await cache.match(url)) return;
        const r = await fetch(new Request(url, { headers: authHeaders() }));
        if (r && (r.status === 200 || r.status === 206)) {
          await cache.put(url, r);
        }
      } catch(_) {}
    }));
  }
  enforceLimit(cache, cacheName === CACHE_THUMBS ? 1000 : 200);
}

// ── UTILS ────────────────────────────────────────────────────────────────────
function authHeaders(existing) {
  const h = new Headers(existing || {});
  if (_auth) h.set('Authorization', _auth);
  return h;
}

async function enforceLimit(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(k => cache.delete(k)));
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

function openShareDB() {
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

// ── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/famcloud/icons/icon-192.png',
      data: { url: data.url },
      actions: [{ action: 'open', title: 'Abrir' }]
    });
  } catch(err) {}
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'open' && e.notification.data?.url) {
    e.waitUntil(clients.openWindow(e.notification.data.url));
  }
});