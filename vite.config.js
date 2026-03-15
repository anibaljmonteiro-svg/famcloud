import { defineConfig } from 'vite'

export default defineConfig({
  // Base path = nome do repositório GitHub
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    // Deixar o Vite gerir os nomes automaticamente
    // garante que o CSS é injectado correctamente no HTML
  },

  server: {
    port: 5173,
    open: true,
  }
})
