/**
 * FamCloud Service Worker v5.0
 * 
 * GRANDE MELHORIA: Video Streaming via SW Proxy
 * O SW intercepta pedidos de vídeo/áudio e adiciona o Authorization header
 * O browser faz Range requests nativamente → seek instantâneo, sem download completo
 * 
 * Sem isto: vídeo de 2GB = esperar 20 minutos
 * Com isto: vídeo de 2GB = reproduz em 2 segundos, seek em qualquer posição
 */

const SW_VERSION = 'fc-v25';
const CACHE_STATIC = 'fc-static-v25';
const CACHE_THUMBS = 'fc-thumbs-v25';
const CACHE_HTML   = 'fc-html-v25';

const PRECACHE = [
  '/famcloud/',
  '/famcloud/index.html',
];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_HTML)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  const keep = new Set([SW_VERSION, CACHE_STATIC, CACHE_THUMBS, CACHE_HTML]);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── MENSAGENS DA APP → SW ────────────────────────────────────────────────────
// A app envia as credenciais ao SW para ele poder fazer pedidos autenticados
let _auth = null;
self.addEventListener('message', e => {
  if (e.data?.type === 'SET_AUTH') {
    _auth = e.data.auth; // "Basic base64..."
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

  // ══════════════════════════════════════════════════════════════
  // VIDEO/AUDIO STREAMING — interceta e adiciona auth header
  // URL especial: /famcloud/stream?path=/remote.php/dav/files/...
  // ══════════════════════════════════════════════════════════════
  if (url.pathname === '/famcloud/stream' && url.searchParams.has('path')) {
    e.respondWith(handleStream(e.request, url));
    return;
  }

  // Assets estáticos Vite
  if (url.pathname.includes('/assets/') ||
      url.pathname.match(/\.(js|css|woff2?|ttf|eot|png|ico|svg)$/)) {
    e.respondWith(cacheFirst(e.request, CACHE_STATIC));
    return;
  }

  // Thumbnails — cache 30 dias
  if (url.pathname.includes('/core/preview') || url.searchParams.has('fileId')) {
    e.respondWith(cacheFirst(e.request, CACHE_THUMBS));
    return;
  }

  // HTML — stale-while-revalidate
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_HTML));
    return;
  }
});

// ── VIDEO STREAMING HANDLER ───────────────────────────────────────────────────
async function handleStream(request, url) {
  const targetPath = url.searchParams.get('path');
  const proxyBase = url.searchParams.get('proxy') || 'https://famcloud.famcloud.workers.dev/nextcloud';
  const targetUrl = proxyBase + targetPath;

  // Usa as credenciais guardadas pelo SW
  const authHeader = _auth || request.headers.get('X-FC-Auth');
  if (!authHeader) {
    return new Response('Auth required', { status: 401 });
  }

  // Copia headers do pedido original (incluindo Range para seek)
  const headers = new Headers();
  headers.set('Authorization', authHeader);

  // Range header — essencial para seek no vídeo
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    headers.set('Range', rangeHeader);
  }

  try {
    const response = await fetch(targetUrl, {
      headers,
      method: 'GET',
    });

    // Passa a resposta tal qual (com Content-Range, Accept-Ranges, etc.)
    const respHeaders = new Headers(response.headers);
    // CORS para o player de vídeo
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

// ── CACHE STRATEGIES ─────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  } catch(e) {
    return new Response('Offline', { status: 503 });
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
