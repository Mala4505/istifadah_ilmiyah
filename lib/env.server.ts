import 'server-only'
import { z } from 'zod'

/**
 * Server secrets (§4.5) — split out of lib/env.ts after a real incident:
 * lib/supabase/client.ts (Client-Component-safe) imported `publicEnv` from
 * the old single env.ts, and importing ANY export from a module runs that
 * module's entire top-level code. Since the old file evaluated
 * `serverEnv = readServerEnv()` unconditionally at the top level, every
 * page that used the browser Supabase client dragged this module's
 * `typeof window` guard into the client bundle too — where it always threw,
 * the moment the bundle actually ran in a browser. Build/SSR never caught
 * it because Node has no `window`.
 *
 * The fix is structural, not just the runtime guard below: this file is
 * never imported by lib/env.ts or anything client-safe, so a Client
 * Component can no longer reach it by accident. `server-only` (Next.js's
 * own sentinel package) turns any future accidental import into a build
 * error instead of a browser-only runtime throw discovered by a user.
 */

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
  // Never resolvable on the public internet by design — ITS-number login
  // (lib/auth/its.ts) maps each 8-digit ITS number to
  // `<its_number>@ITS_LOGIN_EMAIL_DOMAIN` and stores that as auth.users.email,
  // Supabase Auth's login handle only. It is never sent anywhere as a real
  // address, so the domain does not need to exist or accept mail.
  ITS_LOGIN_EMAIL_DOMAIN: z.string().min(1).default('members.istefadah.internal'),
})

function readServerEnv() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv was imported into browser code. Server secrets (Supabase secret key, Anthropic key, DB URL) must never reach the client bundle — read publicEnv from @/lib/env instead.'
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
    ITS_LOGIN_EMAIL_DOMAIN: process.env.ITS_LOGIN_EMAIL_DOMAIN,
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

/**
 * Server-only — Route Handlers, Server Components, Server Actions, and
 * worker/index.ts. Throws if evaluated in a browser bundle rather than
 * silently leaking.
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
