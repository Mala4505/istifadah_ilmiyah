/**
 * Which Postgres schema (and storage buckets) this deployment uses.
 *
 * Production uses `public`. Vercel Preview deployments set
 * NEXT_PUBLIC_DB_SCHEMA=staging so they read and write the `staging` schema
 * and the `staging-*` buckets in the same Supabase project, never live data.
 *
 * Only these two values are possible, so DB_SCHEMA is safe to put straight
 * into SQL text (lib/actions/events.ts, lib/import/*). Plain module, no
 * 'use client' / 'server-only', so both sides can import it.
 */
export const DB_SCHEMA: 'public' | 'staging' =
  process.env.NEXT_PUBLIC_DB_SCHEMA === 'staging' ? 'staging' : 'public'

/**
 * supabase-js `db.schema` option. Typed as 'public' so every client keeps the
 * default SupabaseClient type; at runtime it carries the real schema name.
 */
export const SUPABASE_DB_OPTIONS = { schema: DB_SCHEMA as 'public' }

/** Storage bucket name for this deployment ('board-packs' -> 'staging-board-packs'). */
export function bucketName(base: string): string {
  return DB_SCHEMA === 'staging' ? `staging-${base}` : base
}
