import './styles/main.css'

// FamCloud v2.1.0
// Stack: Vite + Vanilla JS
// Deploy: GitHub Pages → Cloudflare Worker → Nextcloud Hetzner



// ─── THEMES ──────────────────────────────────────────────────────────────────
const THEMES = {
  terra:    { name:'FamCloud',    emoji:'🌌', dots:['#4f46e5','#7c3aed','#e8eaff'], meta:'#4f46e5' },
  dark:     { name:'Obsidian',    emoji:'💎', dots:['#a78bfa','#8b5cf6','#0e0e12'], meta:'#a78bfa' },
  ocean:    { name:'Sakura',      emoji:'🌸', dots:['#db2777','#ec4899','#fff7f9'], meta:'#db2777' },
  forest:   { name:'Matcha',      emoji:'🍵', dots:['#16a34a','#15803d','#f2f7f2'], meta:'#16a34a' },
  candy:    { name:'AMOLED Neon', emoji:'⚡', dots:['#06b6d4','#0891b2','#000000'], meta:'#06b6d4' },
  midnight: { name:'Nord',        emoji:'❄️',  dots:['#5c7cfa','#4c6ef5','#e8edf4'], meta:'#5c7cfa' },
  sunset:   { name:'Manuscript',  emoji:'📜', dots:['#b45309','#92400e','#faf8f3'], meta:'#b45309' }
};

let currentTheme = localStorage.getItem('fc_theme') || 'terra';

function applyTheme(t) {
  if (!THEMES[t]) return;
  currentTheme = t;
  document.body.setAttribute('data-theme', t);
  document.getElementById('meta-theme').content = THEMES[t].meta;
  localStorage.setItem('fc_theme', t);
  renderThemeDots();
}

function renderThemeDots() {
  const dots = document.getElementById('theme-dots');
  dots.innerHTML = Object.entries(THEMES).map(([k,v]) =>
    `<div class="theme-dot${k===currentTheme?' active':''}" title="${v.name}"
      style="background:${v.dots[0]}" data-theme-key="${k}"></div>`
  ).join('');
  dots.onclick = e => {
    const dot = e.target.closest('[data-theme-key]');
    if (!dot) return;
    applyTheme(dot.dataset.themeKey);
    renderThemeDots();
  };
}

function renderThemeGrid() {
  const el = document.getElementById('theme-grid');
  el.innerHTML = Object.entries(THEMES).map(([k,v]) => `
    <div class="theme-card${k===currentTheme?' active':''}"
      style="background:${v.dots[2]}" data-theme-key="${k}">
      <div class="theme-card-dots">
        ${v.dots.map(d=>`<div class="theme-card-dot" style="background:${d}"></div>`).join('')}
      </div>
      <div class="theme-card-name">${v.emoji} ${v.name}</div>
    </div>`).join('');
  // Event delegation — mais fiável no mobile que onclick inline
  el.onclick = e => {
    const card = e.target.closest('[data-theme-key]');
    if (!card) return;
    applyTheme(card.dataset.themeKey);
    renderThemeGrid();
    // Feedback visual
    card.style.transform = 'scale(0.95)';
    setTimeout(() => { card.style.transform = ''; }, 150);
  };
}

// ─── STATE ───────────────────────────────────────────────────────────────────
const S = {
  server:'', user:'', pass:'',
  path:'/', hist:[],
  view: localStorage.getItem('fc_view') || 'grid',
  sort: JSON.parse(localStorage.getItem('fc_sort') || '{"by":"name","dir":"asc"}'),
  selected: new Set(), selecting: false,
  loadAbort: null, // AbortController para cancelar PROPFIND anterior
  favorites: JSON.parse(localStorage.getItem('fc_favs') || '[]'),
  lastItems: [],
  dragItem: null,
  renameTarget: null, moveTargets: [],
  galleryItems: [], galleryIdx: 0, galleryZoom: 1,
  pdfDoc: null, pdfPageN: 1, pdfTotal: 0, pdfPath: '',
  uploadXHR: null, uploadCancel: false,
  installPrompt: null,
  sidebarOpen: window.innerWidth > 700,
  searchTimer: null,
  touchTimer: null
};

const HIDDEN = ['Deleted Files','.famcloud-avatars','Photos','Talk Attachments','Talk','Nextcloud Talk','Nextcloud intro'];
const IE = ['jpg','jpeg','png','gif','webp','heic','svg','bmp','tiff','avif'];
const VE = ['mp4','mov','avi','mkv','m4v','webm','3gp','ogv'];
const AE = ['mp3','aac','flac','wav','m4a','ogg','opus'];


// ─── PROXY CONFIG ─────────────────────────────────────────────────────────────
// Cloudflare Worker URL — substitui pelo teu após deploy do worker
// Ex: https://famcloud.SEU-NOME.workers.dev
const PROXY = localStorage.getItem('fc_proxy') || 'https://famcloud.famcloud.workers.dev';
// Safari iOS: adiciona credentials:'include' a todos os fetch para o proxy
const _origFetch2 = window.fetch;

// ─── FETCH WRAPPER com intercept 401, timeout e credentials iOS ──────────────
const FETCH_TIMEOUT = 30000; // 30s timeout global para todos os fetches
// Apanha sessões expiradas e aplica timeout de 25s a pedidos WebDAV
const _origFetch = window.fetch.bind(window);
window.fetch = async (url, opts={}) => {
  // Timeout de 25s em pedidos ao proxy (não em uploads — esses têm o seu próprio controlo)
  let timeoutId;
  const isUpload   = opts.method === 'PUT' || opts.method === 'POST';
  const isAborted  = opts.signal;
  const isStream   = typeof url === 'string' && url.includes('/famcloud/stream');
  // Downloads explícitos marcados com X-FC-Download — sem timeout (ficheiros grandes)
  const isDownload = opts.headers?.['X-FC-Download'] === '1';
  if (!isUpload && !isAborted && !isStream && !isDownload && typeof url === 'string' && url.includes(PROXY)) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 15000);
    opts = { ...opts, signal: controller.signal };
  }
  let r;
  try {
    r = await _origFetch(url, opts);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (!r) throw new Error('Timeout ou sem resposta');
  if (r.status === 401 && S.user && url.toString().includes(PROXY)) {
    // Usa _refreshSession (AES decrypt → legacy fallback) — definido mais abaixo
    const refreshed = await _refreshSession();
    if (refreshed) {
      // Retry com signal limpo — o original pode estar abortado
      const r2 = await _origFetch(url, {
        ...opts, signal: undefined,
        headers: { ...(opts.headers||{}), 'Authorization': auth() }
      });
      if (r2.status !== 401) return r2;
    }
    if (S.user) { toast('Sessão expirada. A reconectar...', 'err'); setTimeout(doLogout, 1500); }
  }
  return r;
};
// URL directo do Nextcloud — usado APENAS no header Destination do WebDAV MOVE/COPY
// O Nextcloud valida que o Destination pertence ao mesmo servidor
const NC = 'https://nx91769.your-storageshare.de';
// Encoding seguro para nomes de ficheiros portugueses (acentos, espaços, etc.)
const safeName = n => encodeURIComponent(n).replace(/%20/g,' ');
// isMobile memoizado — recalcula só em resize, não em cada render
let _isMobileCache = window.innerWidth <= 700 || 'ontouchstart' in window;
window.addEventListener('resize', () => { _isMobileCache = window.innerWidth <= 700 || 'ontouchstart' in window; }, { passive: true });
const isMobile = () => _isMobileCache;

// ── MOVE com gestão de duplicados ───────────────────────────────────────────
// Retorna: 'ok' | 'skip' | 'error'
async function moveItem(src, destDir, options={}) {
  // options: { overwrite: false, autoRename: false }
  const srcNm = src.replace(/\/$/, '').split('/').pop();
  const destUrl = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + destDir + encodeURIComponent(srcNm);
  const overwriteH = options.overwrite ? 'T' : 'F';

  const r = await fetch(dav(src), {
    method: 'MOVE',
    headers: { 'Authorization': auth(), 'Destination': destUrl, 'Overwrite': overwriteH }
  });

  if (r.ok || r.status === 201 || r.status === 204) return { status: 'ok', name: srcNm };

  if (r.status === 412) {
    // Conflito — ficheiro já existe no destino
    if (options.overwrite) return { status: 'error', name: srcNm, code: 412 };

    if (options.autoRename) {
      // Gera nome único: foto.jpg → foto (2).jpg
      const newNm = await autoRename(srcNm, destDir);
      const destUrl2 = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + destDir + encodeURIComponent(newNm);
      const r2 = await fetch(dav(src), {
        method: 'MOVE',
        headers: { 'Authorization': auth(), 'Destination': destUrl2, 'Overwrite': 'F' }
      });
      if (r2.ok || r2.status === 201 || r2.status === 204) return { status: 'ok', name: newNm, renamed: true };
      return { status: 'error', name: srcNm, code: r2.status };
    }

    return { status: 'duplicate', name: srcNm, destUrl };
  }

  return { status: 'error', name: srcNm, code: r.status };
}

async function autoRename(name, destDir) {
  // Verifica quais nomes existem no destino e gera um único
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const base = ext ? name.slice(0, -(ext.length)) : name;
  let n = 2, candidate = name;
  // Lista o destino para ver o que existe
  try {
    const r = await fetch(dav(destDir), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>'
    });
    if (r.ok) {
      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      const existing = new Set([...xml.querySelectorAll('displayname')].map(el => el.textContent));
      while (existing.has(candidate)) { candidate = `${base} (${n++})${ext}`; }
    }
  } catch(e) {
    candidate = `${base} (${Date.now()})${ext}`;
  }
  return candidate;
}
const davDest = p => NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + p;
const trashDest = p => NC + '/remote.php/dav/trashbin/' + encodeURIComponent(S.user) + p;

// ─── UTILS ───────────────────────────────────────────────────────────────────
// ─── AUTH IMAGE CACHE ──────────────────────────────────────────────────────
// <img src=""> não envia Authorization. Carregamos via fetch com auth → blob URL
// LRU cache para thumbnails — max 150 entradas (evita memory leak em mobile)
const _IMG_CACHE_MAX = 300; // aumentado: 4 utilizadores com pastas grandes
const _imgCache = new Map();
// Concorrência limitada — máx 6 fetches de imagem simultâneos
const _IMG_CONCURRENCY = 6;      // thumbnails do grid
const _IMG_CONCURRENCY_GAL = 2;  // galeria — fila separada, não bloqueia grid

// Filas independentes: galeria não bloqueia thumbnails do grid
let _galQueue = [], _galActive = 0;
function _galNext() {
  if (_galActive >= _IMG_CONCURRENCY_GAL || !_galQueue.length) return;
  _galActive++;
  _galQueue.shift()().finally(() => { _galActive--; _galNext(); });
}
function _galThrottle(fn) {
  return new Promise(res => {
    _galQueue.push(() => fn().then(res, res));
    _galNext();
  });
}

const _activeBlobUrls = new Set();
// AbortController global para thumbnails — cancelado ao navegar
let _imgAbortCtrl = new AbortController();
// AbortController separado para a galeria — não é cancelado ao navegar entre pastas
let _galleryAbortCtrl = new AbortController();
let _galleryProgInt  = null; // interval da barra de progresso — module scope para evitar leak

// ── TOUCH STATE — module scope (não stale entre renders) ────────────────────
// Declarar aqui evita que renderFiles() re-declare e perca estado durante toque
let _tCard = null, _tTimer = null, _tMoved = false, _tX = 0, _tY = 0;

function _cancelPendingThumbs() {
  _imgAbortCtrl.abort();
  _imgAbortCtrl = new AbortController();
  _imgQueue.length = 0;
  _imgActive = 0;
  // Não cancela _galleryAbortCtrl — a galeria pode estar aberta durante navegação
}

function _cancelGallery() {
  _galleryAbortCtrl.abort();
  _galleryAbortCtrl = new AbortController();
  _galQueue.length = 0;
  _galActive = 0;
}

// ─── EXIF — lê metadados de JPEG via Range request (64KB) ────────────────────
const _exifCache = new Map(); // path → dados EXIF | null

async function _loadExif(item) {
  const bar = document.getElementById('gallery-exif');
  if (!bar || !isImg(item.name)) { if (bar) bar.innerHTML = ''; return; }

  const ext = (item.name.split('.').pop() || '').toLowerCase();
  if (!['jpg','jpeg','heic','heif'].includes(ext)) { bar.innerHTML = ''; return; }

  // Cache hit
  if (_exifCache.has(item.path)) {
    _renderExifBar(bar, _exifCache.get(item.path));
    return;
  }

  // Range request — só os primeiros 64KB (EXIF está no header do JPEG)
  try {
    const r = await _origFetch(dav(item.path), {
      headers: { 'Authorization': auth(), 'Range': 'bytes=0-65535' },
      signal: _galleryAbortCtrl.signal
    });
    if (!r.ok && r.status !== 206) { _exifCache.set(item.path, null); return; }

    const blob = await r.blob();

    // Usar exifr se disponível (CDN), fallback para leitura manual
    let data = null;
    if (typeof exifr !== 'undefined') {
      try {
        data = await exifr.parse(blob, {
          tiff: true, exif: true, gps: true,
          pick: ['Make','Model','DateTimeOriginal','FNumber','ExposureTime',
                 'ISO','FocalLength','ImageWidth','ImageHeight','GPSLatitude',
                 'GPSLongitude','GPSLatitudeRef','GPSLongitudeRef']
        });
      } catch(_) {}
    }

    const out = _parseExifData(data);
    _exifCache.set(item.path, out);
    _renderExifBar(bar, out);
  } catch(e) {
    if (e?.name !== 'AbortError') _exifCache.set(item.path, null);
  }
}

function _parseExifData(d) {
  if (!d) return null;
  const out = {};
  if (d.Make && d.Model) {
    out.camera = d.Model.startsWith(d.Make) ? d.Model : `${d.Make} ${d.Model}`.trim();
  } else if (d.Model) {
    out.camera = d.Model;
  }
  if (d.DateTimeOriginal) {
    try {
      const dt = d.DateTimeOriginal instanceof Date ? d.DateTimeOriginal : new Date(d.DateTimeOriginal);
      if (!isNaN(dt)) out.date = dt.toLocaleDateString('pt-PT', {
        day:'2-digit', month:'short', year:'numeric'
      }) + ' ' + dt.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });
    } catch(_) {}
  }
  if (d.FNumber)       out.aperture  = 'f/' + Number(d.FNumber).toFixed(1);
  if (d.ExposureTime)  out.shutter   = d.ExposureTime < 1
    ? '1/' + Math.round(1 / d.ExposureTime) + 's'
    : Number(d.ExposureTime).toFixed(1) + 's';
  if (d.ISO)           out.iso       = 'ISO ' + d.ISO;
  if (d.FocalLength)   out.focal     = Math.round(d.FocalLength) + 'mm';
  if (d.ImageWidth && d.ImageHeight) out.dims = `${d.ImageWidth}×${d.ImageHeight}`;

  // GPS
  if (d.GPSLatitude && d.GPSLongitude) {
    let lat = Array.isArray(d.GPSLatitude)
      ? d.GPSLatitude[0] + d.GPSLatitude[1]/60 + d.GPSLatitude[2]/3600
      : Number(d.GPSLatitude);
    let lon = Array.isArray(d.GPSLongitude)
      ? d.GPSLongitude[0] + d.GPSLongitude[1]/60 + d.GPSLongitude[2]/3600
      : Number(d.GPSLongitude);
    if (d.GPSLatitudeRef  === 'S') lat = -lat;
    if (d.GPSLongitudeRef === 'W') lon = -lon;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.mapsUrl = `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
    }
  }
  return Object.keys(out).length ? out : null;
}

function _renderExifBar(bar, exif) {
  if (!exif) { bar.innerHTML = ''; return; }
  const parts = [];
  if (exif.date)    parts.push(`📅 ${exif.date}`);
  if (exif.camera)  parts.push(`📷 ${exif.camera}`);
  if (exif.dims)    parts.push(`📐 ${exif.dims}`);
  const tech = [exif.aperture, exif.shutter, exif.iso, exif.focal].filter(Boolean);
  if (tech.length)  parts.push(tech.join(' · '));
  if (exif.mapsUrl) parts.push(`<a href="${exif.mapsUrl}" target="_blank" rel="noopener" style="color:inherit">📍 Ver no mapa</a>`);
  bar.innerHTML = parts.map(p => `<span class="exif-item">${p}</span>`).join('');
}

function _imgCacheCleanup() {
  if (_imgCache.size <= _IMG_CACHE_MAX) return;
  // Remove os mais antigos (primeiros 20)
  const keys = Array.from(_imgCache.keys()).slice(0, 20);
  keys.forEach(k => {
    try { URL.revokeObjectURL(_imgCache.get(k)); } catch(e) {}
    _imgCache.delete(k);
  });
}

// ─── LAZY IMAGE LOADING via IntersectionObserver ──────────────────────────────
const _lazyObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const img = entry.target;
    const src = img.dataset.src;
    const fb  = img.dataset.fb;
    if (src) {
      delete img.dataset.src;
      delete img.dataset.fb;
      authImg(img, src, fb);
    }
    _lazyObserver.unobserve(img);
  });
}, { rootMargin: '800px 0px', threshold: 0.01 }); // pré-carrega mais cedo — menos 'buracos' em scroll rápido
let _imgQueue = [], _imgActive = 0;
function _imgNext() {
  if (_imgActive >= _IMG_CONCURRENCY || !_imgQueue.length) return;
  _imgActive++;
  const fn = _imgQueue.shift();
  fn().finally(() => { _imgActive--; _imgNext(); });
}
function _imgThrottle(fn) {
  return new Promise(res => {
    _imgQueue.push(() => fn().then(res, res));
    _imgNext();
  });
}
function _imgCacheSet(key, val) {
  if (_imgCache.size >= _IMG_CACHE_MAX) {
    // Remove a entrada mais antiga (Map mantém ordem de inserção)
    const oldest = _imgCache.keys().next().value;
    const oldUrl = _imgCache.get(oldest);
    // Nunca revogar — deixar o GC tratar (evita ERR_FILE_NOT_FOUND)
    // URLs de blob são pequenas e o GC limpa quando necessário
    _imgCache.delete(oldest);
  }
  _imgCache.set(key, val);
}
// Gera URL de thumbnail nativo do Nextcloud
function thumbUrl(fileid, size=128) {
  // Default 128px: suficiente para cards mobile (124px) e desktop (148px)
  // Retina: o browser escala correctamente com object-fit:cover
  // Reduzir de 256 → 128: thumbnails ~4x menores → 4x mais rápidos no 1º load
  if (!fileid) return null;
  const s = Math.min(size, 256); // máximo 256px
  return PROXY + '/nextcloud/index.php/core/preview?fileId=' + fileid + '&x=' + s + '&y=' + s + '&forceIcon=0&a=1';
}
async function authImg(el, url, fallbackUrl, externalSignal) {
  if (!url) return;
  const cacheKey = url;

  // 1. Cache em memória (mais rápido — sem IDB)
  if (_imgCache.has(cacheKey)) { el.src = _imgCache.get(cacheKey); return; }

  // 2. IDB — só para ficheiros completos (fotos offline)
  // Thumbnails (/preview) são cacheados pelo SW — mais rápido que IDB b64
  if (!url.includes('/preview') && !url.includes('/core/')) {
    const idbCached = await Promise.race([
      _idbThumb.get(cacheKey),
      new Promise(res => setTimeout(() => res(null), 150))
    ]);
    if (idbCached) {
      try {
        const blobUrl = b64ToBlobUrl(idbCached);
        _imgCache.set(cacheKey, blobUrl);
        el.src = blobUrl;
        return;
      } catch(_) {}
    }
  }

  // Galeria usa fila própria (não bloqueia thumbnails do grid)
  const throttleFn = externalSignal ? _galThrottle : _imgThrottle;
  await throttleFn(async () => {
  try {
    const signal = externalSignal || _imgAbortCtrl.signal;
    if (signal.aborted) return;
    // Usa _origFetch para thumbnails — sem timeout global (estão na fila com concorrência limitada)
    // O timeout do wrapper seria aplicado ao tempo total na fila, não ao fetch em si
    const r = await _origFetch(url, { headers: { 'Authorization': auth() }, redirect: 'follow', signal });
    if (r.ok) {
      const blob = await r.blob();
      if (blob.type.startsWith('image/') && blob.size > 100) {
        const objUrl = URL.createObjectURL(blob);
        _imgCache.set(cacheKey, objUrl);
        _imgCacheCleanup();
        el.src = objUrl;
        _activeBlobUrls.add(objUrl);
        el.onload = () => {};
        el.onerror = () => { _activeBlobUrls.delete(objUrl); };
        // Thumbnails (/preview) → SW Cache API trata disto automaticamente (30 dias)
        // Não guardar no _idbThumb — SW cacheFirst é mais rápido que b64ToBlobUrl
        return;
      }
    }
    // Worker v5.0 devolve SVG placeholder em vez de 404 — fallback não necessário
    // Se chegou aqui, o blob.type não era imagem ou o size era <= 100 bytes
    // O onerror do <img> já trata isto mostrando o ícone genérico
  } catch(e) { if (e.name !== 'AbortError') { /* silencioso — mostra ícone genérico */ } }
  }); // _imgThrottle
}


const b64 = s => btoa(unescape(encodeURIComponent(s)));
const auth = () => 'Basic ' + b64(S.user + ':' + S.pass);
// ─── ENCRIPTAÇÃO AES-GCM (Web Crypto API) ────────────────────────────────────
// Credenciais encriptadas com AES-256-GCM
// Chave derivada com PBKDF2 a partir de uma chave de dispositivo
// Mesmo que alguém leia o localStorage, não consegue decifrar sem a chave

// Chave de dispositivo: combinação de user-agent + hostname (estável por browser/device)
const _deviceKey = () => {
  const raw = (navigator.userAgent + location.hostname + 'famcloud-2026').slice(0, 64);
  return raw;
};

async function _deriveKey(keyMaterial) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(keyMaterial), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:enc.encode('famcloud-salt-2026'), iterations:100000, hash:'SHA-256' },
    baseKey, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}

async function encryptCred(plaintext) {
  try {
    const key = await _deriveKey(_deviceKey());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name:'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    // Combina IV + ciphertext em base64
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch(e) {
    // Fallback para obfuscação simples se Web Crypto não disponível
    return btoa('fc2026' + btoa(unescape(encodeURIComponent(plaintext))));
  }
}

async function decryptCred(cipherB64) {
  try {
    const key = await _deriveKey(_deviceKey());
    const combined = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name:'AES-GCM', iv }, key, ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch(e) {
    // Fallback: tenta deobfuscação legacy
    try {
      const d = atob(cipherB64);
      return decodeURIComponent(escape(atob(d.slice(6))));
    } catch(e2) { return null; }
  }
}

// Compatibilidade com código existente (async wrappers)
const obfuscate = s => btoa('fc2026' + btoa(unescape(encodeURIComponent(s))));
const deobfuscate = s => { try { const d = atob(s); return decodeURIComponent(escape(atob(d.slice(6)))); } catch(e) { return s; } };
const dav = p => PROXY + '/nextcloud/remote.php/dav/files/' + encodeURIComponent(S.user) + p;
const ex = n => (n||'').split('.').pop().toLowerCase();
const isImg = n => IE.includes(ex(n));
const isVid = n => VE.includes(ex(n));
const isAud = n => AE.includes(ex(n));
const isPdf = n => ex(n) === 'pdf';
const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
// Sanitização HTML para uso em innerHTML (previne XSS via nomes de ficheiros)
const hesc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function normPath(href) {
  return href
    .replace(PROXY+'/nextcloud/remote.php/dav/files/'+encodeURIComponent(S.user),'')
    .replace(PROXY+'/nextcloud/remote.php/dav/files/'+S.user,'')
    .replace('/nextcloud/remote.php/dav/files/'+encodeURIComponent(S.user),'')
    .replace('/nextcloud/remote.php/dav/files/'+S.user,'')
    .replace('/remote.php/dav/files/'+encodeURIComponent(S.user),'')
    .replace('/remote.php/dav/files/'+S.user,'');
}

function toast(m, t='') {
  const e = document.getElementById('toast');
  e.textContent = m; e.className = 'toast ' + t; e.classList.add('show');
  clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 3400);
}

function showM(t) { document.getElementById(t+'-modal').style.display = 'flex'; }
function hideM(t) { document.getElementById(t+'-modal').style.display = 'none'; }

function fmtSz(b) {
  if (!b || b < 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function fmtDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-PT',{day:'2-digit',month:'2-digit',year:'numeric'}) +
         ' ' + d.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'});
}

function folderIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('foto') || n.includes('photo') || n.includes('imagem') || n.includes('image')) return '🖼️';
  if (n.includes('video') || n.includes('vídeo') || n.includes('filme') || n.includes('movie')) return '🎬';
  if (n.includes('familia') || n.includes('família') || n.includes('family')) return '👨‍👩‍👧‍👦';
  if (n.includes('desporto') || n.includes('sport') || n.includes('futebol') || n.includes('treino')) return '⚽';
  if (n.includes('ferias') || n.includes('férias') || n.includes('vacation') || n.includes('viagem')) return '🏖️';
  if (n.includes('document') || n.includes('doc') || n.includes('arquivo') || n.includes('paper')) return '📄';
  if (n.includes('music') || n.includes('música') || n.includes('audio')) return '🎵';
  if (n.includes('download') || n.includes('transfere')) return '⬇️';
  if (n.includes('backup')) return '💾';
  if (n.includes('trabalho') || n.includes('work') || n.includes('job')) return '💼';
  if (n.includes('pessoal') || n.includes('personal') || n.includes('private')) return '🔒';
  if (n.includes('nota') || n.includes('note')) return '📝';
  if (n.includes('comida') || n.includes('receita') || n.includes('food')) return '🍽️';
  if (n.includes('casa') || n.includes('home') || n.includes('apartamento')) return '🏠';
  if (n.includes('escola') || n.includes('school') || n.includes('estudo')) return '📚';
  if (n.includes('saude') || n.includes('saúde') || n.includes('health') || n.includes('medic')) return '🏥';
  if (n.includes('osm') || n.includes('ids') || n.includes('hdc')) return '📁';
  return '📁';
}

function fIcon(n) {
  const e = ex(n);
  if (IE.includes(e)) return '🖼️';
  if (VE.includes(e)) return '🎬';
  if (AE.includes(e)) return '🎵';
  if (e==='pdf') return '📕';
  if (['doc','docx'].includes(e)) return '📝';
  if (['xls','xlsx'].includes(e)) return '📊';
  if (['ppt','pptx'].includes(e)) return '📋';
  if (['zip','rar','7z','tar','gz','bz2'].includes(e)) return '🗜️';
  if (['html','css','js','ts','jsx','tsx','py','java','cpp','c','go','rs'].includes(e)) return '💻';
  if (['txt','md'].includes(e)) return '📄';
  return '📄';
}

function iCls(n) {
  const e = ex(n);
  if (IE.includes(e)) return 'ic-i';
  if (VE.includes(e)) return 'ic-v';
  if (AE.includes(e)) return 'ic-a';
  if (e==='pdf') return 'ic-p';
  if (['doc','docx','xls','xlsx','ppt','pptx'].includes(e)) return 'ic-d';
  return 'ic-x';
}

// ─── DROPDOWN ────────────────────────────────────────────────────────────────
function toggleDrop() {
  document.getElementById('udrop').classList.toggle('show');
  document.getElementById('ubtn').classList.toggle('open');
}
function closeDrop() {
  document.getElementById('udrop').classList.remove('show');
  document.getElementById('ubtn').classList.remove('open');
}
document.addEventListener('click', e => { if (!e.target.closest('.udrop-wrap')) setTimeout(() => closeDrop(), 100); });

// ─── OFFLINE ─────────────────────────────────────────────────────────────────
function setupOffline() {
  const update = () => {
    const pill = document.getElementById('offline-pill');
    if (!navigator.onLine) { pill.style.display='block'; toast('Sem ligação — a usar cache','err'); }
    else { pill.style.display='none'; }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}
// ══════════════════════════════════════════════════════════════
// WEBAUTHN — LOGIN COM BIOMETRIA (Fingerprint / Face ID)
// ══════════════════════════════════════════════════════════════
const BioAuth = {
  async isSupported() {
    return !!(window.PublicKeyCredential && 
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.());
  },
  
  async register() {
    if (!await this.isSupported()) {
      toast('Biometria não suportada neste dispositivo', 'err');
      return;
    }
    
    try {
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: new Uint8Array(32),
          rp: { name: 'FamCloud', id: location.hostname },
          user: {
            id: new TextEncoder().encode(S.user),
            name: S.user,
            displayName: S.user
          },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required'
          },
          timeout: 60000
        }
      });
      
      localStorage.setItem('fc_webauthn_cred', JSON.stringify({
        id: credential.id,
        rawId: Array.from(new Uint8Array(credential.rawId)),
        response: {
          clientDataJSON: Array.from(new Uint8Array(credential.response.clientDataJSON)),
          attestationObject: Array.from(new Uint8Array(credential.response.attestationObject))
        }
      }));
      
      toast('✅ Biometria ativada! Próximo login com 1 toque.', 'ok');
    } catch(e) {
      Logger.error('WebAuthn register failed', e.message);
      toast('Erro ao configurar biometria', 'err');
    }
  },
  
  async login() {
    const stored = localStorage.getItem('fc_webauthn_cred');
    if (!stored) return false;
    
    try {
      const cred = JSON.parse(stored);
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(32),
          allowCredentials: [{
            id: new Uint8Array(cred.rawId),
            type: 'public-key'
          }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      
      if (assertion) return true;
    } catch(e) {
      Logger.warn('WebAuthn login failed', e.message);
    }
    return false;
  }
};

// ─── REFRESH DE SESSÃO CENTRALIZADO ─────────────────────────────────────────
// Fluxo (diagrama 1): visibilitychange → _refreshSession → SET_AUTH → PROPFIND
// Hierarquia: AES-GCM → JSON legacy → XOR legacy
async function _refreshSession() {
  const saved = localStorage.getItem('fc_cred');
  if (!saved) return false;
  const isAES = localStorage.getItem('fc_cred_enc') === '1';
  try {
    let plaintext;
    if (isAES) {
      plaintext = await decryptCred(saved);
    } else {
      try { JSON.parse(saved); plaintext = saved; }
      catch(_) { plaintext = deobfuscate(saved); }
    }
    if (!plaintext) return false;
    const d = JSON.parse(plaintext);
    if (!d?.user || !d?.pass) return false;
    S.user = d.user; S.pass = d.pass;
    navigator.serviceWorker?.controller?.postMessage({ type: 'SET_AUTH', auth: auth() });
    return true;
  } catch(e) {
    Logger.warn('_refreshSession falhou', e?.message);
    return false;
  }
}

// ─── LOGIN / LOGOUT ───────────────────────────────────────────────────────────
async function doLogin() {
  S.server = PROXY;
  S.user   = document.getElementById('usr').value.trim();
  S.pass   = document.getElementById('pwd').value;
  if (!S.user || !S.pass) { setLE('Preenche o utilizador e a palavra-passe.'); return; }
  const btn = document.getElementById('login-btn');
  btn.textContent = 'A entrar...'; btn.disabled = true;
  try {
    // Login via WebDAV PROPFIND — único método que funciona através do proxy Cloudflare Worker
    // (Netlify filtra o header Authorization nas rotas /ocs/ por segurança)
    // Autenticação: GET simples ao DAV — funciona com ou sem body, Netlify não bloqueia
    // PROPFIND retorna 207, GET retorna 200 (HTML) ou redireciona — ambos significam auth OK
    // 401 = credenciais erradas em qualquer caso
    let loginOk = false, loginStatus = 0;
    try {
      const r = await fetch(dav('/'), {
        method: 'GET',
        headers: { 'Authorization': auth() }
      });
      loginStatus = r.status;
      // GET a pasta WebDAV com credenciais válidas: 200, 207, 301, 302 são todos sucesso
      loginOk = r.status !== 401 && r.status !== 403;
    } catch(e) {
      setLE('Erro de ligação: ' + e.message); return;
    }

    if (loginOk) {
      const _credRaw = JSON.stringify({server:S.server,user:S.user,pass:S.pass});
      // Encripta com AES-GCM antes de guardar
      encryptCred(_credRaw).then(_cred => {
        localStorage.setItem('fc_cred', _cred);
        localStorage.setItem('fc_cred_enc', '1'); // marca como encriptado
        localStorage.setItem('fc_cred_ts', Date.now().toString());
        sessionStorage.setItem('fc', _cred);
      }).catch(() => {
        // Fallback para obfuscação
        const _cred = obfuscate(_credRaw);
        localStorage.setItem('fc_cred', _cred);
        sessionStorage.setItem('fc', _cred);
      });
      initApp();
    } else if (loginStatus === 401) {
      setLE('Credenciais incorretas. Usa a App Password do Nextcloud (Settings → Security → App passwords).');
    } else if (loginStatus === 403) {
      setLE('Sem permissão (403). Verifica o utilizador.');
    } else {
      setLE('Erro ao ligar (' + loginStatus + '). Verifica o servidor.');
    }
  } catch(e) { setLE('Não foi possível ligar. Verifica a ligação à internet.'); }
  btn.textContent = 'Entrar ☁️'; btn.disabled = false;
}

function setLE(m) { const e = document.getElementById('lerr'); e.textContent = m; e.style.display = 'block'; }

function initApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  // Handle PWA shortcuts
  const urlParams = new URLSearchParams(window.location.search);
  const action = urlParams.get('action');
  if (action === 'upload') setTimeout(() => document.getElementById('ufi').click(), 500);
  else if (action === 'camera') setTimeout(() => document.getElementById('cam-input').click(), 500);
  else if (action === 'search') setTimeout(() => openSearch(), 500);
  document.getElementById('uname-top').textContent = S.user;
  document.getElementById('drop-nm').textContent = S.user;
  document.getElementById('uav-l').textContent = S.user.charAt(0).toUpperCase();
  // Indicador offline/online
  initOfflineDetection();
  // Carrega widget "Hoje na História"
  setTimeout(() => loadTodayInHistory(), 2000);
  // Restaura emoji avatar se existir
  const savedEmoji = localStorage.getItem('fc_emoji_av_' + S.user);
  if (savedEmoji) {
    const uav = document.getElementById('uav');
    if (uav) uav.innerHTML = `<span style="font-size:18px">${savedEmoji}</span>`;
  }
  // Restaura display name
  const savedDN = localStorage.getItem('fc_display_name_' + S.user);
  if (savedDN) {
    const unTop = document.getElementById('uname-top');
    const dropNm = document.getElementById('drop-nm');
    if (unTop) unTop.textContent = savedDN;
    if (dropNm) dropNm.textContent = savedDN;
  }
  // Mostra botão câmara em iOS e Android — ambos suportam capture="environment"
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    document.getElementById('cam-btn').style.display = 'flex';
  }
  if (!S.sidebarOpen) document.getElementById('sb').classList.add('closed');
  setV(S.view, false);
  ['name','date','size'].forEach(k => document.getElementById('s-'+k).classList.toggle('on', k===S.sort.by));
  document.getElementById('s-dir').textContent = S.sort.dir==='asc' ? '↑' : '↓';
  renderThemeDots();
  renderThemeGrid();
  loadAvatar();
  // Restaura última pasta visitada (sobrevive a refresh)
  const _lastPath = (() => {
    try {
      const p = localStorage.getItem('fc_last_path');
      // Valida: começa com '/', não é vazio, não tem '..'
      if (p && p.startsWith('/') && !p.includes('..')) return p;
    } catch(_) {}
    return '/';
  })();
  loadFiles(_lastPath);
  loadStorage();
  loadTree('/');
  setupOffline();
  // Reset tabs (important on re-login)
  calLoaded = false; notesLoaded = false; wxLoaded = false;
  switchTab('files');
  // Verifica uploads pendentes de sessão anterior
  setTimeout(checkUploadQueue, 2000);
  // Inicia indexação BFS em background (3s de delay para não competir com o load inicial)
  setTimeout(startBackgroundIndex, 3000);
}

function doLogout() {
  // ── Cancela todos os processos em curso antes de limpar o estado ──
  // Timers
  clearTimeout(_loadDebounceTimer); _loadDebounceTimer = null;
  // PROPFIND em curso
  if (S.loadAbort)  { S.loadAbort.abort();  S.loadAbort  = null; }
  if (_bgAbort)     { _bgAbort.abort();      _bgAbort     = null; }
  // Upload XHR
  if (S.uploadXHR)  { S.uploadXHR.abort();  S.uploadXHR  = null; }
  S.uploadCancel = true;
  // Slideshow
  if (SS.interval)   { clearInterval(SS.interval); SS.interval = null; }
  if (SS.fetchAbort) { SS.fetchAbort.abort(); SS.fetchAbort = null; }
  const ssVid = document.getElementById('ss-vid');
  if (ssVid) { ssVid.pause(); ssVid.src = ''; }
  // LazyObserver — limpa todas as referências a imgs antigas
  try { _lazyObserver.disconnect(); } catch(_) {}
  // Media overlay activo
  if (_activeMediaOverlay) {
    try { _activeMediaOverlay.remove(); } catch(_) {}
    _activeMediaOverlay = null;
  }
  // Limpa cache de imagens em memória (blob URLs)
  _imgCache.clear();
  _imgQueue.length = 0;
  // Cancela upload queue
  UPQ.jobs = [];

  // ── Limpa estado ──
  sessionStorage.clear();
  localStorage.removeItem('fc_cred');
  localStorage.removeItem('fc_cred_enc');
  S.user=''; S.pass=''; S.server=''; S.path='/'; S.hist=[];
  S.selected.clear(); S.selecting=false; S.lastItems=[];
  S._pendingRefresh = null;
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pwd').value = '';
  document.getElementById('lerr').style.display = 'none';
  document.getElementById('uav').innerHTML = '<span id="uav-l"></span>';
  // Remove badge de refresh se existir
  document.getElementById('refresh-badge')?.remove();
  calLoaded = false; notesLoaded = false; wxLoaded = false;
  // Limpa auth do SW — sem requests autenticados após logout
  navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_AUTH' });
  stopBackgroundIndex();
  if(typeof switchTab==='function') switchTab('files');
}

// ─── AVATAR ───────────────────────────────────────────────────────────────────
async function loadAvatar() {
  try {
    const r = await fetch(PROXY+`/nextcloud/index.php/avatar/${encodeURIComponent(S.user)}/128`, {
      headers: { 'Authorization': auth() }
    });
    if (r.ok) { setAvatar(URL.createObjectURL(await r.blob())); return; }
  } catch(e) { Logger.info('loadAvatar: endpoint principal falhou', e?.message); }
  const stored = sessionStorage.getItem('fc_avpath');
  if (stored) {
    try {
      const r = await fetch(dav(stored), { headers: { 'Authorization': auth() } });
      if (r.ok) setAvatar(URL.createObjectURL(await r.blob()));
    } catch(e) { Logger.info('loadAvatar: fallback falhou', e?.message); }
  }
}

function setAvatar(src) {
  document.getElementById('uav').innerHTML = `<img src="${src}" alt="">`;
  document.getElementById('prof-av').innerHTML = `<img src="${src}" alt=""><div class="prof-av-badge">📷</div>`;
}

async function uploadAvatar(file) {
  if (!file) return;
  const st = document.getElementById('av-status');
  st.textContent = 'A carregar...';
  try {
    const fd = new FormData(); fd.append('files[]', file);
    const r = await fetch(PROXY+'/nextcloud/index.php/avatar', {
      method: 'POST', headers: { 'Authorization': auth(), 'requesttoken': '' }, body: fd
    });
    if (r.ok) {
      await new Promise(res => setTimeout(res, 900)); await loadAvatar();
      st.textContent = '✅ Foto atualizada!'; toast('Foto de perfil atualizada!', 'ok'); return;
    }
  } catch(e) {}
  // Fallback: WebDAV
  try {
    await fetch(dav('/.famcloud-avatars'), { method:'MKCOL', headers:{'Authorization':auth()} }).catch(()=>{}); // 405=já existe, ok
    const ext = file.name.split('.').pop().toLowerCase();
    const p = `/.famcloud-avatars/${S.user}.${ext}`;
    await fetch(dav(p), { method:'PUT', headers:{'Authorization':auth()}, body:file });
    const r2 = await fetch(dav(p), { headers:{'Authorization':auth()} });
    if (r2.ok) { setAvatar(URL.createObjectURL(await r2.blob())); sessionStorage.setItem('fc_avpath', p); }
    st.textContent = '✅ Foto guardada!'; toast('Foto de perfil guardada!', 'ok');
  } catch(e) { st.textContent = 'Erro ao guardar foto.'; toast('Erro ao guardar foto', 'err'); }
  document.getElementById('av-input').value = '';
}

// Avatares pré-definidos (emojis como o Discord)
const AV_PRESETS = ['🦁','🐯','🦊','🐺','🦝','🐻','🐼','🐨','🦄','🐸','🦋','🦅','🌟','🔥','⚡','🌈','🎭','🎸','🚀','🌊'];

function openProfile() {
  const nmEl = document.getElementById('prof-nm');
  const avlEl = document.getElementById('prof-av-l');
  const stEl = document.getElementById('av-status');
  const profAv = document.getElementById('prof-av');
  const dispNm = document.getElementById('prof-display-nm');
  const okEl = document.getElementById('prof-ok');
  const errEl = document.getElementById('prof-err');
  if (nmEl) nmEl.textContent = S.user;
  if (avlEl) avlEl.textContent = S.user.charAt(0).toUpperCase();
  if (stEl) stEl.textContent = '';
  if (okEl) okEl.style.display = 'none';
  if (errEl) errEl.style.display = 'none';
  // Preenche nome actual
  const savedName = localStorage.getItem('fc_display_name_' + S.user) || S.user;
  if (dispNm) dispNm.value = savedName;
  // Avatar actual
  const img = document.getElementById('uav')?.querySelector('img');
  if (img && profAv) profAv.innerHTML = `<img src="${img.src}" alt=""><div class="prof-av-badge">📷</div>`;
  // Avatares pré-definidos
  const presetsEl = document.getElementById('av-presets');
  if (presetsEl) {
    presetsEl.innerHTML = AV_PRESETS.map(em => `
      <div onclick="window.setEmojiAvatar('${em}')" style="width:44px;height:44px;border-radius:50%;background:var(--gradient);display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;border:2px solid transparent;transition:all .15s;"
        onmouseover="this.style.borderColor='var(--primary)';this.style.transform='scale(1.1)'"
        onmouseout="this.style.borderColor='transparent';this.style.transform=''">
        ${em}
      </div>`).join('');
  }
  showM('profile');
}

function setEmojiAvatar(emoji) {
  // Guarda emoji como avatar
  localStorage.setItem('fc_emoji_av_' + S.user, emoji);
  Store.set('emojiAvatar', emoji);
  // Actualiza UI
  const uav = document.getElementById('uav');
  const profAv = document.getElementById('prof-av');
  const avl = document.getElementById('uav-l');
  if (uav) uav.innerHTML = `<span style="font-size:18px">${emoji}</span>`;
  if (profAv) profAv.innerHTML = `<span style="font-size:44px">${emoji}</span><div class="prof-av-badge">📷</div>`;
  if (avl) avl.textContent = '';
  document.getElementById('av-status').textContent = '✅ Avatar actualizado!';
  toast('Avatar actualizado!', 'ok');
}

async function saveProfile() {
  const dispNm = document.getElementById('prof-display-nm');
  const okEl = document.getElementById('prof-ok');
  const errEl = document.getElementById('prof-err');
  if (okEl) okEl.style.display = 'none';
  if (errEl) errEl.style.display = 'none';
  const newName = dispNm?.value.trim();
  if (!newName) return;
  // Guarda localmente (Nextcloud OCS para display name)
  localStorage.setItem('fc_display_name_' + S.user, newName);
  // Tenta actualizar no Nextcloud
  try {
    const params = new URLSearchParams();
    params.append('key', 'displayname');
    params.append('value', newName);
    const r = await fetch(PROXY + '/nextcloud/ocs/v2.php/cloud/users/' + encodeURIComponent(S.user), {
      method: 'PUT',
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const txt = await r.text();
    if (txt.includes('200') || txt.includes('100')) {
      if (okEl) okEl.style.display = 'block';
      // Actualiza nome na topbar
      const unTop = document.getElementById('uname-top');
      const dropNm = document.getElementById('drop-nm');
      if (unTop) unTop.textContent = newName;
      if (dropNm) dropNm.textContent = newName;
      toast('Nome actualizado!', 'ok');
    } else {
      // Guardou localmente mesmo que o servidor não aceite
      if (okEl) okEl.style.display = 'block';
      toast('Nome guardado localmente!', 'ok');
    }
  } catch(e) {
    if (okEl) okEl.style.display = 'block';
    toast('Nome guardado localmente!', 'ok');
  }
}

// ─── PASSWORD ─────────────────────────────────────────────────────────────────
function openPassM() {
  ['pw-cur','pw-new','pw-conf'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pw-ok').style.display = 'none';
  document.getElementById('pw-err').style.display = 'none';
  showM('pass');
  setTimeout(() => document.getElementById('pw-cur').focus(), 80);
}

async function changePass() {
  const cur  = document.getElementById('pw-cur').value;
  const nw   = document.getElementById('pw-new').value;
  const cf   = document.getElementById('pw-conf').value;
  const errEl = document.getElementById('pw-err');
  const okEl  = document.getElementById('pw-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  if (!cur||!nw||!cf) { errEl.textContent='Preenche todos os campos.'; errEl.style.display='block'; return; }
  if (nw !== cf)       { errEl.textContent='As palavras-passe não coincidem.'; errEl.style.display='block'; return; }
  if (nw.length < 10)  { errEl.textContent='Mínimo 10 caracteres.'; errEl.style.display='block'; return; }
  if (!/[A-Z]/.test(nw)) { errEl.textContent='Precisas de pelo menos uma maiúscula.'; errEl.style.display='block'; return; }
  if (!/[0-9]/.test(nw)) { errEl.textContent='Precisas de pelo menos um número.'; errEl.style.display='block'; return; }
  const btn = document.getElementById('pw-btn'); btn.textContent = 'A guardar...'; btn.disabled = true;
  try {
    const params = new URLSearchParams(); params.append('key','password'); params.append('value',nw);
    const r = await fetch(PROXY+`/nextcloud/ocs/v2.php/cloud/users/${encodeURIComponent(S.user)}`, {
      method: 'PUT',
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const txt = await r.text();
    if (txt.includes('<statuscode>200</statuscode>') || txt.includes('<statuscode>100</statuscode>')) {
      S.pass = nw; sessionStorage.setItem('fc', JSON.stringify({server:S.server,user:S.user,pass:S.pass}));
      okEl.style.display = 'block'; toast('Palavra-passe alterada!', 'ok');
    } else if (r.status === 403 || txt.includes('997')) {
      errEl.textContent = 'Sem permissão. Confirma a palavra-passe atual.'; errEl.style.display='block';
    } else {
      errEl.textContent = 'Erro ao alterar ('+r.status+'). Tenta novamente.'; errEl.style.display='block';
    }
  } catch(e) { errEl.textContent = 'Erro de ligação.'; errEl.style.display='block'; }
  btn.textContent = 'Guardar'; btn.disabled = false;
}

// ─── STORAGE BAR ─────────────────────────────────────────────────────────────
async function loadStorage() {
  try {
    // Tenta OCS API primeiro — devolve quota real configurada no servidor
    const ocsUrl = PROXY + '/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/remote_shares?format=json';
    const uUrl   = PROXY + '/nextcloud/ocs/v1.php/cloud/users/' + encodeURIComponent(S.user) + '?format=json';
    let used = 0, total = 0, avail = -1;

    try {
      const ru = await fetch(uUrl, { headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' } });
      if (ru.ok) {
        const j = await ru.json();
        const quota = j?.ocs?.data?.quota;
        if (quota) {
          used  = quota.used  || 0;
          total = quota.total || 0;
          avail = quota.free  || -1;
        }
      }
    } catch(e2) {}

    // Fallback: PROPFIND WebDAV
    if (!used) {
      const r = await fetch(dav('/'), {
        method: 'PROPFIND',
        headers: { 'Authorization': auth(), 'Depth': '0', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:quota-used-bytes/><oc:quota-available-bytes/></d:prop></d:propfind>`
      });
      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      used  = parseInt(xml.querySelector('quota-used-bytes')?.textContent  || '0');
      avail = parseInt(xml.querySelector('quota-available-bytes')?.textContent || '-3');
      total = avail > 0 ? used + avail : 0;
    }

    const fill = document.getElementById('st-fill');
    fill.classList.remove('warn');

    if (total > 0) {
      // Quota conhecida
      const pct = Math.min(100, Math.round(used / total * 100));
      document.getElementById('st-txt').textContent = `💾 ${fmtSz(used)} de ${fmtSz(total)}`;
      fill.style.width = pct + '%';
      document.getElementById('st-pct').textContent = pct + '%';
      if (pct > 80) fill.classList.add('warn');
    } else {
      // Quota ilimitada ou desconhecida — mostra só o usado
      document.getElementById('st-txt').textContent = `💾 ${fmtSz(used)} usados`;
      fill.style.width = '0%';
      document.getElementById('st-pct').textContent = '';
    }
  } catch(e) { document.getElementById('st-txt').textContent = '💾 Armazenamento'; }
}

