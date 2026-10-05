-- rate_reference: quantity, discount_pct, gst_rate and a true net_rate
-- (docs/report-data-gaps-plan.md Phase 1).
--
-- Until now verify_document_extraction inserted rate_reference rows with only
-- description / vendor / printed rate / unit, so:
--   * quantity was always null -> Quantity by Unit empty, family spend valued
--     at net_rate x 1;
--   * net_rate was the PRINTED rate, which on discounted lines (Astral / PVC
--     fittings at 30-55% off) is the list price, not what was paid;
--   * every re-save of a bill inserted a fresh set of rows without removing the
--     previous ones (245 line items had 2-7 copies), multiplying spend.
--
-- Rules (agreed with the user 2026-10-05 after a line-by-line check against
-- printed amounts and bill totals):
--
-- discount_pct -- the line's free-text discount, accepted only when the line
--   amount proves it was deducted: N or N% (0-100) with
--   |N - 100*(1 - amount/(qty*rate))| <= 1 point. Explicit 0 / 0.00 / 0% is 0.
--   Everything else stays null: rupee amounts, GST text ("+2.5% CGST ..."),
--   "5%"/"12%" where nothing was deducted (GST read into the discount box),
--   and numbers the amount contradicts (row-shifted OCR). Checked: all 377
--   accepted non-zero lines recompute to the printed amount within Rs 1.
--
-- gst_rate -- bills carry no stored rate (tax_breakdown.rate is always null),
--   so it is derived: tax / (subtotal - bill_discount) and tax / (total - tax),
--   each snapped to a slab (0/5/12/18/28) within 0.5 points. Taken when either
--   base hits a slab and they don't disagree. A bill with no tax amount whose
--   total equals subtotal - bill_discount charged no GST -> 0 (the
--   20260814000001 comment: zero-GST vendors are exactly what this must flag).
--   Otherwise null (misread tax, mixed-rate bills).
--
-- net_rate -- printed rate x (1 - discount_pct/100). Then, on a bill whose
--   line amounts add up to the GST-inclusive total, a line whose own
--   rate x qty x (1 - discount) equals its amount has GST inside the rate, so
--   it is divided by (1 + gst_rate/100). Lines where only the amount includes
--   GST (rate already pre-tax) are left alone -- that's most of those bills.
--
-- quantity = coalesce(quantity_verified, quantity_ocr); unit_normalized filled
-- from the line item where null.
--
-- Rows whose line_item_id was nulled by clear_bill_rate_reference_links can't
-- be traced to a line and are left as they are.

-- ---------------------------------------------------------------------------
-- Helpers (pure; shared by the back-fill and the save function so both apply
-- identical rules).
-- ---------------------------------------------------------------------------

create or replace function private.rr_discount_pct(
  p_discount text, p_qty numeric, p_rate numeric, p_amount numeric
) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v_text text := btrim(p_discount);
  v_n numeric;
begin
  if v_text is null or v_text = '' then
    return null;
  end if;
  if v_text ~ '^0+(\.0+)?\s*%?$' then
    return 0;
  end if;
  if v_text !~ '^[0-9]+(\.[0-9]+)?\s*%?$' then
    return null;
  end if;
  v_n := regexp_replace(v_text, '[^0-9.]', '', 'g')::numeric;
  if v_n > 100 or p_amount is null or coalesce(p_qty * p_rate, 0) <= 0 then
    return null;
  end if;
  if abs(v_n - 100 * (1 - p_amount / (p_qty * p_rate))) <= 1 then
    return round(v_n, 3);
  end if;
  return null;
end;
$$;

