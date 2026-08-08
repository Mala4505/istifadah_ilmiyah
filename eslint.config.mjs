import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

// The host-coupling guard (MASTER-PLAN §10, §13.2). Vercel-only APIs make the
// eventual move to the Windows Server a rewrite instead of a config change.
// This makes that mistake fail `next build` instead of surfacing on cutover day.
const hostCouplingGuard = {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: '@vercel/blob', message: 'Host coupling forbidden (MASTER-PLAN §13.2): use lib/storage.ts (Supabase Storage) instead of Vercel Blob.' },
          { name: '@vercel/kv', message: 'Host coupling forbidden (MASTER-PLAN §13.2): use the Postgres job_queue instead of Vercel KV.' },
          { name: '@vercel/postgres', message: 'Host coupling forbidden (MASTER-PLAN §13.2, §4.5): the app never opens a direct DB connection — use the Supabase Data API via supabase-js.' },
          { name: '@vercel/edge-config', message: 'Host coupling forbidden (MASTER-PLAN §13.2): no Vercel-only config store.' },
          { name: '@vercel/functions', message: 'Host coupling forbidden (MASTER-PLAN §13.2): no Vercel-only runtime APIs.' },
        ],
        patterns: [
          {
            group: ['@vercel/*'],
            message: 'Host coupling forbidden (MASTER-PLAN §13.2): every Vercel-specific package is on the forbidden list. Route Handlers + the Postgres job queue must run unchanged on the Windows Server.',
          },
        ],
      },
    ],
  },
}

const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'worker/dist/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  hostCouplingGuard,
]

export default eslintConfig
