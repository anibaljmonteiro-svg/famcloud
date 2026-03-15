import { defineConfig } from 'vite'

export default defineConfig({
  // Base path para GitHub Pages
  // Se o repo se chamar "famcloud": base = '/famcloud/'
  // Se usares domínio custom ou repo = username.github.io: base = '/'
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    // Não fazer hash nos nomes dos ficheiros para o SW funcionar
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      }
    }
  },

  server: {
    port: 5173,
    open: true,
    // Proxy para desenvolvimento local — evita CORS ao testar
    proxy: {
      '/nextcloud-dev': {
        target: 'https://nx91769.your-storageshare.de',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nextcloud-dev/, '')
      }
    }
  }
})
