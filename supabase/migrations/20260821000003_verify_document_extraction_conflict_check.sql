-- Checklist 5.18 (docs/import-review-ux-checklist.md Phase 5; plan §13 V1):
-- save-conflict detection against document_extraction.current_extraction_run_id.
-- Today the save RPC is last-write-wins: if a re-extraction (Shift+R) swaps
-- in a new ocr_extraction_run while a reviewer already has the old form open,
-- saving their corrections silently overwrites _verified columns against a
-- document that has moved on, with no signal at all.
--
-- Appends p_expected_extraction_run_id as a NEW LAST parameter with a
-- default, rather than renaming or reordering anything -- `create or replace
-- function` rejects a parameter rename outright ("cannot change name of
-- input parameter", SQLSTATE 42P13; see 20260817000003's header comment for
-- why that migration needed an explicit drop instead). Adding one new
-- trailing parameter with a default is exactly the case `create or replace`
-- supports, and it preserves every existing call site -- lib/actions/review.ts's
-- saveVerification (updated in this same change) now always passes it, but
-- the default keeps any other hypothetical caller working unchanged. Grants
-- also survive `create or replace` (unlike drop + create), so nothing needs
-- reapplying here.
--
-- ReviewDocumentDetail.currentExtractionRunId (lib/review/types.ts) already
-- captures the extraction run a reviewer's browser was showing when the page
-- loaded -- it's the natural version token to compare against, no new column
-- needed.
create or replace function private.verify_document_extraction(
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
                         --   unit, unit_normalized, rate, discount, amount}, ...] -- `id`
                         -- must be an existing document_extraction_line_item row under
                         -- this document; rows for other documents are silently skipped
                         -- (the `and li.document_extraction_id = v_doc_extraction_id`
                         -- guard below), never touched
  p_vendor_id bigint,    -- resolved vendor for rate_reference attribution (§3.10):
                         -- the matched entry's vendor_id by default, or whatever the
                         -- reviewer picked/overrode via the `/` autocomplete. Nullable
                         -- because rate_reference.vendor_id is NOT NULL and a document
                         -- with no resolved vendor yet simply gets no rate_reference
                         -- rows this save -- documented in the Day 4 report as a
                         -- deviation, not a silent gap.
  p_expected_extraction_run_id bigint default null
                         -- checklist 5.18: the extraction run the caller's form was
                         -- built from. NULL skips the check entirely (back-compat).
                         -- When non-null and it no longer matches the row's current
                         -- current_extraction_run_id, this raises rather than writes --
                         -- see the SAVE_CONFLICT check just after the row is resolved
                         -- below. The 'SAVE_CONFLICT: ' prefix is a deliberate marker:
                         -- lib/actions/review.ts's saveVerification matches on it to
                         -- distinguish this from every other failure mode.
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
  v_current_run_id bigint;
  v_observed_date date;
  v_item jsonb;
  v_line_item_id bigint;
  v_updated_count int := 0;
  v_inserted_count int := 0;
begin
  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Verifying an extraction requires the reviewer or admin role.';
  end if;

  select de.id, de.source_document_id, de.entry_id, de.current_extraction_run_id
    into v_doc_extraction_id, v_source_document_id, v_entry_id, v_current_run_id
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_doc_extraction_id is null then
    raise exception 'No document_extraction row exists for id %.', p_document_extraction_id;
  end if;

  if not (select private.can_see_source_document(v_source_document_id)) then
    raise exception 'You do not have visibility into source_document %.', v_source_document_id;
  end if;

  -- Checklist 5.18: compare BEFORE writing anything -- a re-extraction since
  -- the caller opened this document means their corrections were made
  -- against OCR text that no longer exists as "current," so the whole save
  -- is rejected rather than partially applied.
  if p_expected_extraction_run_id is not null
     and v_current_run_id is distinct from p_expected_extraction_run_id then
    raise exception 'SAVE_CONFLICT: This document was re-extracted since you opened it — reload to see the latest version before saving.';
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
      rate_verified              = (v_item->>'rate')::numeric,
      discount_verified          = v_item->>'discount',
      amount_verified            = (v_item->>'amount')::numeric
    where li.id = v_line_item_id
      and li.document_extraction_id = v_doc_extraction_id;

    if found then
      v_updated_count := v_updated_count + 1;

      if p_vendor_id is not null and (v_item->>'rate') is not null then
        insert into public.rate_reference (
          item_description_raw, vendor_id, net_rate, unit_normalized,
          observed_date, entry_id, line_item_id
        ) values (
          coalesce(v_item->>'description', ''),
          p_vendor_id,
          (v_item->>'rate')::numeric,
          v_item->>'unit_normalized',
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

comment on function private.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) is
  'Atomic Day-4 review-screen save (MASTER-PLAN §7, §11.2; Phase 2 plan.md §3): writes document_extraction/_line_item _verified columns and inserts rate_reference rows in one transaction. Looks the row up by document_extraction_id directly (multi-bill safe, 20260817000002). Line items use rate/discount/amount (20260820000003). Optional p_expected_extraction_run_id (checklist 5.18) raises a SAVE_CONFLICT-prefixed exception when the document was re-extracted since the caller last read it, instead of silently last-write-wins overwriting. Re-checks reviewer/admin + department visibility itself -- see file header.';

-- PostgREST-callable wrapper -- same append, same reasoning.
create or replace function public.verify_document_extraction(
  p_document_extraction_id bigint,
  p_header jsonb,
  p_line_items jsonb,
  p_vendor_id bigint default null,
  p_expected_extraction_run_id bigint default null
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
    p_document_extraction_id, p_header, p_line_items, p_vendor_id, p_expected_extraction_run_id
  );
$$;

comment on function public.verify_document_extraction(bigint, jsonb, jsonb, bigint, bigint) is
  'Data API entry point for private.verify_document_extraction (MASTER-PLAN §7; Phase 2 plan.md §3). Takes p_document_extraction_id directly (multi-bill safe). Now also accepts p_expected_extraction_run_id (checklist 5.18) for save-conflict detection. Callable by authenticated -- unlike claim_next_job, this one really is invoked by a signed-in reviewer, so the permission checks inside the private function are load-bearing, not a formality.';
