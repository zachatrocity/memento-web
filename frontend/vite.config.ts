import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: [
      'zacharys-mac-mini.tail9420b.ts.net',
      'macmini.zachs.io'
    ],
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/output': 'http://localhost:3000'
    }
  },
  build: {
    outDir: 'build',
    sourcemap: true
  }
})
