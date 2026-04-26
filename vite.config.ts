import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// __BUILD_HASH__ is replaced at build time with a per-deploy timestamp.
// The frontend reads it on load and warns the user if their tab's build
// no longer matches the latest deployed bundle. Stale tabs (e.g. one
// loaded yesterday that's been sitting open) silently write incomplete
// data because their bundle predates v2 logic — this surfaces it.
const BUILD_HASH = new Date().toISOString().replace(/[:.]/g, '-');

export default defineConfig({
  plugins: [react()],
  base: '/human-eval/',
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
  },
})
