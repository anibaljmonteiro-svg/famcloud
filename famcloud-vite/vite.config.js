import { defineConfig } from 'vite'

export default defineConfig({
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    minify: 'esbuild',
  },
  esbuild: {
    keepNames: true,
    // Fase 8.1: preservar console.warn/error em produção para debugging
    // Apenas console.log e console.debug são removidos
    drop: ['debugger'],
    pure: ['console.log', 'console.debug'],
  },

  server: {
    port: 5173,
    open: true,
  }
})
