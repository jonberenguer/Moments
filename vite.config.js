import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Electron renderer loads from file:// in production;
  // use relative paths so assets resolve correctly.
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