// ─── FAVORITES ────────────────────────────────────────────────────────────────
function saveFavs() { localStorage.setItem('fc_favs', JSON.stringify(S.favorites)); }

function toggleFav(path, name, e) {
  if (e) e.stopPropagation();
  const idx = S.favorites.findIndex(f => f.path === path);
  if (idx >= 0) { S.favorites.splice(idx,1); toast('Removido dos favoritos'); }
  else { S.favorites.push({path, name}); toast('Adicionado aos favoritos ⭐', 'ok'); }
  saveFavs(); renderFavs();
}

function renderFavs() {
  const el = document.getElementById('favs-list');
  if (!S.favorites.length) {
    el.innerHTML = '<div style="padding:6px 14px;font-size:12px;color:var(--text2)">Sem favoritos ainda</div>';
    return;
  }
  el.innerHTML = S.favorites.map(f => `
    <div class="ti${S.path===f.path?' active':''}" data-path="${f.path}" onclick="window.navTo('${esc(f.path)}')">
      <span class="ti-ic">⭐</span>
      <span class="ti-nm">${f.name}</span>
      <span class="ti-star on" onclick="toggleFav('${esc(f.path)}','${esc(f.name)}',event)" title="Remover">✕</span>
    </div>`).join('');
}

// ─── TREE ─────────────────────────────────────────────────────────────────────
async function loadTree(p, parentEl) {
  const target = parentEl || document.getElementById('tree');
  if (!parentEl) {
    target.innerHTML = '<div style="padding:12px 14px"><div class="spin" style="width:14px;height:14px;margin:auto"></div></div>';
  }
  try {
    const r = await fetch(dav(p), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><oc:fileid xmlns:oc="http://owncloud.org/ns"/></d:prop></d:propfind>`
    });
    const xmlText = await r.text();
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (!parentEl) { target.innerHTML = ''; target.appendChild(mkTI('🏠','Início','/')); }
    const dirs = [];
    const allItems = []; // para guardar no IDB e evitar PROPFIND extra no loadFiles
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (normPath(rel) === normPath(p) || !rel || rel === '/') return;
      const isDir = resp.querySelector('resourcetype collection') !== null;
      const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
      if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
      const mod  = resp.querySelector('getlastmodified')?.textContent || '';
      const date = mod ? new Date(mod) : new Date(0);
      const fpath = isDir ? (rel.endsWith('/') ? rel : rel+'/') : rel;
      const fileid = resp.querySelector('fileid')?.textContent || '';
      allItems.push({ name:nm, path:fpath, isDir, size, date, dateStr:fmtDate(date), fileid });
      if (isDir) dirs.push({ nm, path: fpath });
    });
    // Guarda no IDB — openDir vai encontrar cache fresco e não precisar de PROPFIND
    if (allItems.length && p !== '/') _idb.set(p, allItems);
    dirs.sort((a,b) => a.nm.localeCompare(b.nm));
    dirs.forEach(d => {
      const wrap = document.createElement('div');
      const item = document.createElement('div');
      item.className = 'ti' + (S.path===d.path?' active':'');
      item.dataset.path = d.path;
      const isFav = S.favorites.some(f => f.path===d.path);
      item.innerHTML = `<span class="ti-ic">${folderIcon(d.nm)}</span><span class="ti-nm">${hesc(d.nm)}</span><span class="ti-star${isFav?' on':''}" title="${isFav?'Remover':'Favorito'}">★</span><span class="ti-ar">›</span>`;
      item.querySelector('.ti-star').addEventListener('click', e => { e.stopPropagation(); toggleFav(d.path, d.nm, e); });
      item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => { e.preventDefault(); item.classList.remove('drag-over'); handleDrop(d.path); });
      const ch = document.createElement('div'); ch.className = 'ti-ch';
      let loaded = false;
      item.addEventListener('click', e => {
        e.stopPropagation();
        // Visual feedback imediato
        item.style.opacity = '0.6';
        setTimeout(() => { item.style.opacity = ''; }, 300);
        navTo(d.path);
        const ar = item.querySelector('.ti-ar');
        if (ch.style.display !== 'block') {
          ch.style.display = 'block'; ar.classList.add('open');
          if (!loaded) {
            loaded = true;
            ch.innerHTML = '<div style="padding:6px 14px 6px 28px"><div class="spin" style="width:12px;height:12px;border-width:2px"></div></div>';
            loadTree(d.path, ch);
          }
        } else { ch.style.display = 'none'; ar.classList.remove('open'); }
      });
      wrap.appendChild(item); wrap.appendChild(ch); target.appendChild(wrap);
    });
  } catch(e) {}
}

function mkTI(ic, nm, p2) {
  const el = document.createElement('div');
  el.className = 'ti' + (S.path===p2?' active':'');
  el.innerHTML = `<span class="ti-ic">${ic}</span><span class="ti-nm">${hesc(nm)}</span>`;
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drag-over'); handleDrop(p2); });
  el.addEventListener('click', () => navTo(p2));
  return el;
}

function updateTreeActive() {
  document.querySelectorAll('.ti[data-path]').forEach(el =>
    el.classList.toggle('active', S.path === el.dataset.path));
  document.querySelectorAll('.ti:not([data-path])').forEach(el => {
    if (el.querySelector('.ti-nm')?.textContent === 'Início')
      el.classList.toggle('active', S.path === '/');
  });
  renderFavs();
}

// ─── FILE LISTING ─────────────────────────────────────────────────────────────


// ─── SYNC INDICATOR ──────────────────────────────────────────────────────────
let _syncTimer = null;
let _syncSafetyTimer = null;
function syncStart(msg = 'A actualizar...') {
  S._isSyncing = true;
  const el = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  if (!el) return;
  if (txt) txt.textContent = msg;
  el.classList.add('show');
  clearTimeout(_syncTimer);
  clearTimeout(_syncSafetyTimer);
  // Timeout de segurança máximo
  _syncSafetyTimer = setTimeout(() => syncDone(), 15000);
  // Actualiza botão slideshow
  const ssBtn = document.getElementById('btn-slideshow');
  if (ssBtn && !ssBtn.disabled) {
    ssBtn.disabled = true;
    ssBtn.style.opacity = '0.5';
    ssBtn.title = 'A carregar pasta...';
  }
}
function syncDone(count) {
  S._isSyncing = false;
  clearTimeout(_syncTimer);
  clearTimeout(_syncSafetyTimer);
  const el = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  if (el && txt) {
    // Mostra confirmação breve antes de desaparecer
    if (count !== undefined) {
      txt.textContent = `✅ ${count} item${count !== 1 ? 's' : ''} prontos`;
    } else {
      txt.textContent = '✅ Actualizado';
    }
  }
  _syncTimer = setTimeout(() => {
    if (el) el.classList.remove('show');
    // Reactiva botão slideshow
    const ssBtn = document.getElementById('btn-slideshow');
    if (ssBtn && ssBtn.disabled) {
      ssBtn.disabled = false;
      ssBtn.style.opacity = '';
      ssBtn.title = 'Slideshow das fotos desta pasta';
    }
  }, 1500);
}

// ─── PAGE LOADER ─────────────────────────────────────────────────────────────
function pageLoaderStart() {
  const el = document.getElementById('page-loader');
  if (!el) return;
  el.className = 'page-loader loading';
  // Safety: sempre termina após 5s no máximo
  clearTimeout(el._safetyTimer);
  el._safetyTimer = setTimeout(() => pageLoaderDone(), 5000);
}
function pageLoaderDone() {
  const el = document.getElementById('page-loader');
  if (!el) return;
  el.className = 'page-loader done';
  setTimeout(() => { el.className = 'page-loader'; }, 500);
}


// ─── DEBOUNCE PARA loadFiles ──────────────────────────────────────────────────
// Previne múltiplos PROPFIND consecutivos (após upload, delete, rename, etc.)
let _loadDebounceTimer = null;
function loadFilesDebounced(p, delay = 300) {
  clearTimeout(_loadDebounceTimer);
  _loadDebounceTimer = setTimeout(() => loadFiles(p || S.path), delay);
}

async function loadFiles(p, preloadedCache) {
  // Cancela qualquer refresh em background da pasta anterior
  if (_bgAbort) { _bgAbort.abort(); _bgAbort = null; }
  // Cancela thumbnails pendentes da pasta anterior
  _cancelPendingThumbs();
  pageLoaderStart();
  const fl = document.getElementById('fl');

  // Cache pré-lido por openDir (evita 2ª leitura IDB) ou lê agora se chamado directamente
  const cached = preloadedCache !== undefined ? preloadedCache : await _idb.get(p);
  if (cached && cached.items && cached.items.length > 0) {
    S.lastItems = cached.items;
    renderFiles(cached.items);
    pageLoaderDone();
    syncDone(cached.items.length);
    _idxAdd(cached.items, p);
    if (!_idb.isFresh(cached)) {
      _refreshInBackground(p);
    }
    return;
  }

  // Sem cache — mostra skeleton
  if (fl && !fl.querySelector('.fgrid, .flist')) {
    fl.innerHTML = S.view === 'grid' ? skeletonGrid() : skeletonList();
  } else if (fl) {
    fl.style.opacity = '0.5';
  }
  S.path = p; clearSel(); updateBC(); updateTreeActive();
  // Guarda pasta actual — sobrevive a refresh/reload
  try { localStorage.setItem('fc_last_path', p); } catch(_) {}
  document.getElementById('btn-back').style.display = p === '/' ? 'none' : 'flex';
  syncStart('A carregar...');
  // Reset da barra de estado ao mudar de pasta
  const statusEl = document.getElementById('files-status');
  if (statusEl) statusEl.classList.remove('show');
  document.getElementById('fl').innerHTML = '<div class="loading"><div class="spin"></div> A carregar...</div>';
  // Cancela pedido anterior se ainda estiver em curso
  if (S.loadAbort) { S.loadAbort.abort(); }
  S.loadAbort = new AbortController();
  // Limpa observer de imagens lazy da pasta anterior
  document.querySelectorAll('img[data-src]').forEach(img => _lazyObserver.unobserve(img));
  const signal = S.loadAbort.signal;
  try {
    const r = await fetch(dav(p), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/><d:creationdate/><oc:fileid xmlns:oc="http://owncloud.org/ns"/></d:prop></d:propfind>`,
      signal
    });
    if (!r.ok && r.status === 401) {
      // Retry once — Netlify proxy sometimes drops Authorization on first request
      await new Promise(res => setTimeout(res, 800));
      const retry = await fetch(dav(p), {
        method: 'PROPFIND',
        headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/><d:creationdate/><oc:fileid xmlns:oc="http://owncloud.org/ns"/></d:prop></d:propfind>`
      });
      if (!retry.ok && retry.status === 401) {
        // Genuinely expired — but try to re-login silently with saved creds
        const saved = localStorage.getItem('fc_cred');
        if (saved) {
          try {
            const d = JSON.parse(saved);
            S.user = d.user; S.pass = d.pass;
            sessionStorage.setItem('fc', saved);
            loadFiles(p); return; // retry with refreshed credentials
          } catch(e) { Logger.warn('restoreSession retry falhou', e?.message); }
        }
        toast('Sessão expirada. Volta a entrar.', 'err'); doLogout(); return;
      }
      // Retry worked — reload normally
      if (!retry.ok) { toast('Erro ao carregar ficheiros (' + retry.status + ')', 'err'); return; }
      loadFiles(p); return;
    }
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    let folders = [], files = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (normPath(rel) === normPath(p)) return;
      const isDir = resp.querySelector('resourcetype collection') !== null;
      const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
      if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
      const mod = resp.querySelector('getlastmodified')?.textContent || resp.querySelector('creationdate')?.textContent || '';
      const date = mod ? new Date(mod) : new Date(0);
      const fpath = isDir ? (rel.endsWith('/') ? rel : rel+'/') : rel;
      const fileid = resp.querySelector('fileid')?.textContent || '';
      const obj = { name:nm, path:fpath, isDir, size, date, dateStr:fmtDate(date), fileid };
      if (isDir) folders.push(obj); else files.push(obj);
    });
    S.lastItems = [...sortItems(folders), ...sortItems(files)];
    // Aviso se próximo do limite do PROPFIND (Nextcloud limita ~500 itens)
    if (S.lastItems.length >= 490) {
      toast(`⚠️ Esta pasta tem ${S.lastItems.length}+ itens. Podem não aparecer todos.`, 'err');
    }
    renderFiles(S.lastItems);
    syncDone(S.lastItems.length);
  } catch(e) {
    pageLoaderDone(); // Garante que loader desaparece mesmo em erro
    syncDone();
    if (e.name === 'AbortError') return; // Navegação cancelada — normal
    document.getElementById('fl').innerHTML = `<div class="empty"><div class="ei">⚠️</div><h3>Erro ao carregar</h3><p>${e.message}</p></div>`;
  }
}

// Actualiza cache em background sem bloquear UI
let _bgAbort = null; // Cancela refresh anterior ao navegar

async function _refreshInBackground(p) {
  // Cancela qualquer refresh anterior em curso
  if (_bgAbort) { _bgAbort.abort(); }
  _bgAbort = new AbortController();
  const signal = _bgAbort.signal;
  syncStart('A actualizar...');
  try {
    const r = await fetch(dav(p), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><oc:fileid xmlns:oc="http://owncloud.org/ns"/></d:prop></d:propfind>`,
      signal
    });
    if (!r.ok || signal.aborted) return;
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    let folders = [], files = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (normPath(rel) === normPath(p)) return;
      const isDir = resp.querySelector('resourcetype collection') !== null;
      const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
      if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
      const mod = resp.querySelector('getlastmodified')?.textContent || '';
      const date = mod ? new Date(mod) : new Date(0);
      const fpath = isDir ? (rel.endsWith('/') ? rel : rel+'/') : rel;
      const fileid = resp.querySelector('fileid')?.textContent || '';
      const obj = { name:nm, path:fpath, isDir, size, date, dateStr:fmtDate(date), fileid };
      if (isDir) folders.push(obj); else files.push(obj);
    });
    const fresh = [...sortItems(folders), ...sortItems(files)];
    if (signal.aborted) return;

    // Guarda sempre no cache
    _idb.set(p, fresh);
    _idxAdd(fresh, p);

    // Só re-renderiza se estiver na mesma pasta
    if (S.path !== p) { syncDone(); return; }

    // Compara se houve mudanças reais (nomes + count)
    const oldNames = new Set(S.lastItems.map(i => i.name));
    const newNames = new Set(fresh.map(i => i.name));
    const changed = fresh.length !== S.lastItems.length ||
      fresh.some(i => !oldNames.has(i.name)) ||
      S.lastItems.some(i => !newNames.has(i.name));

    // Nunca re-renderiza — só actualiza cache e índice
    // Badge discreto se houve mudanças
    if (changed) {
      S._pendingRefresh = fresh;
      _showRefreshBadge();
    }
    syncDone(fresh.length);
  } catch(e) {
    if (e.name !== 'AbortError') syncDone();
  }
}

// Badge discreto "Conteúdo actualizado — clica para ver"
function _showRefreshBadge() {
  let badge = document.getElementById('refresh-badge');
  if (badge) return; // já existe
  badge = document.createElement('button');
  badge.id = 'refresh-badge';
  badge.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:300;background:var(--primary);color:#fff;border:none;border-radius:20px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:var(--font);opacity:0;transition:opacity .3s';
  badge.textContent = '↑ Pasta actualizada — toca para ver';
  badge.onclick = () => {
    if (S._pendingRefresh) {
      S.lastItems = S._pendingRefresh;
      S._pendingRefresh = null;
      renderFiles(S.lastItems);
    }
    badge.remove();
  };
  document.body.appendChild(badge);
  requestAnimationFrame(() => { badge.style.opacity = '1'; });
  // Auto-desaparece após 5s
  setTimeout(() => { badge.style.opacity = '0'; setTimeout(() => badge.remove(), 300); }, 5000);
}

function sortItems(arr) {
  const {by, dir} = S.sort;
  return [...arr].sort((a,b) => {
    let v = 0;
    if (by==='name') v = a.name.localeCompare(b.name, 'pt', {sensitivity:'base'});
    else if (by==='date') v = a.date - b.date;
    else if (by==='size') v = a.size - b.size;
    return dir==='asc' ? v : -v;
  });
}

function setSort(by) {
  if (S.sort.by === by) { toggleSortDir(); return; }
  S.sort.by = by;
  localStorage.setItem('fc_sort', JSON.stringify(S.sort));
  ['name','date','size'].forEach(k => document.getElementById('s-'+k).classList.toggle('on', k===by));
  loadFiles(S.path);
}

function toggleSortDir() {
  S.sort.dir = S.sort.dir==='asc' ? 'desc' : 'asc';
  localStorage.setItem('fc_sort', JSON.stringify(S.sort));
  document.getElementById('s-dir').textContent = S.sort.dir==='asc' ? '↑' : '↓';
  S.lastItems = [
    ...sortItems(S.lastItems.filter(i=>i.isDir)),
    ...sortItems(S.lastItems.filter(i=>!i.isDir))
  ];
  renderFiles(S.lastItems);
}

function setV(v, save=true) {
  S.view = v;
  if (save) localStorage.setItem('fc_view', v);
  document.getElementById('vg').classList.toggle('on', v==='grid');
  document.getElementById('vl').classList.toggle('on', v==='list');
  renderFiles(S.lastItems);
}

function toggleSB() {
  S.sidebarOpen = !S.sidebarOpen;
  document.getElementById('sb').classList.toggle('closed', !S.sidebarOpen);
  // Mobile overlay
  if (window.innerWidth <= 700) {
    document.getElementById('sb-overlay').classList.toggle('show', S.sidebarOpen);
  }
}

function closeSB() {
  S.sidebarOpen = false;
  document.getElementById('sb').classList.add('closed');
  document.getElementById('sb-overlay').classList.remove('show');
}

