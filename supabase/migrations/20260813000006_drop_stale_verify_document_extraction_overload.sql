-- 20260813000002_verify_document_extraction.sql shipped the current
-- verify_document_extraction(p_source_document_id, p_header, p_line_items,
-- p_vendor_id) RPC, which lib/actions/review.ts calls. An earlier prototype
-- with a different signature -- verify_document_extraction(
-- p_document_extraction_id, p_header, p_line_items, p_vendor_display_name,
-- p_vendor_normalized_name) -- was applied directly to the remote project
-- ahead of that migration and never dropped. `supabase db advisors` flags it
-- (2026-08-13 Phase 1A verification pass): a second, unused SECURITY DEFINER
-- function exposed over PostgREST is attack surface with no caller. Dead
-- code, not a second code path -- drop both the public wrapper and the
-- private implementation.
drop function if exists public.verify_document_extraction(
  bigint, jsonb, jsonb, text, text
);
drop function if exists private.verify_document_extraction(
  bigint, jsonb, jsonb, text, text
);
