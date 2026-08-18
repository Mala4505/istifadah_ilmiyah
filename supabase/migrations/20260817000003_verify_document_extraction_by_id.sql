-- Phase 2 (plan.md §3): supersedes private.verify_document_extraction /
-- public.verify_document_extraction (20260813000002, extended by
-- 20260814000011 for vendor_email) to look up the row by
-- document_extraction_id directly instead of by source_document_id.
--
-- Now that document_extraction.source_document_id is no longer unique
-- (20260817000002_document_extraction_multi_bill.sql), the old
-- `where de.source_document_id = p_source_document_id` lookup is ambiguous
-- on any multi-bill document -- it would resolve to whichever row Postgres
-- happens to return first. The review screen already knows exactly which
-- document_extraction it has open (lib/review/types.ts's
-- ReviewDocumentDetail.documentExtractionId), so the RPC takes that id
-- directly rather than re-deriving it.
--
-- Only the identifier logic changes here -- the update statements, the
-- rate_reference insert, and the permission checks are otherwise identical
-- to 20260814000011.
--
-- Postgres rejects `create or replace function` when it changes an input
-- parameter's NAME (even with identical argument types): "cannot change
-- name of input parameter" (SQLSTATE 42P13) -- a guard against silently
-- breaking existing named-argument callers. Renaming
-- p_source_document_id -> p_document_extraction_id therefore needs an
-- explicit drop first; the grants a plain `create or replace` would have
-- preserved are reapplied explicitly at the end of this file instead.
drop function if exists public.verify_document_extraction(bigint, jsonb, jsonb, bigint);
drop function if exists private.verify_document_extraction(bigint, jsonb, jsonb, bigint);

create function private.verify_document_extraction(
  p_document_extraction_id bigint,
  p_header jsonb,       -- {vendor_name, vendor_gstin, vendor_phone, vendor_email, vendor_address,
                         --  invoice_number, invoice_date, subtotal, tax_amount,
                         --  total_amount, notes} -- ALL verified values, whether the
                         -- reviewer edited them or accepted the OCR value as-is
                         -- (§7: "untouched = accepted on save" still writes _verified,
                         -- it just isn't counted as a correction by the accuracy
                         -- harness, which compares _ocr vs _verified downstream --
                         -- nothing this function does needs to know which is which)
  p_line_items jsonb,   -- [{id, description, hsn_sac_code, quantity, quantity_raw_text,
                         --   unit, unit_normalized, list_rate, discount_pct,
                         --   discount_note, net_rate, line_amount}, ...] -- `id` must be
                         -- an existing document_extraction_line_item row under this
                         -- document; rows for other documents are silently skipped
                         -- (the `and li.document_extraction_id = v_doc_extraction_id`
                         -- guard below), never touched
  p_vendor_id bigint     -- resolved vendor for rate_reference attribution (§3.10):
                         -- the matched entry's vendor_id by default, or whatever the
                         -- reviewer picked/overrode via the `/` autocomplete. Nullable
                         -- because rate_reference.vendor_id is NOT NULL and a document
                         -- with no resolved vendor yet simply gets no rate_reference
                         -- rows this save -- documented in the Day 4 report as a
                         -- deviation, not a silent gap.
) returns table (
  document_extraction_id bigint,
  line_items_updated int,
  rate_reference_rows_inserted int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_extraction_id bigint;
  v_source_document_id bigint;
  v_entry_id bigint;
  v_observed_date date;
  v_item jsonb;
  v_line_item_id bigint;
  v_updated_count int := 0;
  v_inserted_count int := 0;
begin
  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Verifying an extraction requires the reviewer or admin role.';
  end if;

  select de.id, de.source_document_id, de.entry_id
    into v_doc_extraction_id, v_source_document_id, v_entry_id
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_doc_extraction_id is null then
    raise exception 'No document_extraction row exists for id %.', p_document_extraction_id;
  end if;

  if not (select private.can_see_source_document(v_source_document_id)) then
    raise exception 'You do not have visibility into source_document %.', v_source_document_id;
  end if;

  -- rate_reference.observed_date: the matched entry's own date when there is one,
  -- otherwise today -- there is no invoice date to fall back on that isn't itself
  -- part of what's being verified in the same statement below.
  if v_entry_id is not null then
    select e.date into v_observed_date from public.entries e where e.id = v_entry_id;
  end if;
  v_observed_date := coalesce(v_observed_date, current_date);

  update public.document_extraction de set
    vendor_name_verified    = p_header->>'vendor_name',
    vendor_gstin_verified   = p_header->>'vendor_gstin',
    vendor_phone_verified   = p_header->>'vendor_phone',
    vendor_email_verified   = p_header->>'vendor_email',
    vendor_address_verified = p_header->>'vendor_address',
    invoice_number_verified = p_header->>'invoice_number',
    invoice_date_verified   = (p_header->>'invoice_date')::date,
    subtotal_verified       = (p_header->>'subtotal')::numeric,
    tax_amount_verified     = (p_header->>'tax_amount')::numeric,
    total_amount_verified   = (p_header->>'total_amount')::numeric,
    notes_verified          = p_header->>'notes',
    verified_at             = now(),
    verified_by             = (select auth.uid())
  where de.id = v_doc_extraction_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb))
  loop
    v_line_item_id := (v_item->>'id')::bigint;

    update public.document_extraction_line_item li set
      description_verified      = v_item->>'description',
      hsn_sac_code_verified      = v_item->>'hsn_sac_code',
      quantity_verified          = (v_item->>'quantity')::numeric,
      quantity_raw_text_verified = v_item->>'quantity_raw_text',
      unit_verified              = v_item->>'unit',
      unit_normalized            = v_item->>'unit_normalized',
      list_rate_verified         = (v_item->>'list_rate')::numeric,
      discount_pct_verified      = (v_item->>'discount_pct')::numeric,
      discount_note_verified     = v_item->>'discount_note',
      net_rate_verified          = (v_item->>'net_rate')::numeric,
      line_amount_verified       = (v_item->>'line_amount')::numeric
    where li.id = v_line_item_id
      and li.document_extraction_id = v_doc_extraction_id;

    if found then
      v_updated_count := v_updated_count + 1;

      if p_vendor_id is not null and (v_item->>'net_rate') is not null then
        insert into public.rate_reference (
          item_description_raw, vendor_id, net_rate, unit_normalized,
          discount_pct, observed_date, entry_id, line_item_id
        ) values (
          coalesce(v_item->>'description', ''),
          p_vendor_id,
          (v_item->>'net_rate')::numeric,
          v_item->>'unit_normalized',
          (v_item->>'discount_pct')::numeric,
          v_observed_date,
          v_entry_id,
          v_line_item_id
        );
        v_inserted_count := v_inserted_count + 1;
      end if;
    end if;
  end loop;

  return query select v_doc_extraction_id, v_updated_count, v_inserted_count;
