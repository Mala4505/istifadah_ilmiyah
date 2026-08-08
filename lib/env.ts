import { z } from 'zod'

/**
 * The portability kit (MASTER-PLAN §2, §13). Every environment variable the
 * app reads goes through here, under the SAME names on Vercel and the
 * Windows Server, so moving hosts is a copy-paste of env vars, not a code
 * change. `DEPLOY_TARGET` is the only place host differences may be
 * branched on (§13.2) — nothing else in the app should read
 * `process.env.VERCEL` or equivalent.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
})

// Server-only. Never imported by a Client Component — see the runtime guard below.
const serverSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().optional().default(''),
  DEPLOY_TARGET: z.enum(['vercel', 'server']).default('vercel'),
  CSP_REPORT_ONLY: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_ID: z.string().min(1).default('local-dev'),
})

function readClientEnv() {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  })
  if (!parsed.success) {
    throw new Error(
      `Invalid or missing public environment variables:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}\nCheck .env.local against .env.example.`
    )
  }
  return parsed.data
}

function readServerEnv() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv was imported into browser code. Server secrets (Supabase secret key, Anthropic key, DB URL) must never reach the client bundle — read publicEnv instead.'
    )
  }
  const parsed = serverSchema.safeParse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    DEPLOY_TARGET: process.env.DEPLOY_TARGET,
    CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
    WORKER_ID: process.env.WORKER_ID,
  })
  if (!parsed.success) {
    throw new Error(
      `Invalid or missing server environment variables:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}\nCheck .env.local against .env.example.`
    )
  }
  return parsed.data
}

/** Safe to import from Client Components. */
export const publicEnv = readClientEnv()

/**
 * Server-only — Route Handlers, Server Components, and worker/index.ts.
 * Throws if evaluated in a browser bundle rather than silently leaking.
 */
export const serverEnv = readServerEnv()

/**
 * True once a real Anthropic key has been provided (MASTER-PLAN §6.4).
 * `.env.example`'s placeholder is a valid-looking string, not a valid key —
 * callers that need OCR (lib/claude-client.ts, worker/handlers/extract.ts)
 * check this and fail with a clear message rather than a cryptic 401
 * partway through a batch.
 */
export const hasAnthropicKey = /^sk-ant-(?!xxx)/.test(serverEnv.ANTHROPIC_API_KEY)
