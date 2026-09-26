-- One-time backfill: populate entries.settles_entry_id for Invoice Against
-- Uplaq (IAU) rows, linking each back to the Advance Payment row it settles,
-- wherever that link is unambiguous. Also wires the same rule into future
-- imports (lib/import/run-portal-import.ts, importDepartmentalRow's
-- invoice_against_uplaq branch) -- this migration only covers the corpus that
-- already exists.
--
-- ---------------------------------------------------------------------------
-- WHY THIS WAS SAFE TO AUTOMATE NOW, WHEN 20260828000002 REFUSED TO
--
-- 20260828000002's own comment explains the original refusal: the IAU list
-- view renders nothing that identifies which advance a row settles, so the
-- only available correspondence is vendor + budget head -- "fuzzy financial
-- linkage... a wrong guess produces a confident wrong answer." That is still
-- true in the ambiguous case. What changed is the finance admin (this
-- organization's own user, 2026-09-26) explicitly asked for the UNAMBIGUOUS
-- case to be auto-linked, with a human flagged only when it is genuinely
-- ambiguous -- i.e. the same fuzzy signal, but now only acted on when it
-- resolves to exactly one answer, and escalated (never guessed) otherwise.
--
-- THE RULE
--
--   For a given open IAU row (type = 'invoice_against_uplaq', is_void =
--   false, settles_entry_id is null), look at every OPEN Advance Payment row
--   (type = 'advance_payment', is_void = false, not already referenced by any
--   other row's settles_entry_id) sharing the same vendor_raw (exact text
--   match) and the same budget_head_id:
--
--     - exactly one such advance  -> link (settles_entry_id := that advance's id)
--     - zero                      -> leave alone; a final invoice that never
--                                     had a tracked advance is legitimate, not
--                                     an error.
--     - more than one             -> leave settles_entry_id null and raise an
--                                     `advance_settlement_ambiguous` exception
--                                     naming every candidate, for a human to
--                                     pick.
--
-- EDGE CASE THE NAIVE SET-BASED VERSION OF THIS WOULD GET WRONG
--
-- A plain "join IAU to advances on vendor_raw/budget_head_id where the
-- advance-side group has exactly one member" query is not enough by itself:
-- if TWO unlinked IAU rows share the same (vendor_raw, budget_head_id) and
-- there is only one open advance under it, that naive join hands the SAME
-- advance id to both IAU rows -- two entries silently claiming one advance,
-- exactly the "confident wrong answer" this feature exists to avoid.
--
-- So step 1 below (the auto-link) requires uniqueness on BOTH sides: exactly
-- one open candidate advance for that (vendor_raw, budget_head_id), AND
-- exactly one still-unlinked IAU row for that same (vendor_raw,
-- budget_head_id). Two IAU rows contesting one advance therefore auto-links
-- neither -- and step 2 (the exception) picks that case up too: it re-joins
-- AFTER the auto-link update, so any IAU row still unlinked that matches at
-- least one open advance (whether because there were genuinely 2+ advances,
-- or because it lost a one-advance contest to a sibling IAU row) gets an
-- `advance_settlement_ambiguous` exception naming the candidate(s). Only an
-- IAU row matching ZERO open advances comes through step 2 untouched.
-- ---------------------------------------------------------------------------

begin;

-- ---- 1. auto-link the unambiguous 1:1 pairings ---------------------------
with candidate_advances as (
  select
    a.id,
    a.vendor_raw,
    a.budget_head_id,
    count(*) over (partition by a.vendor_raw, a.budget_head_id) as advance_group_count
  from public.entries a
  where a.type = 'advance_payment'
    and a.is_void = false
    and a.vendor_raw is not null
    and a.budget_head_id is not null
    -- "open": no row anywhere already settles against this advance.
    and not exists (
      select 1 from public.entries s where s.settles_entry_id = a.id
    )
),
unlinked_iau as (
  select
    i.id,
    i.vendor_raw,
    i.budget_head_id,
    count(*) over (partition by i.vendor_raw, i.budget_head_id) as iau_group_count
  from public.entries i
  where i.type = 'invoice_against_uplaq'
    and i.is_void = false
    and i.settles_entry_id is null
    and i.vendor_raw is not null
    and i.budget_head_id is not null
),
unique_pairs as (
  select i.id as iau_id, a.id as advance_id
  from unlinked_iau i
  join candidate_advances a
    on a.vendor_raw = i.vendor_raw
   and a.budget_head_id = i.budget_head_id
  where a.advance_group_count = 1  -- exactly one open advance for this vendor+head
    and i.iau_group_count = 1      -- exactly one unlinked IAU row for this vendor+head
                                    -- (see header: without this, two IAU rows sharing
                                    -- one advance would both grab it)
)
update public.entries e
   set settles_entry_id = up.advance_id,
       updated_at = now()
  from unique_pairs up
 where e.id = up.iau_id;

-- ---- 2. extend the exception_type CHECK with the new value ---------------
-- Same drop-and-readd-the-full-list pattern as every prior migration that has
-- touched this constraint (Postgres has no `ALTER CONSTRAINT ADD VALUE` for a
-- plain CHECK). Base list copied verbatim from 20260919000001 -- the most
-- recent migration to redefine it (confirmed by grepping supabase/migrations/
-- for `reconciliation_exception_exception_type_check`) -- plus one new value.
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
    'gst_recipient_compliance_missing',
    -- meta-commentary landing in an OCR text field (finding 10.1)
    'ocr_meta_commentary',
    -- entries type-split: bookmarklet-detected tab kind vs UBBL-prefix rule disagree
    'entry_type_kind_mismatch',
    -- our own GSTIN/name missing on a non-tax bill (plan §12 recipient-identity expansion)
    'recipient_identity_missing',
    -- checksum-failing recipient GSTIN, kept as-read for the reviewer (2026-09-07)
    'buyer_gstin_invalid_checksum',
    -- per-line quantity x rate vs amount reconciliation (2026-09-07)
    'line_item_row_math_mismatch',
    -- manual Review-page flag reasons (2026-09-11)
    'not_clear','not_visible',
    -- departmental entry present before but now missing from the portal feed (2026-09-19)
    'departmental_entry_missing_from_portal',
    -- an IAU row has zero or multiple candidate advances to settle against,
    -- or lost a one-advance contest to a sibling IAU row (2026-09-26)
    'advance_settlement_ambiguous'
  ));

