import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Local dev only: forward /api to the API server (port 3000),
  // mirroring apps/web/nginx.conf which proxies /api/ to the API in prod.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