// ─── RENDER GRID/LIST ─────────────────────────────────────────────────────────
function renderFiles(items) {
  const fl = document.getElementById('fl');
  fl.style.opacity = '';
  fl.style.userSelect = '';
  // DOM write é síncrono — não precisamos de bloquear pointerEvents
  // Remove TODOS os listeners anteriores (incluindo prefetch hover)
  if (fl._prefetchEnter) fl.removeEventListener('mouseenter', fl._prefetchEnter, true);
  if (fl._prefetchLeave) fl.removeEventListener('mouseleave', fl._prefetchLeave, true);
  if (fl._delegateHandler) fl.removeEventListener('click', fl._delegateHandler);
  if (fl._safeClick) fl.removeEventListener('click', fl._safeClick);
  if (fl._delegateCTX) fl.removeEventListener('contextmenu', fl._delegateCTX);
  if (fl._delegateTouch) fl.removeEventListener('touchstart', fl._delegateTouch);
  if (fl._delegateTouchMove) fl.removeEventListener('touchmove', fl._delegateTouchMove);
  if (fl._delegateTouchEnd) fl.removeEventListener('touchend', fl._delegateTouchEnd);

  // Prefetch on hover — guardados no fl para remoção no próximo render
  fl._prefetchEnter = (e) => {
    const card = e.target.closest('[data-prefetch]');
    if (card) prefetchDir(card.dataset.prefetch);
  };
  fl._prefetchLeave = (e) => {
    const card = e.target.closest('[data-prefetch]');
    if (card) cancelPrefetch(card.dataset.prefetch);
  };
  fl.addEventListener('mouseenter', fl._prefetchEnter, true);
  fl.addEventListener('mouseleave', fl._prefetchLeave, true);

  fl._delegateHandler = (e) => {
    const card = e.target.closest('[data-path]');
    if (!card) return;
    const p = card.dataset.path;
    const nm = card.dataset.name;
    const isDir = card.dataset.dir === '1';
    const fileid = card.dataset.fid || '';

    // Acção específica (botões de acção)
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action) {
      e.stopPropagation();
      switch(action) {
        case 'dl': dlF(p, nm, isDir); break;
        case 'share': shareItem(p, nm); break;
        case 'rename': startRn(p, nm); break;
        case 'move': startMoveItem(p, nm); break;
        case 'versions': openVersions(p, nm, fileid); break;
        case 'tags': openTags(p, nm, fileid); break;
        case 'del': delIt(p, nm); break;
        case 'sel': e.stopPropagation(); enterOrToggleSel(p); break;
      }
      return;
    }

    // Click no card — só actua se path e name são válidos
    if (!p || !nm) return;
    fcClick(e, p, () => {
      if (isDir) openDir(p);
      else if (isImg(nm)) openGallery(p);
      else if (isPdf(nm)) openPdf(p, nm);
      else if (isVid(nm) || isAud(nm)) openMedia(p, nm);
      else dlF(p, nm);
    });
  };

  fl._delegateCTX = (e) => {
    const card = e.target.closest('[data-path]');
    if (!card) return;
    showCtxMenu(e, card.dataset.path, card.dataset.name, card.dataset.dir==='1', card.dataset.fid||'');
  };

  // ── TOUCH: actua no touchend — vars em module scope (não stale) ────────────
  // _tCard, _tTimer, _tMoved, _tX, _tY estão declarados no topo do módulo
  // Reset de estado no início de cada render (não herdar estado de render anterior)
  clearTimeout(_tTimer); _tCard = null; _tMoved = false;

  fl._delegateTouch = (e) => {
    const card = e.target.closest('[data-path]');
    _tCard  = card || null;
    _tX     = e.touches[0].clientX;
    _tY     = e.touches[0].clientY;
    _tMoved = false;
    clearTimeout(_tTimer);
    if (!card) return;
    _tTimer = setTimeout(() => {
      if (!_tMoved) {
        _tCard = null;
        enterSel(card.dataset.path);
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }, 650);
  };

  fl._delegateTouchMove = (e) => {
    if (_tMoved) return;
    const dx = Math.abs(e.touches[0].clientX - _tX);
    const dy = Math.abs(e.touches[0].clientY - _tY);
    // 12px: threshold mais tolerante para digitizers de iPhone (ruído de dedo)
    // Entre 6-12px: cancela long-press mas NÃO marca como scroll (micro-movement)
    if (dy > 6 && dy < 12) { clearTimeout(_tTimer); return; }
    if (dx > 12 || dy > 12) { _tMoved = true; _tCard = null; clearTimeout(_tTimer); }
  };

  fl._delegateTouchEnd = (e) => {
    clearTimeout(_tTimer);
    const card = _tCard;
    _tCard = null;
    if (!card || _tMoved) return;
    e.preventDefault();
    const fakeE = { target: e.changedTouches[0].target,
                    stopPropagation: ()=>{}, preventDefault: ()=>{} };
    fl._delegateHandler(fakeE);
  };

  fl._safeClick = (e) => {
    if (e.pointerType === 'touch') return;
    fl._delegateHandler(e);
  };

  fl.addEventListener('click', fl._safeClick);
  fl.addEventListener('contextmenu', fl._delegateCTX);
  fl.addEventListener('touchstart', fl._delegateTouch, {passive:true});
  fl.addEventListener('touchmove', fl._delegateTouchMove, {passive:true});
  fl.addEventListener('touchend', fl._delegateTouchEnd, {passive:false});
  if (!items.length) {
    fl.innerHTML = '<div class="empty"><div class="ei">📂</div><h3>Pasta vazia</h3><p>Arrasta ficheiros aqui ou clica em "Carregar"</p></div>';
    return;
  }
  // Virtual Scrolling para pastas grandes (>100 itens)
  destroyVirtualScroll();
  if (items.length >= VS_THRESHOLD) {
    const vsOk = initVirtualScroll(items, fl);
    if (vsOk) {
      // Adiciona event delegation ao vs-content dinâmico
      const vsContent = document.getElementById('vs-content');
      if (vsContent) {
        fl._delegateHandler && fl.removeEventListener('click', fl._delegateHandler);
        fl._delegateCTX && fl.removeEventListener('contextmenu', fl._delegateCTX);
      }
      return; // renderFiles tratado pelo VS
    }
  }

  if (S.view === 'grid') {
    fl.innerHTML = '<div class="fgrid">' + items.map(card).join('') + '</div>';
  } else {
    fl.innerHTML = '<div class="flist"><div class="lh"><span>Nome</span><span>Tamanho</span><span class="cd">Modificado</span><span>Ações</span></div>' + items.map(row).join('') + '</div>';
    addSwipeListeners();
  }
  // Detecta scroll para evitar re-render durante scroll
  const mainEl = document.getElementById('main');
  if (mainEl && !mainEl._scrollListenerAdded) {
    mainEl._scrollListenerAdded = true;
    let _scrollTimer = null;
    mainEl.addEventListener('scroll', () => {
      mainEl._isScrolling = true;
      clearTimeout(_scrollTimer);
      _scrollTimer = setTimeout(() => {
        mainEl._isScrolling = false;
        // Se há refresh pendente, aplica agora
        if (S._pendingRefresh && S.path) {
          S.lastItems = S._pendingRefresh;
          S._pendingRefresh = null;
          renderFiles(S.lastItems);
          const badge = document.getElementById('refresh-badge');
          if (badge) badge.remove();
        }
      }, 150);
    }, { passive: true });
  }

  // Lazy loading para thumbnails e imagens
  requestAnimationFrame(() => {
    fl.querySelectorAll('img[data-src]').forEach(img => {
      if (img.dataset.src) _lazyObserver.observe(img);
    });
  });

  // Prefetch mobile: pré-carrega as primeiras pastas visíveis no IDB
  // No desktop isto é feito ao hover; no mobile precisamos de fazer proactivamente
  // Só prefetch se mobile E pasta não está já em cache fresco
  // Prefetch proactivo de subpastas — mobile E desktop
  // Mobile: sem hover, tem de ser antecipado
  // Desktop: complementa o hover (pastas não hovadas ainda)
  // Carrega TODAS as pastas visíveis, escalonadas para não saturar
  const dirsToFetch = items.filter(it => it.isDir);
  dirsToFetch.forEach((dir, idx) => {
    const delay = 300 + idx * 150; // 300ms, 450ms, 600ms... (mais rápido que antes)
    setTimeout(async () => {
      const existing = await _idb.get(dir.path);
      if (_idb.isFresh(existing)) return;
      prefetchDir(dir.path);
    }, delay);
  });
  // Mostra botão slideshow se há imagens
  const hasImgs = items.some(it => !it.isDir && (isImg(it.name) || isVid(it.name)));
  const ssBtn = document.getElementById('btn-slideshow');
  if (ssBtn) {
    ssBtn.style.display = hasImgs ? '' : 'none';
    // Desactiva enquanto está a actualizar em background
    if (hasImgs && S._isSyncing) {
      ssBtn.disabled = true;
      ssBtn.title = 'A aguardar actualização completa...';
      ssBtn.style.opacity = '0.5';
    } else if (hasImgs) {
      ssBtn.disabled = false;
      ssBtn.title = 'Slideshow das fotos desta pasta';
      ssBtn.style.opacity = '';
    }
  }
  // Actualiza barra de estado com contagens
  updateFilesStatus(items);

  // SW: pré-cacheia thumbnails dos primeiros 50 ficheiros visíveis (diagrama 2)
  if (navigator.serviceWorker?.controller) {
    const thumbUrls = items
      .filter(it => !it.isDir && it.fileid)
      .slice(0, 50)
      .map(it => thumbUrl(it.fileid, 128))
      .filter(Boolean);
    if (thumbUrls.length) {
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_THUMBS', urls: thumbUrls });
    }
  }
}

function card(it) {
  const {name:nm, path:p, isDir, size, dateStr, fileid=''} = it;
  const sel = S.selected.has(p);
  const sz = size ? fmtSz(size) : '';
  let inner;
  if (isDir) {
    inner = `<div class="fic ic-f">📁</div>`;
  } else if (isImg(nm)) {
    if (fileid) {
      // Preview via Nextcloud — sem fallback para ficheiro completo no grid.
      // Se o preview falhar: Worker v5 devolve SVG placeholder (200 image/svg+xml).
      // O download completo só acontece quando o utilizador abre a galeria.
      const tUrl = thumbUrl(fileid, 128); // 128px: cards 124-148px, SW faz cache por URL exacto
      inner = `<img class="thumb loading" data-src="${tUrl}" data-fb="" alt="" onload="this.classList.remove('loading');this.classList.add('loaded')" onerror="this.outerHTML='<div class=\\'fic ic-i\\'>🖼️</div>'">`;
    } else {
      // Sem fileid: ícone imediato, sem pedido de rede. Ficheiro completo só na galeria.
      inner = `<div class="fic ic-i">🖼️</div>`;
    }
  } else if (isVid(nm)) {
    // StorageShare não tem ffmpeg → /core/preview para vídeos dá 404 sempre
    // Ícone imediato — zero fetch, zero erros "indisponível" no grid
    const vidSzLabel = size > 0 ? `<div class="vid-size-badge">${fmtSz(size)}</div>` : '';
    inner = `<div class="fic ic-v" style="position:relative">🎬${vidSzLabel}</div>`;
    } else {
    inner = `<div class="fic ${iCls(nm)}">${fIcon(nm)}</div>`;
  }
  // Usa data attributes em vez de onclick — permite minificação pelo Vite
  return `<div class="fc${isDir?' folder':''}${sel?' selected':''}"
    data-path="${esc(p)}" data-name="${esc(nm)}" data-dir="${isDir?1:0}" data-fid="${fileid}"
    ${isDir?`data-prefetch="${esc(p)}"`:''}>
    <div class="fc-chk" data-action="sel">✓</div>
    <div class="fac">
      ${!isDir?`<button class="fab fa-dl" data-action="dl" title="Download">⬇️</button>`:''}
      <button class="fab fa-sh" data-action="share" title="Partilhar">🔗</button>
      <button class="fab fa-rn" data-action="rename" title="Renomear">✏️</button>
      <button class="fab fa-mv" data-action="move" title="Mover">📦</button>
      ${!isDir&&fileid?`<button class="fab" style="background:#e3f2fd" data-action="versions" title="Versões">🕒</button>`:''}
      <button class="fab" style="background:#fff3e0" data-action="tags" title="Tags">🏷️</button>
      <button class="fab fa-del" data-action="del" title="Apagar">🗑️</button>
    </div>
    ${inner}
    <div class="fn">${nm}</div>
    <div class="fm">${sz?`<span>${sz}</span>`:''} ${dateStr?`<span>${dateStr}</span>`:''}</div>
  </div>`;
}

function row(it) {
  const {name:nm, path:p, isDir, size, dateStr, fileid=''} = it;
  const sz = (!isDir && size) ? fmtSz(size) : '-';
  const sel = S.selected.has(p);
  // Usa data attributes — sem onclick inline, permite event delegation e minificação
  return `<div class="lr${sel?' selected':''}"
    data-path="${esc(p)}" data-name="${esc(nm)}" data-dir="${isDir?1:0}" data-fid="${fileid}"
    ${isDir?`data-prefetch="${esc(p)}"`:''}>
    <div class="lr-n">
      <div class="lr-chk" data-action="sel">${sel?'✓':''}</div>
      ${isDir?'📁':fIcon(nm)}
      <span>${nm}</span>
    </div>
    <div class="lr-s">${sz}</div>
    <div class="lr-d">${dateStr||'-'}</div>
    <div class="lr-a">
      ${!isDir?`<button class="fab fa-dl" data-action="dl">⬇️</button>`:''}
      <button class="fab fa-sh" data-action="share">🔗</button>
      <button class="fab fa-rn" data-action="rename">✏️</button>
      <button class="fab fa-mv" data-action="move">📦</button>
      ${!isDir&&fileid?`<button class="fab" style="background:#e3f2fd" data-action="versions">🕒</button>`:''}
      <button class="fab" style="background:#fff3e0" data-action="tags">🏷️</button>
      <button class="fab fa-del" data-action="del">🗑️</button>
    </div>
  </div>`;
}

// ─── MULTI-SELECT ─────────────────────────────────────────────────────────────
function fcClick(e, path, openFn) {
  if (S.selecting) {
    if (e.shiftKey && S._lastSel) {
      // Shift+click — selecciona intervalo
      const paths = S.lastItems.map(it => it.path);
      const a = paths.indexOf(S._lastSel);
      const b = paths.indexOf(path);
      const [from, to] = a < b ? [a, b] : [b, a];
      paths.slice(from, to+1).forEach(p => S.selected.add(p));
      updateSelBar(); renderFiles(S.lastItems); return;
    }
    toggleSel(path);
  } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd+click — entra em modo selecção directo
    enterOrToggleSel(path);
  } else {
    openFn();
  }
  S._lastSel = path;
}

function enterSel(path) {
  S.selecting = true; S.selected.clear(); S.selected.add(path);
  document.getElementById('fl').classList.add('selecting');
  updateSelBar(); renderFiles(S.lastItems);
}

function enterOrToggleSel(path) {
  if (!S.selecting) {
    S.selecting = true; S.selected.clear();
    document.getElementById('fl').classList.add('selecting');
  }
  toggleSel(path);
}

function toggleSel(path) {
  if (S.selected.has(path)) S.selected.delete(path); else S.selected.add(path);
  if (S.selected.size === 0) { clearSel(); }
  else {
    document.getElementById('fl').classList.add('selecting');
    updateSelBar(); renderFiles(S.lastItems);
  }
}

function clearSel() {
  S.selecting = false; S.selected.clear(); updateSelBar();
  document.getElementById('fl').classList.remove('selecting');
  if (S.lastItems.length) renderFiles(S.lastItems);
}

function selAll() {
  S.lastItems.forEach(it => S.selected.add(it.path));
  S.selecting = true;
  document.getElementById('fl').classList.add('selecting');
  updateSelBar(); renderFiles(S.lastItems);
}

function updateSelBar() {
  const bar = document.getElementById('sel-bar');
  bar.classList.toggle('show', S.selected.size > 0);
  document.getElementById('sel-count').textContent = S.selected.size + ' selecionado' + (S.selected.size!==1?'s':'');
}

// Long press for mobile
// tStart/tEnd mantidos para compatibilidade mas desactivados
// O touch handling real está no event delegation do renderFiles
function tStart(e, path) { /* desactivado — usar event delegation */ }
function tEnd() { /* desactivado */ }

// Swipe to delete in list view
function addSwipeListeners() {
  document.querySelectorAll('.lr').forEach(el => {
    if (el._swipeAdded) return; // evita duplicar listeners
    el._swipeAdded = true;
    let sx = 0, dx = 0;
    el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, {passive:true});
    el.addEventListener('touchmove', e => {
      dx = e.touches[0].clientX - sx;
      if (dx < -20) el.style.transform = `translateX(${Math.max(dx,-70)}px)`;
    }, {passive:true});
    el.addEventListener('touchend', () => {
      if (dx < -55) {
        const nm = el.querySelector('.lr-n span')?.textContent || '';
        if (confirm('Apagar "'+nm+'"?')) { delIt(el.dataset.path, nm); }
        el.style.transform = '';
      } else { el.style.transform = ''; }
      dx = 0;
    });
  });
}

async function bulkDelete() {
  const paths = [...S.selected];
  if (!paths.length) return;
  const names = S.lastItems.filter(it=>paths.includes(it.path)).map(it=>it.name);
  if (!confirm(`Apagar PERMANENTEMENTE ${paths.length} item${paths.length>1?'ns':''}?\n${names.slice(0,5).join('\n')}${names.length>5?'\n+' +(names.length-5)+' mais':''}\n\nEsta acção é irreversível.`)) return;
  if (navigator.vibrate) navigator.vibrate([50,30,50]);

  // Mostra barra de progresso
  const prog = document.getElementById('uprog');
  const progBar = document.getElementById('uprog-bar');
  const progFile = document.getElementById('uprog-file');
  const progSpeed = document.getElementById('uprog-speed');
  prog.style.display = 'block';
  progSpeed.textContent = '';

  let done = 0, errors = 0;
  for (const p of paths) {
    const nm = names[paths.indexOf(p)] || p.split('/').pop();
    progFile.textContent = `🗑️ A apagar: ${nm} (${done+1}/${paths.length})`;
    progBar.style.width = Math.round((done / paths.length) * 100) + '%';
    try {
      const deleteUrl = dav(p);
      const r = await fetch(deleteUrl, { method:'DELETE', headers:{'Authorization':auth()} });
      if (r.ok || r.status===204) { done++; }
      else if (r.status === 404) {
        // Ficheiro pode ter sido já apagado ou path errado — tenta com path encoded
        const encodedPath = p.split('/').map(s => encodeURIComponent(s)).join('/');
        const r2 = await fetch(dav(encodedPath), { method:'DELETE', headers:{'Authorization':auth()} });
        if (r2.ok || r2.status===204 || r2.status===404) done++;
        else errors++;
      }
      else errors++;
    } catch(e) {
 errors++; }
  }

  progBar.style.width = '100%';
  setTimeout(() => { prog.style.display='none'; progBar.style.width='0%'; }, 1000);

  if (errors && done===0) toast(`❌ Erro ao apagar. Tenta novamente.`, 'err');
  else if (errors) toast(`⚠️ ${done} apagado${done>1?'s':''}, ${errors} com erro.`, 'err');
  else toast(`🗑️ ${done} item${done>1?'ns':''} apagado${done>1?'s':''}.`, 'ok');
  clearSel(); loadFilesDebounced(S.path); loadStorage();
}

async function bulkDownload() {
  const items = S.lastItems.filter(it => S.selected.has(it.path));
  if (!items.length) { toast('Seleciona itens para download.', 'err'); return; }
  toast(`⬇️ A descarregar ${items.length} item${items.length>1?'ns':''}...`);
  let done = 0, errors = 0;
  for (const it of items) {
    try {
      await dlF(it.path, it.name, it.isDir);
      done++;
    } catch(e) { errors++; }
    await new Promise(r => setTimeout(r, 400));
  }
  if (errors) toast(`⚠️ ${done} OK, ${errors} com erro.`, 'err');
  else toast(`✅ ${done} ficheiro${done>1?'s':''} descarregado${done>1?'s':''}!`, 'ok');
}

function bulkMoveOpen() {
  const paths = [...S.selected]; const names = S.lastItems.filter(it=>paths.includes(it.path)).map(it=>it.name);
  if (paths.length) openMoveModal(paths, names);
}

// ─── DRAG & DROP ─────────────────────────────────────────────────────────────
function dStart(e, p, nm, isDir) {
  if (isMobile()) { e.preventDefault(); return; }
  S.dragItem = {p, nm, isDir};
  e.dataTransfer.effectAllowed = 'move';
  // Drag image limpa — só o ícone do ficheiro, sem distorções
  try {
    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;top:-200px;left:-200px;padding:8px 14px;background:var(--card);border:2px solid var(--primary);border-radius:10px;font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.2);';
    ghost.textContent = (isDir ? '📁 ' : '📄 ') + nm;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 20, 20);
    setTimeout(() => { document.body.removeChild(ghost); e.target.classList.add('dragging'); }, 0);
  } catch(_) {
    setTimeout(() => e.target.classList.add('dragging'), 0);
  }
}
function dEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  S.dragItem = null;
}

async function handleDrop(destPath) {
  if (!S.dragItem) return;
  const src = S.dragItem.p;
  const dest = destPath.endsWith('/') ? destPath : destPath + '/';
  const srcParent = src.replace(/\/$/,'').substring(0, src.replace(/\/$/,'').lastIndexOf('/')+1);
  if (srcParent === dest || src === dest) { toast('Já está nessa pasta.'); S.dragItem=null; return; }
  const destFolderNm = dest.split('/').filter(Boolean).pop() || 'Início';
  const srcNm = src.replace(/\/$/,'').split('/').pop();
  try {
    const result = await moveItem(src, dest);
    if (result.status === 'ok') {
      const msg = result.renamed ? `"${srcNm}" renomeado para "${result.name}" e movido.` : `"${srcNm}" movido para "${destFolderNm}"!`;
      toast(msg, 'ok');
      loadFilesDebounced(S.path); loadStorage();
    } else if (result.status === 'duplicate') {
      // Pergunta o que fazer
      const choice = confirm(`"${srcNm}" já existe em "${destFolderNm}".\n\nOK = Substituir\nCancelar = Manter os dois (renomeia automaticamente)`);
      const result2 = await moveItem(src, dest, { overwrite: choice, autoRename: !choice });
      if (result2.status === 'ok') {
        const msg = result2.renamed ? `"${srcNm}" guardado como "${result2.name}".` : `"${srcNm}" substituído em "${destFolderNm}".`;
        toast(msg, 'ok');
        loadFilesDebounced(S.path); loadStorage();
      } else {
        toast(`Erro ao mover "${srcNm}" (${result2.code})`, 'err');
      }
    } else {
      toast(`Erro ao mover "${srcNm}" (${result.code})`, 'err');
    }
  } catch(e) { toast('Erro ao mover', 'err'); }
  S.dragItem = null;
}

// Drop zone (external file upload — suporta ficheiros E pastas com subpastas)
let dzEl;
document.addEventListener('DOMContentLoaded', () => {
  dzEl = document.getElementById('dz');
  if (!dzEl) return;
  dzEl.addEventListener('dragover', e => { if (!S.dragItem) { e.preventDefault(); dzEl.classList.add('over'); } });
  dzEl.addEventListener('dragleave', () => dzEl.classList.remove('over'));
dzEl.addEventListener('drop', async e => {
  e.preventDefault(); dzEl.classList.remove('over');
  if (S.dragItem) { S.dragItem = null; return; }
  const items = Array.from(e.dataTransfer.items || []);
  // Se tiver items com getAsEntry — suporta pastas
  if (items.length && items[0].webkitGetAsEntry) {
    const allFiles = [];
    const readEntry = async (entry, basePath) => {
      if (entry.isFile) {
        await new Promise(res => entry.file(f => {
          // Simula webkitRelativePath para manter estrutura
          Object.defineProperty(f, 'webkitRelativePath', { value: basePath + f.name, writable: false });
          allFiles.push(f);
          res();
        }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => new Promise(res => {
          const entries = [];
          const read = () => reader.readEntries(batch => {
            if (!batch.length) { res(entries); return; }
            entries.push(...batch); read();
          }, res);
          read();
        });
        const subEntries = await readAll();
        for (const sub of subEntries) {
          await readEntry(sub, basePath + entry.name + '/');
        }
      }
    };
    toast('📁 A ler estrutura de pastas...', '');
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await readEntry(entry, '');
    }
    if (allFiles.length) {
      const label = items.length === 1 && items[0].webkitGetAsEntry()?.isDirectory
        ? `📁 ${items[0].webkitGetAsEntry().name} (${allFiles.length} ficheiros)`
        : `${allFiles.length} ficheiro${allFiles.length>1?'s':''}`;
      UPQ.add(allFiles, label);
    }
  } else if (e.dataTransfer.files.length) {
    uploadFiles(e.dataTransfer.files);
  }
  S.dragItem = null;
});
}); // DOMContentLoaded for dzEl

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
function navTo(p) {
  // Usa openDir para beneficiar do cache IDB (evita PROPFIND se cache fresco)
  openDir(p);
}
async function openDir(p) {
  const target = p.endsWith('/') ? p : p+'/';
  S.hist.push(S.path);
  if (window.innerWidth <= 700 && S.sidebarOpen) closeSB();
  // Cancela prefetch pendente para esta pasta (evita PROPFIND duplo)
  cancelPrefetch(target);
  // Lê IDB uma única vez — loadFiles não volta a ler
  const cached = await _idb.get(target);
  if (_idb.isFresh(cached) && cached.items?.length) {
    // Cache fresco → sem pedidos ao servidor
    S.path = target;
    S.lastItems = cached.items;
    clearSel(); updateBC(); updateTreeActive();
    document.getElementById('btn-back').style.display = 'flex';
    try { localStorage.setItem('fc_last_path', target); } catch(_) {}
    renderFiles(cached.items);
    syncDone(cached.items.length);
    _idxAdd(cached.items, target);
    _cancelPendingThumbs();
    return;
  }
  // Cache stale ou inexistente → passa cache (pode ser nulo) ao loadFiles
  // para evitar segunda leitura IDB
  loadFiles(target, cached);
}
function goBack() { if (S.hist.length) loadFiles(S.hist.pop()); }
function goHome() { S.hist = []; loadFiles('/'); }
function jumpTo(p) { S.hist.push(S.path); loadFiles(p); }

function updateBC() {
  const parts = S.path.split('/').filter(Boolean);
  let html = `<span class="bci" onclick="goHome()">🏠</span>`;
  let b = '/';
  parts.forEach(p => {
    b += p + '/';
    const fp = b;
    html += `<span class="bc-sep">›</span><span class="bci" onclick="jumpTo('${fp}')">${decodeURIComponent(p)}</span>`;
  });
  document.getElementById('bc').innerHTML = html;
}

// ─── UPLOAD (real progress) ───────────────────────────────────────────────────
function cancelUpload() {
  S.uploadCancel = true;
  if (S.uploadXHR) S.uploadXHR.abort();
  UPQ.jobs = [];
  document.getElementById('uprog').style.display = 'none';
  toast('Uploads cancelados');
}

async function uploadFolderFiles(fl) {
  if (!fl || !fl.length) return;
  // Group files by top-level folder name
  const topFolder = fl[0].webkitRelativePath ? fl[0].webkitRelativePath.split('/')[0] : 'Pasta';
  const label = `📁 ${topFolder} (${fl.length} ficheiros)`;
  const job = { id: ++UPQ._idSeq, label, files: Array.from(fl), destDir: S.path, status:'wait', done:0, errors:0, total:fl.length };
  UPQ.jobs.push(job);
  UPQ._render();
  if (!UPQ._running) UPQ._run();
}

// ─── UPLOAD QUEUE MANAGER ────────────────────────────────────────────────────


// ─── INDEXEDDB CACHE ─────────────────────────────────────────────────────────
// Guarda conteúdo de pastas para navegação instantânea
// Padrão: stale-while-revalidate (mostra cache, actualiza em background)
const _idb = (() => {
  let db = null;
  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open('fc-cache-v2', 2); // v2 adiciona searchIndex
    r.onupgradeneeded = e => {
      const d = e.target.result;
      const oldV = e.oldVersion;
      if (oldV < 1) {
        d.createObjectStore('dirs', { keyPath: 'path' });
      }
      if (oldV < 2) {
        // Índice de pesquisa global — persistente entre sessões
        if (!d.objectStoreNames.contains('searchIndex')) {
          const si = d.createObjectStore('searchIndex', { keyPath: 'path' });
          si.createIndex('name', 'name');
        }
      }
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  return {
    async get(path) {
      try {
        const d = await open();
        return new Promise((res) => {
          const tx = d.transaction('dirs', 'readonly');
          const req = tx.objectStore('dirs').get(path);
          req.onsuccess = () => res(req.result || null);
          req.onerror = () => res(null);
        });
      } catch(e) { return null; }
    },

    // Verifica se o cache é suficientemente fresco para não precisar de background refresh
    // TTL adaptativo: pastas com muitos itens = menos refrescadas (mais estáveis)
    isFresh(cached) {
      if (!cached || !cached.ts) return false;
      const age = Date.now() - cached.ts;
      // TTL personalizado (ex: prefetch usa 2min)
      if (cached.ttl) return age < cached.ttl;
      const count = cached.items?.length || 0;
      // Pastas grandes (fotos) → 20min | Pequenas → 5min
      const ttl = count > 50 ? 20 * 60 * 1000 : 5 * 60 * 1000;
      return age < ttl;
    },
    async set(path, items, customTTL) {
      try {
        const d = await open();
        const tx = d.transaction('dirs', 'readwrite');
        // customTTL permite ao prefetch definir TTL mais curto (2min vs 20-30min)
        tx.objectStore('dirs').put({ path, items, ts: Date.now(), ttl: customTTL || null });
      } catch(e) {}
    },
    async del(path) {
      try {
        const d = await open();
        const tx = d.transaction('dirs', 'readwrite');
        tx.objectStore('dirs').delete(path);
      } catch(e) {}
    },
    async clear() {
      try {
        const d = await open();
        const tx = d.transaction('dirs', 'readwrite');
        tx.objectStore('dirs').clear();
      } catch(e) {}
    }
  };
})();


// ─── IDB SEARCH INDEX ────────────────────────────────────────────────────────
// CRUD para o store searchIndex (persistente entre sessões)
const _idbSearch = (() => {
  // Reutiliza a mesma conexão do _idb (fc-cache-v2)
  async function _db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('fc-cache-v2', 2);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('searchIndex')) {
          const si = d.createObjectStore('searchIndex', { keyPath: 'path' });
          si.createIndex('name', 'name');
        }
      };
      r.onsuccess = e => res(e.target.result);
      r.onerror   = () => rej(r.error);
    });
  }

  return {
    async addBatch(items) {
      try {
        const db = await _db();
        const tx = db.transaction('searchIndex', 'readwrite');
        const store = tx.objectStore('searchIndex');
        for (const it of items) store.put(it);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      } catch(e) { Logger.warn('_idbSearch.addBatch', e?.message); }
    },

    async search(q) {
      try {
        const db = await _db();
        return new Promise((res, rej) => {
          const tx = db.transaction('searchIndex', 'readonly');
          const req = tx.objectStore('searchIndex').getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror   = () => rej(req.error);
        });
      } catch(e) { return []; }
    },

    async count() {
      try {
        const db = await _db();
        return new Promise(res => {
          const req = db.transaction('searchIndex','readonly')
                        .objectStore('searchIndex').count();
          req.onsuccess = () => res(req.result || 0);
          req.onerror   = () => res(0);
        });
      } catch(e) { return 0; }
    },

    async getIndexedAt() {
      try {
        return parseInt(localStorage.getItem('fc_search_indexed_at') || '0');
      } catch(e) { return 0; }
    },

    setIndexedAt() {
      try { localStorage.setItem('fc_search_indexed_at', Date.now().toString()); } catch(_) {}
    },

    async clear() {
      try {
        const db = await _db();
        db.transaction('searchIndex','readwrite').objectStore('searchIndex').clear();
        localStorage.removeItem('fc_search_indexed_at');
      } catch(_) {}
    }
  };
})();

// ─── INDEXAÇÃO BFS EM BACKGROUND ─────────────────────────────────────────────
// Percorre toda a árvore de pastas 3s após login
// requestIdleCallback garante que não interfere com a UI
// Max 1 PROPFIND concorrente, 200ms entre requests, retry em 429
let _bgIndexAbort = null;
let _bgIndexRunning = false;

async function startBackgroundIndex() {
  if (_bgIndexRunning) return;

  // Só re-indexa se o índice tiver mais de 24h ou estiver vazio
  const lastIndexed = await _idbSearch.getIndexedAt();
  const count = await _idbSearch.count();
  const age   = Date.now() - lastIndexed;
  if (count > 0 && age < 24 * 60 * 60 * 1000) {
    // Índice fresco — restaurar apenas para o _searchIdx em memória
    const all = await _idbSearch.search('');
    all.forEach(it => _searchIdx.set(it.path, it));
    Logger.info(`startBackgroundIndex: índice restaurado (${count} itens, ${Math.round(age/60000)}min)`);
    return;
  }

  _bgIndexRunning = true;
  _bgIndexAbort   = new AbortController();
  const signal    = _bgIndexAbort.signal;

  // Progressbar discreta no footer
  const _showProgress = (done, total) => {
    const el = document.getElementById('search-index-progress');
    if (!el) return;
    const pct = total ? Math.round(done / total * 100) : 0;
    el.textContent = `🔍 Índice: ${done} pastas...`;
    el.style.display = total && done >= total ? 'none' : 'block';
  };

  // Criar elemento de progresso se não existir
  if (!document.getElementById('search-index-progress')) {
    const el = document.createElement('div');
    el.id = 'search-index-progress';
    el.style.cssText = 'font-size:10px;color:var(--text3);padding:2px 14px;display:none';
    document.querySelector('.files-status')?.after(el);
  }

  Logger.info('startBackgroundIndex: a iniciar BFS');
  const queue   = ['/']; // BFS queue de paths a visitar
  const visited = new Set(['/']);
  let   done    = 0;
  const batch   = []; // acumula items para flush em IDB

  const flushBatch = async () => {
    if (!batch.length) return;
    await _idbSearch.addBatch([...batch]);
    batch.length = 0;
  };

  const idle = (deadline) => new Promise(res => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(res, { timeout: 2000 });
    } else {
      setTimeout(res, 16); // fallback Safari (não tem requestIdleCallback)
    }
  });

  while (queue.length && !signal.aborted) {
    const path = queue.shift();
    _showProgress(done, done + queue.length);

    // Aguarda idle slot do browser (não bloqueia UI)
    await idle();
    if (signal.aborted) break;

    try {
      const r = await _origFetch(dav(path), {
        method: 'PROPFIND',
        headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
        signal
      });

      if (r.status === 429) {
        // Rate limit — backoff exponencial
        const wait = 5000 * (1 + Math.random());
        Logger.warn(`startBackgroundIndex: 429 em ${path}, aguarda ${Math.round(wait)}ms`);
        await new Promise(res => setTimeout(res, wait));
        queue.unshift(path); // volta à frente da fila
        continue;
      }

      if (!r.ok) { done++; continue; }

      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      xml.querySelectorAll('response').forEach(resp => {
        const rel = normPath(decodeURIComponent(resp.querySelector('href')?.textContent || ''));
        if (!rel || normPath(rel) === normPath(path)) return;
        const nm = resp.querySelector('displayname')?.textContent || '';
        if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
        const isDir   = resp.querySelector('resourcetype collection') !== null;
        const size    = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
        const mod     = resp.querySelector('getlastmodified')?.textContent || '';
        const date    = mod ? new Date(mod) : new Date(0);
        const fpath   = isDir ? (rel.endsWith('/') ? rel : rel+'/') : rel;

        const item = { name:nm, path:fpath, isDir, size, dateStr:fmtDate(date), parent:path };
        _searchIdx.set(fpath, item);
        batch.push(item);

        // Adicionar subpastas à queue BFS
        if (isDir && !visited.has(fpath)) {
          visited.add(fpath);
          queue.push(fpath);
        }
      });

      // Flush ao IDB a cada 200 itens (não bloqueante)
      if (batch.length >= 200) await flushBatch();

    } catch(e) {
      if (e?.name === 'AbortError') break;
      Logger.warn('startBackgroundIndex: erro em ' + path, e?.message);
    }

    done++;
    // Pausa entre requests — não saturar o servidor
    await new Promise(res => setTimeout(res, 200));
  }

  await flushBatch();
  _idbSearch.setIndexedAt();
  _bgIndexRunning = false;
  _showProgress(done, done);
  Logger.info(`startBackgroundIndex: concluído — ${_searchIdx.size} itens indexados`);
}

function stopBackgroundIndex() {
  if (_bgIndexAbort) { _bgIndexAbort.abort(); _bgIndexAbort = null; }
  _bgIndexRunning = false;
}

// TTL do cache — 5 minutos
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos
// ─── INDEXEDDB CACHE PARA THUMBNAILS ──────────────────────────────────────────
// Persiste blob URLs como base64 entre sessões — zero fetches ao servidor nas
// visitas seguintes para fotos já vistas. Limite: 500 entradas, ~50MB aprox.
const _idbThumb = (() => {
  let db = null;
  const STORE = 'thumbs';
  const MAX   = 500;

  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open('fc-thumbs-v1', 1);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'url' });
        s.createIndex('ts', 'ts');
      }
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror = () => rej(r.error);
  });

  return {
    async get(url) {
      try {
        const d = await open();
        return new Promise(res => {
          const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(url);
          req.onsuccess = () => res(req.result?.b64 || null);
          req.onerror = () => res(null);
        });
      } catch(_) { return null; }
    },

    async set(url, b64) {
      try {
        const d = await open();
        const tx = d.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put({ url, b64, ts: Date.now() });
        // Limpa entradas antigas se exceder MAX (async — não bloqueia)
        const count = await new Promise(res => {
          const r = store.count(); r.onsuccess = () => res(r.result);
        });
        if (count > MAX) {
          // Remove as 50 mais antigas por timestamp
          const idx = store.index('ts');
          let deleted = 0;
          idx.openCursor().onsuccess = e => {
            const cursor = e.target.result;
            if (cursor && deleted < 50) { cursor.delete(); deleted++; cursor.continue(); }
          };
        }
      } catch(_) {}
    },

    async clear() {
      try {
        const d = await open();
        d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      } catch(_) {}
    }
  };
})();

// Converte Blob para base64 string
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
}

// Converte base64 para Blob URL
function b64ToBlobUrl(b64) {
  const parts = b64.split(',');
  const mime  = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bytes = atob(parts[1]);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime }));
}





