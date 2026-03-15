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
  const isUpload = opts.method === 'PUT' || opts.method === 'POST';
  const isAborted = opts.signal;
  if (!isUpload && !isAborted && typeof url === 'string' && url.includes(PROXY)) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 25000);
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
    // Tenta refresh silencioso com credenciais guardadas
    const saved = localStorage.getItem('fc_cred');
    if (saved) {
      try {
        let d; try { d = JSON.parse(saved); } catch(e) { d = JSON.parse(deobfuscate(saved)); }
        S.user = d.user; S.pass = d.pass;
        // Retry o pedido original uma vez
        const r2 = await _origFetch(url, {
          ...opts,
          headers: { ...(opts.headers||{}), 'Authorization': auth() }
        });
        if (r2.status !== 401) return r2;
      } catch(e) {}
    }
    // Falhou mesmo — força logout limpo
    if (S.user) { toast('Sessão expirada. A reconectar...', 'err'); setTimeout(doLogout, 1500); }
  }
  return r;
};
// URL directo do Nextcloud — usado APENAS no header Destination do WebDAV MOVE/COPY
// O Nextcloud valida que o Destination pertence ao mesmo servidor
const NC = 'https://nx91769.your-storageshare.de';
// Encoding seguro para nomes de ficheiros portugueses (acentos, espaços, etc.)
const safeName = n => encodeURIComponent(n).replace(/%20/g,' ');
const isMobile = () => window.innerWidth <= 700 || 'ontouchstart' in window;

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
const _IMG_CACHE_MAX = 150;
const _imgCache = new Map();
// Concorrência limitada — máx 6 fetches de imagem simultâneos
const _IMG_CONCURRENCY = 6;

// Cleanup automático do cache de imagens quando excede o limite
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
}, { rootMargin: '200px 0px', threshold: 0.01 });
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
    try { URL.revokeObjectURL(oldUrl); } catch(e) {}
    _imgCache.delete(oldest);
  }
  _imgCache.set(key, val);
}
// Gera URL de thumbnail nativo do Nextcloud
function thumbUrl(fileid, size=256) {
  if (!fileid) return null;
  return PROXY + '/nextcloud/index.php/core/preview?fileId=' + fileid + '&x=' + size + '&y=' + size + '&forceIcon=0&a=1';
}
async function authImg(el, url, fallbackUrl) {
  if (!url) return;
  const cacheKey = url;
  if (_imgCache.has(cacheKey)) { el.src = _imgCache.get(cacheKey); return; }
  await _imgThrottle(async () => {
  try {
    const r = await fetch(url, { headers: { 'Authorization': auth() }, redirect: 'follow' });
    if (r.ok) {
      const blob = await r.blob();
      if (blob.type.startsWith('image/') && blob.size > 100) {
        const objUrl = URL.createObjectURL(blob);
        _imgCache.set(cacheKey, objUrl);
        _imgCacheCleanup(); // evita memory leak
        el.src = objUrl;
        return;
      }
    }
    // Falhou thumbnail — tenta o ficheiro completo como fallback
    if (fallbackUrl && fallbackUrl !== url) {
      if (_imgCache.has(fallbackUrl)) { el.src = _imgCache.get(fallbackUrl); return; }
      const r2 = await fetch(fallbackUrl, { headers: { 'Authorization': auth() } });
      if (r2.ok) {
        const blob2 = await r2.blob();
        if (blob2.type.startsWith('image/')) {
          const objUrl2 = URL.createObjectURL(blob2);
          _imgCacheSet(fallbackUrl, objUrl2);
          _imgCacheSet(cacheKey, objUrl2);
          el.src = objUrl2;
        }
      }
    }
  } catch(e) { /* silencioso — mostra ícone genérico */ }
  }); // _imgThrottle
}


const b64 = s => btoa(unescape(encodeURIComponent(s)));
const auth = () => 'Basic ' + b64(S.user + ':' + S.pass);
// Ofuscação de credenciais em storage (não é encriptação — impede leitura directa)
const _salt = 'fc2026';
const obfuscate = s => btoa(_salt + btoa(unescape(encodeURIComponent(s))));
const deobfuscate = s => { try { const d = atob(s); return decodeURIComponent(escape(atob(d.slice(_salt.length)))); } catch(e) { return s; } };
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
document.addEventListener('click', e => { if (!e.target.closest('.udrop-wrap')) closeDrop(); });

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
      const _cred = obfuscate(_credRaw);
      // iOS Safari: sessionStorage limpa em cada abertura da PWA
      // Usar SEMPRE localStorage como fonte de verdade
      localStorage.setItem('fc_cred', _cred);
      localStorage.setItem('fc_cred_ts', Date.now().toString()); // timestamp para debug
      sessionStorage.setItem('fc', _cred);
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
  document.getElementById('uname-top').textContent = S.user;
  document.getElementById('drop-nm').textContent = S.user;
  document.getElementById('uav-l').textContent = S.user.charAt(0).toUpperCase();
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    document.getElementById('cam-btn').style.display = 'flex';
  }
  if (!S.sidebarOpen) document.getElementById('sb').classList.add('closed');
  setV(S.view, false);
  ['name','date','size'].forEach(k => document.getElementById('s-'+k).classList.toggle('on', k===S.sort.by));
  document.getElementById('s-dir').textContent = S.sort.dir==='asc' ? '↑' : '↓';
  renderThemeDots();
  renderThemeGrid();
  loadAvatar();
  loadFiles('/');
  loadStorage();
  loadTree('/');
  setupOffline();
  // Reset tabs (important on re-login)
  calLoaded = false; notesLoaded = false; wxLoaded = false;
  switchTab('files');
  // Verifica uploads pendentes de sessão anterior
  setTimeout(checkUploadQueue, 2000);
}

function doLogout() {
  sessionStorage.clear();
  localStorage.removeItem('fc_cred');
  S.user=''; S.pass=''; S.server=''; S.path='/'; S.hist=[];
  S.selected.clear(); S.selecting=false; S.lastItems=[];
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pwd').value = '';
  document.getElementById('lerr').style.display = 'none';
  document.getElementById('uav').innerHTML = '<span id="uav-l"></span>';
  calLoaded = false; notesLoaded = false; wxLoaded = false;
  if(typeof switchTab==='function') switchTab('files');
}

