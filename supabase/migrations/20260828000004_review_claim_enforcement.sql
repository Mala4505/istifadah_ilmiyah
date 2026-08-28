-- Hub screen certification, §3 Wave 1, item 1.8 (docs/hub-screen-certification.md):
-- "The claim is a race, is never released, never refreshed, and never
-- enforced." This migration closes the "never enforced" quarter of that
-- finding: today `private.verify_document_extraction` (last redefined by
-- 20260821000003_verify_document_extraction_conflict_check.sql, still the
-- live 5-argument signature -- 20260821000005 only dropped the stale 4-arg
-- overload, it did not touch this function's body) checks the reviewer/admin
-- role and department visibility, but never reads `source_document.claimed_by`
-- at all. Two reviewers who both have the same bill open can both call Save;
-- last write wins with no signal to either of them.
--
-- The fix mirrors the SAVE_CONFLICT pattern 20260821000003 already
-- established for the extraction-run version conflict: raise a
-- 'SAVE_CONFLICT: '-prefixed exception. lib/actions/review.ts's
-- saveVerification already does `error.message.startsWith('SAVE_CONFLICT:')`
-- and surfaces `{ ok: false, conflict: true }` from that alone -- no new
-- TS-layer variant is needed for this to reach the UI.
--
-- The check lives INSIDE this SECURITY DEFINER function, not as a separate
-- pre-check `.select()` in saveVerification, deliberately: a JS-side read
-- followed by a JS-side decision to call (or not call) the RPC leaves a
-- TOCTOU gap between the check and the RPC's actual writes. Reading the
-- claim and deciding whether to write it happen in the same transaction as
-- the write itself here.
--
-- "Held by someone else, and not stale" uses the same 15-minute window as
-- `CLAIM_STALE_AFTER_MS` / `claimReviewDocument` in lib/actions/review.ts
-- (companion fix in the same change: claimReviewDocument is rewritten there
-- to a single atomic conditional UPDATE instead of a read-then-write, and
-- review-workspace.tsx gains a release-on-unmount call and a 5-minute
-- heartbeat) -- a claim that has gone stale no longer blocks a save here,
-- same as it no longer blocks a fresh claim there.
--
-- Only the identifier/permission logic gains this one new check -- the rest
-- of the function body (the extraction-run conflict check, the
-- document_extraction/_line_item updates, the rate_reference insert) is
-- otherwise byte-for-byte identical to 20260821000003.
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
                         -- see the SAVE_CONFLICT check below. The 'SAVE_CONFLICT: '
                         -- prefix is a deliberate marker: lib/actions/review.ts's
                         -- saveVerification matches on it to distinguish this (and the
                         -- claim conflict below) from every other failure mode.
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
  v_claimed_by uuid;
  v_claimed_at timestamptz;
  v_claimant_name text;
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

  -- Hub cert 1.8 ("never enforced"): reject the save outright when this
  -- bill's source_document is actively claimed by someone else -- checked
  -- here, at write time, not just at open time (claimReviewDocument only
  -- gates entering the screen; nothing previously stopped a save once a
  -- reviewer was already in). A null claimant, our own claim, or a claim
  -- older than the standard 15-minute staleness window all pass through
  -- unblocked, matching claimReviewDocument's own three-way OR exactly.
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
  'Atomic Day-4 review-screen save (MASTER-PLAN §7, §11.2; Phase 2 plan.md §3): writes document_extraction/_line_item _verified columns and inserts rate_reference rows in one transaction. Looks the row up by document_extraction_id directly (multi-bill safe, 20260817000002). Line items use rate/discount/amount (20260820000003). Rejects with a SAVE_CONFLICT-prefixed exception when either (a) the document was re-extracted since the caller last read it (p_expected_extraction_run_id, checklist 5.18) or (b) the source_document is actively claimed by a different, non-stale reviewer (hub-screen-certification.md §3 item 1.8) -- the second check closes the TOCTOU gap a JS-side pre-check would leave, since it runs in the same transaction as the writes it guards. Re-checks reviewer/admin + department visibility itself -- see file header.';

-- public.verify_document_extraction wrapper is unchanged (same 5-arg
-- signature, same positional delegation) -- see 20260821000003 for its
-- definition. No re-create needed here.
