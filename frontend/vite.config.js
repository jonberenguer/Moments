import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Relative asset paths so they resolve under the Wails asset server.
  base: './',

  server: {
    port: 5173,
    // No COOP/COEP headers needed — no SharedArrayBuffer / WASM required.
    // Native FFmpeg child process handles all encoding work.
  },

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
})
