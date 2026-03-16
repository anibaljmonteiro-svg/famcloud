import { defineConfig } from 'vite'

export default defineConfig({
  // Base path = nome do repositório GitHub
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    // esbuild built-in com keep_names — preserva nomes para globalThis exports
    minify: 'esbuild',
  },
  esbuild: {
    keepNames: true,  // preserva nomes de funções — essencial para Object.assign(globalThis)
    drop: ['console', 'debugger'],
  },

  server: {
    port: 5173,
    open: true,
  }
})
