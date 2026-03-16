import { defineConfig } from 'vite'

export default defineConfig({
  // Base path = nome do repositório GitHub
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    // Manter nomes das funções para que window.X = fn funcione correctamente
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: true },
      mangle: false, // NÃO renomear variáveis — essencial para window.* exports
    },
  },

  server: {
    port: 5173,
    open: true,
  }
})