// ─── AVATAR ───────────────────────────────────────────────────────────────────
async function loadAvatar() {
  try {
    const r = await fetch(PROXY+`/nextcloud/index.php/avatar/${encodeURIComponent(S.user)}/128`, {
      headers: { 'Authorization': auth() }
    });
    if (r.ok) { setAvatar(URL.createObjectURL(await r.blob())); return; }
  } catch(e) {}
  const stored = sessionStorage.getItem('fc_avpath');
  if (stored) {
    try {
      const r = await fetch(dav(stored), { headers: { 'Authorization': auth() } });
      if (r.ok) setAvatar(URL.createObjectURL(await r.blob()));
    } catch(e) {}
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

function openProfile() {
  document.getElementById('prof-nm').textContent = S.user;
  document.getElementById('prof-av-l').textContent = S.user.charAt(0).toUpperCase();
  document.getElementById('av-status').textContent = '';
  const img = document.getElementById('uav').querySelector('img');
  if (img) document.getElementById('prof-av').innerHTML = `<img src="${img.src}"><div class="prof-av-badge">📷</div>`;
  showM('profile');
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
    <div class="ti${S.path===f.path?' active':''}" data-path="${f.path}" onclick="navTo('${esc(f.path)}')">
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
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`
    });
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    if (!parentEl) { target.innerHTML = ''; target.appendChild(mkTI('🏠','Início','/')); }
    const dirs = [];
    xml.querySelectorAll('response').forEach(resp => {
      const rel = normPath(decodeURIComponent(resp.querySelector('href').textContent));
      if (normPath(rel) === normPath(p) || !rel || rel === '/') return;
      if (resp.querySelector('resourcetype collection')) {
        const nm = resp.querySelector('displayname')?.textContent || rel.split('/').filter(Boolean).pop() || '';
        if (nm && !nm.startsWith('.') && !HIDDEN.includes(nm))
          dirs.push({ nm, path: rel.endsWith('/') ? rel : rel+'/' });
      }
    });
    dirs.sort((a,b) => a.nm.localeCompare(b.nm));
    dirs.forEach(d => {
      const wrap = document.createElement('div');
      const item = document.createElement('div');
      item.className = 'ti' + (S.path===d.path?' active':'');
      item.dataset.path = d.path;
      const isFav = S.favorites.some(f => f.path===d.path);
      item.innerHTML = `<span class="ti-ic">📁</span><span class="ti-nm">${hesc(d.nm)}</span><span class="ti-star${isFav?' on':''}" title="${isFav?'Remover':'Favorito'}">★</span><span class="ti-ar">›</span>`;
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
async function loadFiles(p) {
  S.path = p; clearSel(); updateBC(); updateTreeActive();
  document.getElementById('btn-back').style.display = p === '/' ? 'none' : 'flex';
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
          } catch(e) {}
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
  } catch(e) {
    if (e.name === 'AbortError') return; // Navegação cancelada — normal
    document.getElementById('fl').innerHTML = `<div class="empty"><div class="ei">⚠️</div><h3>Erro ao carregar</h3><p>${e.message}</p></div>`;
  }
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
  if (!items.length) {
    fl.innerHTML = '<div class="empty"><div class="ei">📂</div><h3>Pasta vazia</h3><p>Arrasta ficheiros aqui ou clica em "Carregar"</p></div>';
    return;
  }
  if (S.view === 'grid') {
    fl.innerHTML = '<div class="fgrid">' + items.map(card).join('') + '</div>';
  } else {
    fl.innerHTML = '<div class="flist"><div class="lh"><span>Nome</span><span>Tamanho</span><span class="cd">Modificado</span><span>Ações</span></div>' + items.map(row).join('') + '</div>';
    addSwipeListeners();
  }
  // Carrega thumbnails com autenticação
  requestAnimationFrame(() => {
    fl.querySelectorAll('img[data-src]').forEach(img => {
      const src = img.dataset.src;
      const fb = img.dataset.fb || null;
      if (src) { _lazyObserver.observe(img); } // lazy load via IntersectionObserver
    });
  });
  // Mostra botão slideshow se há imagens
  const hasImgs = items.some(it => !it.isDir && isImg(it.name));
  const ssBtn = document.getElementById('btn-slideshow');
  if (ssBtn) ssBtn.style.display = hasImgs ? '' : 'none';
}

function card(it) {
  const {name:nm, path:p, isDir, size, dateStr, fileid=''} = it;
  const sp = esc(p), sn = esc(nm);
  const sel = S.selected.has(p);
  const sz = size ? fmtSz(size) : '';
  let inner;
  if (isDir) {
    inner = `<div class="fic ic-f">📁</div>`;
  } else if (isImg(nm)) {
    const tUrl = fileid ? thumbUrl(fileid, 300) : dav(p);
    const fbUrl = fileid ? dav(p) : null;
    inner = `<img class="thumb" data-src="${tUrl}" data-fb="${fbUrl||''}" alt="${nm}" onerror="this.outerHTML='<div class=\\'fic ic-i\\'>🖼️</div>'">`;
  } else if (isVid(nm)) {
    inner = `<div class="fic ic-v">🎬</div>`;
  } else {
    inner = `<div class="fic ${iCls(nm)}">${fIcon(nm)}</div>`;
  }
  const clickFn = isDir ? `openDir('${sp}')` :
    isImg(nm) ? `openGallery('${sp}')` :
    isPdf(nm) ? `openPdf('${sp}','${sn}')` :
    isVid(nm) || isAud(nm) ? `openMedia('${sp}','${sn}')` :
    `dlF('${sp}','${sn}')`;
  return `<div class="fc${isDir?' folder':''}${sel?' selected':''}"
    onclick="fcClick(event,'${sp}',()=>{${clickFn}})"
    oncontextmenu="event.preventDefault();enterSel('${sp}')"
    ontouchstart="tStart(event,'${sp}')" ontouchend="tEnd()"
    draggable="${isMobile()?'false':'true'}"
    ondragstart="if(!isMobile())dStart(event,'${sp}','${sn}',${isDir})"
    ondragend="if(!isMobile())dEnd(event)"
    ${isDir?`ondragover="if(!isMobile()){event.preventDefault();this.classList.add('drag-over')}" ondragleave="this.classList.remove('drag-over')" ondrop="if(!isMobile()){event.preventDefault();this.classList.remove('drag-over');handleDrop('${sp}')}"`:''}>
    <div class="fc-chk" onclick="event.stopPropagation();enterOrToggleSel('${sp}')">✓</div>
    <div class="fac">
      ${!isDir?`<button class="fab fa-dl" onclick="event.stopPropagation();dlF('${sp}','${sn}',${isDir})" title="${isDir?'Download ZIP':'Download'}">⬇️</button>`:''}
      <button class="fab fa-sh" onclick="event.stopPropagation();shareItem('${sp}','${sn}')" title="Partilhar">🔗</button>
      <button class="fab fa-rn" onclick="event.stopPropagation();startRn('${sp}','${sn}')" title="Renomear">✏️</button>
      <button class="fab fa-mv" onclick="event.stopPropagation();startMoveItem('${sp}','${sn}')" title="Mover">📦</button>
      ${!isDir&&fileid?`<button class="fab" style="background:#e3f2fd" onclick="event.stopPropagation();openVersions('${sp}','${sn}','${fileid}')" title="Versões">🕒</button>`:''}      <button class="fab" style="background:#fff3e0" onclick="event.stopPropagation();openTags('${sp}','${sn}','${fileid}')" title="Tags">🏷️</button>
      <button class="fab fa-del" onclick="event.stopPropagation();delIt('${sp}','${sn}')" title="Apagar">🗑️</button>
    </div>
    ${inner}
    <div class="fn">${nm}</div>
    <div class="fm">${sz?`<span>${sz}</span>`:''} ${dateStr?`<span>${dateStr}</span>`:''}</div>
  </div>`;
}

function row(it) {
  const {name:nm, path:p, isDir, size, dateStr, fileid=''} = it;
  const sp = esc(p), sn = esc(nm);
  const sz = (!isDir && size) ? fmtSz(size) : '-';
  const sel = S.selected.has(p);
  const clickFn = isDir ? `openDir('${sp}')` :
    isImg(nm) ? `openGallery('${sp}')` :
    isPdf(nm) ? `openPdf('${sp}','${sn}')` :
    isVid(nm) || isAud(nm) ? `openMedia('${sp}','${sn}')` :
    `dlF('${sp}','${sn}')`;
  return `<div class="lr${sel?' selected':''}" data-path="${p}"
    onclick="fcClick(event,'${sp}',()=>{${clickFn}})"
    oncontextmenu="event.preventDefault();enterSel('${sp}')"
    draggable="${isMobile()?'false':'true'}"
    ondragstart="if(!isMobile())dStart(event,'${sp}','${sn}',${isDir})"
    ondragend="if(!isMobile())dEnd(event)"
    ${isDir?`ondragover="if(!isMobile()){event.preventDefault();this.classList.add('drag-over')}" ondragleave="this.classList.remove('drag-over')" ondrop="if(!isMobile()){event.preventDefault();this.classList.remove('drag-over');handleDrop('${sp}')}"`:''}>
    <div class="lr-n"><div class="lr-chk">${sel?'✓':''}</div>${isDir?'📁':fIcon(nm)}<span>${nm}</span></div>
    <div class="lr-s">${sz}</div>
    <div class="lr-d">${dateStr||'-'}</div>
    <div class="lr-a" onclick="event.stopPropagation()">
      ${!isDir?`<button class="fab fa-dl" onclick="dlF('${sp}','${sn}')">⬇️</button>`:''}
      <button class="fab fa-sh" onclick="shareItem('${sp}','${sn}')">🔗</button>
      <button class="fab fa-rn" onclick="startRn('${sp}','${sn}')">✏️</button>
      <button class="fab fa-mv" onclick="startMoveItem('${sp}','${sn}')">📦</button>
      ${!isDir&&fileid?`<button class="fab" style="background:#e3f2fd" onclick="openVersions('${sp}','${sn}','${fileid}')">🕒</button>`:''}      <button class="fab" style="background:#fff3e0" onclick="openTags('${sp}','${sn}','${fileid}')">🏷️</button>
      <button class="fab fa-del" onclick="delIt('${sp}','${sn}')">🗑️</button>
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
function tStart(e, path) {
  S.touchTimer = setTimeout(() => { enterSel(path); }, 800);
}
function tEnd() {
  clearTimeout(S.touchTimer);
}

// Swipe to delete in list view
function addSwipeListeners() {
  document.querySelectorAll('.lr').forEach(el => {
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
      loadFilesDebounced(S.path); loadStorage(); setTimeout(() => loadTree('/'), 500);
    } else if (result.status === 'duplicate') {
      // Pergunta o que fazer
      const choice = confirm(`"${srcNm}" já existe em "${destFolderNm}".\n\nOK = Substituir\nCancelar = Manter os dois (renomeia automaticamente)`);
      const result2 = await moveItem(src, dest, { overwrite: choice, autoRename: !choice });
      if (result2.status === 'ok') {
        const msg = result2.renamed ? `"${srcNm}" guardado como "${result2.name}".` : `"${srcNm}" substituído em "${destFolderNm}".`;
        toast(msg, 'ok');
        loadFilesDebounced(S.path); loadStorage(); setTimeout(() => loadTree('/'), 500);
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
const dzEl = document.getElementById('dz');
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

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
function navTo(p) { S.hist.push(S.path); loadFiles(p); }
function openDir(p) {
  S.hist.push(S.path); loadFiles(p.endsWith('/') ? p : p+'/');
  // Fecha sidebar ao navegar no mobile
  if (window.innerWidth <= 700 && S.sidebarOpen) closeSB();
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
const UPQ = {
  jobs: [],   // {id, name, total, files, destPath, status:'wait'|'run'|'ok'|'err', done:0, errors:0}
  _running: false,
  _idSeq: 0,
  add(files, label) {
    const id = ++this._idSeq;
    this.jobs.push({ id, label, files: Array.from(files), status:'wait', done:0, errors:0, total:files.length });
    this._render();
    if (!this._running) this._run();
  },
  _render() {
    const prog = document.getElementById('uprog');
    const queue = document.getElementById('uprog-queue');
    const activeJobs = this.jobs.filter(j => j.status !== 'ok' || this.jobs.length <= 5);
    if (activeJobs.length === 0) { prog.style.display='none'; return; }
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
    // Auto-hide after 4s if all done
    setTimeout(() => {
      if (this.jobs.every(j=>j.status==='ok'||j.status==='err')) {
        document.getElementById('uprog').style.display='none';
        document.getElementById('uprog-bar').style.width='0%';
        this.jobs = [];
      }
    }, 4000);
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
      try { queueId=await UQ.add(f,destPath); } catch(e) {}
      let uploaded=false;
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
          };
          xhr.onload=()=>{
            if(xhr.status===507){toast('❌ Servidor sem espaço.','err');S.uploadCancel=true;}
            resolve(xhr.status<400);
          };
          xhr.onerror=()=>resolve(false);
          xhr.onabort=()=>resolve(null);
          const LARGE=50*1024*1024;
          const uploadUrl=f.size>LARGE?NC+'/remote.php/dav/files/'+encodeURIComponent(S.user)+destPath:dav(destPath);
          xhr.open('PUT',uploadUrl);
          xhr.setRequestHeader('Authorization',auth());
          xhr.send(f);
        });
        if (ok===null) break;
        if (ok) { uploaded=true; } else if (attempt===2) { job.errors++; }
      }
      if (uploaded) { sentBytes+=f.size; if(queueId){try{await UQ.setStatus(queueId,'done');}catch(e){}} }
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
    loadFilesDebounced(S.path); loadStorage(); setTimeout(()=>loadTree('/'),600);
  }
};

async function uploadFiles(fl) {
  if (!fl || !fl.length) return;
  if (fl.length > 200) {
    const ok = confirm(fl.length + ' ficheiros selecionados.\nIsto pode demorar alguns minutos.\nContinuar?');
    if (!ok) return;
  }
  const label = fl.length===1 ? fl[0].name : `${fl.length} ficheiros`;
  UPQ.add(fl, label);
}

async function uploadFiles_LEGACY(fl) {
  if (!fl || !fl.length) return;
  S.uploadCancel = false;
  const prog = document.getElementById('uprog'); prog.style.display = 'block';
  document.getElementById('uprog-title').textContent = `⬆️ A carregar ${fl.length} ficheiro${fl.length>1?'s':''}...`;
  const files = Array.from(fl);
  let totalBytes = files.reduce((s,f) => s+f.size, 0), sentBytes = 0, errors = 0, done = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    if (S.uploadCancel) break;
    const f = files[i];
    document.getElementById('uprog-file').textContent = `${i+1}/${files.length}: ${f.name}`;
    // Build dest path (handle webkitRelativePath for folder uploads)
    let destDir = S.path;
    if (f.webkitRelativePath) {
      const parts = f.webkitRelativePath.split('/');
      let cur = S.path;
      for (let j = 0; j < parts.length - 1; j++) {
        cur += (cur.endsWith('/') ? '' : '/') + encodeURIComponent(parts[j]);
        await fetch(dav(cur), { method:'MKCOL', headers:{'Authorization':auth()} }).catch(()=>{});
        cur += '/';
      }
      destDir = cur;
    }
    const destPath = destDir + encodeURIComponent(f.name).replace(/%2F/g,'/').replace(/'/g,'%27');
    // Regista na fila persistente antes de enviar
    let queueId = null;
    try { queueId = await UQ.add(f, destPath); } catch(e) {}
    const fileStart = Date.now();
    // Retry até 3 vezes com backoff exponencial
    let uploaded = false;
    for (let attempt = 0; attempt < 3 && !S.uploadCancel && !uploaded; attempt++) {
      if (attempt > 0) {
        document.getElementById('uprog-file').textContent = `↻ Retry ${attempt}/2: ${f.name}`;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
      const ok = await new Promise(resolve => {
        const xhr = new XMLHttpRequest(); S.uploadXHR = xhr;
        xhr.upload.onprogress = e => {
          const totalSent = sentBytes + e.loaded;
          const pct = Math.min(99, Math.round(totalSent / totalBytes * 100));
          document.getElementById('uprog-bar').style.width = pct + '%';
          const elapsed = (Date.now() - startTime) / 1000 || 0.001;
          document.getElementById('uprog-speed').textContent = fmtSz(totalSent / elapsed) + '/s';
        };
        xhr.onload = () => {
          if (xhr.status === 507) {
            toast('❌ Servidor sem espaço (507). Liberta espaço e tenta novamente.', 'err');
            S.uploadCancel = true;
          }
          resolve(xhr.status < 400);
        };
        xhr.onerror = () => resolve(false);
        xhr.onabort = () => resolve(null);
        // Ficheiros > 50MB: upload directo ao Nextcloud (bypass Cloudflare 30s timeout)
        const LARGE = 50 * 1024 * 1024;
        const uploadUrl = f.size > LARGE
          ? NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + destPath
          : dav(destPath);
        if (f.size > LARGE && attempt === 0) {
          document.getElementById('uprog-file').textContent = `📡 Directo: ${i+1}/${files.length}: ${f.name}`;
        }
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Authorization', auth());
        xhr.send(f);
      });
      if (ok === null) break; // cancelado
      if (ok) { uploaded = true; } else if (attempt === 2) { errors++; }
    }
    if (uploaded) {
      sentBytes += f.size;
      if (queueId) { try { await UQ.setStatus(queueId, 'done'); } catch(e) {} }
    }
    done++;
  }
  document.getElementById('uprog-bar').style.width = '100%';
  setTimeout(() => { prog.style.display='none'; document.getElementById('uprog-bar').style.width='0%'; }, 900);
  S.uploadXHR = null;
  if (!S.uploadCancel) {
    const ok = done - errors;
    if (errors && ok === 0) toast(`❌ ${errors} ficheiro${errors>1?'s':''} falharam. Tenta novamente.`, 'err');
    else if (errors) toast(`⚠️ ${ok} carregado${ok>1?'s':''}, ${errors} falharam.`, 'err');
    else toast(`✅ ${ok} ficheiro${ok>1?'s':''} carregado${ok>1?'s':''}!`, 'ok');
    loadFilesDebounced(S.path); loadStorage(); setTimeout(() => loadTree('/'), 600);
  } else {
    toast('Upload cancelado.', '');
  }
  ['ufi','folder-ufi','cam-input','gallery-input','doc-input'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value='';
  });
  // Limpa entradas concluídas da fila
  try { await UQ.clearDone(); } catch(e) {}
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
        headers: { 'Authorization': auth() },
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
      headers: { 'Authorization': auth() },
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
  if (!confirm(`Apagar "${nm}" permanentemente?\n\nEsta acção é irreversível.`)) return;
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
  try {
    const r = await fetch(dav(p), { method:'DELETE', headers:{'Authorization':auth()} });
    if (r.ok || r.status===204) { toast('"' + nm + '" apagado.', 'ok'); loadFilesDebounced(S.path); loadStorage(); }
    else if (r.status === 404) {
      // Tenta com path re-encoded
      const ep = p.split('/').map(s => encodeURIComponent(s)).join('/');
      const r2 = await fetch(dav(ep), { method:'DELETE', headers:{'Authorization':auth()} });
      if (r2.ok || r2.status===204) { toast('"' + nm + '" apagado.', 'ok'); loadFilesDebounced(S.path); loadStorage(); }
      else toast('Ficheiro não encontrado no servidor.', 'err');
    }
    else toast('Erro ao apagar (' + r.status + ')', 'err');
  } catch(e) { toast('Erro ao apagar', 'err'); }
}

// ─── RENAME ───────────────────────────────────────────────────────────────────
function startRn(p, nm) {
  S.renameTarget = {p, nm}; document.getElementById('ri').value = nm; showM('rename');
  setTimeout(() => { const i = document.getElementById('ri'); i.focus(); i.select(); }, 80);
}
async function doRename() {
  const n = document.getElementById('ri').value.trim();
  if (!n || !S.renameTarget) return;
  const par = S.renameTarget.p.replace(/\/$/,'').substring(0, S.renameTarget.p.replace(/\/$/,'').lastIndexOf('/')+1);
  const dest = NC + '/remote.php/dav/files/' + encodeURIComponent(S.user) + par + encodeURIComponent(n);
  try {
    const r = await fetch(dav(S.renameTarget.p), { method:'MOVE', headers:{'Authorization':auth(),'Destination':dest,'Overwrite':'F'} });
    if (r.ok || r.status===201 || r.status===204) { toast('Renomeado!', 'ok'); hideM('rename'); loadFiles(S.path); }
    else toast('Erro ao renomear (' + r.status + ')', 'err');
  } catch(e) { toast('Erro ao renomear', 'err'); }
}

// ─── CREATE FOLDER ────────────────────────────────────────────────────────────
async function createFolder() {
  const n = document.getElementById('fi').value.trim(); if (!n) return;
  try {
    const r = await fetch(dav(S.path + encodeURIComponent(n)), { method:'MKCOL', headers:{'Authorization':auth()} });
    if (r.ok || r.status===201) {
      toast('Pasta "'+n+'" criada!', 'ok'); hideM('folder');
      document.getElementById('fi').value = '';
      loadFiles(S.path); setTimeout(() => loadTree('/'), 500);
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
  } catch(e) {}
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

  hideM('move'); clearSel(); loadFilesDebounced(S.path); loadStorage(); setTimeout(() => loadTree('/'), 500);
}

// ─── GALLERY ──────────────────────────────────────────────────────────────────
function openGallery(clickedPath) {
  S.galleryItems = S.lastItems.filter(it => !it.isDir && isImg(it.name));
  S.galleryIdx   = S.galleryItems.findIndex(it => it.path === clickedPath);
  if (S.galleryIdx < 0) S.galleryIdx = 0;
  S.galleryZoom  = 1;
  document.getElementById('gallery-ov').classList.add('show');
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

function renderGallery() {
  const it = S.galleryItems[S.galleryIdx]; if (!it) return;
  const img = document.getElementById('gallery-img');
  const loadingEl = document.getElementById('gallery-loading');
  const brokenEl = document.getElementById('gallery-broken');
  const progFill = document.getElementById('gallery-prog-fill');
  img.style.transform = 'scale(1)'; img.classList.remove('zoomed'); S.galleryZoom = 1;
  // Show loading state
  img.classList.add('loading-img');
  loadingEl.style.display = 'flex';
  brokenEl.style.display = 'none';
  progFill.style.width = '20%';
  // Simulate progress while loading
  let prog = 20;
  const progInt = setInterval(() => {
    prog = Math.min(85, prog + Math.random() * 15);
    progFill.style.width = prog + '%';
  }, 300);
  img.onload = () => {
    clearInterval(progInt);
    progFill.style.width = '100%';
    setTimeout(() => {
      loadingEl.style.display = 'none';
      img.classList.remove('loading-img');
    }, 200);
  };
  img.onerror = () => {
    clearInterval(progInt);
    loadingEl.style.display = 'none';
    brokenEl.style.display = 'flex';
    img.classList.remove('loading-img');
  };
  img.src = ''; authImg(img, dav(it.path));
  document.getElementById('gallery-nm').textContent = it.name;
  document.getElementById('gallery-count').textContent = (S.galleryIdx+1) + ' / ' + S.galleryItems.length;
  // strip thumbnails
  const strip = document.getElementById('gallery-strip');
  strip.innerHTML = S.galleryItems.map((g,i) =>
    `<img class="gallery-thumb${i===S.galleryIdx?' active':''}" data-src="${dav(g.path)}" alt="${g.name}" onclick="galleryGoTo(${i})">`
  ).join('');
  strip.querySelectorAll('img[data-src]').forEach(img => {
    const src = img.dataset.src; delete img.dataset.src; authImg(img, src);
  });
  setTimeout(() => {
    const at = strip.querySelector('.active');
    if (at) at.scrollIntoView({inline:'center', behavior:'smooth'});
  }, 80);
}

function galleryNav(d) {
  S.galleryIdx = (S.galleryIdx + d + S.galleryItems.length) % S.galleryItems.length;
  renderGallery();
}
function galleryGoTo(i) { S.galleryIdx = i; renderGallery(); }

function galleryZoomToggle() {
  S.galleryZoom = S.galleryZoom > 1 ? 1 : 2.5;
  const img = document.getElementById('gallery-img');
  img.style.transform = `scale(${S.galleryZoom})`;
  img.classList.toggle('zoomed', S.galleryZoom > 1);
}
document.getElementById('gallery-img').addEventListener('dblclick', galleryZoomToggle);
document.getElementById('gallery-img').addEventListener('click', e => {
  if (S.galleryZoom > 1) galleryZoomToggle();
});

function closeGallery() {
  document.getElementById('gallery-ov').classList.remove('show');
  document.getElementById('gallery-img').src = '';
}

// ─── SLIDESHOW ────────────────────────────────────────────────────────────────
const SS = { items:[], idx:0, interval:null, speed:5000, paused:false, showInfo:false };

function startSlideshowFromFolder() {
  SS.items = S.lastItems.filter(it => !it.isDir && isImg(it.name));
  if (!SS.items.length) { toast('Sem fotos nesta pasta.', 'err'); return; }
  SS.idx = 0; SS.paused = false;
  document.getElementById('slideshow-ov').classList.add('show');
  const el = document.getElementById('slideshow-ov');
  if (el.requestFullscreen) el.requestFullscreen().catch(()=>{});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  ssShow(); ssPlay();
}

function startSlideshow() {
  SS.items = S.galleryItems.filter(it => isImg(it.name));
  if (!SS.items.length) { toast('Sem imagens para slideshow.', 'err'); return; }
  SS.idx = S.galleryIdx || 0;
  SS.paused = false;
  closeGallery();
  document.getElementById('slideshow-ov').classList.add('show');
  const el = document.getElementById('slideshow-ov');
  if (el.requestFullscreen) el.requestFullscreen().catch(()=>{});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  ssShow(); ssPlay();
}

function ssShow() {
  const it = SS.items[SS.idx];
  if (!it) return;
  const img = document.getElementById('ss-img');
  img.classList.add('fade');
  setTimeout(() => {
    authImg(img, dav(it.path));
    img.onload = () => img.classList.remove('fade');
    img.onerror = () => { img.classList.remove('fade'); ssNext(); };
  }, 400);
  document.getElementById('ss-counter').textContent = (SS.idx+1) + ' / ' + SS.items.length;
  document.getElementById('ss-title').textContent = it.name;
  document.getElementById('ss-sub').textContent = it.dateStr || '';
  const prog = document.getElementById('ss-prog');
  prog.style.transition = 'none'; prog.style.width = '0%';
  setTimeout(() => { prog.style.transition = `width ${SS.speed}ms linear`; prog.style.width = '100%'; }, 50);
}

function ssPlay() {
  if (SS.interval) clearInterval(SS.interval);
  SS.interval = setInterval(ssNext, SS.speed);
}

function ssNext() {
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
    ssShow(); ssPlay();
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
  document.getElementById('slideshow-ov').classList.remove('show');
  if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}

// Touch swipe no slideshow
(function() {
  let t0=0, tx=0;
  const el = document.getElementById('slideshow-ov');
  el.addEventListener('touchstart', e => { t0=Date.now(); tx=e.touches[0].clientX; }, {passive:true});
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx)>60 && Date.now()-t0<400) {
      if (dx<0) ssNext();
      else { SS.idx=(SS.idx-1+SS.items.length)%SS.items.length; ssShow(); }
      if (!SS.paused) { clearInterval(SS.interval); ssPlay(); }
    }
  }, {passive:true});
})();

// Touch swipe + pinch zoom
let _gTx = null, _gPd = null;
function setupGalleryTouch() {
  const v = document.getElementById('gallery-viewer');
  v.ontouchstart = e => {
    if (e.touches.length===1) _gTx = e.touches[0].clientX;
    if (e.touches.length===2) _gPd = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  };
  v.ontouchmove = e => {
    if (e.touches.length===2 && _gPd) {
      const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      S.galleryZoom = Math.min(4, Math.max(1, d / _gPd * S.galleryZoom));
      const img = document.getElementById('gallery-img');
      img.style.transform = `scale(${S.galleryZoom})`;
      img.classList.toggle('zoomed', S.galleryZoom > 1.1);
    }
  };
  v.ontouchend = e => {
    if (_gTx !== null && e.changedTouches.length===1 && S.galleryZoom <= 1) {
      const dx = e.changedTouches[0].clientX - _gTx;
      if (Math.abs(dx) > 60) galleryNav(dx < 0 ? 1 : -1);
    }
    _gTx = null; _gPd = null;
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
function openMedia(p, nm) {
  const ext = ex(nm);
  const tag = VE.includes(ext) ? 'video' : 'audio';
  const attrs = VE.includes(ext) ? 'style="max-width:88vw;max-height:76vh;border-radius:10px;" preload="metadata"' : 'controls style="width:100%;margin-top:20px"';
  // Reuse gallery overlay as simple viewer
  const ovHtml = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px">
      <div style="color:white;font-size:14px;font-weight:500;max-width:80vw;text-align:center">${nm}</div>
      <${tag} src="${dav(p)}" controls autoplay ${attrs}></${tag}>
      <button onclick="this.closest('[style]').remove()" style="padding:8px 20px;background:rgba(255,255,255,.2);border:1.5px solid rgba(255,255,255,.4);border-radius:8px;color:white;font-family:var(--font);font-size:13px;cursor:pointer">✕ Fechar</button>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', ovHtml);
}

// ─── SHARE ────────────────────────────────────────────────────────────────────
async function shareItem(p, nm) {
  document.getElementById('share-desc').textContent = 'Partilhar "' + nm + '"';
  document.getElementById('share-content').innerHTML = '<div class="loading" style="padding:24px"><div class="spin"></div></div>';
  showM('share');
  try {
    const params = new URLSearchParams();
    params.append('path', p.replace(/\/$/,''));
    params.append('shareType', '3');
    params.append('permissions', '1');
    const r = await fetch(PROXY+'/nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares', {
      method: 'POST',
      headers: { 'Authorization': auth(), 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const txt = await r.text();
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const token = doc.querySelector('token')?.textContent;
    const url   = doc.querySelector('url')?.textContent;
    if (token || url) {
      const shareUrl = url || `https://nx91769.your-storageshare.de/index.php/s/${token}`;
      document.getElementById('share-content').innerHTML = `
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Link criado. Qualquer pessoa com o link pode ver:</p>
        <div class="share-link-box">
          <input type="text" id="share-url-inp" value="${shareUrl}" readonly>
          <button onclick="copyShareLink()">Copiar</button>
        </div>
        <p style="font-size:12px;color:var(--text2);line-height:1.5">⚠️ Link público. Partilha apenas com quem confias.</p>`;
    } else {
      const code = doc.querySelector('statuscode')?.textContent;
      throw new Error(code==='403'?'Sem permissão para partilhar':'Resposta inesperada ('+code+')');
    }
  } catch(e) {
    document.getElementById('share-content').innerHTML = `<div style="color:var(--red);font-size:13px;padding:14px;background:#fef2f0;border-radius:10px">Não foi possível criar link:<br>${e.message}<br><small>A funcionalidade de partilha pode não estar activa no servidor.</small></div>`;
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
  if (!q || q.length < 2) { document.getElementById('search-results').innerHTML='<div class="sr-hint">Escreve pelo menos 2 caracteres</div>'; return; }
  document.getElementById('search-results').innerHTML = '<div class="sr-loading" style="padding:32px;text-align:center"><div class="spin" style="margin:auto"></div></div>';
  S.searchTimer = setTimeout(() => execSearch(q), 350);
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
  el.innerHTML = (local ? `<div style="padding:6px 16px;font-size:11px;color:var(--text2);background:var(--bg2)">⚠️ Pesquisa na pasta atual — DASL não suportado pelo servidor</div>` : '') +
    results.map(it => `
      <div class="sr-item" onclick="srClick('${esc(it.path)}',${it.isDir},'${esc(it.name)}')">
        <span style="font-size:18px;flex-shrink:0">${it.isDir?'📁':fIcon(it.name)}</span>
        <div style="min-width:0;flex:1">
          <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.name}</div>
          <div class="sr-path">${it.parent || '/'}</div>
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
          <button class="trash-restore" onclick="restoreItem('${esc(it.href)}','${esc(it.fname)}')">↩️ Restaurar</button>
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
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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
document.getElementById('search-ov').addEventListener('click', e => {
  if (e.target === document.getElementById('search-ov')) closeSearch();
});


// ══════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ══════════════════════════════════════════════════════════════
const TABS = ['files','calendar','notes','weather'];
let currentTab = 'files';
let calLoaded = false, notesLoaded = false, wxLoaded = false;

function switchTab(tab) {
  currentTab = tab;
  TABS.forEach(t => {
    document.getElementById('sec-'+t)?.classList.toggle('active', t===tab);
    document.getElementById('bnt-'+t)?.classList.toggle('active', t===tab);
  });
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
    grid += `<div class="cal-day${isToday?' today':''}" onclick="calDayClick(${d},${month},${year})">${numLabel}${evHtml}${more}</div>`;
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
      <button class="cal-ev-del" onclick="deleteEvent('${esc(ev.evHref)}','${esc(ev.calHref)}','${esc(ev.summary)}')" title="Apagar">🗑️</button>
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
    return '<div class="note-item' + (currentNote && currentNote.id === n.id ? ' active' : '') + '" onclick="openNote(' + JSON.stringify(n.id) + ')">' +
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
        <button class="ver-restore" onclick="restoreVersion('${esc(v.href)}','${esc(name)}')">↩️ Restaurar</button>
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
    ? current.map(t=>`<span class="tag-chip" style="background:${color(t.id)}20;color:${color(t.id)}" onclick="removeTag('${t.id}','${esc(t.name)}')">${t.name} <span class="tag-chip-x">✕</span></span>`).join('')
    : '<span style="font-size:12px;color:var(--text2);padding:6px">Sem tags ainda</span>';

  document.getElementById('tags-available').innerHTML = available.length
    ? available.map(t=>`<button class="tag-opt" style="color:${color(t.id)}" onclick="assignTag('${t.id}','${esc(t.name)}')">${t.name}</button>`).join('')
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
      tags.map(t=>`<span class="tag-chip" style="background:var(--bg2);color:var(--text);border:1.5px solid var(--border)" onclick="toggleTagFilter('${t.id}','${esc(t.name)}',this)">${t.name}</span>`).join('')+
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
  if (raw) sessionStorage.setItem('fc', raw); // sincroniza para esta sessão
  if (raw) {
    try {
      // Suporta formato antigo (JSON directo) e novo (ofuscado)
      let parsed;
      try { parsed = JSON.parse(raw); } catch(e) { parsed = JSON.parse(deobfuscate(raw)); }
      if (parsed && parsed.user && parsed.pass) {
        S.server = PROXY; S.user = parsed.user; S.pass = parsed.pass;
        // Migra para formato ofuscado se ainda não estava
        const reobf = obfuscate(JSON.stringify(parsed));
        sessionStorage.setItem('fc', reobf);
        localStorage.setItem('fc_cred', reobf);
        initApp();
        if (new URLSearchParams(location.search).get('shared') === '1') {
          setTimeout(checkPendingShares, 1200);
        }
        return;
      }
    } catch(e) {}
  }
  // Nenhuma sessão — mostra login
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

// iOS PWA: ao voltar ao primeiro plano, verifica se a sessão ainda é válida
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user) {
    // Ping silencioso ao DAV para validar sessão
    fetch(dav('/'), { method:'PROPFIND', headers:{'Authorization':auth(),'Depth':'0'} })
      .then(r => {
        if (r.status === 401) {
          const saved = localStorage.getItem('fc_cred');
          if (saved) {
            try { const d=JSON.parse(saved); S.user=d.user; S.pass=d.pass; } catch(e){}
          } else { doLogout(); }
        }
      }).catch(() => {}); // offline — não fazer nada
    // Actualiza barra de quota ao voltar ao primeiro plano
    loadStorage();
  }
});


// ── PULL-TO-REFRESH ──────────────────────────────────────────────────────────
(function() {
  let startY = 0, pulling = false, ptr = null;
  function getMain() { return document.querySelector('.main'); }

  document.addEventListener('touchstart', e => {
    const main = getMain();
    if (!main || main.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const main = getMain();
    if (!main || main.scrollTop > 0) { pulling = false; return; }
    const dy = e.touches[0].clientY - startY;
    if (dy < 20) return;
    if (!ptr) {
      ptr = document.createElement('div');
      ptr.id = 'ptr-indicator';
      ptr.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--primary);color:#fff;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;z-index:999;pointer-events:none;transition:opacity .2s;';
      document.body.appendChild(ptr);
    }
    ptr.textContent = dy > 70 ? '↑ Soltar para actualizar' : '↓ Puxar para actualizar';
    ptr.style.opacity = Math.min(1, dy / 70);
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!pulling || !ptr) { pulling = false; return; }
    const dy = e.changedTouches[0].clientY - startY;
    pulling = false;
    if (dy > 70) {
      ptr.textContent = '🔄 A actualizar...';
      if (navigator.vibrate) navigator.vibrate(30);
      loadFiles(S.path);
      loadStorage();
    }
    setTimeout(() => { if (ptr) { ptr.remove(); ptr = null; } }, 600);
  }, { passive: true });
})();



// ─── EXPOSE TO GLOBAL SCOPE (required for HTML onclick handlers) ───────────
window.applyTheme = applyTheme;
window.renderThemeDots = renderThemeDots;
window.renderThemeGrid = renderThemeGrid;
window.moveItem = moveItem;
window.autoRename = autoRename;
window._imgCacheCleanup = _imgCacheCleanup;
window._imgNext = _imgNext;
window._imgThrottle = _imgThrottle;
window._imgCacheSet = _imgCacheSet;
window.thumbUrl = thumbUrl;
window.authImg = authImg;
window.normPath = normPath;
window.toast = toast;
window.showM = showM;
window.hideM = hideM;
window.fmtSz = fmtSz;
window.fmtDate = fmtDate;
window.fIcon = fIcon;
window.iCls = iCls;
window.toggleDrop = toggleDrop;
window.closeDrop = closeDrop;
window.setupOffline = setupOffline;
window.doLogin = doLogin;
window.setLE = setLE;
window.initApp = initApp;
window.doLogout = doLogout;
window.loadAvatar = loadAvatar;
window.setAvatar = setAvatar;
window.uploadAvatar = uploadAvatar;
window.openProfile = openProfile;
window.openPassM = openPassM;
window.changePass = changePass;
window.loadStorage = loadStorage;
window.saveFavs = saveFavs;
window.toggleFav = toggleFav;
window.renderFavs = renderFavs;
window.loadTree = loadTree;
window.mkTI = mkTI;
window.updateTreeActive = updateTreeActive;
window.loadFiles = loadFiles;
window.sortItems = sortItems;
window.setSort = setSort;
window.toggleSortDir = toggleSortDir;
window.setV = setV;
window.toggleSB = toggleSB;
window.closeSB = closeSB;
window.renderFiles = renderFiles;
window.card = card;
window.row = row;
window.fcClick = fcClick;
window.enterSel = enterSel;
window.enterOrToggleSel = enterOrToggleSel;
window.toggleSel = toggleSel;
window.clearSel = clearSel;
window.selAll = selAll;
window.updateSelBar = updateSelBar;
window.tStart = tStart;
window.tEnd = tEnd;
window.addSwipeListeners = addSwipeListeners;
window.bulkDelete = bulkDelete;
window.bulkDownload = bulkDownload;
window.bulkMoveOpen = bulkMoveOpen;
window.dStart = dStart;
window.dEnd = dEnd;
window.handleDrop = handleDrop;
window.navTo = navTo;
window.openDir = openDir;
window.goBack = goBack;
window.goHome = goHome;
window.jumpTo = jumpTo;
window.updateBC = updateBC;
window.cancelUpload = cancelUpload;
window.uploadFolderFiles = uploadFolderFiles;
window.uploadFiles = uploadFiles;
window.uploadFiles_LEGACY = uploadFiles_LEGACY;
window.dlF = dlF;
window.delIt = delIt;
window.startRn = startRn;
window.doRename = doRename;
window.createFolder = createFolder;
window.startMoveItem = startMoveItem;
window.openMoveModal = openMoveModal;
window.doMove = doMove;
window.openGallery = openGallery;
window.renderGallery = renderGallery;
window.galleryNav = galleryNav;
window.galleryGoTo = galleryGoTo;
window.galleryZoomToggle = galleryZoomToggle;
window.closeGallery = closeGallery;
window.startSlideshowFromFolder = startSlideshowFromFolder;
window.startSlideshow = startSlideshow;
window.ssShow = ssShow;
window.ssPlay = ssPlay;
window.ssNext = ssNext;
window.ssPause = ssPause;
window.ssSpeed = ssSpeed;
window.ssInfo = ssInfo;
window.closeSlideshow = closeSlideshow;
window.setupGalleryTouch = setupGalleryTouch;
window.openPdf = openPdf;
window.renderPdfPage = renderPdfPage;
window.pdfNav = pdfNav;
window.closePdf = closePdf;
window.openMedia = openMedia;
window.shareItem = shareItem;
window.copyShareLink = copyShareLink;
window.openSearch = openSearch;
window.closeSearch = closeSearch;
window.schedSearch = schedSearch;
window.execSearch = execSearch;
window.renderSearchResults = renderSearchResults;
window.srClick = srClick;
window.openTrash = openTrash;
window.restoreItem = restoreItem;
window.emptyTrash = emptyTrash;
window.openActivity = openActivity;
window.openQuota = openQuota;
window.renderQuota = renderQuota;
window.installPWA = installPWA;
window.switchTab = switchTab;
window.loadWeather = loadWeather;
window.calNav = calNav;
window.loadCalendar = loadCalendar;
window.loadCalEvents = loadCalEvents;
window.parseVEvent = parseVEvent;
window.renderCalendar = renderCalendar;
window.calDayClick = calDayClick;
window.submitNewEvent = submitNewEvent;
window.deleteEvent = deleteEvent;
window.ensureNotesDir = ensureNotesDir;
window.noteToText = noteToText;
window.textToNote = textToNote;
window.loadNotes = loadNotes;
window.renderNotesList = renderNotesList;
window.stringToColor = stringToColor;
window.filterNotes = filterNotes;
window.openNote = openNote;
window.notesBack = notesBack;
window.noteChanged = noteChanged;
window.saveNote = saveNote;
window.newNote = newNote;
window.deleteNote = deleteNote;
window.openVersions = openVersions;
window.restoreVersion = restoreVersion;
window.openTags = openTags;
window.renderTagsModal = renderTagsModal;
window.assignTag = assignTag;
window.removeTag = removeTag;
window.createAndAssignTag = createAndAssignTag;
window.openTagFilter = openTagFilter;
window.toggleTagFilter = toggleTagFilter;
window.loadTaggedFiles = loadTaggedFiles;
window.clearTagFilter = clearTagFilter;
window.toggleFab = toggleFab;
window.closeFab = closeFab;
window.checkUploadQueue = checkUploadQueue;
window.showResumeModal = showResumeModal;
window.restoreSession = restoreSession;
window.checkPendingShares = checkPendingShares;
window.S = S;
window.SS = SS;
window.UPQ = UPQ;
window.UQ = UQ;
window.THEMES = THEMES;