// ─── ESTADO REACTIVO ─────────────────────────────────────────────────────────
// Mini-store reactivo: quando o estado muda, os componentes subscrevem
// e actualizam automaticamente. Sem Redux, sem dependências.
const Store = (() => {
  const _subs = new Map();
  const _state = {
    path: '/',
    user: '',
    displayName: '',
    emojiAvatar: '',
    theme: 'terra',
    view: 'grid',
    sort: { by:'name', dir:'asc' },
    selecting: false,
    selected: new Set(),
    storageUsed: 0,
    storageTotal: 0,
  };

  return {
    get(key) { return _state[key]; },

    set(key, value) {
      if (_state[key] === value) return;
      _state[key] = value;
      // Notifica subscritores
      const handlers = _subs.get(key) || [];
      handlers.forEach(fn => { try { fn(value); } catch(e) {} });
      // Também S para compatibilidade com código existente
      if (key in S) S[key] = value;
    },

    subscribe(key, fn) {
      if (!_subs.has(key)) _subs.set(key, []);
      _subs.get(key).push(fn);
      // Chama imediatamente com valor actual
      fn(_state[key]);
      return () => {
        const arr = _subs.get(key) || [];
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      };
    }
  };
})();

// Subscritores do Store — actualizam UI automaticamente
// Quando o nome de exibição muda → actualiza topbar e dropdown
Store.subscribe('displayName', name => {
  if (!name) return;
  const unTop = document.getElementById('uname-top');
  const dropNm = document.getElementById('drop-nm');
  if (unTop) unTop.textContent = name;
  if (dropNm) dropNm.textContent = name;
});

// Quando emoji avatar muda → actualiza todos os avatares
Store.subscribe('emojiAvatar', emoji => {
  if (!emoji) return;
  const uav = document.getElementById('uav');
  if (uav) uav.innerHTML = `<span style="font-size:18px">${emoji}</span>`;
});

// Quando tema muda → actualiza meta theme-color
Store.subscribe('theme', theme => {
  const t = THEMES[theme];
  if (t?.meta) {
    const meta = document.getElementById('meta-theme');
    if (meta) meta.content = t.meta;
  }
});

// Quando storage muda → actualiza barra
Store.subscribe('storageUsed', used => {
  const total = Store.get('storageTotal');
  if (!total) return;
  const pct = Math.round(used/total*100);
  const fill = document.getElementById('st-fill');
  const txt = document.getElementById('st-txt');
  const pctEl = document.getElementById('st-pct');
  if (fill) { fill.style.width = pct+'%'; fill.classList.toggle('warn', pct>80); }
  if (txt) txt.textContent = `💾 ${fmtSz(used)} de ${fmtSz(total)}`;
  if (pctEl) pctEl.textContent = pct+'%';
});

// ─── SEARCH INDEX LOCAL ──────────────────────────────────────────────────────
// Índice em memória de todos os ficheiros visitados
// Cresce organicamente à medida que o utilizador navega
const _searchIdx = new Map(); // path → {name, path, isDir, parent}

function _idxAdd(items, parentPath) {
  items.forEach(it => {
    _searchIdx.set(it.path, {
      name: it.name,
      path: it.path,
      isDir: it.isDir,
      parent: parentPath,
      size: it.size,
      dateStr: it.dateStr
    });
  });
}

function _idxSearch(q) {
  if (!q) return [];
  const ql = q.toLowerCase();
  const prefix  = []; // nome começa com a query (prioridade alta)
  const include = []; // nome contém a query (prioridade normal)

  for (const [, item] of _searchIdx) {
    const nl = item.name.toLowerCase();
    if (nl.startsWith(ql))    prefix.push(item);
    else if (nl.includes(ql)) include.push(item);
  }

  const sort = (arr) => arr.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'pt');
  });

  return [...sort(prefix), ...sort(include)].slice(0, 100);
}

// Highlight do termo pesquisado no nome do ficheiro
function _highlightTerm(name, q) {
  if (!q) return hesc(name);
  const idx = name.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return hesc(name);
  return hesc(name.slice(0, idx))
    + '<mark style="background:var(--primary);color:#fff;border-radius:2px;padding:0 2px">'
    + hesc(name.slice(idx, idx + q.length))
    + '</mark>'
    + hesc(name.slice(idx + q.length));
}

// Ctrl+K para abrir pesquisa
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    window.openSearch();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    UndoStack.pop();
  }
  if (e.key === 'Escape') {
    window.closeSearch();
    window.closeCtx();
  }
});

// ─── SKELETON SCREENS ────────────────────────────────────────────────────────
function skeletonGrid(n=12) {
  return '<div class="fgrid sk-loading">' + Array.from({length:n}, () => `
    <div class="sk-card">
      <div class="sk sk-icon"></div>
      <div class="sk sk-nm"></div>
      <div class="sk sk-meta"></div>
    </div>`).join('') + '</div>';
}
function skeletonList(n=10) {
  return '<div class="flist sk-loading"><div class="lh"><span>Nome</span><span>Tamanho</span><span class="cd">Modificado</span><span>Ações</span></div>' +
    Array.from({length:n}, () => `
    <div class="sk-row">
      <div class="sk sk-nm-r"></div>
      <div class="sk sk-sz"></div>
      <div class="sk sk-dt"></div>
      <div class="sk sk-ac"></div>
    </div>`).join('') + '</div>';
}


// ─── CONTEXT MENU ────────────────────────────────────────────────────────────
let _ctxMenu = null;

function closeCtx() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function showCtxMenu(e, path, nm, isDir, fileid='') {
  e.preventDefault();
  e.stopPropagation();
  closeCtx();

  const sp = esc(path), sn = esc(nm);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-header">📄 ${nm}</div>
    ${!isDir ? `<button class="ctx-item" onclick="closeCtx();window.dlF('${sp}','${sn}')"><span class="ctx-ic dl">⬇️</span>Download</button>` : ''}
    <button class="ctx-item" onclick="closeCtx();window.shareItem('${sp}','${sn}')"><span class="ctx-ic sh">🔗</span>Partilhar</button>
    <button class="ctx-item" onclick="closeCtx();window.startRn('${sp}','${sn}')"><span class="ctx-ic rn">✏️</span>Renomear</button>
    <button class="ctx-item" onclick="closeCtx();window.startMoveItem('${sp}','${sn}')"><span class="ctx-ic mv">📦</span>Mover para...</button>
    <button class="ctx-item" onclick="closeCtx();window.openTags('${sp}','${sn}','${fileid}')"><span class="ctx-ic tg">🏷️</span>Tags</button>
    ${!isDir && fileid ? `<button class="ctx-item" onclick="closeCtx();window.openVersions('${sp}','${sn}','${fileid}')"><span class="ctx-ic vr">🕒</span>Versões</button>` : ''}
    ${isDir ? `<button class="ctx-item" onclick="closeCtx();window.openDir('${sp}')"><span class="ctx-ic dl">📂</span>Abrir pasta</button>` : ''}
    <div class="ctx-sep"></div>
    <button class="ctx-item red" onclick="closeCtx();window.delIt('${sp}','${sn}')"><span class="ctx-ic dl-red">🗑️</span>Apagar</button>
  `;

  // Posiciona o menu
  document.body.appendChild(menu);
  _ctxMenu = menu;
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width > vw - 10) x = vw - r.width - 10;
  if (y + r.height > vh - 10) y = vh - r.height - 10;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Fecha ao clicar fora
  setTimeout(() => document.addEventListener('click', closeCtx, {once:true}), 0);
}


// ─── PRE-FETCH ────────────────────────────────────────────────────────────────
const _prefetchCache = new Map();
const _prefetchTimers = new Map();

function prefetchDir(path) {
  if (_prefetchCache.has(path) || !path) return;
  const t = setTimeout(async () => {
    _prefetchTimers.delete(path);
    if (_prefetchCache.has(path)) return;
    try {
      const r = await fetch(dav(path), {
        method: 'PROPFIND',
        headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
      });
      if (r.ok) {
        const txt = await r.text();
        _prefetchCache.set(path, txt);
        // Guarda no IDB — quando o utilizador abrir, openDir encontra cache fresco
        // e não precisa de fazer PROPFIND (zero pedidos ao servidor)
        try {
          const xml = new DOMParser().parseFromString(txt, 'text/xml');
          const items = [];
          xml.querySelectorAll('response').forEach(resp => {
            const rel = normPath(decodeURIComponent(resp.querySelector('href')?.textContent || ''));
            if (!rel || normPath(rel) === normPath(path)) return;
            const isDir = resp.querySelector('resourcetype collection') !== null;
            const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
            if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
            const size = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
            const mod  = resp.querySelector('getlastmodified')?.textContent || '';
            const date = mod ? new Date(mod) : new Date(0);
            const fpath = isDir ? (rel.endsWith('/') ? rel : rel+'/') : rel;
            const fileid = resp.querySelector('fileid')?.textContent || '';
            items.push({ name:nm, path:fpath, isDir, size, date, dateStr:fmtDate(date), fileid });
          });
          // TTL curto para prefetch (2 min) — conteúdo pode mudar
          if (items.length) _idb.set(path, items, 2 * 60 * 1000);
        } catch(_) {}
      }
    } catch(e) {}
  }, 300); // só pre-fetch se hover durar 300ms
  _prefetchTimers.set(path, t);
}

function cancelPrefetch(path) {
  const t = _prefetchTimers.get(path);
  if (t) { clearTimeout(t); _prefetchTimers.delete(path); }
}

function getPrefetched(path) {
  return _prefetchCache.get(path) || null;
}


// ─── CHUNKED UPLOAD ──────────────────────────────────────────────────────────
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB por chunk

// ─── RESUME UPLOAD STATE ─────────────────────────────────────────────────────
// Guarda estado de uploads no IndexedDB para retomar após falha de rede
const _resumeDB = (() => {
  let db = null;
  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open('fc-resume-v1', 1);
    r.onupgradeneeded = e => {
      e.target.result.createObjectStore('uploads', { keyPath: 'fileKey' });
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  return {
    async get(key) {
      try {
        const d = await open();
        return new Promise(res => {
          const req = d.transaction('uploads','readonly').objectStore('uploads').get(key);
          req.onsuccess = () => res(req.result || null);
          req.onerror = () => res(null);
        });
      } catch(e) { return null; }
    },
    async save(key, uploadId, lastChunk, totalChunks, destPath) {
      try {
        const d = await open();
        d.transaction('uploads','readwrite').objectStore('uploads')
          .put({ fileKey:key, uploadId, lastChunk, totalChunks, destPath, ts:Date.now() });
      } catch(e) {}
    },
    async del(key) {
      try {
        const d = await open();
        d.transaction('uploads','readwrite').objectStore('uploads').delete(key);
      } catch(e) {}
    }
  };
})();

// Gera chave única para um ficheiro (nome + tamanho + data modificação)
function _fileKey(file, destPath) {
  return `${file.name}:${file.size}:${file.lastModified}:${destPath}`;
}

async function uploadChunked(file, destPath, onProgress) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const fileKey = _fileKey(file, destPath);

  // Verifica se existe upload em curso para este ficheiro
  let uploadId, startChunk = 0;
  const pending = await _resumeDB.get(fileKey);

  if (pending && (Date.now() - pending.ts) < 24 * 60 * 60 * 1000) {
    // Upload existente — tenta retomar
    uploadId = pending.uploadId;
    startChunk = pending.lastChunk + 1;
    const chunkDir = NC + '/remote.php/dav/uploads/' + encodeURIComponent(S.user) + '/' + uploadId;
    // Verifica se a pasta ainda existe no servidor
    const check = await fetch(chunkDir, {
      method: 'PROPFIND', headers: { 'Authorization': auth(), 'Depth': '0' }
    }).catch(() => null);
    if (!check || !check.ok) {
      // Pasta expirou — começa de novo
      startChunk = 0;
      uploadId = null;
    } else {
      toast(`⏭️ A retomar upload de "${file.name}" a partir do chunk ${startChunk}...`, '');
    }
  }

  if (!uploadId) {
    // Novo upload — cria pasta temporária no Nextcloud
    uploadId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const chunkDir = NC + '/remote.php/dav/uploads/' + encodeURIComponent(S.user) + '/' + uploadId;
    await fetch(chunkDir, { method: 'MKCOL', headers: { 'Authorization': auth() } });
  }

  const chunkDir = NC + '/remote.php/dav/uploads/' + encodeURIComponent(S.user) + '/' + uploadId;
  let uploaded = startChunk * CHUNK_SIZE;

  for (let i = startChunk; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const chunkName = String(i).padStart(5, '0');

    let chunkOk = false;
    for (let attempt = 0; attempt < 3 && !chunkOk; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = e => {
            onProgress(uploaded + e.loaded, file.size, i + 1, totalChunks);
          };
          xhr.onload = () => xhr.status < 400 ? resolve() : reject(new Error('HTTP ' + xhr.status));
          xhr.onerror = reject;
          xhr.ontimeout = reject;
          xhr.timeout = 60000; // 60s por chunk
          xhr.open('PUT', chunkDir + '/' + chunkName);
          xhr.setRequestHeader('Authorization', auth());
          xhr.send(chunk);
        });
        chunkOk = true;
      } catch(e) {
        if (attempt === 2) throw new Error(`Chunk ${i} falhou após 3 tentativas`);
      }
    }

    uploaded += (end - start);
    onProgress(uploaded, file.size, i + 1, totalChunks);

    // Guarda progresso após cada chunk — permite retomar
    await _resumeDB.save(fileKey, uploadId, i, totalChunks, destPath);
  }

  // Move o ficheiro para o destino final
  const finalUrl = NC + '/remote.php/dav/uploads/' + encodeURIComponent(S.user) + '/' + uploadId + '/.file';
  const moveResp = await fetch(finalUrl, {
    method: 'MOVE',
    headers: {
      'Authorization': auth(),
      'Destination': NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + destPath,
      'Overwrite': 'T'
    }
  });
  if (!moveResp.ok) throw new Error('Finalização falhou: ' + moveResp.status);

  // Limpa o registo de upload concluído
  await _resumeDB.del(fileKey);
}


// ─── COMPRESSÃO DE IMAGENS ───────────────────────────────────────────────────
const IMG_MAX_PX = 2560;   // max dimension (2K)
const IMG_QUALITY = 0.88;  // qualidade JPEG/WebP

async function compressImage(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  // Detecção HEIC por magic bytes — apanha ficheiros iOS com extensão .jpg que são HEIC internamente
  // HEIC magic: bytes 4-7 = 'ftyp', bytes 8-11 = 'heic'|'heix'|'mif1'|'msf1'
  if (!['jpg','jpeg','png','bmp','tiff','webp'].includes(ext)) {
    if (['heic','heif'].includes(ext)) return file; // pass-through explícito
    // Para outras extensões, verificar magic bytes
    try {
      const header = await file.slice(0, 12).arrayBuffer();
      const view = new DataView(header);
      const ftyp = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
      const brand = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      if (ftyp === 'ftyp' && ['heic','heix','mif1','msf1'].includes(brand)) return file;
    } catch(_) {}
    return file;
  }

  // Para JPEG/PNG: verificar se é HEIC disfarçado
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    const view = new DataView(header);
    const ftyp = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    const brand = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (ftyp === 'ftyp' && ['heic','heix','mif1','msf1'].includes(brand)) return file;
  } catch(_) {}

  // Ficheiros pequenos — não vale o processamento
  if (file.size < 800 * 1024) return file; // < 800KB

  try {
    // Verifica suporte a OffscreenCanvas (não existe em iOS Safari)
    const useOffscreen = typeof OffscreenCanvas !== 'undefined';

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch(e) {
      // createImageBitmap falhou (HEIC disfarçado, ficheiro corrompido, etc.)
      return file;
    }

    const { width: w, height: h } = bitmap;
    if (!w || !h) { bitmap.close(); return file; }

    // Calcula dimensões — máximo 2K mas preserva aspect ratio
    let nw = w, nh = h;
    if (w > IMG_MAX_PX || h > IMG_MAX_PX) {
      const ratio = Math.min(IMG_MAX_PX / w, IMG_MAX_PX / h);
      nw = Math.round(w * ratio);
      nh = Math.round(h * ratio);
    }

    let blob;
    if (useOffscreen) {
      // OffscreenCanvas — mais rápido, não bloqueia UI
      const canvas = new OffscreenCanvas(nw, nh);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, nw, nh);
      bitmap.close();
      // WebP: 0.78 qualidade (mais eficiente que JPEG 0.88, visualmente equivalente)
      const supportsWebP = useOffscreen;
      blob = await canvas.convertToBlob({
        type: supportsWebP ? 'image/webp' : 'image/jpeg',
        quality: supportsWebP ? 0.78 : 0.80
      });
      if (supportsWebP && blob.size >= file.size * 0.9) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.80 });
      }
    } else {
      // Fallback: canvas normal (iOS Safari)
      const canvas = document.createElement('canvas');
      canvas.width = nw; canvas.height = nh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, nw, nh);
      bitmap.close();
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.80));
    }

    if (!blob || blob.size >= file.size) return file; // sem ganho

    const isWebP = blob.type === 'image/webp';
    const newName = file.name.replace(/\.[^.]+$/, isWebP ? '.webp' : '.jpg');
    return new File([blob], newName, {
      type: blob.type,
      lastModified: file.lastModified
    });

  } catch(e) {
    return file;
  }
}
// ══════════════════════════════════════════════════════════════
// AUTO-UPLOAD DA CÂMARA — POLÍTICA INTELIGENTE
// ══════════════════════════════════════════════════════════════
const CameraUpload = {
  enabled: localStorage.getItem('fc_cam_upload') === '1',
  policy: JSON.parse(localStorage.getItem('fc_cam_policy') || JSON.stringify({
    onlyOnWiFi: true,
    onlyWhenCharging: false,
    excludeScreenshots: true,
    compressBeforeUpload: true,
    groupByDate: true
  })),
  
  async init() {
    if (!this.enabled) return;
    
    // Observa mudanças de rede/bateria
    if (navigator.connection) {
      navigator.connection.addEventListener('change', () => this.checkQueue());
    }
    if (navigator.getBattery) {
      const battery = await navigator.getBattery();
      battery.addEventListener('chargingchange', () => this.checkQueue());
    }
    
    // Verifica fila ao arrancar
    this.checkQueue();
  },
  
  async checkQueue() {
    if (!this.enabled) return;
    
    // Verifica políticas
    if (this.policy.onlyOnWiFi && navigator.connection?.type !== 'wifi') return;
    if (this.policy.onlyWhenCharging) {
      const battery = await navigator.getBattery?.();
      if (battery && !battery.charging) return;
    }
    
    // Processa fotos da câmara pendentes (IndexedDB 'fc-camera-queue')
    await this.processPending();
  },
  
  async processPending() {
    const pending = await _idb.get('/.camera-queue');
    if (!pending?.items?.length) return;
    
    toast(`📤 A carregar ${pending.items.length} foto${pending.items.length>1?'s':''} da câmara...`);
    
    for (const item of pending.items) {
      // Filtra screenshots se policy ativa
      if (this.policy.excludeScreenshots && item.name.toLowerCase().includes('screenshot')) {
        continue;
      }
      
      // Comprime se necessário
      const file = item.file;
      const toUpload = this.policy.compressBeforeUpload && isImg(file.name) && file.size > 1024*1024
        ? await compressImage(file)
        : file;
      
      // Upload para pasta configurada
      const destPath = (this.policy.groupByDate 
        ? S.path + new Date(item.ts).toISOString().split('T')[0] + '/' 
        : S.path) + encodeURIComponent(toUpload.name);
      
      try {
        await fetch(dav(destPath), {
          method: 'PUT',
          headers: { 'Authorization': auth() },
          body: toUpload
        });
        toast(`✅ ${toUpload.name} carregada`, 'ok');
      } catch(e) {
        Logger.warn('Camera upload failed', e.message);
      }
    }
    
    await _idb.del('/.camera-queue');
    loadFilesDebounced(S.path);
  },
  
  async addPhoto(file) {
    const item = {
      name: file.name,
      file: file,
      ts: Date.now(),
      path: S.path
    };
    
    const existing = await _idb.get('/.camera-queue') || { items: [] };
    existing.items.push(item);
    await _idb.set('/.camera-queue', existing);
    
    await this.checkQueue();
    toast('📸 Foto guardada para upload', 'ok');
  },
  
  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('fc_cam_upload', this.enabled ? '1' : '0');
    toast(this.enabled ? '✅ Auto-upload ativado' : '⏸ Auto-upload pausado', this.enabled ? 'ok' : '');
  }
};

// ─── WEB SHARE API ───────────────────────────────────────────────────────────
async function webShareFile(p, nm) {
  if (!navigator.share) {
    // Fallback — copia link para clipboard
    const url = dav(p) + '?auth=' + btoa(auth().replace('Basic ',''));
    try { await navigator.clipboard.writeText(url); toast('Link copiado!', 'ok'); }
    catch(e) { toast('Web Share não suportado neste browser', 'err'); }
    return;
  }
  try {
    toast('⏳ A preparar ficheiro...', '');
    const r = await fetch(dav(p), { headers: { 'Authorization': auth() } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const file = new File([blob], nm, { type: blob.type });
    await navigator.share({ files: [file], title: nm });
    toast('✅ Partilhado!', 'ok');
  } catch(e) {
    if (e.name !== 'AbortError') toast('Erro ao partilhar: ' + e.message, 'err');
  }
}


// ─── HOJE NA HISTÓRIA ────────────────────────────────────────────────────────
async function loadTodayInHistory() {
  const el = document.getElementById('today-widget');
  if (!el) return;

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yearAgo = now.getFullYear() - 1;

  try {
    // Pesquisa ficheiros com data de hoje em anos anteriores
    const body = `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/><d:getlastmodified/><d:resourcetype/><oc:fileid xmlns:oc="http://owncloud.org/ns"/></d:prop></d:select>
    <d:from><d:scope><d:href>${PROXY}/nextcloud/remote.php/dav/files/${encodeURIComponent(S.user)}/</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where>
      <d:and>
        <d:not><d:is-collection/></d:not>
        <d:or>
          <d:like><d:prop><d:displayname/></d:prop><d:literal>%.jpg%</d:literal></d:like>
          <d:like><d:prop><d:displayname/></d:prop><d:literal>%.jpeg%</d:literal></d:like>
          <d:like><d:prop><d:displayname/></d:prop><d:literal>%.png%</d:literal></d:like>
        </d:or>
      </d:and>
    </d:where>
    <d:limit><d:nresults>200</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;

    const r = await fetch(PROXY + '/nextcloud/remote.php/dav/files/' + encodeURIComponent(S.user) + '/', {
      method: 'SEARCH',
      headers: { 'Authorization': auth(), 'Content-Type': 'application/xml', 'Depth': 'infinity' },
      body
    });

    if (r.status === 501 || r.status === 405) {
      // Nextcloud StorageShare não suporta SEARCH — desactiva widget
      el.style.display = 'none';
      return;
    }
    if (!r.ok) throw new Error('search failed');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const photos = [];
    xml.querySelectorAll('response').forEach(resp => {
      const mod = resp.querySelector('getlastmodified')?.textContent || '';
      if (!mod) return;
      const d = new Date(mod);
      const dMM = String(d.getMonth()+1).padStart(2,'0');
      const dDD = String(d.getDate()).padStart(2,'0');
      const dYY = d.getFullYear();
      if (dMM === mm && dDD === dd && dYY < now.getFullYear()) {
        const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
        const nm = resp.querySelector('displayname')?.textContent || '';
        const fid = resp.querySelector('fileid')?.textContent || '';
        if (nm && !nm.startsWith('.')) {
          photos.push({ path: rel, name: nm, fileid: fid, year: dYY });
        }
      }
    });

    if (!photos.length) {
      el.style.display = 'none';
      return;
    }

    // Escolhe uma foto aleatória
    const pick = photos[Math.floor(Math.random() * photos.length)];
    const yearsAgo = now.getFullYear() - pick.year;
    const thumbSrc = dav(pick.path); // carrega imagem directamente — sem preview NC

    el.style.display = 'block';
    el.innerHTML = `
      <div class="today-card" onclick="window.openGallery('${esc(pick.path)}')">
        <div class="today-img-wrap">
          <img class="today-img" data-src="${thumbSrc}" alt="${hesc(pick.name)}"
            onerror="this.style.display='none'">
          <div class="today-badge">📅 Hoje, há ${yearsAgo} ano${yearsAgo>1?'s':''}</div>
        </div>
        <div class="today-info">
          <div class="today-title">📸 Hoje na História</div>
          <div class="today-sub">${hesc(pick.name)}</div>
          <div class="today-meta">${pick.year} · ${photos.length} foto${photos.length>1?'s':''} neste dia</div>
        </div>
      </div>`;

    // Lazy load da imagem
    const img = el.querySelector('img[data-src]');
    if (img) _lazyObserver.observe(img);

  } catch(e) {
    el.style.display = 'none';
  }
}


// ─── UPLOAD OPTIMISTA ────────────────────────────────────────────────────────
function addOptimisticCard(file, path) {
  const nm = file.name;
  const fakeItem = {
    name: nm, path: path, isDir: false,
    size: file.size, dateStr: 'A carregar...', fileid: ''
  };
  // Insere no início dos ficheiros (após as pastas)
  const firstFile = S.lastItems.findIndex(it => !it.isDir);
  if (firstFile >= 0) S.lastItems.splice(firstFile, 0, fakeItem);
  else S.lastItems.push(fakeItem);

  // Renderiza e marca o card como uploading
  renderFiles(S.lastItems);

  // Encontra o card e adiciona estado visual
  const grid = document.querySelector('.fgrid');
  if (!grid) return null;
  const cards = grid.querySelectorAll('.fc');
  for (const card of cards) {
    const onclick = card.getAttribute('onclick') || '';
    if (onclick.includes(esc(path))) {
      card.classList.add('fc-uploading');
      // Anel de progresso SVG
      const ring = document.createElementNS('http://www.w3.org/2000/svg','svg');
      ring.setAttribute('class','fc-upload-ring');
      ring.setAttribute('viewBox','0 0 22 22');
      const C = 2 * Math.PI * 9; // circumference
      ring.innerHTML = `
        <circle class="bg" cx="11" cy="11" r="9"/>
        <circle class="prog" cx="11" cy="11" r="9"
          stroke-dasharray="${C}" stroke-dashoffset="${C}"/>`;
      card.appendChild(ring);
      return { card, ring, path };
    }
  }
  return null;
}

function updateOptimisticCard(handle, pct) {
  if (!handle) return;
  const prog = handle.ring?.querySelector('.prog');
  if (prog) {
    const C = 2 * Math.PI * 9;
    prog.setAttribute('stroke-dashoffset', C - (C * pct / 100));
  }
}

function removeOptimisticCard(path) {
  // Remove item fake da lista
  S.lastItems = S.lastItems.filter(it => !(it.path === path && it.dateStr === 'A carregar...'));
}


// ─── INDICADOR OFFLINE/ONLINE ────────────────────────────────────────────────
function initOfflineDetection() {
  const pill = document.getElementById('offline-pill');
  const body = document.body;

  function setOffline() {
    if (pill) { pill.style.display = 'block'; pill.textContent = '⚡ Offline'; }
    body.classList.add('is-offline');
    toast('📡 Sem ligação à internet.', 'err');
  }

  function setOnline() {
    if (pill) { pill.style.display = 'none'; }
    body.classList.remove('is-offline');
    if (!navigator.onLine) return;
    toast('✅ Ligação restabelecida!', 'ok');
    // Re-carrega ficheiros da pasta actual
    if (S.user) loadFilesDebounced(S.path);
  }

  window.addEventListener('offline', setOffline);
  window.addEventListener('online', setOnline);

  // Estado inicial
  if (!navigator.onLine) setOffline();
}


// ─── LOGGER CENTRAL ──────────────────────────────────────────────────────────
const Logger = (() => {
  const _logs = [];
  const MAX = 50;

  function _add(level, msg, data) {
    const entry = { level, msg, data, ts: new Date().toISOString() };
    _logs.unshift(entry);
    if (_logs.length > MAX) _logs.pop();
    // Guarda no localStorage para debug
    try { localStorage.setItem('fc_logs', JSON.stringify(_logs.slice(0, 20))); } catch(e) {}
  }

  return {
    error(msg, data) { _add('error', msg, data); },
    warn(msg, data)  { _add('warn',  msg, data); },
    info(msg, data)  { _add('info',  msg, data); },
    getLogs()        { return [..._logs]; },
    clear()          { _logs.length = 0; },
  };
})();

// Captura erros não tratados
window.addEventListener('unhandledrejection', e => {
  Logger.error('Unhandled promise rejection', e.reason?.message || e.reason);
});
window.addEventListener('error', e => {
  Logger.error('Uncaught error', { msg: e.message, file: e.filename, line: e.lineno });
});

// ─── HANDLE ERROR CENTRALIZADO ───────────────────────────────────────────────
// 3 categorias: user (toast), background (só log), auth (mensagem específica)
// Dedup: mesmo context+msg suprimido durante 5s (evita spam de toasts)
const _errDedup = new Map();
function handleError(context, err, showToast = false) {
  if (!err) return;
  // AbortError é sempre silencioso (navegação normal)
  if (err?.name === 'AbortError' || err?.message?.includes('aborted')) return;
  const key = context + String(err?.message || err);
  const now = Date.now();
  if (_errDedup.has(key) && now - _errDedup.get(key) < 5000) return;
  _errDedup.set(key, now);
  // Log sempre
  Logger.warn(context, err?.message || String(err));
  // Toast só em operações iniciadas pelo utilizador
  if (showToast) {
    const msg = _errMsg(context, err);
    toast(msg, 'err');
  }
}
function _errMsg(context, err) {
  const status = err?.status || err?.code;
  if (context.includes('upload'))   return `❌ Erro no upload: ${err?.message || 'tenta novamente'}`;
  if (context.includes('delete'))   return `❌ Erro ao apagar: ${err?.message || ''}`;
  if (context.includes('rename'))   return `❌ Erro ao renomear: ${err?.message || ''}`;
  if (context.includes('move'))     return `❌ Erro ao mover: ${err?.message || ''}`;
  if (context.includes('folder'))   return `❌ Erro ao criar pasta: ${err?.message || ''}`;
  if (context.includes('download')) return `❌ Erro no download: ${err?.message || ''}`;
  if (context.includes('share'))    return `❌ Erro na partilha: ${err?.message || ''}`;
  if (status === 507)               return '❌ Servidor sem espaço disponível';
  if (status === 429)               return '⚠️ Demasiados pedidos — aguarda um momento';
  return `❌ ${context}: ${err?.message || 'erro desconhecido'}`;
}


// ─── DESFAZER (CTRL+Z) ───────────────────────────────────────────────────────
const UndoStack = (() => {
  const _stack = []; // {type, data, undo}
  const MAX = 10;

  return {
    push(action) {
      _stack.unshift(action);
      if (_stack.length > MAX) _stack.pop();
      // Mostra hint
      toast(`✅ ${action.label} · Ctrl+Z para desfazer`, 'ok');
    },
    async pop() {
      const action = _stack.shift();
      if (!action) { toast('Nada para desfazer.', ''); return; }
      try {
        await action.undo();
        toast(`↩️ Desfeito: ${action.label}`, 'ok');
        loadFilesDebounced(S.path);
        _idb.del(S.path);
      } catch(e) {
        Logger.error('Undo failed', e.message);
        toast('Erro ao desfazer.', 'err');
      }
    },
    has() { return _stack.length > 0; }
  };
})();


// ─── VISTA RECENTES ──────────────────────────────────────────────────────────
const Recents = (() => {
  const KEY = 'fc_recents_v1';
  const MAX = 20;

  function _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch(e) { return []; }
  }
  function _save(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch(e) {}
  }

  return {
    add(item) {
      const arr = _load().filter(r => r.path !== item.path);
      arr.unshift({ ...item, accessedAt: Date.now() });
      _save(arr.slice(0, MAX));
    },
    get() { return _load(); },
    clear() { _save([]); }
  };
})();

function showRecents() {
  const items = Recents.get();
  const fl = document.getElementById('fl');
  if (!items.length) {
    fl.innerHTML = '<div class="empty"><div class="ei">🕐</div><h3>Sem recentes</h3><p>Os ficheiros que abrires aparecem aqui.</p></div>';
    return;
  }
  // Renderiza como grid normal
  S.lastItems = items.map(r => ({
    name: r.name, path: r.path, isDir: r.isDir,
    size: r.size || 0, dateStr: r.accessedAt ? new Date(r.accessedAt).toLocaleDateString('pt-PT') : '',
    fileid: r.fileid || ''
  }));
  renderFiles(S.lastItems);
}


// ─── BATCHING WEBDAV ─────────────────────────────────────────────────────────
// Processa operações em lotes para evitar rate limiting (429)
async function batchWebDAV(items, operation, { batchSize = 4, delayMs = 200 } = {}) {
  const results = { ok: 0, err: 0, errors: [] };

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(async item => {
      try {
        await operation(item);
        results.ok++;
      } catch(e) {
        results.err++;
        results.errors.push({ item, error: e.message });
        Logger.warn('batchWebDAV error', { item, error: e.message });
      }
    }));
    // Pequena pausa entre batches para não saturar o servidor
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}


// ─── REQUEST COALESCING ──────────────────────────────────────────────────────
// Se dois pedidos para o mesmo URL estiverem em curso simultaneamente,
// partilham a mesma Promise em vez de abrir duas ligações
const _pendingReqs = new Map();

async function coalescedFetch(url, options = {}) {
  const key = url + (options.method || 'GET');
  if (_pendingReqs.has(key)) {
    // Já há um pedido em curso — espera pelo mesmo resultado
    return _pendingReqs.get(key);
  }
  const promise = fetch(url, options).finally(() => {
    _pendingReqs.delete(key);
  });
  _pendingReqs.set(key, promise);
  return promise;
}


// ─── VIRTUAL SCROLLING ───────────────────────────────────────────────────────
// Para pastas com muitos itens, renderiza apenas o que está visível
// Threshold: activa para >100 itens (abaixo disso DOM normal é mais simples)
const VS_THRESHOLD = 80; // activa virtual scroll com 80+ itens — elimina jank em pastas com muitas fotos
const VS_ITEM_H_GRID = 165;  // altura real dos cards: thumb(86)+texto+padding
const VS_ITEM_H_LIST = 48;   // altura de uma row na lista
const VS_COLS_ESTIMATE = 4;  // colunas estimadas (ajusta no resize)
const VS_BUFFER = 5; // 5 linhas extra — menos buracos em scroll rápido

let _vsState = null; // estado do virtual scroll activo

