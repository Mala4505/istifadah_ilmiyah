-- Fixes a signature-overload bug introduced by 20260821000003
-- (verify_document_extraction_conflict_check): appending a new trailing
-- parameter via `create or replace function` does NOT replace an existing
-- function when the argument list's arity changes -- Postgres matches
-- functions by full parameter signature (name + arg types + count), not by
-- name alone, so `create or replace` there silently created a SECOND
-- overload (5 args) alongside the original (4 args) instead of replacing
-- it, the same way 20260817000003's header comment warned about for a
-- parameter RENAME. Verified live on the hosted project: both
-- private.verify_document_extraction and public.verify_document_extraction
-- existed as two distinct oids each (4-arg and 5-arg) after 20260821000003
-- was pushed.
--
-- Two real problems resulted, not just clutter:
--   1. The stale 4-arg public.verify_document_extraction was still directly
--      callable by any authenticated user (its EXECUTE grant from
--      20260817000003 was never touched), completely bypassing checklist
--      5.18's save-conflict check for any caller that still invokes it with
--      only 4 arguments.
--   2. A newly created Postgres function defaults to EXECUTE granted to
--      PUBLIC unless explicitly revoked. 20260821000003 never applied this
--      codebase's usual revoke-then-grant convention to the new 5-arg
--      overloads (every other function here revokes from public/anon and
--      grants only to authenticated -- see 20260817000003, 20260813000002),
--      so the 5-arg overloads were callable by the anon role too. The
--      function body's own private.is_reviewer_or_admin() check still
--      blocks an anonymous caller in practice (auth.uid() is null for
--      anon), but the grant itself should never have been that loose.
--
-- Drop the stale 4-arg overloads outright (nothing should still be calling
-- them -- lib/actions/review.ts's saveVerification always passes all 5
-- arguments as of 20260821000003), then re-apply the standard grant
-- convention to the 5-arg overloads that remain.
drop function if exists public.verify_document_extraction(bigint, jsonb, jsonb, bigint);
drop function if exists private.verify_document_extraction(bigint, jsonb, jsonb, bigint);

revoke execute on function private.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) from public;
revoke execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) from public;
revoke execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) from anon;
grant execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) to authenticated;
