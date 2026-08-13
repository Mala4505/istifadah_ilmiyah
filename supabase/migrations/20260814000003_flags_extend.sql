-- Phase 2 -- widen `flags` (20260808000025) for the detectors flags-run actually ships.
--
-- §3.10 anticipated five flag types, all of them cost/pattern based. Reading the pilot
-- corpus added a second family the schema had no room for: tax and statutory compliance.
-- Those detectors need no history at all -- they fire on a single verified document -- so
-- they are the first thing flags-run can usefully do, well before ~200 documents exist.

alter table public.flags drop constraint flags_flag_type_check;
alter table public.flags add constraint flags_flag_type_check
  check (flag_type in (
    -- original five (§3.10)
    'vendor_cluster','duplicate_payment','rate_drift','discount_inconsistency',
    'missing_documentation',
    -- pattern detectors, need history
    'vendor_splitting','rate_above_benchmark',
    -- compliance detectors, fire on a single document
    'gst_not_charged','gstin_invalid','gstin_missing','gst_type_mismatch',
    'gst_rate_anomaly','tax_math_mismatch','tds_threshold'
  ));

alter table public.flags
  -- Several new detectors are about a VENDOR across many entries, not about one entry.
  -- vendor_splitting and tds_threshold have no single entry_id to point at -- entry_id
  -- stays null on those rows and related_entry_ids carries the set.
  add column vendor_id bigint references public.vendor(id),
  -- The numbers behind the description, so the UI can show the working rather than a
  -- sentence, and so a dismissed flag can be re-justified months later without re-deriving
  -- it. Shape is per detector, e.g. for tds_threshold:
  --   {"threshold": 100000, "cumulative": 92436, "window": "FY2025-26", "bill_count": 4}
  add column evidence jsonb,
  -- flags-run is idempotent via the unique dedup_key: a re-run upserts and bumps this
  -- rather than inserting a duplicate or erroring. created_at therefore keeps meaning
  -- "first seen", which is what ageing a flag depends on.
  add column last_detected_at timestamptz not null default now();

create index flags_vendor_idx on public.flags (vendor_id) where vendor_id is not null;
-- The open-flags screen groups by type; the existing flags_open_idx leads with status and
-- severity, so a per-type count still scans every open row without this.
create index flags_type_open_idx on public.flags (flag_type, severity)
  where status = 'open';

-- ----------------------------------------------------------------------------
-- Idempotent upsert used by flags-run.
-- ----------------------------------------------------------------------------
-- Kept as a function rather than inline SQL in the worker because the conflict target and
-- the "never resurrect a dismissed flag" rule are easy to get subtly wrong, and getting
-- them wrong means a reviewer's dismissal silently reappears in their queue on the next
-- run -- the single fastest way to make people stop trusting the tool.
create or replace function public.upsert_flag(
  p_flag_type text,
  p_dedup_key text,
  p_description text,
  p_severity text default 'medium',
  p_entry_id bigint default null,
  p_related_entry_ids bigint[] default null,
  p_vendor_id bigint default null,
  p_amount_at_risk numeric default null,
  p_evidence jsonb default null,
  p_detected_by_run text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into public.flags (
    flag_type, dedup_key, description, severity, entry_id, related_entry_ids,
    vendor_id, amount_at_risk, evidence, detected_by_run, last_detected_at
  ) values (
    p_flag_type, p_dedup_key, p_description, p_severity, p_entry_id, p_related_entry_ids,
    p_vendor_id, p_amount_at_risk, p_evidence, p_detected_by_run, now()
  )
  on conflict (dedup_key) do update set
    -- Refresh the facts: amounts and evidence legitimately change as more documents land
    -- against the same vendor (a splitting flag's total grows with each new bill).
    description      = excluded.description,
    severity         = excluded.severity,
    amount_at_risk   = excluded.amount_at_risk,
    evidence         = excluded.evidence,
    related_entry_ids = excluded.related_entry_ids,
    detected_by_run  = excluded.detected_by_run,
    last_detected_at = now()
    -- status, resolved_by and resolved_at are deliberately absent from the SET list. A
    -- confirmed or dismissed flag keeps its human verdict; the run updates the evidence
    -- underneath it but never reopens it.
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_flag(
  text, text, text, text, bigint, bigint[], bigint, numeric, jsonb, text) from public, authenticated;
grant execute on function public.upsert_flag(
  text, text, text, text, bigint, bigint[], bigint, numeric, jsonb, text) to service_role;