function initVirtualScroll(items, container) {
  if (items.length < VS_THRESHOLD) return false;

  const isGrid = S.view === 'grid';

  // ── COLUNAS REAIS — medir o contentor, não estimar ──────────────────────
  // CSS usa auto-fill minmax(124px,1fr) em mobile, 148px em desktop
  // VS_COLS_ESTIMATE=4 estava errado para mobile (3 cols) e desktop (6-9 cols)
  const containerW = container.clientWidth || document.getElementById('main').clientWidth || 375;
  const minCardW   = isGrid ? (window.innerWidth <= 700 ? 124 : 148) : 1;
  const cols       = isGrid ? Math.max(1, Math.floor((containerW - 22) / (minCardW + 9))) : 1;
  // -22 = padding do .main (11px × 2), +9 = gap da .fgrid

  // Altura estimada para calcular o spacer inicial (será corrigida após render)
  const itemH = isGrid ? VS_ITEM_H_GRID : VS_ITEM_H_LIST;
  const totalRows = Math.ceil(items.length / cols);
  const totalH    = totalRows * itemH;

  container.innerHTML = `
    <div id="vs-spacer-top" style="height:0px"></div>
    <div id="vs-content"></div>
    <div id="vs-spacer-bot" style="height:${totalH}px"></div>`;

  _vsState = { items, cols, itemH, totalH, isGrid, container, _si: -1, _ei: -1 };
  _vsRender();

  // ── MEDIR ALTURA REAL após primeiro render ──────────────────────────────
  // Usa rAF para garantir que o browser já calculou o layout
  requestAnimationFrame(() => {
    if (!_vsState) return;
    const content = document.getElementById('vs-content');
    const firstCard = content?.querySelector('.fc, .lr');
    if (firstCard) {
      // Altura real do card + gap
      const realH   = firstCard.offsetHeight + (isGrid ? 9 : 0); // gap: 9px (grid), 0 (list)
      const realCols = isGrid
        ? Math.max(1, Math.round(content.offsetWidth / firstCard.offsetWidth))
        : 1;
      if (realH > 10 && realH !== _vsState.itemH) {
        _vsState.itemH  = realH;
        _vsState.cols   = realCols;
        const newTotal  = Math.ceil(items.length / realCols) * realH;
        _vsState.totalH = newTotal;
        // Recalcular spacer inferior com dimensões reais
        const spBot = document.getElementById('vs-spacer-bot');
        if (spBot) spBot.style.height = newTotal + 'px';
        // Forçar re-render com medições correctas
        _vsState._si = -1; _vsState._ei = -1;
        _vsRender();
      }
    }
  });

  // Listener de scroll
  const main = document.getElementById('main');
  if (main._vsHandler) main.removeEventListener('scroll', main._vsHandler);
  main._vsHandler = _vsThrottle(_vsRender);
  main.addEventListener('scroll', main._vsHandler, { passive: true });

  // Listener de resize — recalcula cols se o utilizador rodar o ecrã
  if (main._vsResize) window.removeEventListener('resize', main._vsResize);
  main._vsResize = _vsThrottle(() => {
    if (!_vsState || !isGrid) return;
    const content = document.getElementById('vs-content');
    const firstCard = content?.querySelector('.fc');
    if (!firstCard) return;
    const newCols = Math.max(1, Math.round(content.offsetWidth / firstCard.offsetWidth));
    if (newCols !== _vsState.cols) {
      _vsState.cols   = newCols;
      _vsState.totalH = Math.ceil(items.length / newCols) * _vsState.itemH;
      const spBot = document.getElementById('vs-spacer-bot');
      if (spBot) spBot.style.height = _vsState.totalH + 'px';
      _vsState._si = -1; _vsState._ei = -1;
      _vsRender();
    }
  });
  window.addEventListener('resize', main._vsResize, { passive: true });

  return true;
}

function _vsThrottle(fn) {
  // Apenas rAF — sem setTimeout adicional.
  // rAF sincroniza com o frame do browser (16ms a 60fps).
  // Adicionar setTimeout(150ms) causava 166ms de lag visível no scroll.
  let raf = null;
  return () => {
    if (raf) return; // já agendado para este frame
    raf = requestAnimationFrame(() => { raf = null; fn(); });
  };
}

function _vsRender() {
  if (!_vsState) return;
  const { items, cols, itemH, isGrid } = _vsState;
  const main = document.getElementById('main');
  const scrollTop = main.scrollTop;
  const viewH = main.clientHeight;

  const startRow = Math.max(0, Math.floor(scrollTop / itemH) - VS_BUFFER);
  const endRow   = Math.min(
    Math.ceil(items.length / cols),
    Math.ceil((scrollTop + viewH) / itemH) + VS_BUFFER
  );
  const startIdx = startRow * cols;
  const endIdx   = Math.min(items.length, endRow * cols);

  // ── DIFF: se o range visível não mudou, não há nada a fazer ──────────────
  if (_vsState._si === startIdx && _vsState._ei === endIdx) return;
  _vsState._si = startIdx;
  _vsState._ei = endIdx;

  const topH = startRow * itemH;
  const botH = Math.max(0, (_vsState.totalH - endRow * itemH));

  const spTop = document.getElementById('vs-spacer-top');
  const spBot = document.getElementById('vs-spacer-bot');
  if (spTop) spTop.style.height = topH + 'px';
  if (spBot) spBot.style.height = botH + 'px';

  const visible = items.slice(startIdx, endIdx);
  const content = document.getElementById('vs-content');
  if (!content) return;

  if (isGrid) {
    content.innerHTML = '<div class="fgrid">' + visible.map(card).join('') + '</div>';
  } else {
    content.innerHTML = '<div class="flist"><div class="lh"><span>Nome</span><span>Tamanho</span><span class="cd">Modificado</span><span>Ações</span></div>' +
      visible.map(row).join('') + '</div>';
  }

  content.querySelectorAll('img[data-src]').forEach(img => _lazyObserver.observe(img));
}

function destroyVirtualScroll() {
  _vsState = null;
  const main = document.getElementById('main');
  if (main._vsHandler) {
    main.removeEventListener('scroll', main._vsHandler);
    main._vsHandler = null;
  }
  if (main._vsResize) {
    window.removeEventListener('resize', main._vsResize);
    main._vsResize = null;
  }
}


// ─── BARRA DE ESTADO DOS FICHEIROS ───────────────────────────────────────────
function updateFilesStatus(items) {
  const el = document.getElementById('files-status');
  if (!el) return;
  if (!items.length) { el.classList.remove('show'); return; }

  const dirs   = items.filter(i => i.isDir).length;
  const imgs   = items.filter(i => !i.isDir && isImg(i.name)).length;
  const vids   = items.filter(i => !i.isDir && isVid(i.name)).length;
  const docs   = items.filter(i => !i.isDir && isPdf(i.name)).length;
  const others = items.filter(i => !i.isDir && !isImg(i.name) && !isVid(i.name) && !isPdf(i.name)).length;
  const total  = items.length;

  const parts = [];
  if (dirs)   parts.push(`<span class="fs-item">📁 <span class="fs-count">${dirs}</span></span>`);
  if (imgs)   parts.push(`<span class="fs-item">🖼️ <span class="fs-count">${imgs}</span></span>`);
  if (vids)   parts.push(`<span class="fs-item">🎬 <span class="fs-count">${vids}</span></span>`);
  if (docs)   parts.push(`<span class="fs-item">📄 <span class="fs-count">${docs}</span></span>`);
  if (others) parts.push(`<span class="fs-item">📎 <span class="fs-count">${others}</span></span>`);

  // Nota: "listados" = estrutura de ficheiros carregada, não os conteúdos/thumbnails
  const note = S._isSyncing ? ' · ⏳' : ' · ✓';
  el.innerHTML = parts.join('<span class="fs-sep">·</span>') +
    `<span class="fs-sep">·</span><span class="fs-item" style="color:var(--text3)">${total} itens${note}</span>`;

  el.classList.add('show');
}


// ─── STORAGE STATS ───────────────────────────────────────────────────────────
async function openStorageStats() {
  showM('storage-stats');
  const content = document.getElementById('storage-stats-content');
  content.innerHTML = '<div class="loading"><div class="spin"></div> A calcular...</div>';

  try {
    // Lê pastas de topo
    const r = await fetch(dav('/'), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:quota-used-bytes/></d:prop></d:propfind>`
    });
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const responses = [...xml.querySelectorAll('response')].slice(1); // remove raiz

    const folders = responses.map(resp => {
      const name = resp.querySelector('displayname')?.textContent || '';
      const isDir = resp.querySelector('resourcetype collection') !== null;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent || '0') || 0;
      return { name, isDir, size };
    }).filter(f => f.isDir && f.name);

    if (!folders.length) {
      content.innerHTML = '<p style="color:var(--text2);text-align:center;padding:20px">Sem pastas</p>';
      return;
    }

    // Ordena por nome
    folders.sort((a,b) => a.name.localeCompare(b.name));

    // Quota total
    const quotaResp = await fetch(PROXY + '/nextcloud/remote.php/dav/files/' + encodeURIComponent(S.user) + '/', {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '0', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>`
    });
    const quotaXml = new DOMParser().parseFromString(await quotaResp.text(), 'text/xml');
    const used = parseInt(quotaXml.querySelector('quota-used-bytes')?.textContent || '0');
    const avail = parseInt(quotaXml.querySelector('quota-available-bytes')?.textContent || '0');
    const total = used + avail;

    let html = '';
    if (total > 0) {
      const pct = Math.round(used/total*100);
      html += `<div style="margin-bottom:16px;padding:14px;background:var(--bg2);border-radius:12px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-bottom:6px">
          <span>💾 Espaço usado</span>
          <span><b style="color:var(--primary)">${fmtSz(used)}</b> de ${fmtSz(total)}</span>
        </div>
        <div style="height:8px;background:var(--bg3);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--gradient);border-radius:4px;transition:width .6s"></div>
        </div>
        <div style="text-align:right;font-size:11px;color:var(--text3);margin-top:4px">${fmtSz(avail)} livres</div>
      </div>`;
    }

    html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">Pastas de topo</div>`;
    for (const f of folders) {
      const icon = f.name.match(/foto|photo|imag/i) ? '🖼️' :
                   f.name.match(/video|vid/i) ? '🎬' :
                   f.name.match(/doc|pdf/i) ? '📄' :
                   f.name.match(/music|musica|áudio/i) ? '🎵' : '📁';
      html += `<div onclick="window.openDir('/${f.name}/');window.hideM('storage-stats')"
        style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .15s;margin-bottom:4px"
        onmouseenter="this.style.background='var(--bg2)'" onmouseleave="this.style.background=''">
        <span style="font-size:20px">${icon}</span>
        <span style="flex:1;font-size:13px;font-weight:500;color:var(--text)">${f.name}</span>
        <span style="font-size:12px;color:var(--text3)">›</span>
      </div>`;
    }

    content.innerHTML = html;
  } catch(e) {
    content.innerHTML = `<p style="color:var(--red);text-align:center;padding:20px">Erro: ${e.message}</p>`;
  }
}

const UPQ = {
  jobs: [],   // {id, name, total, files, destPath, status:'wait'|'run'|'ok'|'err', done:0, errors:0}
  _running: false,
  _idSeq: 0,
  add(files, label) {
    const id = ++this._idSeq;
    this.jobs.push({ id, label, files: Array.from(files), status:'wait', done:0, errors:0, total:files.length });
    // Mostrar painel imediatamente — utilizador sabe que a acção foi registada
    const prog = document.getElementById('uprog');
    if (prog) prog.style.display = 'block';
    this._render();
    if (!this._running) this._run();
  },
  _render() {
    const prog = document.getElementById('uprog');
    const queue = document.getElementById('uprog-queue');
    const activeJobs = this.jobs.filter(j => j.status === 'wait' || j.status === 'run');
    const recentDone = this.jobs.filter(j => j.status === 'ok' || j.status === 'err');
    // Esconde se não há jobs activos E todos os concluídos têm mais de 4s
    if (activeJobs.length === 0 && recentDone.length === 0) { 
      prog.style.display='none'; return; 
    }
    prog.style.display = 'block';
    const running = this.jobs.filter(j=>j.status==='run');
    const waiting = this.jobs.filter(j=>j.status==='wait');
    const done = this.jobs.filter(j=>j.status==='ok'||j.status==='err');
    document.getElementById('uprog-title').textContent =
      running.length ? `⬆️ ${running.length} upload${running.length>1?'s':''} activo${running.length>1?'s':''}` + (waiting.length ? ` · ${waiting.length} em fila` : '') :
      done.length === this.jobs.length ? `✅ Todos os uploads concluídos` : `⏳ A aguardar...`;
    // Show last 6 jobs
    const shown = this.jobs.slice(-6);
    queue.innerHTML = shown.map(j => {
      const icon = j.status==='ok'?'✅':j.status==='err'?'❌':j.status==='run'?'⬆️':'⏳';
      const cls = j.status==='ok'?'ok':j.status==='err'?'err':j.status==='run'?'run':'wait';
      const pct = j.total ? Math.round((j.done/j.total)*100) : 0;
      const info = j.status==='run' ? ` (${j.done}/${j.total} · ${pct}%)` : j.status==='ok' ? ` (${j.total})` : j.status==='err' ? ` (${j.errors} erros)` : ` (${j.total})`;
      return `<div class="uq-item"><span class="uq-name">${icon} ${j.label}</span><span class="uq-status ${cls}">${info}</span></div>`;
    }).join('');
  },
  async _run() {
    this._running = true;
    while (true) {
      const job = this.jobs.find(j=>j.status==='wait');
      if (!job) break;
      job.status = 'run';
      this._render();
      await this._execJob(job);
      this._render();
    }
    this._running = false;
    // Auto-hide após 3s sempre que termina
    const prog = document.getElementById('uprog');
    if (prog) {
      prog.style.transition = 'opacity .5s';
      setTimeout(() => {
        prog.style.opacity = '0';
        setTimeout(() => {
          prog.style.display = 'none';
          prog.style.opacity = '1';
          document.getElementById('uprog-bar').style.width = '0%';
          this.jobs = [];
        }, 500);
      }, 3000);
    }
  },
  async _execJob(job) {
    S.uploadCancel = false;
    let totalBytes = job.files.reduce((s,f)=>s+f.size,0), sentBytes=0;
    const startTime = Date.now();
    // Captura o destDir no início do job — não muda mesmo que o utilizador navegue
    const jobDestDir = job.destDir || S.path;
    for (let i=0; i<job.files.length; i++) {
      if (S.uploadCancel) break;
      const f = job.files[i];
      document.getElementById('uprog-file').textContent = `${job.label} · ${i+1}/${job.files.length}: ${f.name}`;
      let destDir = jobDestDir;
      if (f.webkitRelativePath) {
        const parts = f.webkitRelativePath.split('/');
        let cur = jobDestDir;
        for (let j=0; j<parts.length-1; j++) {
          cur += (cur.endsWith('/')?'':'/')+encodeURIComponent(parts[j]);
          await fetch(dav(cur),{method:'MKCOL',headers:{'Authorization':auth()}}).catch(()=>{});
          cur+='/';
        }
        destDir = cur;
      }
      const destPath = destDir + encodeURIComponent(f.name).replace(/%2F/g,'/').replace(/'/g,'%27');
      let queueId=null;
      try { queueId=await UQ.add(f,destPath); } catch(e) { handleError('upload-queue', e); }
      // Comprime imagens antes de enviar (>1MB)
      // Upload optimista — mostra card na grid imediatamente
      const optPath = destDir + encodeURIComponent(f.name).replace(/%2F/g,'/');
      const optHandle = (S.view === 'grid' && S.path === jobDestDir) ? addOptimisticCard(f, optPath) : null;

      let fileToUpload = f;
      if (isImg(f.name) && f.size > 1024*1024) {
        document.getElementById('uprog-file').textContent = `🗜️ A comprimir ${f.name}...`;
        fileToUpload = await compressImage(f);
        if (fileToUpload !== f) {
          const saved = Math.round((1 - fileToUpload.size/f.size)*100);
          const fmt = fileToUpload.name.endsWith('.webp') ? 'WebP' : 'JPEG';
          const msg = `🗜️ ${f.name}: ${fmtSz(f.size)} → ${fmtSz(fileToUpload.size)} (-${saved}%)`;
          document.getElementById('uprog-speed').textContent = msg;
          // Toast visível se a poupança for significativa (>30%)
          if (saved >= 30) toast(`📦 Comprimido: ${fmtSz(f.size)} → ${fmtSz(fileToUpload.size)} (-${saved}%)`, 'ok');
        }
      }
      const f2 = fileToUpload; // usa ficheiro comprimido daqui para a frente

      let uploaded=false;
      // Ficheiros > 100MB usam chunked upload para suportar falhas e retoma
      if (f2.size > 100 * 1024 * 1024 && !S.uploadCancel) {
        try {
          await uploadChunked(f2, destPath, (sent, total, chunk, totalChunks) => {
            const pct = Math.min(99, Math.round(sent / total * 100));
            document.getElementById('uprog-bar').style.width = pct + '%';
            document.getElementById('uprog-file').textContent = `⬆️ ${f.name} — chunk ${chunk}/${totalChunks} (${pct}%)`;
            const elapsed = (Date.now() - startTime) / 1000 || 0.001;
            document.getElementById('uprog-speed').textContent = fmtSz(sent / elapsed) + '/s';
          });
          uploaded = true;
        } catch(chunkErr) {
          // Fallback para upload normal se chunked falhar
        }
      }
      for (let attempt=0; attempt<3&&!S.uploadCancel&&!uploaded; attempt++) {
        if (attempt>0) { await new Promise(r=>setTimeout(r,1000*attempt)); }
        const ok = await new Promise(resolve=>{
          const xhr=new XMLHttpRequest(); S.uploadXHR=xhr;
          xhr.upload.onprogress=e=>{
            const totalSent=sentBytes+e.loaded;
            const pct=Math.min(99,Math.round(totalSent/totalBytes*100));
            document.getElementById('uprog-bar').style.width=pct+'%';
            const elapsed=(Date.now()-startTime)/1000||0.001;
            document.getElementById('uprog-speed').textContent=fmtSz(totalSent/elapsed)+'/s';
            // Actualiza anel de progresso no card optimista
            updateOptimisticCard(optHandle, Math.round(e.loaded/e.total*100));
          };
          xhr.onload=()=>{
            if(xhr.status===507){toast('❌ Servidor sem espaço.','err');S.uploadCancel=true;}
            resolve(xhr.status<400);
          };
          xhr.onerror=()=>resolve(false);
          xhr.onabort=()=>resolve(null);
          const LARGE=50*1024*1024;
          const uploadUrl=f2.size>LARGE?NC+'/remote.php/dav/files/'+encodeURIComponent(S.user)+destPath:dav(destPath);
          xhr.open('PUT',uploadUrl);
          xhr.setRequestHeader('Authorization',auth());
          xhr.send(f2);
        });
        if (ok===null) break;
        if (ok) { uploaded=true; } else if (attempt===2) { job.errors++; }
      }
      if (uploaded) {
        sentBytes+=f2.size;
        if(queueId){try{await UQ.setStatus(queueId,'done');}catch(e){}}
        removeOptimisticCard(optPath);
      } else {
        removeOptimisticCard(optPath);
      }
      job.done++;
      this._render();
    }
    document.getElementById('uprog-bar').style.width='100%';
    job.status = job.errors===0?'ok':'err';
    S.uploadXHR=null;
    const okCount=job.done-job.errors;
    if(job.errors&&okCount===0) toast(`❌ ${job.errors} ficheiros falharam.`,'err');
    else if(job.errors) toast(`⚠️ ${okCount} carregados, ${job.errors} falharam.`,'err');
    else toast(`✅ ${okCount} ficheiro${okCount>1?'s':''} carregado${okCount>1?'s':''}!`,'ok');
    loadFilesDebounced(S.path); loadStorage();
    // Recarrega árvore só se o upload criou subpastas (folder upload com webkitRelativePath)
    const hadSubfolders = job.files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
    if (hadSubfolders) setTimeout(()=>loadTree('/'),600);
  }
};

async function uploadFiles(fl) {
  if (!fl || !fl.length) return;
  // Registar background sync para retomar se perder ligação
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    navigator.serviceWorker.ready.then(sw => {
      sw.sync.register('fc-upload-retry').catch(() => {});
    });
  }
  if (fl.length > 200) {
    const ok = confirm(fl.length + ' ficheiros selecionados.\nIsto pode demorar alguns minutos.\nContinuar?');
    if (!ok) return;
  }
  const label = fl.length===1 ? fl[0].name : `${fl.length} ficheiros`;
  UPQ.add(fl, label);
}


// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
async function dlF(p, nm, isDir=false) {
  if (isDir) {
    // Pasta → ZIP via fetch com Authorization header (sem expor credenciais no URL)
    const folderPath = p.replace(/\/$/, '');
    const parts = folderPath.split('/').filter(Boolean);
    const folderName = parts[parts.length - 1] || nm;
    const parentPath = '/' + parts.slice(0, -1).join('/');
    const zipUrl = NC + '/index.php/apps/files/ajax/download.php'
      + '?dir=' + encodeURIComponent(parentPath)
      + '&files[]=' + encodeURIComponent(folderName);

    const prog = document.getElementById('uprog');
    const progBar = document.getElementById('uprog-bar');
    const progFile = document.getElementById('uprog-file');
    const progSpeed = document.getElementById('uprog-speed');
    prog.style.display = 'block';
    progFile.textContent = '📦 A preparar ZIP: ' + nm;
    progBar.style.width = '5%';
    progSpeed.textContent = '';

    try {
      const ctrl = new AbortController();
      S._zipAbort = ctrl;
      const r = await fetch(zipUrl, {
        headers: { 'Authorization': auth(), 'X-FC-Download': '1' },
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      // Stream com progresso real
      const contentLength = parseInt(r.headers.get('content-length') || '0');
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      const t0 = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const elapsed = (Date.now() - t0) / 1000 || 0.1;
        const speed = fmtSz(received / elapsed) + '/s';
        const pct = contentLength ? Math.min(95, Math.round(received / contentLength * 100)) : Math.min(95, Math.round(received / 1024 / 1024));
        progBar.style.width = pct + '%';
        progFile.textContent = '📦 ZIP: ' + nm + ' — ' + fmtSz(received);
        progSpeed.textContent = speed;
      }

      const blob = new Blob(chunks);
      if (blob.size < 22) throw new Error('ZIP inválido');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = nm + '.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      progBar.style.width = '100%';
      toast('✅ "' + nm + '.zip" descarregado!', 'ok');
    } catch(e) {
      if (e.name === 'AbortError') { toast('Download cancelado.', ''); }
      else { toast('❌ Erro ZIP: ' + e.message, 'err'); }
    } finally {
      setTimeout(() => { prog.style.display='none'; progBar.style.width='0%'; }, 1200);
      S._zipAbort = null;
    }
    return;
  }
  // Ficheiro normal — força download sem abrir no browser
  const prog = document.getElementById('uprog');
  const progBar = document.getElementById('uprog-bar');
  const progFile = document.getElementById('uprog-file');
  const progSpeed = document.getElementById('uprog-speed');
  prog.style.display = 'block';
  progFile.textContent = '⬇️ ' + nm;
  progBar.style.width = '5%';
  progSpeed.textContent = '';
  try {
    const ctrl = new AbortController();
    const r = await fetch(dav(p), {
      headers: { 'Authorization': auth(), 'X-FC-Download': '1' },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const contentLength = parseInt(r.headers.get('content-length') || '0');
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    const t0 = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const elapsed = (Date.now() - t0) / 1000 || 0.1;
      const speed = fmtSz(received / elapsed) + '/s';
      const pct = contentLength ? Math.min(95, Math.round(received / contentLength * 100)) : Math.min(80, Math.round(received / 1024 / 1024));
      progBar.style.width = pct + '%';
      progFile.textContent = '⬇️ ' + nm + ' — ' + fmtSz(received);
      progSpeed.textContent = speed;
    }
    // Força download — nunca abre no browser
    const blob = new Blob(chunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nm; // download attribute força sempre ficheiro, nunca abre
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    progBar.style.width = '100%';
    toast('✅ ' + nm + ' descarregado!', 'ok');
  } catch(e) {
    toast('❌ Erro: ' + e.message, 'err');
  } finally {
    setTimeout(() => { prog.style.display='none'; progBar.style.width='0%'; }, 1200);
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
async function delIt(p, nm) {
  if (!confirm(`Apagar "${nm}"?\n\nEsta acção é irreversível.`)) return;
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);

  // OPTIMISTIC UPDATE — remove da UI imediatamente
  const prevItems = [...S.lastItems];
  S.lastItems = S.lastItems.filter(it => it.path !== p);
  renderFiles(S.lastItems);
  _idb.set(S.path, S.lastItems); // actualiza cache
  // Push para undo stack
  UndoStack.push({
    label: `Apagar "${nm}"`,
    undo: async () => {
      // Não conseguimos restaurar ficheiros apagados sem lixo
      // Mas podemos avisar e abrir o lixo
      toast('Ficheiro apagado permanentemente. Verifica o lixo.', 'err');
      openTrash();
    }
  });

  try {
    const r = await fetch(dav(p), { method:'DELETE', headers:{'Authorization':auth()} });
    if (r.ok || r.status===204 || r.status===404) {
      loadStorage();
    } else {
      // ROLLBACK
      S.lastItems = prevItems;
      renderFiles(S.lastItems);
      _idb.set(S.path, prevItems);
      toast('Erro ao apagar (' + r.status + ')', 'err');
    }
  } catch(e) {
    S.lastItems = prevItems;
    renderFiles(S.lastItems);
    toast('Erro ao apagar', 'err');
  }
}

// ─── RENAME ───────────────────────────────────────────────────────────────────
function startRn(p, nm) {
  S.renameTarget = {p, nm}; document.getElementById('ri').value = nm; showM('rename');
  setTimeout(() => { const i = document.getElementById('ri'); i.focus(); i.select(); }, 80);
}
async function doRename() {
  const n = document.getElementById('ri').value.trim();
  if (!n || !S.renameTarget) return;
  const oldPath = S.renameTarget.p;
  const oldNm = S.renameTarget.nm;
  const par = oldPath.replace(/\/$/,'').substring(0, oldPath.replace(/\/$/,'').lastIndexOf('/')+1);
  const dest = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + par + encodeURIComponent(n);
  const newPath = par + (oldPath.endsWith('/') ? n + '/' : n);

  // OPTIMISTIC UPDATE — muda o nome na UI antes do servidor responder
  const prevItems = [...S.lastItems];
  S.lastItems = S.lastItems.map(it =>
    it.path === oldPath ? {...it, name: n, path: newPath} : it
  );
  renderFiles(S.lastItems);
  hideM('rename');

  try {
    const r = await fetch(dav(oldPath), { method:'MOVE', headers:{'Authorization':auth(),'Destination':dest,'Overwrite':'F'} });
    if (r.ok || r.status===201 || r.status===204) {
      const oldNm2 = S.renameTarget?.nm || '';
      const newNm2 = n;
      UndoStack.push({
        label: `Renomear "${oldNm2}" → "${newNm2}"`,
        undo: async () => {
          const curPath = newPath;
          const dest2 = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + par + encodeURIComponent(oldNm2);
          await fetch(dav(curPath), { method:'MOVE', headers:{'Authorization':auth(),'Destination':dest2,'Overwrite':'F'} });
        }
      });
      _idb.del(S.path); // Invalida cache desta pasta
      loadFilesDebounced(S.path); // Sincroniza com servidor
    } else {
      // ROLLBACK — reverte se falhou
      S.lastItems = prevItems;
      renderFiles(S.lastItems);
      toast('Erro ao renomear (' + r.status + ')', 'err');
    }
  } catch(e) {
    S.lastItems = prevItems;
    renderFiles(S.lastItems);
    toast('Erro ao renomear', 'err');
  }
}

// ─── CREATE FOLDER ────────────────────────────────────────────────────────────
async function createFolder() {
  const n = document.getElementById('fi').value.trim(); if (!n) return;
  try {
    const r = await fetch(dav(S.path + encodeURIComponent(n)), { method:'MKCOL', headers:{'Authorization':auth()} });
    if (r.ok || r.status===201) {
      toast('Pasta "'+n+'" criada!', 'ok'); hideM('folder');
      document.getElementById('fi').value = '';
      loadFiles(S.path); setTimeout(() => loadTree('/'), 400); // necessário: criou nova pasta
    } else toast('Erro ao criar pasta (' + r.status + ')', 'err');
  } catch(e) { toast('Erro ao criar pasta', 'err'); }
}

// ─── MOVE ─────────────────────────────────────────────────────────────────────
function startMoveItem(p, nm) { openMoveModal([p], [nm]); }

async function openMoveModal(paths, names) {
  S.moveTargets = paths;
  document.getElementById('move-desc').textContent = 'Mover ' + (names.length===1 ? '"'+names[0]+'"' : names.length+' itens') + ' para:';
  const sel = document.getElementById('move-sel');
  sel.innerHTML = '<option value="/">🏠 Início (raiz)</option>';
  try {
    const r = await fetch(dav('/'), {
      method: 'PROPFIND', headers:{'Authorization':auth(),'Depth':'2','Content-Type':'application/xml'},
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`
    });
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const dirs = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (!rel || rel === '/') return;
      if (resp.querySelector('resourcetype collection')) {
        const nm2 = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
        const fp = rel.endsWith('/') ? rel : rel+'/';
        if (nm2 && !nm2.startsWith('.') && !HIDDEN.includes(nm2) && !paths.includes(fp))
          dirs.push({nm:nm2, path:fp});
      }
    });
    dirs.sort((a,b)=>a.nm.localeCompare(b.nm));
    dirs.forEach(d => { sel.innerHTML += `<option value="${d.path}">📁 ${hesc(d.nm)}</option>`; });
  } catch(e) { Logger.warn('openMoveModal: erro ao carregar pastas', e?.message); }
  showM('move');
}

async function doMove() {
  const dest = document.getElementById('move-sel').value;
  const destNm = dest==='/' ? 'Início' : dest.split('/').filter(Boolean).pop();
  let moved = 0, duplicates = [], errors = 0;

  // Primeira passagem — tenta mover todos
  for (const src of S.moveTargets) {
    try {
      const result = await moveItem(src, dest);
      if (result.status === 'ok') moved++;
      else if (result.status === 'duplicate') duplicates.push(src);
      else errors++;
    } catch(e) { errors++; }
  }

  // Trata duplicados se existirem
  if (duplicates.length > 0) {
    const nms = duplicates.map(s => s.replace(/\/$/, '').split('/').pop()).join(', ');
    const choice = confirm(`${duplicates.length} ficheiro${duplicates.length>1?'s':''} já exist${duplicates.length>1?'em':'e'} em "${destNm}":\n${nms}\n\nOK = Substituir\nCancelar = Manter os dois (renomeia automaticamente)`);
    for (const src of duplicates) {
      try {
        const result2 = await moveItem(src, dest, { overwrite: choice, autoRename: !choice });
        if (result2.status === 'ok') moved++;
        else errors++;
      } catch(e) { errors++; }
    }
  }

  // Feedback final
  if (errors && moved === 0) toast(`❌ Erro ao mover. Tenta novamente.`, 'err');
  else if (errors) toast(`⚠️ ${moved} movido${moved>1?'s':''}, ${errors} com erro.`, 'err');
  else toast(`✅ ${moved} item${moved>1?'ns':''} movido${moved>1?'s':''} para "${destNm}"!`, 'ok');

  hideM('move'); clearSel(); loadFilesDebounced(S.path); loadStorage();
}

// ─── GALLERY ──────────────────────────────────────────────────────────────────
function openGallery(clickedPath) {
  S.galleryItems = S.lastItems.filter(it => !it.isDir && isImg(it.name));
  S.galleryIdx   = S.galleryItems.findIndex(it => it.path === clickedPath);
  if (S.galleryIdx < 0) S.galleryIdx = 0;
  S.galleryZoom  = 1;
  document.getElementById('gallery-ov').classList.add('show');
  // SW: pré-cacheia foto actual + 3 adjacentes (diagrama 2)
  _swCacheGalleryAdjacent(S.galleryIdx);
  document.getElementById('gallery-dl').onclick = () => {
    const it = S.galleryItems[S.galleryIdx];
    dlF(it.path, it.name);
  };
  document.getElementById('gallery-sh').onclick = () => {
    const it = S.galleryItems[S.galleryIdx];
    shareItem(it.path, it.name);
  };
  renderGallery();
  setupGalleryTouch();
}

function renderGallery(dir) {
  const it = S.galleryItems[S.galleryIdx]; if (!it) return;
  // Aborta fetch anterior + limpa interval + limpa EXIF anterior
  _cancelGallery();
  clearInterval(_galleryProgInt); _galleryProgInt = null;
  const _exifBar = document.getElementById('gallery-exif');
  if (_exifBar) _exifBar.innerHTML = '';
  clearInterval(_galleryProgInt); _galleryProgInt = null;
  const img = document.getElementById('gallery-img');
  // Animação de slide
  if (dir) {
    img.classList.remove('slide-left', 'slide-right');
    void img.offsetWidth; // reflow para reiniciar animação
    img.classList.add(dir === 'left' ? 'slide-left' : 'slide-right');
  }
  const loadingEl = document.getElementById('gallery-loading');
  const brokenEl = document.getElementById('gallery-broken');
  const progFill = document.getElementById('gallery-prog-fill');
  img.style.transform = 'scale(1)'; img.classList.remove('zoomed'); S.galleryZoom = 1;
  // Show loading state
  img.classList.add('loading-img');
  loadingEl.style.display = 'flex';
  brokenEl.style.display = 'none';
  progFill.style.width = '20%';
  // Usar module-level _galleryProgInt — evita acumulação de intervals ao navegar rápido
  clearInterval(_galleryProgInt);
  let _prog = 20;
  _galleryProgInt = setInterval(() => {
    _prog = Math.min(85, _prog + Math.random() * 15);
    progFill.style.width = _prog + '%';
  }, 300);
  img.onload = () => {
    clearInterval(_galleryProgInt); _galleryProgInt = null;
    progFill.style.width = '100%';
    setTimeout(() => {
      loadingEl.style.display = 'none';
      img.classList.remove('loading-img');
    }, 200);
  };
  img.onerror = () => {
    clearInterval(_galleryProgInt); _galleryProgInt = null;
    loadingEl.style.display = 'none';
    brokenEl.style.display = 'flex';
    img.classList.remove('loading-img');
  };
  img.src = ''; authImg(img, dav(it.path), null, _galleryAbortCtrl.signal);
  // Carrega EXIF em background (Range request 64KB)
  _loadExif(it);
  document.getElementById('gallery-nm').textContent = it.name;
  document.getElementById('gallery-count').textContent = (S.galleryIdx+1) + ' / ' + S.galleryItems.length;
  // strip thumbnails
  // Usa preview 128px se houver fileid — evita descarregar ficheiros completos
  // (numa pasta com 229 fotos = 229 downloads desnecessários antes desta fix)
  const strip = document.getElementById('gallery-strip');
  strip.innerHTML = S.galleryItems.map((g,i) => {
    const tUrl = g.fileid ? thumbUrl(g.fileid, 128) : dav(g.path);
    const fbUrl = g.fileid ? dav(g.path) : '';
    return `<img class="gallery-thumb${i===S.galleryIdx?' active':''}" data-src="${tUrl}" data-fb="${fbUrl}" alt="${g.name}" onclick="window.galleryGoTo(${i})">`;
  }).join('');
  strip.querySelectorAll('img[data-src]').forEach(img => {
    const src = img.dataset.src; const fb = img.dataset.fb || '';
    delete img.dataset.src; delete img.dataset.fb;
    authImg(img, src, fb);
  });
  setTimeout(() => {
    const at = strip.querySelector('.active');
    if (at) at.scrollIntoView({inline:'center', behavior:'smooth'});
  }, 80);

  // Dots de posição (só se <= 20 imagens)
  let dotsEl = document.getElementById('gallery-dots');
  if (!dotsEl) {
    dotsEl = document.createElement('div');
    dotsEl.id = 'gallery-dots';
    dotsEl.className = 'gallery-dots';
    document.getElementById('gallery-viewer')?.appendChild(dotsEl);
  }
  if (S.galleryItems.length <= 20) {
    dotsEl.innerHTML = S.galleryItems.map((_, i) =>
      `<div class="gallery-dot-item${i === S.galleryIdx ? ' active' : ''}"></div>`
    ).join('');
    dotsEl.style.display = 'flex';
  } else {
    dotsEl.style.display = 'none';
  }
}

function galleryNav(d) {
  S.galleryIdx = (S.galleryIdx + d + S.galleryItems.length) % S.galleryItems.length;
  renderGallery(d > 0 ? 'left' : 'right');
  // SW: pré-cacheia 2 atrás + 5 à frente (diagrama 2)
  _swCacheGalleryAdjacent(S.galleryIdx);
}

function _swCacheGalleryAdjacent(idx) {
  if (!navigator.serviceWorker?.controller || !S.galleryItems.length) return;
  const n = S.galleryItems.length;
  const urls = [];
  // 2 atrás + foto actual + 5 à frente
  for (let i = -2; i <= 5; i++) {
    const item = S.galleryItems[(idx + i + n) % n];
    if (item) urls.push(dav(item.path));
  }
  navigator.serviceWorker.controller.postMessage({ type: 'CACHE_PHOTOS', urls });
}
function galleryGoTo(i) {
  const d = i > S.galleryIdx ? 1 : -1;
  S.galleryIdx = i;
  renderGallery(d > 0 ? 'left' : 'right');
}

function galleryZoomToggle() {
  S.galleryZoom = S.galleryZoom > 1 ? 1 : 2.5;
  const img = document.getElementById('gallery-img');
  img.style.transform = `scale(${S.galleryZoom})`;
  img.classList.toggle('zoomed', S.galleryZoom > 1);
}
document.addEventListener('DOMContentLoaded', () => {
  const galleryImg = document.getElementById('gallery-img');
  if (galleryImg) {
    galleryImg.addEventListener('dblclick', galleryZoomToggle);
    galleryImg.addEventListener('click', e => { if (S.galleryZoom > 1) galleryZoomToggle(); });
  }
});

function closeGallery() {
  _cancelGallery(); // cancela fetches pendentes da galeria
  document.getElementById('gallery-ov').classList.remove('show');
  document.getElementById('gallery-img').src = '';
}

// ─── SLIDESHOW ────────────────────────────────────────────────────────────────
const SS = { items:[], idx:0, interval:null, speed:5000, paused:false, showInfo:false, isVideo:false, fetchAbort:null };

// ─── VIDEO THUMBNAIL ─────────────────────────────────────────────────────────
const _vidThumbCache = new Map();
async function generateVideoThumb(el, path) {
  if (_vidThumbCache.has(path)) {
    const thumb = _vidThumbCache.get(path);
    if (el) el.outerHTML = `<img class="thumb" src="${thumb}" alt="">`;
    return;
  }
  try {
    const r = await fetch(dav(path), { headers: { 'Authorization': auth() } });
    if (!r.ok) return;
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.src = blobUrl; video.muted = true; video.preload = 'metadata';
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => { video.currentTime = Math.min(1, video.duration * 0.1); };
      video.onseeked = res; video.onerror = rej; setTimeout(rej, 8000);
    });
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 170;
    canvas.getContext('2d').drawImage(video, 0, 0, 300, 170);
    const thumbData = canvas.toDataURL('image/jpeg', 0.7);
    _vidThumbCache.set(path, thumbData);
    URL.revokeObjectURL(blobUrl);
    const current = el?.id ? document.getElementById(el.id) : null;
    if (current) current.outerHTML = `<img class="thumb" src="${thumbData}" alt="">`;
  } catch(e) { /* mantém ícone */ }
}

function startSlideshowFromFolder() {
  SS.items = S.lastItems.filter(it => !it.isDir && (isImg(it.name) || isVid(it.name)));
  if (!SS.items.length) { toast('Sem fotos ou vídeos nesta pasta.', 'err'); return; }
  SS.paused = false;
  // Restaura posição anterior se for a mesma pasta e recente (< 1 hora)
  let startIdx = 0;
  try {
    const saved = JSON.parse(localStorage.getItem('fc_ss_state') || '{}');
    const isRecent = saved.ts && (Date.now() - saved.ts) < 60 * 60 * 1000;
    const isSamePath = saved.path === S.path;
    if (isRecent && isSamePath && saved.idx > 0 && saved.idx < SS.items.length) {
      startIdx = saved.idx;
      if (saved.speed) SS.speed = saved.speed;
      toast(`▶️ A retomar do slide ${startIdx + 1}/${SS.items.length}`, '');
    }
  } catch(_) {}
  SS.idx = startIdx;
  document.getElementById('slideshow-ov').classList.add('show');
  const el = document.getElementById('slideshow-ov');
  if (el.requestFullscreen) el.requestFullscreen().catch(()=>{});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  ssShow(); ssPlay();
}

function startSlideshow() {
  SS.items = S.lastItems.filter(it => !it.isDir && (isImg(it.name) || isVid(it.name)));
  if (!SS.items.length) { toast('Sem fotos ou vídeos para slideshow.', 'err'); return; }
  SS.idx = S.galleryIdx || 0;
  SS.paused = false;
  closeGallery();
  document.getElementById('slideshow-ov').classList.add('show');
  const el = document.getElementById('slideshow-ov');
  if (el.requestFullscreen) el.requestFullscreen().catch(()=>{});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  ssShow();
  // ssPlay só se o primeiro item não for vídeo (ssShow já gere o interval para vídeos)
  if (!SS.items[SS.idx] || !isVid(SS.items[SS.idx].name)) ssPlay();
}

function ssShow() {
  const it = SS.items[SS.idx];
  if (!it) return;
  // Persiste posição do slideshow — retoma de onde ficou
  try {
    localStorage.setItem('fc_ss_state', JSON.stringify({
      path: S.path,
      idx: SS.idx,
      speed: SS.speed,
      ts: Date.now()
    }));
  } catch(_) {}
  const img = document.getElementById('ss-img');
  const vid = document.getElementById('ss-vid');
  SS.isVideo = isVid(it.name);

  document.getElementById('ss-counter').textContent = (SS.idx+1) + ' / ' + SS.items.length;
  document.getElementById('ss-title').textContent = it.name;
  document.getElementById('ss-sub').textContent = (SS.isVideo ? '🎬 ' : '🖼️ ') + (it.dateStr || '');

  const prog = document.getElementById('ss-prog');
  prog.style.transition = 'none'; prog.style.width = '0%';

  if (SS.isVideo) {
    img.style.display = 'none';
    vid.style.display = 'block';
    vid.style.opacity = '0';
    vid.pause();
    vid.src = '';
    if (SS.interval) { clearInterval(SS.interval); SS.interval = null; }

    // Loader discreto
    let ssLoader = document.getElementById('ss-loader');
    if (!ssLoader) {
      ssLoader = document.createElement('div');
      ssLoader.id = 'ss-loader';
      ssLoader.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:12px;color:rgba(255,255,255,.8);font-size:13px;pointer-events:none;';
      ssLoader.innerHTML = '<div class="spin" style="width:36px;height:36px;border-width:3px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></div><div id="ss-loader-txt">▶️ A iniciar vídeo...</div>';
      document.getElementById('slideshow-ov').appendChild(ssLoader);
    }
    ssLoader.style.display = 'flex';

    // ── STREAMING REAL via Service Worker ────────────────────
    // Sem download completo — reproduz imediatamente como YouTube
    // O SW intercepta /famcloud/stream?path=... e adiciona auth
    const swReady = 'serviceWorker' in navigator && navigator.serviceWorker.controller;
    if (swReady) {
      // Envia auth ao SW
      navigator.serviceWorker.controller.postMessage({ type: 'SET_AUTH', auth: auth() });
      // Usar S.server em vez de PROXY (minificado pelo Vite)
      const davPath = '/remote.php/dav/files/' + encodeURIComponent(S.user) + it.path;
      const streamUrl = `/famcloud/stream?path=${encodeURIComponent(davPath)}&proxy=${encodeURIComponent(S.server + '/nextcloud')}`;
      vid.src = streamUrl;
      vid.load();
      vid.oncanplay = () => {
        vid.style.opacity = '1';
        ssLoader.style.display = 'none';
        vid.play().catch(() => {});
        // Barra de progresso baseada na duração real
        const dur = vid.duration * 1000 || 60000;
        prog.style.transition = `width ${dur}ms linear`;
        prog.style.width = '100%';
      };
      vid.onended = () => {
        vid.src = '';
        if (!SS.paused) ssNext();
      };
      vid.onerror = () => {
        // Fallback para download se SW falhar
        ssLoader.querySelector('#ss-loader-txt').textContent = '⬇️ A descarregar...';
        _ssVideoFallback(it, vid, prog, ssLoader);
      };
    } else {
      // Sem SW — download progressivo (fallback)
      _ssVideoFallback(it, vid, prog, ssLoader);
    }
  } else {
    // Mostrar imagem, esconder vídeo
    vid.style.display = 'none';
    vid.pause(); vid.src = '';
    img.style.display = 'block';
    img.classList.add('fade');
    setTimeout(() => {
      authImg(img, dav(it.path));
      img.onload = () => img.classList.remove('fade');
      img.onerror = () => { img.classList.remove('fade'); ssNext(); };
    }, 300);
    // Barra de progresso normal para fotos
    setTimeout(() => {
      prog.style.transition = `width ${SS.speed}ms linear`;
      prog.style.width = '100%';
    }, 50);
    // Reactiva interval para fotos
    ssPlay();
  }
}


// Fallback de vídeo para slideshow (sem Service Worker)
function _ssVideoFallback(it, vid, prog, ssLoader) {
  const loaderTxt = ssLoader.querySelector('#ss-loader-txt') || ssLoader.querySelector('div:last-child');
  if (SS.fetchAbort) { SS.fetchAbort.abort(); }
  SS.fetchAbort = new AbortController();
  fetch(dav(it.path), {
    headers: { 'Authorization': auth() },
    signal: SS.fetchAbort.signal
  }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = parseInt(r.headers.get('content-length') || '0');
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return chunks;
      chunks.push(value);
      received += value.length;
      if (total && loaderTxt) {
        const pct = Math.round(received / total * 100);
        loaderTxt.textContent = `⬇️ ${pct}% — ${fmtSz(received)} / ${fmtSz(total)}`;
      }
      return pump();
    });
    return pump().then(() => new Blob(chunks));
  }).then(blob => {
    const blobUrl = URL.createObjectURL(blob);
    vid.src = blobUrl;
    vid.style.opacity = '1';
    if (ssLoader) ssLoader.style.display = 'none';
    vid.play().catch(() => {});
    vid.onended = () => { URL.revokeObjectURL(blobUrl); if (!SS.paused) ssNext(); };
    vid.onloadedmetadata = () => {
      const dur = vid.duration * 1000 || SS.speed;
      prog.style.transition = `width ${dur}ms linear`;
      prog.style.width = '100%';
    };
  }).catch(e => {
    if (e.name === 'AbortError') return;
    if (ssLoader) ssLoader.style.display = 'none';
    setTimeout(() => ssNext(), 2000);
  });
}

function ssPlay() {
  if (SS.interval) clearInterval(SS.interval);
  // Não inicia interval se o item actual for vídeo
  // Vídeos avançam automaticamente quando terminam (via vid.onended)
  const current = SS.items[SS.idx];
  if (current && isVid(current.name)) return;
  SS.interval = setInterval(ssNext, SS.speed);
}

function ssNext() {
  // Limpa vídeo actual se existir
  const vid = document.getElementById('ss-vid');
  if (vid && vid.src) { vid.pause(); URL.revokeObjectURL(vid.src); vid.src = ''; }
  SS.idx = (SS.idx + 1) % SS.items.length;
  ssShow();
}

function ssPause() {
  SS.paused = !SS.paused;
  const btn = document.getElementById('ss-pause-btn');
  if (SS.paused) {
    clearInterval(SS.interval);
    document.getElementById('ss-prog').style.transition = 'none';
    btn.textContent = '▶️ Continuar';
  } else {
    btn.textContent = '⏸ Pausar';
    const current = SS.items[SS.idx];
    if (current && isVid(current.name)) {
      // Vídeo — retoma o play do vídeo, não o interval
      const vid = document.getElementById('ss-vid');
      if (vid && vid.src) vid.play().catch(() => {});
    } else {
      ssShow(); ssPlay();
    }
  }
}

function ssSpeed() {
  const speeds = [3000, 5000, 8000, 12000];
  const labels = ['3s', '5s', '8s', '12s'];
  const cur = speeds.indexOf(SS.speed);
  const next = (cur + 1) % speeds.length;
  SS.speed = speeds[next];
  document.getElementById('ss-speed-btn').textContent = '⏱ ' + labels[next];
  if (!SS.paused) { ssPlay(); ssShow(); }
}

function ssInfo() {
  SS.showInfo = !SS.showInfo;
  document.getElementById('ss-info').style.display = SS.showInfo ? 'block' : 'none';
  document.getElementById('ss-info-btn').textContent = SS.showInfo ? 'ℹ️ Ocultar' : 'ℹ️ Info';
}

function closeSlideshow() {
  clearInterval(SS.interval); SS.interval = null;
  // Cancela download de vídeo em curso
  if (SS.fetchAbort) { SS.fetchAbort.abort(); SS.fetchAbort = null; }
  const vid = document.getElementById('ss-vid');
  if (vid) { vid.pause(); if (vid.src && vid.src.startsWith('blob:')) { URL.revokeObjectURL(vid.src); } vid.src = ''; }
  // Limpa todos os loaders — mesmo os criados durante _ssVideoFallback
  document.querySelectorAll('#ss-loader').forEach(el => el.remove());
  document.getElementById('slideshow-ov').classList.remove('show');
  if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}

// Touch swipe no slideshow
document.addEventListener('DOMContentLoaded', function() {
  let t0=0, tx=0;
  const el = document.getElementById('slideshow-ov');
  if (!el) return;
  el.addEventListener('touchstart', e => { t0=Date.now(); tx=e.touches[0].clientX; }, {passive:true});
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx)>60 && Date.now()-t0<400) {
      if (dx<0) ssNext();
      else { SS.idx=(SS.idx-1+SS.items.length)%SS.items.length; ssShow(); }
      if (!SS.paused) { clearInterval(SS.interval); ssPlay(); }
    }
  }, {passive:true});
});

// Touch swipe + pinch zoom
let _gTx = null, _gPd = null, _gBaseZoom = 1;
function setupGalleryTouch() {
  const v = document.getElementById('gallery-viewer');
  v.ontouchstart = e => {
    if (e.touches.length === 1) {
      _gTx = e.touches[0].clientX;
    }
    if (e.touches.length === 2) {
      // Captura distância INICIAL e zoom BASE — fórmula linear, sem acumulação exponencial
      _gPd = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _gBaseZoom = S.galleryZoom; // zoom no momento em que o pinch começa
    }
  };
  v.ontouchmove = e => {
    if (e.touches.length === 2 && _gPd) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      // Linear: zoom = baseZoom × (distânciaActual / distânciaInicial)
      // Sem multiplicar por S.galleryZoom — evita crescimento exponencial
      S.galleryZoom = Math.min(4, Math.max(1, _gBaseZoom * (d / _gPd)));
      const img = document.getElementById('gallery-img');
      img.style.transform = `scale(${S.galleryZoom})`;
      img.classList.toggle('zoomed', S.galleryZoom > 1.1);
    }
  };
  v.ontouchend = e => {
    if (_gTx !== null && e.changedTouches.length === 1 && S.galleryZoom <= 1) {
      const dx = e.changedTouches[0].clientX - _gTx;
      if (Math.abs(dx) > 60) galleryNav(dx < 0 ? 1 : -1);
    }
    _gTx = null; _gPd = null;
    // _gBaseZoom não reseta — mantém zoom actual como base para próximo pinch
  };
}

// ─── PDF VIEWER ───────────────────────────────────────────────────────────────
async function openPdf(p, nm) {
  S.pdfPath = p; S.pdfPageN = 1;
  document.getElementById('pdf-nm').textContent = nm;
  document.getElementById('pdf-dl-btn').onclick = () => dlF(p, nm);
  document.getElementById('pdf-ov').classList.add('show');
  document.getElementById('pdf-content').innerHTML = '<div class="loading" style="color:#aaa"><div class="spin"></div> A carregar PDF...</div>';
  try {
    if (!window.pdfjsLib) throw new Error('PDF.js não carregado');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const r = await fetch(dav(p), { headers:{'Authorization':auth()} });
    if (!r.ok) throw new Error('Erro HTTP '+r.status);
    S.pdfDoc = await pdfjsLib.getDocument({data: await r.arrayBuffer()}).promise;
    S.pdfTotal = S.pdfDoc.numPages;
    await renderPdfPage(1);
  } catch(e) {
    document.getElementById('pdf-content').innerHTML = `<div style="color:#ccc;padding:40px;text-align:center">Erro ao abrir PDF.<br><small>${e.message}</small></div>`;
  }
}

async function renderPdfPage(n) {
  if (!S.pdfDoc) return;
  S.pdfPageN = Math.max(1, Math.min(n, S.pdfTotal));
  document.getElementById('pdf-info').textContent = `${S.pdfPageN} / ${S.pdfTotal}`;
  const page = await S.pdfDoc.getPage(S.pdfPageN);
  const container = document.getElementById('pdf-content');
  const maxW = container.clientWidth - 32;
  const vp = page.getViewport({scale: Math.min(2.5, maxW / page.getViewport({scale:1}).width)});
  let canvas = container.querySelector('.pdf-canvas');
  if (!canvas) { canvas = document.createElement('canvas'); canvas.className='pdf-canvas'; container.innerHTML=''; container.appendChild(canvas); }
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
}

function pdfNav(d) { renderPdfPage(S.pdfPageN + d); }
function closePdf() { document.getElementById('pdf-ov').classList.remove('show'); S.pdfDoc = null; }

// ─── MEDIA (video/audio) ──────────────────────────────────────────────────────
// Referência ao player activo — só um de cada vez
let _activeMediaOverlay = null;

function openMedia(p, nm) {
  // Fechar player anterior se existir
  if (_activeMediaOverlay) {
    const prev = _activeMediaOverlay;
    _activeMediaOverlay = null;
    const prevMedia = prev.querySelector('video, audio');
    if (prevMedia) {
      prevMedia.pause();
      prevMedia.removeAttribute('src');
      prevMedia.load();
    }
    prev.remove();
  }

  const item = S.lastItems?.find(it => it.path === p);
  if (item) Recents.add(item);
  const ext = ex(nm);
  const isVideo = VE.includes(ext);

  // Criar overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px';

  // Título
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'color:rgba(255,255,255,.8);font-size:13px;font-weight:500;max-width:80vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  titleEl.textContent = nm;

  // Elemento de media
  const mediaEl = document.createElement(isVideo ? 'video' : 'audio');
  mediaEl.controls = true;
  mediaEl.autoplay = false; // não auto-play — esperar pelo load
  mediaEl.preload = 'metadata';
  mediaEl.playsInline = true;
  if (isVideo) {
    mediaEl.style.cssText = 'max-width:96vw;max-height:72vh;border-radius:8px;background:#000;';
  } else {
    mediaEl.style.cssText = 'width:90vw;margin-top:10px;';
  }

  // Loading indicator — criado ANTES de ser usado
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText = 'color:rgba(255,255,255,.7);font-size:13px;text-align:center;min-height:40px;display:flex;align-items:center;justify-content:center';
  const fileSzMB = Math.round((S.lastItems?.find(i=>i.path===p)?.size||0)/1024/1024);
  const loadMsg = fileSzMB > 50
    ? `<div class="spin" style="width:24px;height:24px;border-width:2.5px;border-color:rgba(255,255,255,.3);border-top-color:#fff;margin-right:8px"></div> A iniciar stream${fileSzMB>0?' ('+fileSzMB+'MB)':''}...`
    : '<div class="spin" style="width:24px;height:24px;border-width:2.5px;border-color:rgba(255,255,255,.3);border-top-color:#fff;margin-right:8px"></div> A carregar...';
  loadingEl.innerHTML = loadMsg;

  // ── CONTROLOS CUSTOMIZADOS ──────────────────────────────────
  const controls = document.createElement('div');
  controls.style.cssText = 'width:100%;max-width:96vw;display:flex;flex-direction:column;gap:8px;padding:0 4px';

  // Barra de progresso
  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'width:100%;height:6px;background:rgba(255,255,255,.2);border-radius:3px;cursor:pointer;touch-action:manipulation;position:relative';
  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'height:100%;width:0%;background:var(--primary,#4f46e5);border-radius:3px;pointer-events:none;transition:width .1s';
  const progressBuf = document.createElement('div');
  progressBuf.style.cssText = 'position:absolute;top:0;left:0;height:100%;width:0%;background:rgba(255,255,255,.15);border-radius:3px;pointer-events:none';
  progressWrap.appendChild(progressBuf);
  progressWrap.appendChild(progressFill);

  // Linha de botões
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';

  const mkBtn = (txt, title) => {
    const b = document.createElement('button');
    b.textContent = txt; b.title = title;
    b.style.cssText = 'padding:6px 10px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);border-radius:7px;color:#fff;font-size:13px;cursor:pointer;touch-action:manipulation;flex-shrink:0';
    return b;
  };

  const playBtn = mkBtn('▶️', 'Play/Pause (Espaço)');
  const timeEl = document.createElement('span');
  timeEl.style.cssText = 'color:rgba(255,255,255,.7);font-size:12px;flex:1;text-align:center;white-space:nowrap';
  timeEl.textContent = '0:00 / 0:00';
  const skipBk = mkBtn('⏪ 10s', 'Recuar 10s');
  const skipFw = mkBtn('10s ⏩', 'Avançar 10s');
  const speedBtn = mkBtn('1×', 'Velocidade');
  const volBtn = mkBtn('🔊', 'Volume');
  const fsBtn = mkBtn('⛶', 'Fullscreen');
  const dlBtn2 = mkBtn('⬇️', 'Download');
  const closeBtn = mkBtn('✕', 'Fechar');
  closeBtn.style.cssText += ';background:rgba(200,50,50,.4)';

  btnRow.append(playBtn, skipBk, skipFw, speedBtn, volBtn, fsBtn, dlBtn2, closeBtn);
  controls.append(progressWrap, btnRow);

  // Montar overlay
  overlay.appendChild(titleEl);
  overlay.appendChild(mediaEl);
  overlay.appendChild(loadingEl);
  if (isVideo) overlay.appendChild(controls);
  else overlay.appendChild(btnRow); // áudio: só botões
  document.body.appendChild(overlay);
  _activeMediaOverlay = overlay;

  // ── LÓGICA DOS CONTROLOS ─────────────────────────────────────
  const fmt = s => { const m=Math.floor(s/60); return m+':'+(Math.floor(s%60)+'').padStart(2,'0'); };
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let speedIdx = 2;

  mediaEl.ontimeupdate = () => {
    if (!mediaEl.duration) return;
    const pct = mediaEl.currentTime / mediaEl.duration * 100;
    progressFill.style.width = pct + '%';
    timeEl.textContent = fmt(mediaEl.currentTime) + ' / ' + fmt(mediaEl.duration);
  };
  mediaEl.onprogress = () => {
    if (!mediaEl.duration || !mediaEl.buffered.length) return;
    progressBuf.style.width = (mediaEl.buffered.end(mediaEl.buffered.length-1) / mediaEl.duration * 100) + '%';
  };
  mediaEl.onplay = () => { playBtn.textContent = '⏸️'; };
  mediaEl.onpause = () => { playBtn.textContent = '▶️'; };
  mediaEl.oncanplay = () => { loadingEl.style.display = 'none'; };

  playBtn.onclick = () => mediaEl.paused ? mediaEl.play() : mediaEl.pause();
  skipBk.onclick = () => { mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 10); };
  skipFw.onclick = () => { mediaEl.currentTime = Math.min(mediaEl.duration||0, mediaEl.currentTime + 10); };
  speedBtn.onclick = () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    mediaEl.playbackRate = speeds[speedIdx];
    speedBtn.textContent = speeds[speedIdx] + '×';
  };
  volBtn.onclick = () => {
    mediaEl.muted = !mediaEl.muted;
    volBtn.textContent = mediaEl.muted ? '🔇' : '🔊';
  };
  fsBtn.onclick = () => {
    const el = overlay;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
    } else {
      document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    }
  };
  dlBtn2.onclick = () => dlF(p, nm);

  // Seek na barra de progresso
  const seekTo = (e) => {
    if (!mediaEl.duration) return;
    const rect = progressWrap.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    mediaEl.currentTime = Math.max(0, Math.min(1, x / rect.width)) * mediaEl.duration;
  };
  progressWrap.addEventListener('click', seekTo);
  progressWrap.addEventListener('touchend', seekTo, {passive:true});

  // Fechar
  const doClose = () => {
    mediaEl.pause();
    mediaEl.removeAttribute('src');
    mediaEl.load();
    if (mediaEl._blobUrl) { URL.revokeObjectURL(mediaEl._blobUrl); mediaEl._blobUrl = null; }
    if (_activeMediaOverlay === overlay) _activeMediaOverlay = null;
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  closeBtn.onclick = doClose;
  overlay.onclick = (e) => { if (e.target === overlay) doClose(); };

  // Keyboard shortcuts
  const escHandler = (e) => {
    if (e.key === 'Escape') doClose();
    else if (e.key === ' ') { e.preventDefault(); mediaEl.paused ? mediaEl.play() : mediaEl.pause(); }
    else if (e.key === 'ArrowLeft') mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 10);
    else if (e.key === 'ArrowRight') mediaEl.currentTime = Math.min(mediaEl.duration||0, mediaEl.currentTime + 10);
    else if (e.key === 'f') fsBtn?.click();
    else if (e.key === 'm') volBtn?.click();
  };
  document.addEventListener('keydown', escHandler);

  // Carregar o vídeo
  // Se há upload activo, não usar SW stream (evita competição por conexões HTTP)
  const hasActiveUpload = UPQ.jobs.some(j => j.status === 'run');
  // SW disponível: precisa de estar activo E registado (não apenas 'in navigator')
  // Na primeira visita ou após update do SW, controller é null
  const swAvailable = isVideo && !hasActiveUpload &&
    'serviceWorker' in navigator &&
    navigator.serviceWorker.controller?.state !== 'redundant' &&
    !!navigator.serviceWorker.controller;

  if (swAvailable) {
    // Streaming via SW — sem download completo, seek nativo
    navigator.serviceWorker.controller.postMessage({ type: 'SET_AUTH', auth: auth() });
    const davPath = '/remote.php/dav/files/' + encodeURIComponent(S.user) + p;
    const streamUrl = '/famcloud/stream?path=' + encodeURIComponent(davPath) + '&proxy=' + encodeURIComponent(S.server + '/nextcloud');
    mediaEl.src = streamUrl;
    mediaEl.load();
    mediaEl.oncanplay = () => {
      loadingEl.style.display = 'none';
      mediaEl.play().catch(() => {});
    };
    mediaEl.onerror = () => {
      // Fallback para download directo
      _mediaFallbackLoad(mediaEl, loadingEl, p, nm);
    };
  } else if (isVideo) {
    // Fallback: download progressivo
    _mediaFallbackLoad(mediaEl, loadingEl, p, nm);
  } else {
    // Áudio — stream directo funciona
    const davPath = '/remote.php/dav/files/' + encodeURIComponent(S.user) + p;
    mediaEl.src = S.server + '/nextcloud' + davPath;
    mediaEl.setRequestHeader = undefined; // não existe em audio — usar fetch wrapper
    // Para áudio usa fetch com auth
    _mediaFallbackLoad(mediaEl, loadingEl, p, nm);
  }
}

async function _mediaFallbackLoad(mediaEl, loadingEl, p, nm) {
  try {
    const r = await fetch(S.server + '/nextcloud/remote.php/dav/files/' + encodeURIComponent(S.user) + p, {
      headers: { 'Authorization': auth() }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = parseInt(r.headers.get('content-length') || '0');
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        const pct = Math.round(received / total * 100);
        loadingEl.innerHTML = pct + '% — ' + fmtSz(received) + ' / ' + fmtSz(total);
      } else {
        loadingEl.textContent = fmtSz(received) + ' carregados...';
      }
    }
    const blob = new Blob(chunks);
    const blobUrl = URL.createObjectURL(blob);
    mediaEl.src = blobUrl;
    mediaEl._blobUrl = blobUrl;
    mediaEl.onended = () => { URL.revokeObjectURL(blobUrl); mediaEl._blobUrl = null; };
    loadingEl.style.display = 'none';
    mediaEl.play().catch(() => {});
  } catch(e) {
    loadingEl.textContent = '❌ ' + e.message;
  }
}


// ─── SHARE ────────────────────────────────────────────────────────────────────
// Partilha activa — para editar/eliminar
let _activeShare = null;

async function shareItem(p, nm) {
  _activeShare = { p, nm };
  document.getElementById('share-desc').textContent = 'Partilhar "' + nm + '"';
  document.getElementById('share-content').innerHTML = _shareUI();
  showM('share');
  // Verifica se já existe partilha para este ficheiro
  _loadExistingShares(p);
}

function _shareUI() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24*60*60*1000).toISOString().split('T')[0];
  const in7d = new Date(now.getTime() + 7*24*60*60*1000).toISOString().split('T')[0];
  const in30d = new Date(now.getTime() + 30*24*60*60*1000).toISOString().split('T')[0];

  return `
    <div id="share-existing" style="margin-bottom:14px"></div>
    <div style="background:var(--bg2);border-radius:12px;padding:14px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Novo link</div>
      <span class="slbl">Expiração</span>
      <div class="share-expiry-row">
        <button class="share-exp-btn active" data-days="1" onclick="window.setShareExpiry(this,'${tomorrow}')">24h</button>
        <button class="share-exp-btn" data-days="7" onclick="window.setShareExpiry(this,'${in7d}')">7 dias</button>
        <button class="share-exp-btn" data-days="30" onclick="window.setShareExpiry(this,'${in30d}')">30 dias</button>
        <button class="share-exp-btn" data-days="0" onclick="window.setShareExpiry(this,'')">Sem limite</button>
      </div>
      <span class="slbl" style="margin-top:10px;display:block">Palavra-passe (opcional)</span>
      <input class="mi" type="password" id="share-pw" placeholder="Proteger com password" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="share-editable" style="width:16px;height:16px">
        <label for="share-editable" style="font-size:13px;color:var(--text2)">Permitir edição/upload</label>
      </div>
      <button class="btn btn-p" style="width:100%;justify-content:center" onclick="window.createShare()">
        🔗 Criar link
      </button>
    </div>
    <div id="share-result"></div>`;
}

// Data de expiração seleccionada
let _shareExpiry = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];

function setShareExpiry(btn, date) {
  _shareExpiry = date;
  document.querySelectorAll('.share-exp-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function createShare() {
  if (!_activeShare) return;
  const btn = document.querySelector('#share-content .btn-p');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ A criar...'; }

  try {
    const params = new URLSearchParams();
    params.append('path', _activeShare.p.replace(/\/$/,''));
    params.append('shareType', '3'); // link público
    params.append('permissions', document.getElementById('share-editable')?.checked ? '7' : '1');
    if (_shareExpiry) params.append('expireDate', _shareExpiry);
    const pw = document.getElementById('share-pw')?.value;
    if (pw) params.append('password', pw);

    const r = await fetch(PROXY+'/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares', {
      method: 'POST',
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const txt = await r.text();
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const token = doc.querySelector('token')?.textContent;
    const url = doc.querySelector('url')?.textContent;

    if (!token && !url) {
      const code = doc.querySelector('statuscode')?.textContent;
      throw new Error(code === '403' ? 'Sem permissão' : 'Erro ' + code);
    }

    const shareUrl = url || `${NC}/index.php/s/${token}`;
    const expiryTxt = _shareExpiry
      ? `Expira em ${new Date(_shareExpiry).toLocaleDateString('pt-PT')}`
      : 'Sem expiração';

    document.getElementById('share-result').innerHTML = `
      <div style="background:rgba(5,150,105,.08);border:1.5px solid rgba(5,150,105,.2);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">✅ Link criado · ${expiryTxt}${pw?' · 🔒 Com password':''}</div>
        <div class="share-link-box" style="margin-bottom:8px">
          <input type="text" id="share-url-inp" value="${shareUrl}" readonly>
          <button onclick="window.copyShareLink()">Copiar</button>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-s" style="flex:1;justify-content:center;font-size:12px" onclick="window.nativeShareLink('${shareUrl}','${hesc(_activeShare.nm)}')">📤 Partilhar</button>
          <button class="btn btn-red" style="flex:1;justify-content:center;font-size:12px" onclick="window.deleteShare('${token}')">🗑️ Revogar</button>
        </div>
      </div>`;

    // Recarrega lista de partilhas
    _loadExistingShares(_activeShare.p);

  } catch(e) {
    document.getElementById('share-result').innerHTML =
      `<div style="color:var(--red);font-size:13px;padding:12px;background:#fef2f0;border-radius:10px">❌ ${e.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Criar link'; }
  }
}

async function _loadExistingShares(path) {
  const el = document.getElementById('share-existing');
  if (!el) return;
  try {
    const r = await fetch(
      PROXY + '/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares?path=' + encodeURIComponent(path.replace(/\/$/,'')),
      { headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' } }
    );
    if (!r.ok) return;
    const txt = await r.text();
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const shares = [...doc.querySelectorAll('element')].filter(s =>
      s.querySelector('share_type')?.textContent === '3'
    );
    if (!shares.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">
        Links activos (${shares.length})
      </div>
      ${shares.map(s => {
        const token = s.querySelector('token')?.textContent || '';
        const url = s.querySelector('url')?.textContent || `${NC}/index.php/s/${token}`;
        const exp = s.querySelector('expiration')?.textContent;
        const hasPass = s.querySelector('share_with')?.textContent;
        const expTxt = exp ? `⏰ ${new Date(exp).toLocaleDateString('pt-PT')}` : '∞ Sem limite';
        return `<div class="share-active-row">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${url}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${expTxt}${hasPass?' · 🔒':''}</div>
          </div>
          <button class="btn btn-s" style="padding:5px 10px;font-size:11px;flex-shrink:0" onclick="navigator.clipboard.writeText('${url}').then(()=>window.toast('Copiado!','ok'))">📋</button>
          <button class="btn btn-red" style="padding:5px 10px;font-size:11px;flex-shrink:0" onclick="window.deleteShare('${token}')">🗑️</button>
        </div>`;
      }).join('')}`;
  } catch(e) { Logger.warn('_loadExistingShares', e?.message); }
}

async function deleteShare(token) {
  if (!confirm('Revogar este link? Quem tiver o link deixa de conseguir aceder.')) return;
  try {
    await fetch(PROXY + '/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares/' + token, {
      method: 'DELETE',
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' }
    });
    toast('✅ Link revogado!', 'ok');
    if (_activeShare) _loadExistingShares(_activeShare.p);
    document.getElementById('share-result').innerHTML = '';
  } catch(e) { toast('Erro ao revogar', 'err'); }
}

async function nativeShareLink(url, name) {
  if (navigator.share) {
    try { await navigator.share({ url, title: name }); } catch(e) { if (e?.name !== 'AbortError') handleError('share', e, true); }
  } else {
    navigator.clipboard.writeText(url).then(() => toast('Link copiado!', 'ok'));
  }
}

function copyShareLink() {
  const inp = document.getElementById('share-url-inp');
  if (!inp) return;
  navigator.clipboard.writeText(inp.value)
    .then(() => toast('Link copiado!', 'ok'))
    .catch(() => { inp.select(); document.execCommand('copy'); toast('Link copiado!', 'ok'); });
}

// ─── GLOBAL SEARCH ────────────────────────────────────────────────────────────
function openSearch() {
  document.getElementById('search-ov').classList.add('show');
  setTimeout(() => document.getElementById('search-inp').focus(), 80);
}
function closeSearch() {
  document.getElementById('search-ov').classList.remove('show');
  document.getElementById('search-inp').value = '';
  document.getElementById('search-results').innerHTML = '<div class="sr-hint">Escreve para pesquisar em todos os ficheiros</div>';
}

function schedSearch(q) {
  clearTimeout(S.searchTimer);
  if (!q || q.length < 2) {
    document.getElementById('search-results').innerHTML='<div class="sr-hint">Escreve pelo menos 2 caracteres · Ctrl+K para abrir</div>';
    return;
  }
  // Mostra resultados locais IMEDIATAMENTE (< 1ms)
  const localResults = _idxSearch(q);
  if (localResults.length > 0) {
    renderSearchResults(localResults, q, true);
    // Adiciona indicador de que está a pesquisar no servidor
    const el = document.getElementById('search-results');
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px 16px;font-size:11px;color:var(--text3);display:flex;align-items:center;gap:6px;border-top:1px solid var(--border)';
    hint.innerHTML = '<div class="spin" style="width:10px;height:10px;border-width:1.5px"></div> A pesquisar no servidor...';
    el.appendChild(hint);
  } else {
    document.getElementById('search-results').innerHTML = '<div class="sr-loading" style="padding:32px;text-align:center"><div class="spin" style="margin:auto"></div></div>';
  }
  S.searchTimer = setTimeout(() => execSearch(q), 400);
}

async function execSearch(q) {
  try {
    // DASL WebDAV search
    const body = `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:select>
    <d:from><d:scope><d:href>${PROXY}/nextcloud/remote.php/dav/files/${encodeURIComponent(S.user)}/</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>%${q}%</d:literal></d:like></d:where>
    <d:orderby><d:order><d:prop><d:displayname/></d:prop><d:ascending/></d:order></d:orderby>
    <d:limit><d:nresults>50</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/files/'+encodeURIComponent(S.user)+'/', {
      method: 'SEARCH',
      headers: { 'Authorization': auth(), 'Content-Type': 'application/xml', 'Depth': 'infinity' },
      body
    });
    if (r.status === 501 || r.status === 405) throw new Error('SEARCH not supported');
    if (!r.ok) throw new Error('SEARCH not supported');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const results = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (!rel || rel === '/') return;
      const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
      if (!nm || nm.startsWith('.') || HIDDEN.includes(nm)) return;
      const isDir = resp.querySelector('resourcetype collection') !== null;
      const size  = parseInt(resp.querySelector('getcontentlength')?.textContent||'0')||0;
      const fpath = isDir ? (rel.endsWith('/')?rel:rel+'/') : rel;
      const parent = rel.replace(/\/$/,'').split('/').slice(0,-1).join('/') || '/';
      results.push({name:nm, path:fpath, isDir, size, parent});
    });
    renderSearchResults(results, q);
  } catch(e) {
    // Fallback: search current folder items
    const results = S.lastItems.filter(it => it.name.toLowerCase().includes(q.toLowerCase()));
    renderSearchResults(results, q, true);
  }
}

function renderSearchResults(results, q, local=false) {
  const el = document.getElementById('search-results');
  if (!results.length) {
    el.innerHTML = `<div class="sr-empty">Nenhum resultado para "${q}"${local?'<br><small>(pesquisa local)</small>':''}</div>`;
    return;
  }
  const _q = document.getElementById('search-inp')?.value || '';
  el.innerHTML = (local ? `<div style="padding:6px 16px;font-size:11px;color:var(--text2);background:var(--bg2)">⚠️ A pesquisar no índice local — ${_searchIdx.size} itens indexados</div>` : '') +
    results.map(it => `
      <div class="sr-item" onclick="window.srClick('${esc(it.path)}',${it.isDir},'${esc(it.name)}')">
        <span style="font-size:18px;flex-shrink:0">${it.isDir?'📁':fIcon(it.name)}</span>
        <div style="min-width:0;flex:1">
          <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_highlightTerm(it.name, _q)}</div>
          <div class="sr-path">${hesc(it.parent || '/')}</div>
        </div>
        <span style="font-size:12px;color:var(--text2);flex-shrink:0">${it.size?fmtSz(it.size):''}</span>
      </div>`).join('');
}

function srClick(p, isDir, nm) {
  closeSearch();
  if (isDir) { navTo(p); }
  else if (isImg(nm)) { openGallery(p); }
  else if (isPdf(nm)) { openPdf(p, nm); }
  else if (isVid(nm) || isAud(nm)) { openMedia(p, nm); }
  else { dlF(p, nm); }
}

// ─── TRASH ────────────────────────────────────────────────────────────────────
async function openTrash() {
  showM('trash');
  document.getElementById('trash-list').innerHTML = '<div class="loading"><div class="spin"></div></div>';
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/trashbin/'+encodeURIComponent(S.user)+'/', {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:displayname/><d:getcontentlength/><nc:trashbin-filename/><nc:trashbin-deletion-time/></d:prop></d:propfind>`
    });
    if (!r.ok) throw new Error('Lixo indisponível ('+r.status+')');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const items = [];
    xml.querySelectorAll('response').forEach(resp => {
      // Keep raw href for DELETE/MOVE requests, decode only for display/comparison
      const rawHref = resp.querySelector('href').textContent;
      const href = decodeURIComponent(rawHref);
      // Skip root — compare decoded (Anibal) not encoded (%41nibal)
      if (href.endsWith('/trashbin/'+S.user+'/') || href.endsWith('/trashbin/'+encodeURIComponent(S.user)+'/')) return;
      const fname = resp.querySelector('trashbin-filename')?.textContent || resp.querySelector('displayname')?.textContent || href.split('/').pop().replace(/\.\d+$/, '') || '';
      const dtime = resp.querySelector('trashbin-deletion-time')?.textContent || '';
      const date  = dtime ? new Date(parseInt(dtime)*1000).toLocaleDateString('pt-PT',{day:'2-digit',month:'2-digit',year:'numeric'}) : '';
      if (fname) items.push({fname, href: rawHref, date});
    });
    if (!items.length) {
      document.getElementById('trash-list').innerHTML = '<p style="text-align:center;padding:24px;color:var(--text2);font-size:14px">🎉 O lixo está vazio!</p>';
      return;
    }
    document.getElementById('trash-list').innerHTML = `
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">${items.length} item(ns)</div>
      <div class="trash-items">
        ${items.map(it=>`<div class="trash-row">
          <span class="trash-nm">${fIcon(it.fname)} ${it.fname}</span>
          <span class="trash-dt">${it.date||''}</span>
          <button class="trash-restore" onclick="window.restoreItem('${esc(it.href)}','${esc(it.fname)}')">↩️ Restaurar</button>
        </div>`).join('')}
      </div>`;
  } catch(e) {
    document.getElementById('trash-list').innerHTML = `<p style="text-align:center;padding:24px;color:var(--text2);font-size:13px">Não foi possível carregar o lixo.<br><small>${e.message}</small></p>`;
  }
}

async function restoreItem(rawHref, fname) {
  // rawHref is the original href from server (may or may not be encoded)
  // Prefix with /nextcloud if it's a relative path
  const full = rawHref.startsWith('http') ? rawHref :
               rawHref.startsWith('/nextcloud') ? rawHref : '/nextcloud' + rawHref;
  // Destination: /trashbin/user/restore/filename
  const dest = NC + '/remote.php/dav/trashbin/'+encodeURIComponent(S.user)+'/restore/'+encodeURIComponent(fname);
  try {
    const r = await fetch(full, { method:'MOVE', headers:{'Authorization':auth(),'Destination':dest,'Overwrite':'F'} });
    if (r.ok || r.status===201 || r.status===204) {
      toast(fname+' restaurado!', 'ok'); openTrash(); loadFiles(S.path);
    } else {
      toast('Erro ao restaurar ('+r.status+')', 'err');
    }
  } catch(e) { toast('Erro ao restaurar: '+e.message, 'err'); }
}

async function emptyTrash() {
  if (!confirm('Apagar PERMANENTEMENTE tudo no lixo?\n\nEsta acção é IRREVERSÍVEL.')) return;

  // Hetzner StorageShare não suporta DELETE na raiz do trashbin.
  // Solução: listar todos os itens e apagar um a um.
  const btn = document.querySelector('#trash-modal .btn-red');
  if (btn) { btn.textContent = '⏳ A esvaziar...'; btn.disabled = true; }

  try {
    // 1. Fetch all items in trash
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/trashbin/'+encodeURIComponent(S.user)+'/', {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`
    });

    if (!r.ok) throw new Error('Não foi possível listar o lixo ('+r.status+')');

    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const hrefs = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rawHref = resp.querySelector('href').textContent;
      const decoded = decodeURIComponent(rawHref);
      // Skip the trashbin root itself
      if (decoded.endsWith('/trashbin/'+S.user+'/') ||
          decoded.endsWith('/trashbin/'+encodeURIComponent(S.user)+'/')) return;
      hrefs.push(rawHref); // keep raw for DELETE request
    });

    if (!hrefs.length) {
      toast('O lixo já estava vazio.', 'ok');
      hideM('trash'); loadStorage();
      return;
    }

    // 2. Delete each item individually
    let deleted = 0, errors = 0;
    for (const rawHref of hrefs) {
      const fullUrl = rawHref.startsWith('http') ? rawHref :
                      rawHref.startsWith('/nextcloud') ? rawHref : '/nextcloud' + rawHref;
      try {
        const rd = await fetch(fullUrl, { method: 'DELETE', headers: { 'Authorization': auth() } });
        if (rd.ok || rd.status === 204 || rd.status === 404) deleted++;
        else {
 errors++; }
      } catch(e) { errors++; }
    }

    if (btn) { btn.textContent = '🗑️ Esvaziar tudo'; btn.disabled = false; }

    if (errors === 0) {
      toast(`Lixo esvaziado! ${deleted} item(ns) apagado(s) permanentemente.`, 'ok');
    } else {
      toast(`${deleted} apagado(s), ${errors} erro(s).`, errors > 0 ? 'err' : 'ok');
    }
    hideM('trash'); loadStorage();

  } catch(e) {
    if (btn) { btn.textContent = '🗑️ Esvaziar tudo'; btn.disabled = false; }
    toast('Erro ao esvaziar lixo: ' + e.message, 'err');
  }
}

