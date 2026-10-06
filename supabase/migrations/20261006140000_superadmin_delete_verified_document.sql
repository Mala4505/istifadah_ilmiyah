-- Superadmin may delete a document even after its extraction was verified.
--
-- 20260820000001 refused any document with a verified extraction, for every
-- role. Direct instruction: a superadmin deleting a reviewed document should
-- remove everything that came from that PDF -- pages, OCR runs, extractions,
-- line items, exceptions, entry-bill links, rate history, queued jobs -- but
-- NEVER the entries themselves. An entry is a booked financial row from the
-- hub; it only loses its link to the deleted bill and goes back to showing
-- "no document".
--
-- Admins keep the old guard: they still get the restrict_violation and must
-- cancel instead.
--
-- What the delete reaches (everything else already cascades from
-- source_document, see 20260820000001's notes):
--
--   * rate_reference.line_item_id -> document_extraction_line_item is NO
--     ACTION. Unverified documents never have rate_reference rows, which is
--     why the old function didn't need this; verified ones do, and the
--     line-item delete below would fail on 23503 without it. Those rows are
--     derived from this document's OCR line items, so they go with it.
--   * entry_bill_link cascades from both source_document and
--     document_extraction -- link rows only; `entries` is not touched by any
--     cascade or trigger on this path.

create or replace function private.delete_source_document(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
begin
  if not (select private.is_superadmin()) and exists (
    select 1 from public.document_extraction de
     where de.source_document_id = p_id and de.verified_at is not null
  ) then
    raise exception 'source_document % has a verified extraction and cannot be deleted; cancel it instead', p_id
      using errcode = 'restrict_violation';
  end if;

  -- Rate history derived from this document's line items (NO ACTION edge).
  delete from public.rate_reference rr
   using public.document_extraction_line_item li
     join public.document_extraction de on de.id = li.document_extraction_id
   where rr.line_item_id = li.id
     and de.source_document_id = p_id;

  -- Clears the two NO ACTION edges described in 20260820000001. Matched via
  -- the extraction as well as the page, since a line item's page id can be null.
  delete from public.document_extraction_line_item li
   using public.document_extraction de
   where li.document_extraction_id = de.id
     and de.source_document_id = p_id;

  delete from public.document_extraction_line_item li
   using public.document_page dp
   where li.document_page_id = dp.id
     and dp.source_document_id = p_id;

  -- Document-scoped exceptions the cascade cannot reach.
  delete from public.reconciliation_exception
   where dedup_key like '%:' || p_id::text;

  -- Stops any worker from extracting a document that no longer exists.
  delete from public.job_queue
   where (payload->>'source_document_id')::bigint = p_id;

  delete from public.source_document
   where id = p_id
   returning storage_path into v_storage_path;

  return v_storage_path;
end;
$$;
