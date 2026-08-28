-- Collapse the split Departmental/Audit status into ONE status per entry, and
-- drop the columns that duplication left behind (user decision, 2026-08-28).
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- entry_status was keyed on (code, source_system), so the SAME real-world
-- status existed twice -- confirmed live before writing this: 'paid' as #8
-- (audit, sort 3, terminal, "Paid") AND #11 (departmental, sort 999, "paid");
-- likewise 'received', 'not_verified' and 'tax_invoice_upload_pending_paid'.
-- entries then carried two independent pointers (status_id, audit_status_id)
-- into that split vocabulary, so "what is this entry's status?" had two
-- answers that no screen reconciled.
--
-- The operator's model is simpler and is the one implemented here: an entry
-- has one status. Whichever import last saw the row -- Departmental or Audit
-- -- writes it. The Hub's OWN status is a genuinely different thing and stays
-- exactly where it was, in entries.hub_status_id -> public.hub_status.
--
-- WHICH SIDE WINS THE MERGE
--
-- The Audit portal is downstream of the Departmental one, so where an entry
-- carried both, the audit value is the later word and becomes the unified
-- status. That is the operator's stated rule: "if the entry exists, just
-- rewrite that status with that new status of the audit."
--
-- WHICH ROW WINS PER DUPLICATED CODE
--
-- Lowest sort_order, tie-broken by lowest id. A curated row (given a real
-- label and ordering by hand, e.g. 20260814000008) always has a real
-- sort_order, while a row auto-inserted on first sight by resolveStatus gets
-- sort_order 999 and a label that is just the raw code. So this keeps the
-- human-curated row and discards the stub, which is the intended direction.
-- ---------------------------------------------------------------------------

begin;

-- ---- 1. pick a winner per duplicated code, repoint every reference ---------

create temp table status_merge on commit drop as
with ranked as (
  select id,
         code,
         row_number() over (partition by code order by sort_order, id) as rn,
         first_value(id) over (partition by code order by sort_order, id) as winner_id
    from public.entry_status
)
select id as loser_id, winner_id, code
  from ranked
 where rn > 1;

update public.entries e
   set status_id = m.winner_id
  from status_merge m
 where e.status_id = m.loser_id;

update public.entries e
   set audit_status_id = m.winner_id
  from status_merge m
 where e.audit_status_id = m.loser_id;

-- ---- 2. collapse the two pointers into one --------------------------------
-- Audit wins where present; the Departmental value stands otherwise. Done
-- BEFORE the columns are dropped, so no status is lost in the process.

update public.entries
   set status_id  = coalesce(audit_status_id, status_id),
       status_raw = coalesce(audit_status_raw, status_raw)
 where audit_status_id is not null
    or audit_status_raw is not null;

delete from public.entry_status s
 using status_merge m
 where s.id = m.loser_id;

-- ---- 3. drop the views that read the doomed columns -----------------------
-- Recreated at the bottom of this migration, minus those columns. Dropped
-- first because Postgres will not let a column disappear out from under a
-- view that selects it.

drop view if exists public.v_entry_enriched;
drop view if exists public.v_entry_status_counts;
drop view if exists public.v_department_audit_variance;

-- ---- 4. drop the redundant columns ----------------------------------------
-- audit_status_*        -- merged into status_id/status_raw above.
-- budget_head_raw       -- never populated, and budget_head.raw_label already
--                          holds the portal's verbatim label.
-- variance_reason       -- never populated; leftover from the abandoned
--                          two-amount tenant/main model whose tenant_amount
--                          and main_amount columns were already consolidated
--                          into the single `amount`.
-- The two partial indexes on audit_status_id / audit_status_changed_by are
-- dropped implicitly with their columns.

alter table public.entries
  drop column if exists audit_status_id,
  drop column if exists audit_status_raw,
  drop column if exists audit_status_changed_at,
  drop column if exists audit_status_changed_by,
  drop column if exists budget_head_raw,
  drop column if exists variance_reason;

-- entries.audit_synced_at / audit_sync_batch_id are deliberately KEPT: they
-- answer "when did the Audit side last confirm this row, and in which batch",
-- which is still meaningful once the status itself is unified.

-- ---- 5. one status vocabulary, not one per source system ------------------
-- source_system existed only to let the same code live twice. With the
-- duplicates merged there is nothing left for it to separate, and keeping it
-- would re-admit the split the moment a status was resolved with the "wrong"
-- system. code becomes the natural key.