// ─── ACTIVITY ─────────────────────────────────────────────────────────────────
async function openActivity() {
  showM('activity');
  document.getElementById('act-list').innerHTML = '<div class="loading"><div class="spin"></div></div>';
  try {
    const r = await fetch(PROXY+'/nextcloud/ocs/v2.php/apps/activity/api/v2/activity/all?limit=40&format=json', {
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' }
    });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const json = await r.json();
    const items = json.ocs?.data || [];
    if (!items.length) {
      document.getElementById('act-list').innerHTML = '<p style="color:var(--text2);font-size:13px;padding:16px;text-align:center">Sem actividade registada.</p>';
      return;
    }
    const icons = {'file_created':'📤','file_deleted':'🗑️','file_changed':'✏️','shared':'🔗','file_restored':'↩️','file_moved':'📦','comments':'💬'};
    document.getElementById('act-list').innerHTML = '<div style="max-height:380px;overflow-y:auto">' +
      items.map(it => `<div class="act-row">
        <div class="act-ic">${icons[it.type]||'📋'}</div>
        <div class="act-text"><strong>${it.user}</strong> ${it.subject}</div>
        <span class="act-time">${fmtDate(new Date(it.datetime))}</span>
      </div>`).join('') + '</div>';
  } catch(e) {
    document.getElementById('act-list').innerHTML = `<div style="color:var(--text2);font-size:13px;padding:20px;text-align:center">API de actividade não disponível neste servidor.<br><small>Activa a app "Activity" no Nextcloud.</small></div>`;
  }
}

// ─── QUOTA ────────────────────────────────────────────────────────────────────
async function openQuota() {
  showM('quota');
  document.getElementById('quota-list').innerHTML = '<div class="loading"><div class="spin"></div></div>';
  try {
    // Try admin endpoint
    const r = await fetch(PROXY+'/nextcloud/ocs/v2.php/cloud/users?format=json', {
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' }
    });
    if (!r.ok) throw new Error('Sem acesso admin');
    const json = await r.json();
    const users = json.ocs?.data?.users || [];
    if (!users.length) throw new Error('Sem utilizadores');
    const quotas = await Promise.all(users.map(async uid => {
      try {
        const r2 = await fetch(PROXY+`/nextcloud/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`, {
          headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' }
        });
        const j = await r2.json(); const d = j.ocs?.data;
        return { uid, used:d?.quota?.used||0, total:d?.quota?.total||-3, display:d?.displayname||uid };
      } catch(e) { return { uid, used:0, total:-3, display:uid }; }
    }));
    renderQuota(quotas);
  } catch(e) {
    // Own quota only
    try {
      const r = await fetch(PROXY+`/nextcloud/ocs/v2.php/cloud/users/${encodeURIComponent(S.user)}?format=json`, {
        headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true' }
      });
      const j = await r.json(); const d = j.ocs?.data;
      renderQuota([{ uid:S.user, used:d?.quota?.used||0, total:d?.quota?.total||-3, display:d?.displayname||S.user }], true);
    } catch(e2) {
      document.getElementById('quota-list').innerHTML = '<p style="color:var(--text2);font-size:13px;padding:16px">Não foi possível obter informação de quota.</p>';
    }
  }
}

function renderQuota(quotas, ownOnly=false) {
  document.getElementById('quota-list').innerHTML = (ownOnly ? '<p style="font-size:12px;color:var(--text2);margin-bottom:12px">Apenas a tua quota (sem permissão de admin)</p>' : '') +
    quotas.map(u => {
      const pct = u.total>0 ? Math.round(u.used/u.total*100) : 0;
      return `<div class="quota-row">
        <div class="quota-user">
          <div class="quota-av">${u.display.charAt(0).toUpperCase()}</div>
          <span style="font-weight:500;overflow:hidden;text-overflow:ellipsis">${u.display}</span>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text2);text-align:right">${fmtSz(u.used)} / ${u.total>0?fmtSz(u.total):'5 TB'}</div>
          ${u.total>0?`<div class="quota-bar-wrap"><div class="quota-bar-bg"><div class="quota-bar-fill" style="width:${pct}%"></div></div></div>`:''}
        </div>
      </div>`;
    }).join('');
}

// ─── PWA ──────────────────────────────────────────────────────────────────────
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); S.installPrompt = e;
  document.getElementById('install-btn').style.display = 'flex';
});
function installPWA() {
  if (S.installPrompt) { S.installPrompt.prompt(); S.installPrompt = null; }
  document.getElementById('install-btn').style.display = 'none';
}
window.addEventListener('appinstalled', () => { toast('FamCloud instalada! 🎉', 'ok'); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/famcloud/sw.js').catch(() => {}));
  // Recebe mensagem do SW quando volta online com uploads pendentes
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'BACKGROUND_SYNC') {
      checkUploadQueue();
    }
  });
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const inGallery = document.getElementById('gallery-ov').classList.contains('show');
  const inSS = document.getElementById('slideshow-ov').classList.contains('show');
  if (e.key === 'Escape') {
    if (inSS) { closeSlideshow(); return; }
    closeSearch(); closeGallery(); closePdf();
    document.querySelectorAll('.mov').forEach(m => m.style.display='none');
    if (S.selecting) clearSel();
  }
  if ((e.ctrlKey||e.metaKey) && e.key==='f') { e.preventDefault(); openSearch(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='a' && S.selecting) { e.preventDefault(); selAll(); }
  if (e.key==='Delete' && S.selecting && S.selected.size && !inGallery && !inSS) bulkDelete();
  if (e.key==='ArrowLeft'  && inGallery) galleryNav(-1);
  if (e.key==='ArrowRight' && inGallery) galleryNav(1);
  if (e.key===' ' && inSS) { e.preventDefault(); ssPause(); }
  if (e.key==='ArrowLeft'  && inSS) { SS.idx=(SS.idx-1+SS.items.length)%SS.items.length; ssShow(); }
  if (e.key==='ArrowRight' && inSS) ssNext();
  if (e.key==='Enter' && document.getElementById('login-screen').style.display !== 'none') doLogin();
});

// Click outside search closes it
document.addEventListener('DOMContentLoaded', () => {
  const searchOv = document.getElementById('search-ov');
  if (searchOv) searchOv.addEventListener('click', e => { if (e.target === searchOv) closeSearch(); });
});


// ══════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ══════════════════════════════════════════════════════════════
const TABS = ['files','recents','calendar','notes','weather'];
let currentTab = 'files';
let calLoaded = false, notesLoaded = false, wxLoaded = false;

function switchTab(tab) {
  currentTab = tab;
  TABS.forEach(t => {
    document.getElementById('sec-'+t)?.classList.toggle('active', t===tab);
    document.getElementById('bnt-'+t)?.classList.toggle('active', t===tab);
  });
  if (tab==='recents') {
    // Renderiza no contentor correcto
    const rl = document.getElementById('recents-list');
    if (rl) {
      const items = Recents.get();
      if (!items.length) {
        rl.innerHTML = '<div class="empty"><div class="ei">🕐</div><h3>Sem recentes</h3><p>Os ficheiros que abrires aparecem aqui.</p></div>';
      } else {
        S.lastItems = items.map(r => ({
          name:r.name, path:r.path, isDir:r.isDir,
          size:r.size||0,
          dateStr: r.accessedAt ? new Date(r.accessedAt).toLocaleDateString('pt-PT') : '',
          fileid:r.fileid||''
        }));
        // Renderiza directamente no recents-list
        const prev = S.view;
        const prevFl = document.getElementById('fl');
        const tempFl = rl;
        rl.innerHTML = (S.view==='grid')
          ? '<div class="fgrid">' + S.lastItems.map(card).join('') + '</div>'
          : '<div class="flist"><div class="lh"><span>Nome</span><span>Tamanho</span><span class="cd">Acedido</span><span>Ações</span></div>' + S.lastItems.map(row).join('') + '</div>';
        requestAnimationFrame(() => {
          rl.querySelectorAll('img[data-src]').forEach(img => _lazyObserver.observe(img));
        });
      }
    }
  }
  if (tab==='calendar' && !calLoaded) { calLoaded=true; loadCalendar(); }
  if (tab==='notes' && !notesLoaded) { notesLoaded=true; loadNotes(); }
  if (tab==='weather' && !wxLoaded)  { wxLoaded=true; loadWeather(); }
}

// ══════════════════════════════════════════════════════════════
// WEATHER — Open-Meteo (free, no API key)
// ══════════════════════════════════════════════════════════════
const WX_CODES = {
  0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️',
  45:'🌫️', 48:'🌫️',
  51:'🌦️', 53:'🌦️', 55:'🌧️',
  61:'🌧️', 63:'🌧️', 65:'🌧️',
  71:'🌨️', 73:'🌨️', 75:'❄️', 77:'🌨️',
  80:'🌦️', 81:'🌧️', 82:'⛈️',
  85:'🌨️', 86:'❄️',
  95:'⛈️', 96:'⛈️', 99:'⛈️'
};
const WX_DESC = {
  0:'Sol', 1:'Maioritariamente limpo', 2:'Parcialmente nublado', 3:'Nublado',
  45:'Nevoeiro', 48:'Nevoeiro gelado',
  51:'Chuviscos leves', 53:'Chuviscos', 55:'Chuviscos fortes',
  61:'Chuva leve', 63:'Chuva', 65:'Chuva forte',
  71:'Neve leve', 73:'Neve', 75:'Neve forte', 77:'Granizo',
  80:'Aguaceiros leves', 81:'Aguaceiros', 82:'Aguaceiros fortes',
  85:'Aguaceiros de neve', 86:'Aguaceiros de neve fortes',
  95:'Trovoada', 96:'Trovoada com granizo', 99:'Trovoada forte'
};

async function loadWeather() {
  const cityInp = document.getElementById('wx-city-inp');
  const city = cityInp?.value.trim() || 'Lisboa';
  const el = document.getElementById('wx-content');
  el.innerHTML = '<div class="loading"><div class="spin"></div> A obter clima para '+city+'...</div>';
  try {
    // Geocode city
    const geoR = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`);
    const geoJ = await geoR.json();
    if (!geoJ.results?.length) throw new Error('Cidade não encontrada: '+city);
    const {latitude:lat, longitude:lon, name, country} = geoJ.results[0];

    // Fetch weather
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,precipitation_probability,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
    const wxR = await fetch(wxUrl);
    const wx = await wxR.json();
    const cw = wx.current_weather;
    const code = cw.weathercode;
    const emoji = WX_CODES[code] || '🌡️';
    const desc = WX_DESC[code] || 'Desconhecido';
    const temp = Math.round(cw.temperature);
    const wind = Math.round(cw.windspeed);
    const isDay = cw.is_day;

    // Hourly (next 12h)
    const now = new Date();
    const currentHour = now.getHours();
    const hourly = wx.hourly;
    const hours = [];
    for (let i = currentHour; i < Math.min(currentHour+12, 24); i++) {
      hours.push({
        time: i+':00',
        temp: Math.round(hourly.temperature_2m[i]),
        code: hourly.weathercode[i],
        rain: hourly.precipitation_probability[i]||0
      });
    }

    el.innerHTML = `
      <div class="wx-card">
        <div class="wx-main">
          <div class="wx-emoji">${emoji}</div>
          <div class="wx-right">
            <div class="wx-temp">${temp}<sup>°C</sup></div>
            <div class="wx-desc">${desc}</div>
            <div class="wx-city">📍 ${name}, ${country}</div>
          </div>
        </div>
        <div class="wx-details">
          <div class="wx-det"><div class="wx-det-val">${wind} km/h</div><div class="wx-det-lbl">Vento</div></div>
          <div class="wx-det"><div class="wx-det-val">${wx.daily?.temperature_2m_max?.[0]??'-'}°</div><div class="wx-det-lbl">Máx</div></div>
          <div class="wx-det"><div class="wx-det-val">${wx.daily?.temperature_2m_min?.[0]??'-'}°</div><div class="wx-det-lbl">Mín</div></div>
          <div class="wx-det"><div class="wx-det-val">${wx.daily?.precipitation_probability_max?.[0]??0}%</div><div class="wx-det-lbl">Chuva</div></div>
        </div>
      </div>
      <div class="wx-hourly-wrap">
        <div class="wx-hourly-title">Próximas horas</div>
        <div class="wx-hourly-row">
          ${hours.map(h=>`<div class="wx-hour">
            <div class="wx-hour-time">${h.time}</div>
            <div class="wx-hour-ic">${WX_CODES[h.code]||'🌡️'}</div>
            <div class="wx-hour-temp">${h.temp}°</div>
            <div class="wx-hour-rain">${h.rain}%</div>
          </div>`).join('')}
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="empty"><div class="ei">🌡️</div><h3>Sem dados</h3><p>${e.message}</p></div>`;
  }
}

// ══════════════════════════════════════════════════════════════
// CALENDAR — CalDAV
// ══════════════════════════════════════════════════════════════
let calDate = new Date();
let calEvents = [];
let calCalendars = [];
let selEventForDel = null;

const CAL_COLORS = ['#e53935','#8e24aa','#1e88e5','#00897b','#43a047','#fb8c00','#f4511e','#6d4c41'];

function calNav(d) {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth()+d, 1);
  renderCalendar();
}

async function loadCalendar() {
  document.getElementById('cal-body').innerHTML = '<div class="loading"><div class="spin"></div> A carregar calendários...</div>';
  try {
    // 1. List calendars
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/calendars/'+encodeURIComponent(S.user)+'/', {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns">
        <d:prop><d:displayname/><oc:calendar-color/><cs:getctag/><cal:supported-calendar-component-set/></d:prop></d:propfind>`
    });
    if (!r.ok) throw new Error('CalDAV indisponível ('+r.status+')');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    calCalendars = [];
    xml.querySelectorAll('response').forEach(resp => {
      const href = resp.querySelector('href')?.textContent || '';
      if (href.endsWith('/'+encodeURIComponent(S.user)+'/')) return;
      if (!resp.querySelector('supported-calendar-component-set')) return;
      const comps = resp.querySelector('supported-calendar-component-set')?.textContent || '';
      if (!comps.includes('VEVENT') && !resp.querySelector('comp[name="VEVENT"]')) {
        // Check alternate way
        const compEls = resp.querySelectorAll('comp');
        let hasVevent = false;
        compEls.forEach(c => { if(c.getAttribute('name')==='VEVENT') hasVevent=true; });
        if (!hasVevent) return;
      }
      const nm = resp.querySelector('displayname')?.textContent || href.split('/').filter(Boolean).pop() || 'Calendário';
      const color = resp.querySelector('calendar-color')?.textContent?.substring(0,7) || CAL_COLORS[calCalendars.length % CAL_COLORS.length];
      calCalendars.push({ href, name:nm, color });
    });
    if (!calCalendars.length) {
      // Try simpler — personal calendar always exists
      calCalendars = [{ href: PROXY+'/nextcloud/remote.php/dav/calendars/'+S.user+'/personal/', name:'Pessoal', color:'#1e88e5' }];
    }
    await loadCalEvents();
  } catch(e) {
    document.getElementById('cal-body').innerHTML = `<div class="empty"><div class="ei">📅</div><h3>Calendário indisponível</h3><p>${e.message}</p></div>`;
  }
}

async function loadCalEvents() {
  calEvents = [];
  const year = calDate.getFullYear(), month = calDate.getMonth();
  const start = new Date(year, month, 1).toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  const end   = new Date(year, month+1, 0, 23, 59, 59).toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';

  for (const cal of calCalendars) {
    try {
      const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><d:getetag/><c:calendar-data/></d:prop>
        <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
          <c:time-range start="${start}" end="${end}"/>
        </c:comp-filter></c:comp-filter></c:filter>
      </c:calendar-query>`;
      const href = cal.href.startsWith('http') ? cal.href : PROXY+(cal.href.startsWith('/nextcloud') ? cal.href : '/nextcloud'+cal.href);
      const r = await fetch(href, { method:'REPORT', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'}, body });
      if (r.status === 501 || r.status === 405) throw new Error('REPORT not supported');
      if (!r.ok) continue;
      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      xml.querySelectorAll('response').forEach(resp => {
        const ical = resp.querySelector('calendar-data')?.textContent || '';
        if (!ical) return;
        const ev = parseVEvent(ical, cal, resp.querySelector('href')?.textContent || '');
        if (ev) calEvents.push(ev);
      });
    } catch(e) {}
  }
  renderCalendar();
}

function parseVEvent(ical, cal, evHref) {
  try {
    const get = (key) => {
      const m = ical.match(new RegExp(key+'(?:;[^:]*)?:([^\r\n]+)'));
      return m ? m[1].trim() : '';
    };
    const uid = get('UID');
    const summary = get('SUMMARY') || '(sem título)';
    const dtstart = get('DTSTART');
    const dtend = get('DTEND') || '';
    const description = get('DESCRIPTION') || '';
    if (!dtstart) return null;
    const parseDate = s => {
      if (s.length === 8) return new Date(s.substr(0,4)+'-'+s.substr(4,2)+'-'+s.substr(6,2)+'T00:00:00');
      const clean = s.replace(/Z$/,'');
      return new Date(clean.substr(0,4)+'-'+clean.substr(4,2)+'-'+clean.substr(6,2)+'T'+
        (clean.length>8?clean.substr(9,2)+':'+clean.substr(11,2)+':'+clean.substr(13,2):'00:00:00'));
    };
    const start = parseDate(dtstart);
    const end = dtend ? parseDate(dtend) : new Date(start.getTime()+3600000);
    const allDay = dtstart.length === 8;
    const timeStr = allDay ? 'Dia inteiro' :
      start.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})+' – '+end.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'});
    return { uid, summary, start, end, timeStr, allDay, description, calName:cal.name, color:cal.color, calHref:cal.href, evHref };
  } catch(e) { return null; }
}

function renderCalendar() {
  const year = calDate.getFullYear(), month = calDate.getMonth();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  document.getElementById('cal-month-lbl').textContent = months[month]+' '+year;

  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const startMon = (firstDay+6)%7; // Mon=0
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  // Populate event calendar selector
  const sel = document.getElementById('ev-cal-sel');
  if (sel && !sel.options.length) {
    calCalendars.forEach(c => {
      const opt = document.createElement('option'); opt.value=c.href; opt.textContent=c.name;
      sel.appendChild(opt);
    });
  }

  // Set today's date in event form
  const evDate = document.getElementById('ev-date');
  if (evDate && !evDate.value) evDate.value = today.toISOString().split('T')[0];

  // Render colour picker
  const colDiv = document.getElementById('ev-colors');
  if (colDiv && !colDiv.children.length) {
    CAL_COLORS.forEach((c,i) => {
      const d = document.createElement('div');
      d.className = 'ev-col'+(i===0?' sel':'');
      d.style.background = c; d.dataset.color = c;
      d.onclick = () => { document.querySelectorAll('.ev-col').forEach(x=>x.classList.remove('sel')); d.classList.add('sel'); };
      colDiv.appendChild(d);
    });
  }

  // Group events by day
  const evsByDay = {};
  calEvents.forEach(ev => {
    const d = ev.start.getDate();
    const m = ev.start.getMonth(); const y = ev.start.getFullYear();
    if (y===year && m===month) {
      if (!evsByDay[d]) evsByDay[d] = [];
      evsByDay[d].push(ev);
    }
  });

  // Build grid
  let grid = '<div class="cal-grid">';
  ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].forEach(d => { grid += `<div class="cal-dow">${d}</div>`; });

  // Days from previous month
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = startMon-1; i >= 0; i--) {
    grid += `<div class="cal-day other-month"><div class="cal-day-num">${prevDays-i}</div></div>`;
  }
  // This month
  for (let d = 1; d <= daysInMonth; d++) {
    const dayDate = new Date(year, month, d); dayDate.setHours(0,0,0,0);
    const isToday = dayDate.getTime()===today.getTime();
    const dayEvs = evsByDay[d] || [];
    const numLabel = isToday ? `<div class="cal-day-num"><span style="background:var(--primary);color:#fff;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800">${d}</span></div>` : `<div class="cal-day-num">${d}</div>`;
    const evHtml = dayEvs.slice(0,3).map(ev=>`<div class="cal-ev" style="background:${ev.color}" title="${ev.summary}">${ev.summary}</div>`).join('');
    const more = dayEvs.length>3 ? `<div style="font-size:9px;color:var(--text2)">+${dayEvs.length-3} mais</div>` : '';
    grid += `<div class="cal-day${isToday?' today':''}" onclick="window.calDayClick(${d},${month},${year})">${numLabel}${evHtml}${more}</div>`;
  }
  // Fill remaining
  const total = startMon + daysInMonth;
  const remaining = total%7===0 ? 0 : 7-total%7;
  for (let i = 1; i <= remaining; i++) { grid += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`; }
  grid += '</div>';

  // Events list for this month
  const sorted = [...calEvents].sort((a,b)=>a.start-b.start);
  const listHtml = sorted.length ? `
    <div class="cal-list-hd">Todos os eventos do mês (${sorted.length})</div>
    ${sorted.map(ev=>`<div class="cal-ev-row" onclick="">
      <div class="cal-ev-dot" style="background:${ev.color}"></div>
      <div class="cal-ev-info">
        <div class="cal-ev-title">${ev.summary}</div>
        <div class="cal-ev-time">${ev.start.toLocaleDateString('pt-PT',{day:'2-digit',month:'short'})} · ${ev.timeStr}</div>
      </div>
      <div class="cal-ev-cal">${ev.calName}</div>
      <button class="cal-ev-del" onclick="window.deleteEvent('${esc(ev.evHref)}','${esc(ev.calHref)}','${esc(ev.summary)}')" title="Apagar">🗑️</button>
    </div>`).join('')}` : '<div style="color:var(--text2);font-size:13px;text-align:center;padding:16px">Sem eventos este mês</div>';

  document.getElementById('cal-body').innerHTML = grid + listHtml;
}

function calDayClick(d, m, y) {
  // Pre-fill date in new event modal
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  document.getElementById('ev-date').value = dateStr;
  showM('newevent');
  setTimeout(()=>document.getElementById('ev-title').focus(), 80);
}

async function submitNewEvent() {
  const title = document.getElementById('ev-title').value.trim();
  const calHref = document.getElementById('ev-cal-sel').value;
  const date = document.getElementById('ev-date').value;
  const tstart = document.getElementById('ev-start').value || '09:00';
  const tend   = document.getElementById('ev-end').value || '10:00';
  const notes  = document.getElementById('ev-notes').value.trim();
  const color  = document.querySelector('.ev-col.sel')?.dataset.color || '#1e88e5';
  const errEl  = document.getElementById('ev-err');
  errEl.style.display='none';

  if (!title) { errEl.textContent='O título é obrigatório.'; errEl.style.display='block'; return; }
  if (!date)  { errEl.textContent='Escolhe uma data.'; errEl.style.display='block'; return; }
  if (!calHref) { errEl.textContent='Nenhum calendário disponível.'; errEl.style.display='block'; return; }

  const uid = 'fc-'+Date.now()+'-'+Math.random().toString(36).substr(2,9);
  const dtFmt = (d,t) => d.replace(/-/g,'')+'T'+t.replace(/:/g,'')+'00';
  const dtstart = dtFmt(date, tstart);
  const dtend   = dtFmt(date, tend);
  const now = new Date().toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';

  const CRLF = '\r\n';
  const icalLines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamCloud//EN',
    'BEGIN:VEVENT',
    'UID:'+uid+'@famcloud',
    'DTSTAMP:'+now,
    'DTSTART:'+dtstart,
    'DTEND:'+dtend,
    'SUMMARY:'+title.replace(/[\r\n]/g,' '),
  ];
  if (notes) icalLines.push('DESCRIPTION:'+notes.replace(/[\r\n]/g,' '));
  icalLines.push('END:VEVENT', 'END:VCALENDAR');
  const ical = icalLines.join(CRLF) + CRLF;

  const base = calHref.startsWith('http') ? calHref : PROXY+(calHref.startsWith('/nextcloud') ? calHref : '/nextcloud'+calHref);
  const url  = base.endsWith('/') ? base+uid+'.ics' : base+'/'+uid+'.ics';

  try {
    const r = await fetch(url, { method:'PUT', headers:{'Authorization':auth(),'Content-Type':'text/calendar; charset=utf-8','If-None-Match':'*'}, body:ical });
    if (r.ok || r.status===201 || r.status===204) {
      toast('Evento "'+title+'" criado! 🎉','ok');
      hideM('newevent');
      document.getElementById('ev-title').value='';
      document.getElementById('ev-notes').value='';
      await loadCalEvents();
    } else { errEl.textContent='Erro ao criar evento ('+r.status+')'; errEl.style.display='block'; }
  } catch(e) { errEl.textContent='Erro de ligação: '+e.message; errEl.style.display='block'; }
}

