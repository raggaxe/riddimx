import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Spotify only accepts http loopback redirects on 127.0.0.1 (not "localhost").
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { rollupOptions: { input: { main: 'index.html', analyzer: 'analyzer.html' } } },
})