-- ---- 3. raise a reconciliation_exception for every remaining ambiguous row -
-- Re-joins AFTER step 1's update, so this only sees IAU rows step 1 left
-- unlinked. An IAU row that matches zero open advances never appears here
-- (inner join) -- the legitimate "final invoice with no tracked advance"
-- case, which needs no human attention.
with remaining_candidates as (
  select
    i.id as iau_entry_id,
    i.vendor_raw,
    i.budget_head_id,
    array_agg(a.ubbl_number order by a.ubbl_number) as candidate_ubbl_numbers,
    count(*) as candidate_count
  from public.entries i
  join public.entries a
    on a.type = 'advance_payment'
   and a.is_void = false
   and a.vendor_raw = i.vendor_raw
   and a.budget_head_id = i.budget_head_id
   and not exists (
     select 1 from public.entries s where s.settles_entry_id = a.id
   )
  where i.type = 'invoice_against_uplaq'
    and i.is_void = false
    and i.settles_entry_id is null
    and i.vendor_raw is not null
    and i.budget_head_id is not null
  group by i.id, i.vendor_raw, i.budget_head_id
)
insert into public.reconciliation_exception (entry_id, exception_type, severity, description, dedup_key)
select
  rc.iau_entry_id,
  'advance_settlement_ambiguous',
  'medium',
  'IAU entry for vendor "' || rc.vendor_raw || '", budget head "' ||
    coalesce(bh.raw_label, 'id ' || rc.budget_head_id::text) || '" has ' ||
    rc.candidate_count || ' possible advance payment(s) it could settle: ' ||
    array_to_string(rc.candidate_ubbl_numbers, ', ') ||
    '. Pick the correct advance manually and set settles_entry_id.',
  'advance_settlement_ambiguous:' || rc.iau_entry_id
from remaining_candidates rc
left join public.budget_head bh on bh.id = rc.budget_head_id
on conflict (dedup_key) do nothing;

commit;
