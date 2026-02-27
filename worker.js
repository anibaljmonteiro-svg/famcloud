/**
 * FamCloud — Cloudflare Worker Proxy
 * Faz bridge entre a PWA (GitHub Pages) e o Nextcloud Hetzner
 * 
 * Deploy:
 *   npx wrangler deploy
 *   ou via dashboard: workers.cloudflare.com
 * 
 * Depois de deploy, copia o URL gerado (ex: famcloud.SEU-NOME.workers.dev)
 * e actualiza a constante PROXY no index.html
 */

const NEXTCLOUD = 'https://nx91769.your-storageshare.de';

// Origens permitidas — adiciona o teu domínio GitHub Pages aqui
// Ex: 'https://anibal.github.io'
// '*' aceita qualquer origem (mais simples, ligeiramente menos seguro)
const ALLOWED_ORIGIN = '*';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, REPORT, SEARCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, Overwrite, If-None-Match, If-Match, DAV, X-Requested-With, X-OC-Mtime, OCS-APIREQUEST',
  'Access-Control-Expose-Headers': 'DAV, ETag, Content-Length, X-Request-Id, OC-FileId, OC-ETag',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS Preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Health check ────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', proxy: NEXTCLOUD }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // ── Proxy: strip /nextcloud prefix e reencaminha para Nextcloud ─────────
    // /nextcloud/remote.php/... → https://nx91769.../remote.php/...

    // Validação de path — bloqueia path traversal e paths não autorizados
    const rawPath = url.pathname.replace(/^\/nextcloud/, '') || '/';
    // Bloqueia: ../, sequências de null bytes, paths fora de remote.php/ocs/index.php
    const ALLOWED_PATHS = ['/remote.php/', '/ocs/', '/index.php/', '/status.php'];
    const pathOk = rawPath === '/' || ALLOWED_PATHS.some(p => rawPath.startsWith(p));
    if (!pathOk || rawPath.includes('..') || rawPath.includes('%2e%2e') || rawPath.includes('\0')) {
      return new Response(JSON.stringify({ error: 'Path not allowed' }), {
        status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
    // Requer header Authorization (impede uso anónimo do proxy)
    if (!request.headers.get('Authorization')) {
      return new Response(JSON.stringify({ error: 'Authorization required' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
    const targetPath = rawPath;
    const targetUrl = NEXTCLOUD + targetPath + (url.search || '');

    // Copia os headers do pedido original, excepto os que o CF/browser injeta
    const reqHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      // Passa tudo excepto headers que causam problemas no proxy
      if (!['host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for',
            'x-forwarded-proto', 'x-real-ip'].includes(lower)) {
        reqHeaders.set(key, value);
      }
    }

    // Body: null para GET/HEAD, stream para o resto
    let body = null;
    if (!['GET', 'HEAD'].includes(request.method)) {
      body = request.body;
    }

    let response;
    try {
      response = await fetch(targetUrl, {
        method: request.method,
        headers: reqHeaders,
        body,
        // Importante: não seguir redirects automaticamente (WebDAV precisa de controlo)
        redirect: 'manual',
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', detail: err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // Constrói response com CORS headers adicionados
    const respHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      respHeaders.set(key, value);
    }

    // Corrige Location headers em redirects (301/302/307/308)
    if (respHeaders.has('Location')) {
      const loc = respHeaders.get('Location');
      if (loc.startsWith(NEXTCLOUD)) {
        // Reescreve o Location para passar pelo proxy
        respHeaders.set('Location', loc.replace(NEXTCLOUD, url.origin + '/nextcloud'));
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  }
};