async function deleteEvent(evHref, calHref, title) {
  if (!confirm('Apagar o evento "'+title+'"?')) return;
  const url = evHref.startsWith('http') ? evHref : PROXY+(evHref.startsWith('/nextcloud') ? evHref : '/nextcloud'+evHref);
  try {
    const r = await fetch(url, { method:'DELETE', headers:{'Authorization':auth()} });
    if (r.ok || r.status===204 || r.status===404) { toast('Evento apagado.','ok'); loadCalEvents(); }
    else toast('Erro ao apagar evento ('+r.status+')','err');
  } catch(e) { toast('Erro ao apagar','err'); }
}

// ══════════════════════════════════════════════════════════════
// NOTES — Nextcloud Notes API
// ══════════════════════════════════════════════════════════════
let allNotes = [];
let currentNote = null;
let notesDirty = false;
let notesSaveTimer = null;

// ══════════════════════════════════════════════════════════════
// NOTES — WebDAV backend (sem app Notes — funciona sempre)
// Guarda notas como ficheiros .md em /FamCloud Notes/ no Nextcloud
// Formato: linha 1 = título, linha 2 = categoria:X, resto = conteúdo
// ══════════════════════════════════════════════════════════════
const NOTES_DIR = '/FamCloud%20Notes/';
const NOTES_DIR_RAW = '/FamCloud Notes/';

// Garante que a pasta existe
async function ensureNotesDir() {
  try {
    const r = await fetch(dav(NOTES_DIR_RAW), { method:'MKCOL', headers:{'Authorization':auth()} });
    return r.status === 201 || r.status === 405 || r.status === 200;
  } catch(e) { return false; }
}

// Serializa nota para texto
// Serializa nota para texto
function noteToText(title, content, category) {
  const safeTitle = (title || 'Sem título').split('\n').join(' ');
  const safeCat   = (category || '').split('\n').join(' ');
  return 'TITLE:' + safeTitle + '\n' +
         'CATEGORY:' + safeCat + '\n' +
         'MODIFIED:' + Math.floor(Date.now() / 1000) + '\n' +
         '---\n' +
         (content || '');
}

// Desserializa texto para nota
function textToNote(text, filename, path) {
  const rawLines = text.split('\n');
  let title = '', category = '', modified = 0, contentStart = 0;
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].startsWith('TITLE:'))    { title    = rawLines[i].slice(6).trim(); }
    else if (rawLines[i].startsWith('CATEGORY:')) { category = rawLines[i].slice(9).trim(); }
    else if (rawLines[i].startsWith('MODIFIED:')) { modified = parseInt(rawLines[i].slice(9)) || 0; }
    else if (rawLines[i] === '---')          { contentStart = i + 1; break; }
  }
  const content = rawLines.slice(contentStart).join('\n');
  return { id: filename, title, content, category, modified, path };
}

async function loadNotes() {
  document.getElementById('notes-list').innerHTML = '<div class="loading"><div class="spin"></div></div>';
  await ensureNotesDir();
  try {
    const r = await fetch(dav(NOTES_DIR_RAW), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>'
    });
    if (!r.ok) throw new Error('Erro ao abrir pasta de notas (' + r.status + ')');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const files = [];
    xml.querySelectorAll('response').forEach(resp => {
      const href = decodeURIComponent(resp.querySelector('href')?.textContent || '');
      const nm   = resp.querySelector('displayname')?.textContent || '';
      if (!nm.endsWith('.md') && !nm.endsWith('.txt')) return;
      const path = normPath(href);
      files.push({ nm, path });
    });

    // Fetch each file in parallel (max 20)
    const results = await Promise.all(
      files.slice(0, 20).map(async f => {
        try {
          const fr = await fetch(dav(f.path), { headers: { 'Authorization': auth() } });
          if (!fr.ok) return null;
          const text = await fr.text();
          return textToNote(text, f.nm, f.path);
        } catch(e) { return null; }
      })
    );
    allNotes = results.filter(Boolean);
    allNotes.sort((a, b) => b.modified - a.modified);
    renderNotesList(allNotes);
  } catch(e) {
    document.getElementById('notes-list').innerHTML =
      '<div style="padding:16px;font-size:13px;color:var(--text2);text-align:center">' + e.message + '</div>';
  }
}

function renderNotesList(notes) {
  const el = document.getElementById('notes-list');
  if (!notes.length) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text2);font-size:13px">Sem notas ainda.<br>Clica <strong>+</strong> para criar a primeira nota.</div>';
    return;
  }
  el.innerHTML = notes.map(n => {
    const preview = (n.content || '').replace(/[\r\n]+/g, ' ').trim().substring(0, 90) || 'Nota vazia';
    const date    = n.modified ? new Date(n.modified * 1000).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' }) : '';
    const catColor = n.category ? stringToColor(n.category) : '';
    return '<div class="note-item' + (currentNote && currentNote.id === n.id ? ' active' : '') + '" onclick="window.openNote(' + JSON.stringify(n.id) + ')">' +
      '<div class="note-item-title">' + (n.title || '(sem título)') + '</div>' +
      '<div class="note-item-preview">' + preview + '</div>' +
      '<div class="note-item-meta">' +
        '<span class="note-item-date">' + date + '</span>' +
        (n.category ? '<span class="note-item-cat" style="background:' + catColor + '20;color:' + catColor + '">' + n.category + '</span>' : '') +
      '</div></div>';
  }).join('');
}

function stringToColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return 'hsl(' + (Math.abs(h) % 360) + ',60%,45%)';
}

function filterNotes(q) {
  const lq = q.toLowerCase();
  const filtered = q ? allNotes.filter(n =>
    (n.title || '').toLowerCase().includes(lq) ||
    (n.content || '').toLowerCase().includes(lq) ||
    (n.category || '').toLowerCase().includes(lq)
  ) : allNotes;
  renderNotesList(filtered);
}

function openNote(id) {
  if (notesDirty) saveNote();
  currentNote = allNotes.find(n => n.id === id);
  if (!currentNote) return;
  document.getElementById('notes-empty').style.display = 'none';
  document.getElementById('notes-editor').style.display = 'flex';
  document.getElementById('notes-title').value   = currentNote.title || '';
  document.getElementById('notes-content').value = currentNote.content || '';
  document.getElementById('notes-cat').value     = currentNote.category || '';
  notesDirty = false;
  renderNotesList(allNotes);
  if (window.innerWidth <= 700) {
    document.getElementById('notes-section').classList.add('editing');
    document.getElementById('notes-back-btn').style.display = 'flex';
  }
}

function notesBack() {
  if (notesDirty) saveNote();
  document.getElementById('notes-section').classList.remove('editing');
  document.getElementById('notes-back-btn').style.display = 'none';
}

function noteChanged() {
  notesDirty = true;
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => { if (notesDirty) saveNote(); }, 2000);
}

async function saveNote() {
  if (!currentNote) return;
  const title    = document.getElementById('notes-title').value.trim() || 'Sem título';
  const content  = document.getElementById('notes-content').value;
  const category = document.getElementById('notes-cat').value.trim();
  notesDirty = false;
  const text = noteToText(title, content, category);
  try {
    const r = await fetch(dav(currentNote.path), {
      method: 'PUT',
      headers: { 'Authorization': auth(), 'Content-Type': 'text/markdown; charset=utf-8' },
      body: text
    });
    if (r.ok || r.status === 201 || r.status === 204) {
      // Update in-memory
      const mod = Math.floor(Date.now() / 1000);
      const idx = allNotes.findIndex(n => n.id === currentNote.id);
      if (idx >= 0) {
        allNotes[idx] = { ...allNotes[idx], title, content, category, modified: mod };
        currentNote = allNotes[idx];
      }
      allNotes.sort((a, b) => b.modified - a.modified);
      renderNotesList(allNotes);
      toast('Nota guardada ✓', 'ok');
    } else {
      toast('Erro ao guardar nota (' + r.status + ')', 'err');
    }
  } catch(e) { toast('Erro ao guardar: ' + e.message, 'err'); }
}

async function newNote() {
  if (notesDirty) await saveNote();
  await ensureNotesDir();
  const filename = 'nota-' + Date.now() + '.md';
  const path     = NOTES_DIR_RAW + filename;
  const text     = noteToText('Nova nota', '', '');
  try {
    const r = await fetch(dav(path), {
      method: 'PUT',
      headers: { 'Authorization': auth(), 'Content-Type': 'text/markdown; charset=utf-8' },
      body: text
    });
    if (r.ok || r.status === 201 || r.status === 204) {
      const note = textToNote(text, filename, path);
      allNotes.unshift(note);
      renderNotesList(allNotes);
      openNote(filename);
      setTimeout(() => {
        const ti = document.getElementById('notes-title');
        ti.focus(); ti.select();
      }, 100);
    } else { toast('Erro ao criar nota (' + r.status + ')', 'err'); }
  } catch(e) { toast('Erro ao criar nota: ' + e.message, 'err'); }
}

async function deleteNote() {
  if (!currentNote) return;
  if (!confirm('Apagar a nota "' + currentNote.title + '"?')) return;
  try {
    const r = await fetch(dav(currentNote.path), {
      method: 'DELETE', headers: { 'Authorization': auth() }
    });
    if (r.ok || r.status === 204 || r.status === 404) {
      toast('Nota apagada.', 'ok');
      allNotes = allNotes.filter(n => n.id !== currentNote.id);
      currentNote = null; notesDirty = false;
      document.getElementById('notes-empty').style.display = 'flex';
      document.getElementById('notes-editor').style.display = 'none';
      renderNotesList(allNotes);
      if (window.innerWidth <= 700) notesBack();
    } else { toast('Erro ao apagar nota (' + r.status + ')', 'err'); }
  } catch(e) { toast('Erro ao apagar: ' + e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════
// FILE VERSIONS — DAV versions API
// ══════════════════════════════════════════════════════════════
let versionsTarget = null;

async function openVersions(path, name, fileid) {
  versionsTarget = {path, name, fileid};
  document.getElementById('ver-fname').textContent = '📄 '+name;
  document.getElementById('ver-list').innerHTML = '<div class="loading"><div class="spin"></div></div>';
  showM('versions');
  if (!fileid) {
    document.getElementById('ver-list').innerHTML = '<p style="color:var(--text2);font-size:13px;padding:16px">ID do ficheiro não disponível.</p>';
    return;
  }
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/versions/'+encodeURIComponent(S.user)+'/versions/'+fileid+'/', {
      method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'},
      body:`<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`
    });
    if (!r.ok) throw new Error('Versões indisponíveis ('+r.status+')');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const versions = [];
    xml.querySelectorAll('response').forEach(resp => {
      const href = resp.querySelector('href')?.textContent || '';
      if (href.endsWith('/versions/'+fileid+'/') || href.endsWith('/versions/'+fileid)) return;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent||'0');
      const mod  = resp.querySelector('getlastmodified')?.textContent || '';
      const date = mod ? new Date(mod) : null;
      versions.push({href, size, date});
    });
    versions.sort((a,b) => b.date-a.date);
    if (!versions.length) {
      document.getElementById('ver-list').innerHTML = '<p style="color:var(--text2);font-size:13px;padding:16px;text-align:center">Sem versões guardadas ainda.<br><small>Versões são criadas automaticamente ao sobrescrever ficheiros.</small></p>';
      return;
    }
    document.getElementById('ver-list').innerHTML = `<div style="max-height:300px;overflow-y:auto"><p style="font-size:12px;color:var(--text2);margin-bottom:10px">${versions.length} versão(ões) guardada(s)</p>`+
      versions.map((v,i)=>`<div class="ver-row">
        <div class="ver-info">
          <div class="ver-date">${i===0?'⭐ Versão anterior · ':''}${v.date?fmtDate(v.date):'Data desconhecida'}</div>
          <div class="ver-size">${fmtSz(v.size)}</div>
        </div>
        <button class="ver-restore" onclick="window.restoreVersion('${esc(v.href)}','${esc(name)}')">↩️ Restaurar</button>
      </div>`).join('')+'</div>';
  } catch(e) {
    document.getElementById('ver-list').innerHTML = `<p style="color:var(--text2);font-size:13px;padding:16px;text-align:center">Erro: ${e.message}</p>`;
  }
}

async function restoreVersion(verHref, name) {
  if (!versionsTarget || !confirm('Restaurar esta versão de "'+name+'"? A versão actual será substituída.')) return;
  const src = verHref.startsWith('http') ? verHref : PROXY+(verHref.startsWith('/nextcloud') ? verHref : '/nextcloud'+verHref);
  const dest = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + versionsTarget.path;
  try {
    const r = await fetch(src, { method:'COPY', headers:{'Authorization':auth(),'Destination':dest,'Overwrite':'T'} });
    if (r.ok || r.status===201 || r.status===204) {
      toast('Versão de "'+name+'" restaurada! 🎉','ok'); hideM('versions'); loadFiles(S.path);
    } else { toast('Erro ao restaurar versão ('+r.status+')','err'); }
  } catch(e) { toast('Erro ao restaurar: '+e.message,'err'); }
}

// ══════════════════════════════════════════════════════════════
// TAGS — Nextcloud systemtags
// ══════════════════════════════════════════════════════════════
let tagsTarget = null;
let allSystemTags = [];
let fileTagIds = new Set();

async function openTags(path, name, fileid) {
  tagsTarget = {path, name, fileid};
  document.getElementById('tags-fname').textContent = '🏷️ Tags para: '+name;
  document.getElementById('tags-current').innerHTML = '<div class="spin" style="width:14px;height:14px;margin:8px auto"></div>';
  document.getElementById('tags-available').innerHTML = '';
  document.getElementById('tag-new-inp').value = '';
  showM('tags');

  try {
    // Load all system tags
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags/', {
      method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'},
      body:`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
        <d:prop><oc:id/><oc:display-name/><oc:user-visible/><oc:user-assignable/></d:prop></d:propfind>`
    });
    allSystemTags = [];
    if (r.ok) {
      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      xml.querySelectorAll('response').forEach(resp => {
        const tagId = resp.querySelector('id')?.textContent;
        const tagName = resp.querySelector('display-name')?.textContent;
        const visible = resp.querySelector('user-visible')?.textContent !== 'false';
        if (tagId && tagName && visible) allSystemTags.push({id:tagId, name:tagName});
      });
    }

    // Load tags for this file
    fileTagIds = new Set();
    if (fileid) {
      const r2 = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags-relations/files/'+fileid+'/', {
        method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'},
        body:`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:id/><oc:display-name/></d:prop></d:propfind>`
      });
      if (r2.ok) {
        const xml2 = new DOMParser().parseFromString(await r2.text(), 'text/xml');
        xml2.querySelectorAll('response').forEach(resp => {
          const tid = resp.querySelector('id')?.textContent;
          if (tid) fileTagIds.add(tid);
        });
      }
    }
    renderTagsModal();
  } catch(e) {
    document.getElementById('tags-current').innerHTML = '<p style="color:var(--text2);font-size:13px">Erro: '+e.message+'</p>';
  }
}

function renderTagsModal() {
  const current = allSystemTags.filter(t => fileTagIds.has(t.id));
  const available = allSystemTags.filter(t => !fileTagIds.has(t.id));
  const color = id => { const h = parseInt(id)*137%360; return `hsl(${h},55%,45%)`; };

  document.getElementById('tags-current').innerHTML = current.length
    ? current.map(t=>`<span class="tag-chip" style="background:${color(t.id)}20;color:${color(t.id)}" onclick="window.removeTag('${t.id}','${esc(t.name)}')">${t.name} <span class="tag-chip-x">✕</span></span>`).join('')
    : '<span style="font-size:12px;color:var(--text2);padding:6px">Sem tags ainda</span>';

  document.getElementById('tags-available').innerHTML = available.length
    ? available.map(t=>`<button class="tag-opt" style="color:${color(t.id)}" onclick="window.assignTag('${t.id}','${esc(t.name)}')">${t.name}</button>`).join('')
    : '<span style="font-size:12px;color:var(--text2)">Sem tags disponíveis</span>';
}

async function assignTag(tagId, tagName) {
  if (!tagsTarget?.fileid) { toast('ID do ficheiro não disponível','err'); return; }
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags-relations/files/'+tagsTarget.fileid+'/'+tagId, {
      method:'PUT', headers:{'Authorization':auth()}
    });
    if (r.ok || r.status===201 || r.status===204 || r.status===409) {
      fileTagIds.add(tagId); renderTagsModal(); toast('Tag "'+tagName+'" adicionada!','ok');
    } else { toast('Erro ao adicionar tag ('+r.status+')','err'); }
  } catch(e) { toast('Erro ao adicionar tag','err'); }
}

async function removeTag(tagId, tagName) {
  if (!tagsTarget?.fileid) return;
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags-relations/files/'+tagsTarget.fileid+'/'+tagId, {
      method:'DELETE', headers:{'Authorization':auth()}
    });
    if (r.ok || r.status===204 || r.status===404) {
      fileTagIds.delete(tagId); renderTagsModal(); toast('Tag "'+tagName+'" removida!','ok');
    } else { toast('Erro ao remover tag ('+r.status+')','err'); }
  } catch(e) { toast('Erro ao remover tag','err'); }
}

async function createAndAssignTag() {
  const name = document.getElementById('tag-new-inp').value.trim();
  if (!name) return;
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags/', {
      method:'POST', headers:{'Authorization':auth(),'Content-Type':'application/json'},
      body: JSON.stringify({ name, userVisible:true, userAssignable:true })
    });
    if (r.ok || r.status===201) {
      const loc = r.headers.get('Content-Location') || '';
      const newId = loc.split('/').pop() || String(Date.now());
      allSystemTags.push({id:newId, name});
      document.getElementById('tag-new-inp').value='';
      if (tagsTarget?.fileid) await assignTag(newId, name);
      else renderTagsModal();
    } else { toast('Erro ao criar tag ('+r.status+')','err'); }
  } catch(e) { toast('Erro ao criar tag','err'); }
}

// Tag filter in files view
let activeTagFilter = null;
async function openTagFilter() {
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags/', {
      method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'},
      body:`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:id/><oc:display-name/><oc:user-visible/></d:prop></d:propfind>`
    });
    if (!r.ok) throw new Error('Tags indisponíveis');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const tags = [];
    xml.querySelectorAll('response').forEach(resp => {
      const tid = resp.querySelector('id')?.textContent;
      const tnm = resp.querySelector('display-name')?.textContent;
      const vis = resp.querySelector('user-visible')?.textContent!=='false';
      if (tid && tnm && vis) tags.push({id:tid, name:tnm});
    });
    const strip = document.getElementById('tag-filter-strip');
    strip.innerHTML = '<span style="font-size:11px;font-weight:700;color:var(--text2);align-self:center">🏷️</span>'+
      tags.map(t=>`<span class="tag-chip" style="background:var(--bg2);color:var(--text);border:1.5px solid var(--border)" onclick="window.toggleTagFilter('${t.id}','${esc(t.name)}',this)">${t.name}</span>`).join('')+
      (activeTagFilter?`<button class="btn btn-g" style="padding:4px 10px;font-size:11px" onclick="clearTagFilter()">✕ Limpar</button>`:'');
    strip.classList.add('show');
  } catch(e) { toast('Erro ao carregar tags: '+e.message,'err'); }
}

function toggleTagFilter(tagId, tagName, el) {
  activeTagFilter = activeTagFilter===tagId ? null : tagId;
  document.querySelectorAll('#tag-filter-strip .tag-chip').forEach(c=>c.style.background='var(--bg2)');
  if (activeTagFilter) { el.style.background='var(--primary)'; el.style.color='#fff'; }
  if (!activeTagFilter) { clearTagFilter(); return; }
  toast('A filtrar por tag: '+tagName);
  // Note: full server-side tag filtering requires SEARCH or ocs endpoint
  // For now filter locally (shows only if already loaded in current folder)
  const filtered = S.lastItems.filter(it => {
    // We'd need fileid-tag mapping; show all and let user know
    return true;
  });
  // Better: navigate to tagged files via OCS
  loadTaggedFiles(tagId, tagName);
}

async function loadTaggedFiles(tagId, tagName) {
  document.getElementById('fl').innerHTML = '<div class="loading"><div class="spin"></div> A filtrar por tag "'+tagName+'"...</div>';
  try {
    const r = await fetch(PROXY+'/nextcloud/remote.php/dav/systemtags-relations/files/'+tagId+'/', {
      method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'1','Content-Type':'application/xml'},
      body:`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:d2="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>`
    });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const items = [];
    xml.querySelectorAll('response').forEach(resp => {
      const href = decodeURIComponent(resp.querySelector('href')?.textContent||'');
      if (href.endsWith('/'+tagId+'/')) return;
      const nm = resp.querySelector('displayname')?.textContent || href.split('/').pop()||'';
      if (!nm || HIDDEN.includes(nm)) return;
      const isDir = resp.querySelector('resourcetype collection')!==null;
      const size = parseInt(resp.querySelector('getcontentlength')?.textContent||'0')||0;
      const mod = resp.querySelector('getlastmodified')?.textContent||'';
      const date = mod?new Date(mod):new Date(0);
      items.push({name:nm, path:normPath(href), isDir, size, date, dateStr:fmtDate(date), fileid:''});
    });
    S.lastItems = items;
    renderFiles(items.length ? items : []);
    if (!items.length) document.getElementById('fl').innerHTML='<div class="empty"><div class="ei">🏷️</div><h3>Sem ficheiros com esta tag</h3><p>Adiciona tags aos ficheiros usando o botão 🏷️</p></div>';
  } catch(e) { document.getElementById('fl').innerHTML=`<div class="empty"><div class="ei">⚠️</div><h3>Erro</h3><p>${e.message}</p></div>`; }
}

function clearTagFilter() {
  activeTagFilter = null;
  document.getElementById('tag-filter-strip').classList.remove('show');
  document.getElementById('tag-filter-strip').innerHTML='';
  loadFiles(S.path);
}

// ─── SESSION RESTORE ──────────────────────────────────────────────────────────

// ── FAB UPLOAD ────────────────────────────────────────────────────────────────
function toggleFab() {
  const menu = document.getElementById('fab-menu');
  const btn  = document.getElementById('fab-main');
  const bd   = document.getElementById('fab-bd');
  const open = menu.classList.toggle('show');
  btn.classList.toggle('open', open);
  bd.classList.toggle('show', open);
}
function closeFab() {
  document.getElementById('fab-menu').classList.remove('show');
  document.getElementById('fab-main').classList.remove('open');
  document.getElementById('fab-bd').classList.remove('show');
}


// ── UPLOAD QUEUE PERSISTENTE (IndexedDB) ─────────────────────────────────────
const UQ = {
  db: null,

  async open() {
    if (this.db) return this.db;
    return new Promise((res, rej) => {
      const r = indexedDB.open('famcloud-uq', 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
          s.createIndex('status', 'status');
        }
      };
      r.onsuccess = e => { this.db = e.target.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },

  async add(file, destPath) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('queue', 'readwrite');
      const req = tx.objectStore('queue').add({
        name: file.name, type: file.type, size: file.size,
        destPath, status: 'pending', ts: Date.now()
      });
      req.onsuccess = () => res(req.result); // returns id
      req.onerror = () => rej(req.error);
    });
  },

  async setStatus(id, status) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (item) { item.status = status; store.put(item); }
        res();
      };
      getReq.onerror = () => rej(getReq.error);
    });
  },

  async getPending() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('queue', 'readonly');
      const req = tx.objectStore('queue').index('status').getAll('pending');
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  },

  async clearDone() {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      const req = store.index('status').openCursor(IDBKeyRange.only('done'));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); } else res();
      };
      req.onerror = () => res();
    });
  },

  async clearAll() {
    const db = await this.open();
    return new Promise(res => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').clear();
      tx.oncomplete = res;
    });
  }
};

// Verifica pendentes ao arrancar — limpa silenciosamente sem incomodar
async function checkUploadQueue() {
  try { await UQ.clearAll(); } catch(e) {}
}

function showResumeModal(pending) {}

window.addEventListener('load', () => {
  applyTheme(currentTheme);
  renderThemeDots();
  renderThemeGrid();
  restoreSession();
});

function restoreSession() {
  // sessionStorage (tab) → localStorage (PWA persistent) → show login
  // iOS PWA: sessionStorage está sempre vazia ao abrir — usar só localStorage
  const raw = localStorage.getItem('fc_cred');
  const isEncrypted = localStorage.getItem('fc_cred_enc') === '1';
  if (raw) {
    const loadCreds = async () => {
      try {
        let plaintext;
        if (isEncrypted) {
          plaintext = await decryptCred(raw);
        } else {
          // Legacy (não encriptado) — força re-login para migrar para AES-GCM
          // Limpa credenciais antigas sem expor ao utilizador
          localStorage.removeItem('fc_cred');
          showLogin();
          return;
        }
        if (!plaintext) throw new Error('decrypt failed');
        const parsed = JSON.parse(plaintext);
        if (parsed && parsed.user && typeof parsed.user === 'string' && parsed.pass && typeof parsed.pass === 'string') {
          S.server = PROXY; S.user = parsed.user; S.pass = parsed.pass;
          sessionStorage.setItem('fc', raw);
          initApp();
          if (new URLSearchParams(location.search).get('shared') === '1') {
            setTimeout(checkPendingShares, 1200);
          }
          return;
        }
      } catch(e) {
        Logger.error('Credential load failed', e.message);
        localStorage.removeItem('fc_cred');
        localStorage.removeItem('fc_cred_enc');
      }
      showLogin();
    };
    loadCreds().catch(() => { showLogin(); });
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
}

// ── SHARE TARGET: lê ficheiros do IndexedDB e faz upload ────────────────────
async function checkPendingShares() {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('famcloud-share', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('pending', { autoIncrement: true });
      r.onsuccess = e => res(e.target.result);
      r.onerror = () => rej(r.error);
    });

    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    const allReq = store.getAll();
    const allKeysReq = store.getAllKeys();

    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; allReq; allKeysReq; });

    const items = allReq.result || [];
    const keys  = allKeysReq.result || [];

    if (!items.length) return;

    // Mostra toast de confirmação
    const count = items.length;
    toast(`📥 ${count} ficheiro${count>1?'s':''} recebido${count>1?'s':''} — a carregar para a FamCloud...`);

    // Converte de volta para File objects e faz upload
    const files = items.map(item =>
      new File([item.data], item.name, { type: item.type })
    );
    await uploadFiles(files);

    // Limpa a fila do IndexedDB
    const tx2 = db.transaction('pending', 'readwrite');
    keys.forEach(k => tx2.objectStore('pending').delete(k));

    // Limpa o ?shared=1 do URL sem reload
    history.replaceState({}, '', location.pathname);
  } catch(e) {
  }
}

// iOS PWA: ao voltar ao primeiro plano (diagrama 1)
// Usa _origFetch com 45s timeout — servidor Hetzner frio pode demorar 20-30s
// NUNCA faz logout por timeout/rede — APENAS por HTTP 401 confirmado
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.user) return;

  // 1. Refresh de credenciais (AES decrypt) + envia auth ao SW
  await _refreshSession();

  // 2. PROPFIND de validação via _origFetch (sem timeout wrapper de 15s)
  const ctrl = new AbortController();
  const visTimer = setTimeout(() => ctrl.abort(), 45000); // 45s para servidor frio
  try {
    const r = await _origFetch(dav('/'), {
      method: 'PROPFIND',
      headers: { 'Authorization': auth(), 'Depth': '0' },
      signal: ctrl.signal
    });

    if (r.status === 401) {
      // Credenciais inválidas → tenta refresh e retry
      const refreshed = await _refreshSession();
      if (refreshed) {
        const r2 = await _origFetch(dav('/'), {
          method: 'PROPFIND',
          headers: { 'Authorization': auth(), 'Depth': '0' }
        });
        if (r2.status === 401) {
          toast('Sessão expirada. Volta a entrar.', 'err');
          setTimeout(doLogout, 1000);
        }
      } else {
        toast('Sessão expirada. Volta a entrar.', 'err');
        setTimeout(doLogout, 1000);
      }
    }
    // 207, 200, timeout, erro de rede → manter sessão, não fazer logout
  } catch(e) {
    // AbortError (timeout 45s) ou erro de rede → servidor frio ou offline
    // NÃO fazer logout — utilizador ainda tem sessão válida
    Logger.info('visibilitychange: timeout/offline, sessão mantida');
  } finally {
    clearTimeout(visTimer);
  }

  loadStorage();
});


// Pull-to-refresh removido — conflituava com scroll nativo no mobile
// O badge "↑ Actualizado" já serve o mesmo propósito sem conflito



// ─── EXPOSE TO GLOBAL SCOPE ───────────────────────────────────────────────
// Usa Object.assign para garantir que o Vite/Terser não optimiza as referências

function webShareCurrentFile() {
  if (!S.galleryItems || S.galleryIdx === undefined) return;
  const item = S.galleryItems[S.galleryIdx];
  if (item) webShareFile(item.path, item.name);
}

// Regista aliases _fc_ para o wrapper HTML
function _registerFcFunctions(fns) {
  Object.keys(fns).forEach(k => { window['_fc_' + k] = fns[k]; });
}

Object.assign(globalThis, {
  coalescedFetch, _pendingReqs,
  handleError, _errMsg,
  startBackgroundIndex, stopBackgroundIndex,
  _idbSearch, _idxSearch, _highlightTerm,
  initVirtualScroll, destroyVirtualScroll, _vsRender,
  Store, Logger, UndoStack, Recents,
  initOfflineDetection, batchWebDAV,
  showRecents,
  createShare, deleteShare, nativeShareLink, setShareExpiry,
  _loadExistingShares,
  addOptimisticCard, updateOptimisticCard, removeOptimisticCard,
  compressImage, webShareFile, webShareCurrentFile, loadTodayInHistory,
  _resumeDB, _fileKey,
  skeletonGrid, skeletonList,
  _idb, _idxAdd, _idxSearch,
  _refreshInBackground,
  _cancelPendingThumbs,
  _cancelGallery,
  _idbThumb,
  _galThrottle,
  _galNext,
  _swCacheGalleryAdjacent,
  _loadExif, _renderExifBar, _parseExifData,
  showCtxMenu, closeCtx,
  prefetchDir, cancelPrefetch, getPrefetched,
  uploadChunked,
  applyTheme,
  renderThemeDots,
  renderThemeGrid,
  moveItem,
  autoRename,
  _imgCacheCleanup,
  _imgNext,
  _imgThrottle,
  _imgCacheSet,
  authImg,
  normPath,
  toast,
  showM,
  hideM,
  fmtSz,
  fmtDate,
  fIcon,
  iCls,
  toggleDrop,
  closeDrop,
  setupOffline,
  doLogin,
  setLE,
  initApp,
  doLogout,
  loadAvatar,
  setAvatar,
  uploadAvatar,
  openProfile,
  // generateVideoThumb disabled,
  folderIcon,
  saveProfile,
  setEmojiAvatar,
  openPassM,
  changePass,
  loadStorage,
  saveFavs,
  toggleFav,
  renderFavs,
  loadTree,
  mkTI,
  updateTreeActive,
  loadFiles, loadFilesDebounced,
  sortItems,
  setSort,
  toggleSortDir,
  setV,
  toggleSB,
  closeSB,
  renderFiles,
  card,
  row,
  fcClick,
  enterSel,
  enterOrToggleSel,
  toggleSel,
  clearSel,
  selAll,
  updateSelBar,
  tStart,
  tEnd,
  addSwipeListeners,
  bulkDelete,
  bulkDownload,
  bulkMoveOpen,
  dStart,
  dEnd,
  handleDrop,
  navTo,
  openDir,
  goBack,
  goHome,
  jumpTo,
  updateBC,
  cancelUpload,
  uploadFolderFiles,
  uploadFiles,
  dlF,
  delIt,
  startRn,
  doRename,
  createFolder,
  startMoveItem,
  openMoveModal,
  doMove,
  openGallery,
  renderGallery,
  galleryNav,
  galleryGoTo,
  galleryZoomToggle,
  closeGallery,
  startSlideshowFromFolder,
  startSlideshow,
  ssShow,
  ssPlay,
  ssNext,
  ssPause,
  ssSpeed,
  ssInfo,
  closeSlideshow,
  setupGalleryTouch,
  openPdf,
  renderPdfPage,
  pdfNav,
  closePdf,
  openMedia,
  shareItem,
  copyShareLink,
  openSearch,
  closeSearch,
  schedSearch,
  execSearch,
  renderSearchResults,
  srClick,
  openTrash,
  restoreItem,
  emptyTrash,
  openActivity,
  openQuota,
  renderQuota,
  installPWA,
  switchTab,
  loadWeather,
  calNav,
  loadCalendar,
  loadCalEvents,
  parseVEvent,
  renderCalendar,
  calDayClick,
  submitNewEvent,
  deleteEvent,
  ensureNotesDir,
  noteToText,
  textToNote,
  loadNotes,
  renderNotesList,
  stringToColor,
  filterNotes,
  openNote,
  notesBack,
  noteChanged,
  saveNote,
  newNote,
  deleteNote,
  openVersions,
  restoreVersion,
  openTags,
  renderTagsModal,
  assignTag,
  removeTag,
  createAndAssignTag,
  openTagFilter,
  toggleTagFilter,
  loadTaggedFiles,
  clearTagFilter,
  toggleFab,
  closeFab,
  checkUploadQueue,
  showResumeModal,
  restoreSession,
  checkPendingShares,
  openStorageStats,
  pageLoaderStart,
  pageLoaderDone,
  syncStart,
  syncDone,
  updateFilesStatus,
  _showRefreshBadge,
  S,
  SS,
  UPQ,
  UQ,
  THEMES,
});
// Registar aliases _fc_ para o wrapper HTML (timing fix)
// O wrapper no HTML aguarda estes aliases antes de executar as funções
{
  const _fc_fns = {doLogin,doLogout,toggleDrop,closeDrop,goHome,goBack,toggleSB,
    openSearch,closeSearch,switchTab,openProfile,openPassM,installPWA,openTrash,
    openActivity,openQuota,openStorageStats,loadWeather,calNav,submitNewEvent,
    newNote,saveNote,deleteNote,notesBack,emptyTrash,toggleFab,closeFab,
    cancelUpload,selAll,bulkDelete,bulkDownload,bulkMoveOpen,clearSel,
    setV,setSort,toggleSortDir,createFolder,doRename,doMove,
    startSlideshow,startSlideshowFromFolder,closeSlideshow,ssPause,ssSpeed,
    ssInfo,ssNext,closeGallery,closePdf,pdfNav,copyShareLink,createShare,
    schedSearch,srClick,calDayClick,filterNotes,openNote,showM,hideM,showRecents,
    galleryNav,galleryGoTo,galleryZoomToggle,shareItem,openVersions,openTags,
    assignTag,removeTag,createAndAssignTag,openTagFilter,clearTagFilter,
    toggleTagFilter,openMoveModal,startRn,dlF,delIt,enterSel,selAll,
    openGallery,openPdf,openMedia,navTo,openDir};
  Object.keys(_fc_fns).forEach(k => { window['_fc_'+k] = _fc_fns[k]; });
}
