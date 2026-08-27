-- Entries type-split: class-table inheritance (Option C), per
-- docs plan "entries type-split: class-table inheritance". `entries` stays
-- the single shared identity table; reimbursement and advance_payment each
-- get a thin 1:1 extension table holding only the columns their Dept-module
-- tab has that invoice-shaped `entries` does not. Invoice needs no
-- extension table -- every column its tab has already exists on `entries`.
--
-- entry_id is the PK (not a separate surrogate id): the relationship is
-- strictly 1:1, enforced by FK'ing straight to entries(id).
create table public.reimbursement_detail (
  entry_id bigint primary key references public.entries(id),
  sr_no text,
  reimbursement_type text,
  reimburse_to_raw text,
  reimburse_to_vendor_id bigint references public.vendor(id),
  import_batch_id bigint references public.import_batch(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.advance_payment_detail (
  entry_id bigint primary key references public.entries(id),
  -- entries.amount already holds Uplaq Amount for advance_payment rows, per
  -- the user's decision -- this column holds the tab's separate Invoice
  -- Amount figure.
  invoice_amount numeric(14,2),
  import_batch_id bigint references public.import_batch(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger reimbursement_detail_set_updated_at before update on public.reimbursement_detail
  for each row execute function private.set_updated_at();
create trigger advance_payment_detail_set_updated_at before update on public.advance_payment_detail
  for each row execute function private.set_updated_at();

alter table public.reimbursement_detail enable row level security;
alter table public.advance_payment_detail enable row level security;

-- Mirrors entries_select's exact department-scoped shape (20260819000003's
-- private.can_see_department, which already short-circuits for
-- admin/superadmin) via a join back to entries. No insert/update policy for
-- `authenticated` -- both tables are populated only by the import
-- pipeline's `pg` client, which connects with the service role and bypasses
-- RLS, same as `entries` rows from import are today.
create policy reimbursement_detail_select on public.reimbursement_detail
  for select to authenticated
  using (exists (
    select 1 from public.entries e
     where e.id = entry_id and (select private.can_see_department(e.department_id))
  ));

create policy advance_payment_detail_select on public.advance_payment_detail
  for select to authenticated
  using (exists (
    select 1 from public.entries e
     where e.id = entry_id and (select private.can_see_department(e.department_id))
  ));

-- One new reconciliation_exception type: a scraped row's UBBL-prefix rule
-- (deriveEntryType) disagreeing with the Dept-module tab it was actually
-- scraped from (detectDepartmentalTableKind). Flag, don't block -- same
-- "flag, don't block" pattern already used for unknown_status_code /
-- allocation_sum_mismatch. Extending the check constraint the same way
-- every migration that has touched it does: drop and re-add with the full
-- list (built from the LIVE definition, 20260825000001, the most recent
-- migration to touch this constraint -- Postgres has no `alter constraint
-- add value` for a plain CHECK the way it does for an enum type).
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
    'entry_type_kind_mismatch'
  ));

-- Widen v_entry_enriched (successor to 20260825000007_entry_enriched_sub_department.sql,
-- last migration-tracked version -- confirmed no later migration touches this
-- view) with the reimbursement/advance-payment detail columns, so they are
-- visible/exportable anywhere the enriched view is read without a second
-- query. CREATE OR REPLACE VIEW only tolerates appending columns after the
-- existing last column (same constraint 20260825000007 and 20260822000011
-- both document), so these three land at the very end.
create or replace view public.v_entry_enriched with (security_invoker = true) as
select
  e.id,
  e.type,
  e.ubbl_number,
  e.main_number,
  e.department_id,
  d.name as department_name,
  e.budget_head_id,
  bh.raw_label as budget_head_raw_label,
  bh.short_label as budget_head_short_label,
  e.invoice_number,
  e.vendor_id,
  v.display_name as vendor_display_name,
  e.vendor_raw,
  e.date,
  e.amount,
  e.variance_reason,
  e.status_id,
  st.code as status_code,
  st.label as status_label,
  e.audit_status_id,
  ast.code as audit_status_code,
  ast.label as audit_status_label,
  e.status_raw,
  e.audit_status_raw,
  e.admin_head_id,
  ah.name as admin_head_name,
  e.zone_id,
  z.name as zone_name,
  e.cost_center_id,
  cc.name as cost_center_name,
  e.remark,
  -- hub_status_* columns unchanged/deferred, see 20260811000003's header
  e.hub_status_id,
  hs.code as hub_status_code,
  hs.label as hub_status_label,
  e.hub_status_changed_at,
  e.hub_status_changed_by,
  e.hub_status_note,
  e.hub_status_exported_at,
  e.audit_status_changed_at,
  e.audit_status_changed_by,
  e.settles_entry_id,
  e.is_void,
  e.source,
  e.import_batch_id,
  e.created_at,
  e.updated_at,
  coalesce(doc.document_count, 0) as document_count,
  e.event_id,
  e.sub_department_id,
  sub.name as sub_department_name,
  rd.sr_no as reimbursement_sr_no,
  rd.reimbursement_type,
  rd.reimburse_to_raw,
  apd.invoice_amount as advance_invoice_amount
from public.entries e
left join public.department d on d.id = e.department_id
left join public.budget_head bh on bh.id = e.budget_head_id
left join public.vendor v on v.id = e.vendor_id
left join public.entry_status st on st.id = e.status_id
left join public.entry_status ast on ast.id = e.audit_status_id
left join public.admin_head ah on ah.id = e.admin_head_id
left join public.zone z on z.id = e.zone_id
left join public.cost_center cc on cc.id = e.cost_center_id
left join public.hub_status hs on hs.id = e.hub_status_id
left join (
  select coalesce(de.entry_id, sd.entry_id) as entry_id, count(distinct sd.id) as document_count
  from public.source_document sd
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and de.entry_id is not null
  where coalesce(de.entry_id, sd.entry_id) is not null
  group by coalesce(de.entry_id, sd.entry_id)
) doc on doc.entry_id = e.id
left join public.sub_department sub on sub.id = e.sub_department_id
left join public.reimbursement_detail rd on rd.entry_id = e.id
left join public.advance_payment_detail apd on apd.entry_id = e.id;
