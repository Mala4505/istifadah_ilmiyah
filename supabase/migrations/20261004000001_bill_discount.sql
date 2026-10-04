-- Bill-level discount: a rupee discount printed on the WHOLE bill ("Less:
-- Discount ₹500" under the subtotal or under the grand total), as opposed to
-- document_extraction_line_item.discount_* which is a per-row discount.
--
-- One positive rupee amount, regardless of whether the vendor applied it
-- before tax (trade discount -- GST charged on subtotal - discount) or after
-- tax (on the final total). Either way the bill's arithmetic is
--   total = subtotal - bill_discount + tax + round_off
-- so one column is enough; the placement only matters to the GST-rate
-- detector, which tries both bases (lib/analytics/rules/compliance.ts).
--
-- Without this column a bill with a footer discount always tripped the
-- subtotal + tax vs total check, and reviewers had to fudge the subtotal.
-- Null = no bill-level discount, so every existing row behaves exactly as
-- before.
alter table public.document_extraction
  add column bill_discount_ocr numeric(12,2),
  add column bill_discount_verified numeric(12,2);

comment on column public.document_extraction.bill_discount_ocr is
  'Rupee discount applied to the whole bill (not a line item), as extracted. Positive number. total = subtotal - bill_discount + tax + round_off.';
comment on column public.document_extraction.bill_discount_verified is
  'Reviewer-verified bill-level discount (see bill_discount_ocr).';

-- private.verify_document_extraction: body copied verbatim from
-- 20260908000003_entry_bill_link_readers.sql, plus bill_discount_verified in
-- the header update. Same 5-arg signature, so create or replace replaces it
-- in place (no new overload -- see 20260821000005 for that trap).
create or replace function private.verify_document_extraction(p_document_extraction_id bigint, p_header jsonb, p_line_items jsonb, p_vendor_id bigint, p_expected_extraction_run_id bigint default null::bigint)
 returns table(document_extraction_id bigint, line_items_updated integer, rate_reference_rows_inserted integer)
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  v_claimed_by uuid;
  v_claimed_at timestamptz;
  v_claimant_name text;
begin
  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Verifying an extraction requires the reviewer or admin role.';
  end if;

  select de.id, de.source_document_id, de.current_extraction_run_id
    into v_doc_extraction_id, v_source_document_id, v_current_run_id
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_doc_extraction_id is null then
    raise exception 'No document_extraction row exists for id %.', p_document_extraction_id;
  end if;

  -- Primary linked entry (largest amount, id tie-break) -- the scalar
  -- attribution point for rate_reference + observed_date.
  select bpe.entry_id into v_entry_id
  from public.v_bill_primary_entry bpe
  where bpe.document_extraction_id = v_doc_extraction_id;

  if not (select private.can_see_source_document(v_source_document_id)) then
    raise exception 'You do not have visibility into source_document %.', v_source_document_id;
  end if;

  select sd.claimed_by, sd.claimed_at into v_claimed_by, v_claimed_at
  from public.source_document sd
  where sd.id = v_source_document_id;

  if v_claimed_by is not null
     and v_claimed_by is distinct from (select auth.uid())
     and v_claimed_at > now() - interval '15 minutes' then
    select sp.display_name into v_claimant_name
    from public.staff_profile sp
    where sp.id = v_claimed_by;

    raise exception 'SAVE_CONFLICT: This bill is currently claimed by % — you can''t save until you take it over.',
      coalesce(v_claimant_name, 'another reviewer');
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
    bill_discount_verified  = (p_header->>'bill_discount')::numeric,
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
$function$;
