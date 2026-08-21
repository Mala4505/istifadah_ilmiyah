-- GST recipient-compliance check (review-page-layout-redesign-plan.md §12):
-- a valid tax invoice a registered recipient can claim input tax credit
-- against must show the recipient's own GSTIN, name, and the invoice number.
-- Only fires when GST is actually charged on the bill (checked in
-- lib/jobs/handlers/extract.ts, not here).
--
-- New _ocr/_verified column pair per field, same convention every other
-- reviewer-correctable field on this table already uses (vendor_gstin_ocr/
-- _verified etc., 20260808000021).
alter table public.document_extraction
  add column if not exists buyer_gstin_ocr text,
  add column if not exists buyer_gstin_verified text,
  add column if not exists buyer_name_ocr text,
  add column if not exists buyer_name_verified text;

-- One new exception type, extending the check constraint 20260820000002 last
-- touched (same pattern: drop and re-add with the full list -- Postgres has
-- no `alter constraint add value` for a plain CHECK the way it does for an
-- enum type). A single combined type, not one per missing item (buyer GSTIN
-- / buyer name / invoice number): a bill missing all three would otherwise
-- raise three near-identical rows for what a reviewer experiences as one
-- problem ("this tax invoice isn't ITC-compliant").
alter table public.reconciliation_exception drop constraint if exists reconciliation_exception_exception_type_check;
alter table public.reconciliation_exception add constraint reconciliation_exception_exception_type_check
  check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_amount','department_vs_audit_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other',
    -- Phase 3 (20260814000005)
    'audit_row_unmatched','audit_ambiguous_match',
    -- vendor_email + own-GSTIN exclusion (20260814000010)
    'vendor_gstin_is_own_org',
    -- leaked tool-call tag syntax in OCR text fields (§3b)
    'ocr_leaked_tag_syntax',
    -- ingest/extraction page-count reconciliation (Phase 3, I1 + I14)
    'page_count_unresolved','page_count_mismatch',
    -- GSTIN checksum guard + per-page extraction failure isolation
    'vendor_gstin_invalid_checksum','page_extraction_failed',
    -- GST recipient-compliance check (plan §12)
    'gst_recipient_compliance_missing'
  ));

-- Extend the Day-4 save RPC to also write the two new _verified columns.
-- Same 5-arg signature as 20260821000005 left it -- `create or replace`
-- covers this (no arity change, so no drop-and-recreate needed the way an
-- arity change would require).
create or replace function private.verify_document_extraction(
  p_document_extraction_id bigint,
  p_header jsonb,       -- {vendor_name, vendor_gstin, vendor_phone, vendor_email, vendor_address,
                         --  invoice_number, invoice_date, subtotal, tax_amount, total_amount, notes,
                         --  buyer_gstin, buyer_name} -- ALL verified values, whether the reviewer
                         -- edited them or accepted the OCR value as-is (§7: "untouched = accepted
                         -- on save" still writes _verified)
  p_line_items jsonb,
  p_vendor_id bigint,
  p_expected_extraction_run_id bigint default null
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

  if p_expected_extraction_run_id is not null
     and v_current_run_id is distinct from p_expected_extraction_run_id then
    raise exception 'SAVE_CONFLICT: This document was re-extracted since you opened it — reload to see the latest version before saving.';
  end if;

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
    buyer_gstin_verified    = p_header->>'buyer_gstin',
    buyer_name_verified     = p_header->>'buyer_name',
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
  'Atomic Day-4 review-screen save (MASTER-PLAN §7, §11.2; Phase 2 plan.md §3): writes document_extraction/_line_item _verified columns and inserts rate_reference rows in one transaction. Looks the row up by document_extraction_id directly (multi-bill safe, 20260817000002). Line items use rate/discount/amount (20260820000003). p_header now also carries buyer_gstin/buyer_name (plan §12 GST recipient-compliance check). Optional p_expected_extraction_run_id (checklist 5.18) raises a SAVE_CONFLICT-prefixed exception when the document was re-extracted since the caller last read it, instead of silently last-write-wins overwriting. Re-checks reviewer/admin + department visibility itself -- see file header.';

-- PostgREST-callable wrapper -- unchanged signature, just forwards through.
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
  'Data API entry point for private.verify_document_extraction (MASTER-PLAN §7; Phase 2 plan.md §3). Takes p_document_extraction_id directly (multi-bill safe). p_header now also carries buyer_gstin/buyer_name (plan §12). Accepts p_expected_extraction_run_id (checklist 5.18) for save-conflict detection. Callable by authenticated -- unlike claim_next_job, this one really is invoked by a signed-in reviewer, so the permission checks inside the private function are load-bearing, not a formality.';
