import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/integration/** talks to the live Supabase project and needs real credentials
    // from .env. It runs under its own project (vitest.integration.config.ts, `npm run
    // test:rls`) so that `npm test` stays offline, fast and runnable without secrets.
    exclude: ['node_modules/**', 'test/integration/**'],
  },
})
