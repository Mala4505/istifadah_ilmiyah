# Staging environment

Staging lives in the same Supabase project as production, in separate schemas:

| | Production | Staging |
|---|---|---|
| Tables, views, RLS | `public` | `staging` |
| Helper functions | `private` | `staging_private` |
| Invoice PDFs bucket | `invoice-documents` | `staging-invoice-documents` |
| Board packs bucket | `board-packs` | `staging-board-packs` |
| App | Vercel Production (`master`) | Vercel Preview (any other branch) |

The switch is one env var, `NEXT_PUBLIC_DB_SCHEMA` (`public` or `staging`), read by
`lib/db-schema.ts`. Every Supabase client, the raw-SQL importers and the storage
bucket names go through it.

## What staging holds

Same structure as production (built 2026-10-16 from a `pg_dump --schema-only` of
`public` + `private`, with names swapped). Master data only: event (marked
"(STAGING)"), departments, sub-departments, budget heads, admin heads, zones,
statuses, HSN rates, item families and the staff roles. No entries, bills,
vendors or documents.

## Logins

Supabase Auth is per project, so staging shares logins with production. A user
only gets access in staging if they have a row in `staging.staff_profile`. The
sign-up trigger (`private.handle_new_user`) only writes to `public.staff_profile`;
add staging staff rows by hand.

## One-time setup

1. Supabase dashboard → Project Settings → Data API → Exposed schemas: add `staging`.
2. Vercel → Project → Settings → Environment Variables, scope **Preview** only:
   `NEXT_PUBLIC_DB_SCHEMA=staging`.

## Keeping staging in step

A new migration must be applied to both schemas. Write it for `public`, then run the
same SQL with `public.` → `staging.` and `private.` → `staging_private.`.

## Background worker

The GitHub Actions worker drains the production queue only. To process staging jobs
run it locally: `NEXT_PUBLIC_DB_SCHEMA=staging npm run worker`.