alter table public.entry_status drop constraint if exists entry_status_code_source_system_key;
alter table public.entry_status drop constraint if exists entry_status_code_key;
alter table public.entry_status drop column if exists source_system;
alter table public.entry_status add constraint entry_status_code_key unique (code);

-- ---- 6. recreate the views against the unified shape ----------------------

create view public.v_department_audit_variance as
  select id as entry_id,
         ubbl_number,
         main_number,
         department_id,
         budget_head_id,
         vendor_id,
         date,
         amount,
         status_id,
         'main_number_missing'::text as variance_type
    from public.entries
   where is_void = false and main_number is null;

-- The former 'audit_status' arm is gone: with one status column there is one
-- status dimension to count, alongside the Hub's own.
create view public.v_entry_status_counts as
  select 'status'::text as dimension,
         e.status_id,
         coalesce(st.code, 'not_set'::text) as status_code,
         coalesce(st.label, 'Not set'::text) as status_label,
         coalesce(st.sort_order, 999) as sort_order,
         e.event_id,
         count(*) as entry_count
    from public.entries e
    left join public.entry_status st on st.id = e.status_id
   group by e.status_id, st.code, st.label, st.sort_order, e.event_id
  union all
  select 'hub_status'::text as dimension,
         e.hub_status_id as status_id,
         hs.code as status_code,
         hs.label as status_label,
         hs.sort_order,
         e.event_id,
         count(*) as entry_count
    from public.entries e
    join public.hub_status hs on hs.id = e.hub_status_id
   group by e.hub_status_id, hs.code, hs.label, hs.sort_order, e.event_id;

-- Byte-for-byte the previous definition, minus only the four audit_status
-- columns and their `ast` join, plus audit_synced_at/audit_sync_batch_id
-- which survive the merge (see the note above the ALTER). Every other column
-- -- including the document_count subquery and the reimbursement/advance
-- detail joins the entries screens read -- is preserved exactly, so no
-- consumer of this view loses a field it did not ask to lose.
create view public.v_entry_enriched as
  select e.id,
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
         e.status_id,
         st.code as status_code,
         st.label as status_label,
         e.status_raw,
         e.admin_head_id,
         ah.name as admin_head_name,
         e.zone_id,
         z.name as zone_name,
         e.cost_center_id,
         cc.name as cost_center_name,
         e.remark,
         e.hub_status_id,
         hs.code as hub_status_code,
         hs.label as hub_status_label,
         e.hub_status_changed_at,
         e.hub_status_changed_by,
         e.hub_status_note,
         e.hub_status_exported_at,
         e.audit_synced_at,
         e.audit_sync_batch_id,
         e.settles_entry_id,
         e.is_void,
         e.source,
         e.import_batch_id,
         e.created_at,
         e.updated_at,
         coalesce(doc.document_count, 0::bigint) as document_count,
         e.event_id,
         e.sub_department_id,
         sub.name as sub_department_name,
         rd.sr_no as reimbursement_sr_no,
         rd.reimbursement_type,
         rd.reimburse_to_raw,
         apd.invoice_amount as advance_invoice_amount
    from public.entries e
    left join public.department   d   on d.id   = e.department_id
    left join public.budget_head  bh  on bh.id  = e.budget_head_id
    left join public.vendor       v   on v.id   = e.vendor_id
    left join public.entry_status st  on st.id  = e.status_id
    left join public.admin_head   ah  on ah.id  = e.admin_head_id
    left join public.zone         z   on z.id   = e.zone_id
    left join public.cost_center  cc  on cc.id  = e.cost_center_id
    left join public.hub_status   hs  on hs.id  = e.hub_status_id
    left join (
      select coalesce(de.entry_id, sd.entry_id) as entry_id,
             count(distinct sd.id) as document_count
        from public.source_document sd
        left join public.document_extraction de
               on de.source_document_id = sd.id and de.entry_id is not null
       where coalesce(de.entry_id, sd.entry_id) is not null
       group by coalesce(de.entry_id, sd.entry_id)
    ) doc on doc.entry_id = e.id
    left join public.sub_department        sub on sub.id = e.sub_department_id
    left join public.reimbursement_detail  rd  on rd.entry_id = e.id
    left join public.advance_payment_detail apd on apd.entry_id = e.id;

commit;