end;
$$;

comment on function private.verify_document_extraction(bigint, jsonb, jsonb, bigint) is
  'Atomic Day-4 review-screen save (MASTER-PLAN §7, §11.2; Phase 2 plan.md §3): writes document_extraction/_line_item _verified columns and inserts rate_reference rows in one transaction. Looks the row up by document_extraction_id directly (multi-bill safe, 20260817000002) rather than by source_document_id. Re-checks reviewer/admin + department visibility itself -- see file header.';

-- PostgREST-callable wrapper. Same argument TYPES as before (bigint, jsonb,
-- jsonb, bigint) -- dropped above alongside the private function, for the
-- same input-parameter-rename reason.
create function public.verify_document_extraction(
  p_document_extraction_id bigint,
  p_header jsonb,
  p_line_items jsonb,
  p_vendor_id bigint default null
) returns table (
  document_extraction_id bigint,
  line_items_updated int,
  rate_reference_rows_inserted int
)
language sql
security definer
set search_path = ''
as $$
  select * from private.verify_document_extraction(
    p_document_extraction_id, p_header, p_line_items, p_vendor_id
  );
$$;

comment on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint) is
  'Data API entry point for private.verify_document_extraction (MASTER-PLAN §7; Phase 2 plan.md §3). Takes p_document_extraction_id directly (multi-bill safe). Callable by authenticated -- unlike claim_next_job, this one really is invoked by a signed-in reviewer, so the permission checks inside the private function are load-bearing, not a formality.';

-- Grants are NOT carried over by `drop` + `create` the way `create or
-- replace` would have preserved them -- reapply the same grants
-- 20260813000002 set up originally.
revoke execute on function private.verify_document_extraction(bigint, jsonb, jsonb, bigint) from public;
revoke execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint) from public;
revoke execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint) from anon;
grant execute on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint) to authenticated;
