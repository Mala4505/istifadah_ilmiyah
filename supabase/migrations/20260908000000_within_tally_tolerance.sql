-- Entries <-> Bills many-to-many, Phase 0 (plan: entry-bill links with automatic
-- variance). SQL twin of tallyWithinTolerance in lib/normalize.ts:162-167.
--
-- No consumers yet -- Phase 2's variance views and the Phase 4 reader rewrites
-- are what call this. Shipped on its own so the function exists and is reviewed
-- in isolation before anything depends on it.
--
-- PARITY CONTRACT: this function and lib/normalize.ts's tallyWithinTolerance
-- MUST stay identical. The TS side:
--   const diff = Math.abs(a - b)
--   const larger = Math.max(Math.abs(a), Math.abs(b))
--   const tolerance = Math.min(1, larger * 0.0005)
--   return diff <= tolerance
-- i.e. the tighter of a flat Rs.1 cap and 0.05% of the larger magnitude. The
-- integration test asserts row-for-row parity against the TS implementation --
-- change one side, change the other, and re-run vitest.integration.
--
-- Null handling: tallyWithinTolerance returns false for a NaN comparison (a or b
-- undefined). This function mirrors that -- a null operand is "not within
-- tolerance", never null -- so callers can use it in WHERE / CASE without an
-- extra coalesce.
--
-- Schema note: the plan named this private.within_tally_tolerance, but the
-- Phase 2 / Phase 4 variance views are `security_invoker` and call it directly
-- in their SELECT lists -- that needs USAGE on the schema + EXECUTE on the
-- function for the `authenticated` role, which the `private` schema
-- deliberately does not grant (it is reachable only from RLS policies, triggers
-- and other SECURITY DEFINER functions). It is a pure, security-inert math
-- function, so it lives in `public`; PostgREST exposing it as an RPC is
-- harmless.

create or replace function public.within_tally_tolerance(a numeric, b numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when a is null or b is null then false
    else abs(a - b) <= least(1, greatest(abs(a), abs(b)) * 0.0005)
  end;
$$;

comment on function public.within_tally_tolerance(numeric, numeric) is
  'SQL twin of tallyWithinTolerance (lib/normalize.ts:162-167). Tighter of a flat Rs.1 cap and 0.05%% of the larger magnitude. Null operand => false. Keep in lockstep with the TS side; parity asserted in vitest.integration.';
