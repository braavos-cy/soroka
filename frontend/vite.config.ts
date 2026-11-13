import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.API_PROXY ?? 'https://localhost:8443', secure: false } } },
})
