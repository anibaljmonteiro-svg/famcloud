import { defineConfig } from 'vite'

export default defineConfig({
  base: '/famcloud/',

  build: {
    outDir: 'dist',
    minify: 'esbuild',
  },
  esbuild: {
    keepNames: true,
    drop: ['debugger'],
    pure: ['console.log', 'console.debug'],
  },

  server: {
    port: 5173,
    open: true,
  }
})
