import { z } from 'zod'

/**
 * The portability kit (MASTER-PLAN §2, §13). Every environment variable the
 * app reads goes through here or through lib/env.server.ts, under the SAME
 * names on Vercel and the Windows Server, so moving hosts is a copy-paste of
 * env vars, not a code change. `DEPLOY_TARGET` (server-only) is the only
 * place host differences may be branched on (§13.2) — nothing else in the
 * app should read `process.env.VERCEL` or equivalent.
 *
 * This file holds ONLY the public schema. It must stay safe to import from
 * a Client Component: importing any export from a module executes that
 * module's entire top-level code, so a client-safe export sharing a file
 * with a server-secrets export is not actually a safe boundary — see
 * lib/env.server.ts for what used to live here and why it moved out.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
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

/** Safe to import from Client Components. */
export const publicEnv = readClientEnv()
