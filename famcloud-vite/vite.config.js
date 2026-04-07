import { defineConfig } from 'vite'

export default defineConfig({
  base: '/famcloud/',
  build: {
    outDir: 'dist',
    minify: 'esbuild', // Mais rápido e agressivo que terser
    target: 'es2020',  // Suporte moderno
    sourcemap: false,  // Reduz tamanho final
    rollupOptions: {
      output: {
        manualChunks: {
          // Separa código pesado se houver, aqui mantemos vanilla leve
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  },
  esbuild: {
    keepNames: true, // Necessário para o Object.assign funcionar na app
    drop: ['console', 'debugger'], // Remove logs no build final
    legalComments: 'none'
  },
  server: {
    port: 5173,
    open: true,
    // Proxy para desenvolvimento local (aponta para o teu worker)
    proxy: {
      '/nextcloud': {
        target: 'https://famcloud.famcloud.workers.dev',
        changeOrigin: true,
        secure: false
      }
    }
  }
})