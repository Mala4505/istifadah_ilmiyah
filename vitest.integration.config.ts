import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Integration tests — separate from vitest.config.ts on purpose.
 *
 * These hit the LIVE Supabase project over the network, need real credentials from
 * `.env`, create and delete their own fixture rows, and take tens of seconds. The
 * default `npm test` project deliberately excludes them so the unit suite stays
 * offline, deterministic and fast (and so CI without secrets does not fail).
 *
 *   npm test        -> test/unit only
 *   npm run test:rls -> this file
 *
 * Single-threaded (`singleFork`) so two test files can never race each other's fixture
 * users or storage paths against one shared database.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/integration/setup-env.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    retry: 0,
  },
})
