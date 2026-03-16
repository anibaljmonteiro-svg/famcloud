import { defineConfig } from 'vite'

export default defineConfig({
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    minify: 'esbuild',  // Reactivado — card() usa data attributes, não onclick inline
  },
  esbuild: {
    keepNames: true,  // Preserva nomes para Object.assign(globalThis) funcionar
    drop: ['console', 'debugger'],
  },

  server: {
    port: 5173,
    open: true,
  }
})