create or replace function private.rr_gst_slab(p_pct numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select s from unnest(array[0, 5, 12, 18, 28]::numeric[]) s
  where abs(p_pct - s) <= 0.5
  limit 1;
$$;

create or replace function private.rr_bill_gst_rate(
  p_subtotal numeric, p_bill_discount numeric, p_tax numeric, p_total numeric
) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v_base numeric := p_subtotal - coalesce(p_bill_discount, 0);
  v_s1 numeric;
  v_s2 numeric;
begin
  if p_tax is null then
    if p_total is not null and v_base is not null and abs(p_total - v_base) <= 1 then
      return 0;
    end if;
    return null;
  end if;
  if v_base > 0 then
    v_s1 := private.rr_gst_slab(100 * p_tax / v_base);
  end if;
  if p_total - p_tax > 0 then
    v_s2 := private.rr_gst_slab(100 * p_tax / (p_total - p_tax));
  end if;
  if v_s1 is not null and v_s2 is not null and v_s1 <> v_s2 then
    return null;
  end if;
  return coalesce(v_s1, v_s2);
end;
$$;

create or replace function private.rr_net_rate(
  p_rate numeric, p_qty numeric, p_amount numeric,
  p_discount_pct numeric, p_gst_rate numeric, p_bill_tax_inclusive boolean
) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v numeric := p_rate * (1 - coalesce(p_discount_pct, 0) / 100);
begin
  if p_bill_tax_inclusive and p_gst_rate > 0 and p_qty > 0 and p_amount is not null
     and abs(v * p_qty - p_amount) <= greatest(1, 0.005 * p_amount) then
    v := v / (1 + p_gst_rate / 100);
  end if;
  return round(v, 2);
end;
$$;

-- Bill-level figures in one place: derived GST rate, and whether the line
-- amounts add up to the GST-inclusive total.
create or replace function private.rr_bill_tax_facts(p_document_extraction_id bigint)
returns table(gst_rate numeric, tax_inclusive boolean)
language sql stable set search_path = '' as $$
  select
    private.rr_bill_gst_rate(
      coalesce(de.subtotal_verified, de.subtotal_ocr),
      coalesce(de.bill_discount_verified, de.bill_discount_ocr),
      coalesce(de.tax_amount_verified, de.tax_amount_ocr),
      coalesce(de.total_amount_verified, de.total_amount_ocr)),
    coalesce(coalesce(de.tax_amount_verified, de.tax_amount_ocr) > 1
      and abs((select sum(coalesce(li.amount_verified, li.amount_ocr))
               from public.document_extraction_line_item li
               where li.document_extraction_id = de.id)
              - coalesce(de.total_amount_verified, de.total_amount_ocr)) <= 2, false)
  from public.document_extraction de
  where de.id = p_document_extraction_id;
$$;

revoke all on function private.rr_discount_pct(text, numeric, numeric, numeric) from public;
revoke all on function private.rr_gst_slab(numeric) from public;
revoke all on function private.rr_bill_gst_rate(numeric, numeric, numeric, numeric) from public;
revoke all on function private.rr_net_rate(numeric, numeric, numeric, numeric, numeric, boolean) from public;
revoke all on function private.rr_bill_tax_facts(bigint) from public;

-- ---------------------------------------------------------------------------
-- Back-fill
-- ---------------------------------------------------------------------------

-- 1. Duplicates from re-saves: keep only the newest row per line item.
delete from public.rate_reference rr
where rr.line_item_id is not null
  and rr.id <> (select max(r2.id) from public.rate_reference r2
                where r2.line_item_id = rr.line_item_id);

-- 2. Quantity / discount / GST / net rate / unit from the line and its bill.
with src as (
  select rr.id,
    coalesce(li.quantity_verified, li.quantity_ocr) q,
    coalesce(li.rate_verified, li.rate_ocr, rr.net_rate) r,
    coalesce(li.amount_verified, li.amount_ocr) a,
    coalesce(li.discount_verified, li.discount_ocr) d,
    li.unit_normalized u,
    f.gst_rate g,
    f.tax_inclusive ti
  from public.rate_reference rr
  join public.document_extraction_line_item li on li.id = rr.line_item_id
  cross join lateral private.rr_bill_tax_facts(li.document_extraction_id) f
), calc as (
  select src.*, private.rr_discount_pct(d, q, r, a) disc from src
)
update public.rate_reference rr set
  quantity        = calc.q,
  discount_pct    = calc.disc,
  gst_rate        = calc.g,
  net_rate        = private.rr_net_rate(calc.r, calc.q, calc.a, calc.disc, calc.g, calc.ti),
  unit_normalized = coalesce(rr.unit_normalized, calc.u)
from calc
where calc.id = rr.id;

-- ---------------------------------------------------------------------------
-- private.verify_document_extraction: body from 20261004000001_bill_discount.sql
-- with the rate_reference insert moved after the line loop so it can
--   (a) replace this bill's earlier rows for the saved lines instead of piling
--       up copies, and
--   (b) write quantity / discount_pct / gst_rate / net_rate with the same
--       helpers as the back-fill above.
-- Same 5-arg signature -> create or replace, no new overload.
-- ---------------------------------------------------------------------------
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
  v_saved_ids bigint[] := '{}';
  v_updated_count int := 0;
  v_inserted_count int := 0;
  v_claimed_by uuid;
  v_claimed_at timestamptz;
  v_claimant_name text;
  v_gst_rate numeric;
  v_tax_inclusive boolean;
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
      v_saved_ids := v_saved_ids || v_line_item_id;
    end if;
  end loop;

  if p_vendor_id is not null and cardinality(v_saved_ids) > 0 then
    -- Bill-level figures read after the header + line updates above, so they
    -- reflect exactly what was just saved.
    select f.gst_rate, f.tax_inclusive into v_gst_rate, v_tax_inclusive
    from private.rr_bill_tax_facts(v_doc_extraction_id) f;

    -- A re-save replaces this bill's earlier rows for these lines rather than
    -- adding another copy of each.
    delete from public.rate_reference rr
    where rr.line_item_id = any(v_saved_ids);

    insert into public.rate_reference (
      item_description_raw, vendor_id, net_rate, unit_normalized,
      observed_date, entry_id, line_item_id,
      quantity, discount_pct, gst_rate
    )
    select
      coalesce(x.description_verified, ''),
      p_vendor_id,
      private.rr_net_rate(x.rate_verified, x.q, x.a, x.disc, v_gst_rate, v_tax_inclusive),
      x.unit_normalized,
      v_observed_date,
      v_entry_id,
      x.id,
      x.q,
      x.disc,
      v_gst_rate
    from (
      select li.id, li.description_verified, li.rate_verified, li.unit_normalized,
        coalesce(li.quantity_verified, li.quantity_ocr) q,
        coalesce(li.amount_verified, li.amount_ocr) a,
        private.rr_discount_pct(
          coalesce(li.discount_verified, li.discount_ocr),
          coalesce(li.quantity_verified, li.quantity_ocr),
          li.rate_verified,
          coalesce(li.amount_verified, li.amount_ocr)) disc
      from public.document_extraction_line_item li
      where li.id = any(v_saved_ids)
        and li.rate_verified is not null
    ) x;

    get diagnostics v_inserted_count = row_count;
  end if;

  return query select v_doc_extraction_id, v_updated_count, v_inserted_count;
end;
$function$;
