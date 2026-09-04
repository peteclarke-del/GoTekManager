import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The version the browser preview reports. The desktop application asks itself
// instead; this only exists so the preview has an answer at all, and it comes
// from package.json so there is nowhere else to forget to change.
const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 1420, strictPort: true },
})
