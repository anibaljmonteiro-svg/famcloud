import { defineConfig } from 'vite'

export default defineConfig({
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    minify: false,  // Sem minificação — preserva nomes de funções para onclick handlers
  },

  server: {
    port: 5173,
    open: true,
  }
})
