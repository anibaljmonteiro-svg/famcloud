# FamCloud v2.1.0

PWA de cloud familiar privada sobre Nextcloud (Hetzner StorageShare).

## Stack
- **Frontend:** Vite + Vanilla JS
- **Backend:** Nextcloud (Hetzner StorageShare NX21, 5TB)
- **Proxy:** Cloudflare Worker (CORS bridge)
- **Deploy:** GitHub Pages (CI/CD automático)

## Estrutura
```
famcloud/
├── public/              ← ficheiros estáticos copiados para dist/
│   ├── sw.js            ← Service Worker
│   ├── manifest.json    ← PWA manifest
│   ├── icon-192.png     ← ícone PWA
│   └── icon-512.png     ← ícone PWA
├── src/
│   ├── main.js          ← JavaScript completo da app
│   └── styles/
│       └── main.css     ← CSS completo
├── index.html           ← HTML shell (Vite entry point)
├── vite.config.js       ← configuração Vite
├── package.json
└── .github/
    └── workflows/
        └── deploy.yml   ← CI/CD automático
```

## Configuração antes de começar

### 1. Alterar base path no vite.config.js
Se o teu repo GitHub se chamar `famcloud`:
```js
base: '/famcloud/'
```
Se usares domínio custom (ex: famcloud.anibalmonteiro.pt):
```js
base: '/'
```

### 2. Ícones
Substitui os ficheiros placeholder em `public/`:
- `icon-192.png` → ícone 192×192px
- `icon-512.png` → ícone 512×512px

### 3. Cloudflare Worker
O ficheiro `worker.js` (separado) precisa de ser deployed no Cloudflare Dashboard.

## Desenvolvimento local

```bash
# 1. Instalar dependências (só uma vez)
npm install

# 2. Servidor de desenvolvimento com hot reload
npm run dev

# Abre automaticamente em http://localhost:5173/famcloud/
```

## Build e deploy manual

```bash
# Build para produção
npm run build

# Testar o build localmente
npm run preview
```

## Deploy automático (recomendado)

Sempre que fizeres `git push` para a branch `main`, o GitHub Actions faz o build e deploy automaticamente.

**Setup inicial no GitHub:**
1. Vai ao teu repo → Settings → Pages
2. Source: **GitHub Actions** (não "Deploy from branch")
3. Pronto — o próximo push faz deploy automático

## Actualizar o Cloudflare Worker

O ficheiro `worker.js` está separado. Para actualizar:
1. Vai a workers.cloudflare.com
2. Abre o worker `famcloud`
3. Edit Code → cola o novo código → Deploy

## URL da app

Após deploy:
`https://anibaljmonteiro-svg.github.io/famcloud/`
