-- reporting-blueprint.md §8 Phase Six, Budget & Spend cluster: A-08 entry-type
-- split by department, A-09 outstanding-advance ageing, A-10 reimbursement
-- profile. All three read straight off `entries` + its Phase-2 type-detail
-- extension tables (20260827000001 / 20260828000002), none of them aggregate
-- money across events (event_id is in every GROUP BY), and each exposes
-- event_id as a plain output column that the loader
-- (lib/reports/surfaces/entry-type-flow.ts) filters on -- matching every other
-- reporting view in supabase/migrations/2026090300000{1..8}.
--
--   v_entry_type_by_department -- A-08. "Invoice vs reimbursement vs advance vs
--     invoice-against-uplaq, per department. A high reimbursement share is a
--     control signal." One row per (department, entry type, event):
--       department_id / department_name -- nullable. Entries with no department
--         fall into a single null-department bucket (department_name null);
--         the section renders it as "No department".
--       type       -- the raw entries.type code (one of the four
--         entries_type_check values: invoice | reimbursement | advance_payment
--         | invoice_against_uplaq).
--       type_label -- entry_type.label for that code (20260901000001), with a
--         humanised fallback if a code is ever missing from the lookup.
--       entry_count  -- count of non-void entries in the group.
--       total_amount -- coalesce(sum(entries.amount), 0) over the same
--         non-void entries. entries.amount is NULLABLE, so a group of
--         amount-less entries reads 0, not null.
--       event_id   -- plain output column, never filtered here.
--     Grain note (skill-observation 25): this is an aggregate view, so the
--     event scoping key lives in the GROUP BY, not just the SELECT -- a
--     department billing across two events yields two rows per type, never one
--     silently-summed row. No LEFT JOIN from a master table, so there is no
--     "show every department with zero activity" base-set to reconstruct; a
--     department only appears once it has at least one non-void entry.
--
--   v_outstanding_advance_ageing -- A-09. "Advances issued but never settled --
--     live cash exposure, bucketed by age and owner." One row per OUTSTANDING
--     advance entry.
--       An advance = entries.type = 'advance_payment', is_void = false.
--       It is OUTSTANDING when NO entry anywhere carries
--         settles_entry_id = <that advance's id>.
--       DATA-MATURITY CAVEAT (not a bug): per 20260828000002, invoice-against-
--         uplaq rows import with settles_entry_id NULL until the Dept portal
--         exposes a real identifier to join an IAU row to the advance it
--         settles. Until that link exists, essentially every advance in the
--         corpus reads as outstanding here, and the "₹ outstanding" figure is
--         an upper bound on true exposure, not a settled-vs-unsettled split.
--         The section states this on the face of the report.
--       entry_id / department_id / department_name / admin_head_id /
--         admin_head_name / vendor_id / vendor_display_name -- the advance's
--         own links (all nullable bigint FKs on entries), resolved via LEFT
--         JOIN so a link-less advance still appears.
--       advance_amount -- entries.amount (the Uplaq Amount for an advance row,
--         per 20260827000001; nullable).
--       advance_date   -- entries.date (nullable).
--       days_outstanding -- current_date - advance_date (integer; null when
--         advance_date is null). Recomputed on every read -- the view has no
--         as-of snapshot dimension, so 'prior_week' comparison is not
--         meaningful for it (the loader documents the same).
--       age_bucket -- '0-30' | '31-60' | '61-90' | '90+', or null when
--         advance_date is null. Oldest bucket is the most severe.
--       invoice_amount -- advance_payment_detail.invoice_amount, the tab's
--         separate Invoice Amount figure (nullable; the detail row may be
--         absent).
--       event_id -- plain output column.
--     Not an aggregate -- one advance in, one row out -- so event_id needs no
--     GROUP BY handling.
--
--   v_reimbursement_profile -- A-10. "Who is reimbursed, how often, how much,
--     for what type. Reimbursements bypass the normal vendor path." One row per
--     (reimbursee, event).
--       REIMBURSEE KEYING (documented decision): a reimbursement is keyed to a
--         real vendor when reimbursement_detail.reimburse_to_vendor_id is set
--         ('v:' || that id); otherwise to a normalised form of
--         reimburse_to_raw ('r:' || lower(trimmed, whitespace-collapsed));
--         if both are absent, the single bucket 'r:(unspecified)'. This means
--         two spellings of the same un-linked person are two reimbursees until
--         someone links them to a vendor -- the same "never fuzzy-auto-merge"
--         posture 20260808000008 takes for vendor identity.
--       DEPARTMENT (documented decision): department is a per-entry attribute,
--         so this view attributes each reimbursee their MODAL department for
--         the event -- the department that appears on the most of that
--         reimbursee's reimbursement entries, ties broken by lowest
--         department_id, nulls last. Exposed as department_id (for the
--         drill-through link) + department_name.
--       reimbursee_key / reimbursee_name / reimburse_to_vendor_id (nullable) /
--         department_id / department_name / entry_count / total_amount /
--         first_date / last_date / event_id.
--       The reimbursement_type breakdown is a SECOND view
--         (v_reimbursement_by_type) rather than a jsonb column, so the
--         section's donut and "dominant type" sentence read it with a plain
--         .select() and the client never has to parse jsonb.
--
--   v_reimbursement_by_type -- A-10 companion. One row per (reimbursement_type,
--     event) across ALL reimbursees: entry_count + total_amount. reimbursement
--     _type is coalesced to '(unspecified)' when the detail row leaves it null.
--
-- security_invoker = true on all four (every view in this codebase runs as the
-- calling user so base-table RLS applies). Each is a brand-new object that the
-- historical blanket grant (20260808000026) predates, so each needs its own
-- explicit grant below.
--
-- Department-leak note (same property v_entry_enriched / v_admin_head_spend
-- document): `entries`, reimbursement_detail and advance_payment_detail are all
-- department-scoped by RLS (can_see_department, which short-circuits for
-- admin/superadmin). department, admin_head and vendor are staff-wide. A
-- department-scoped reviewer therefore sees only their own department's
-- entries in every figure here -- their v_entry_type_by_department has only
-- their department's rows, their advance-ageing list only their department's
-- advances, their reimbursement profile only reimbursees their department
-- filed. This is a per-viewer slice, not an error.

-- ----------------------------------------------------------------------------
-- v_entry_type_by_department -- A-08
-- ----------------------------------------------------------------------------
create view public.v_entry_type_by_department with (security_invoker = true) as
select
  e.department_id,
  d.name as department_name,
  e.type,
  coalesce(et.label, initcap(replace(e.type, '_', ' '))) as type_label,
  count(*) as entry_count,
  coalesce(sum(e.amount), 0) as total_amount,
  e.event_id
from public.entries e
left join public.department d on d.id = e.department_id
left join public.entry_type et on et.code = e.type
where e.is_void = false
group by e.department_id, d.name, e.type, et.label, e.event_id;

-- ----------------------------------------------------------------------------
-- v_outstanding_advance_ageing -- A-09
-- ----------------------------------------------------------------------------
create view public.v_outstanding_advance_ageing with (security_invoker = true) as
with advances as (
  select e.*
  from public.entries e
  where e.type = 'advance_payment'
    and e.is_void = false
),
settled_advance_ids as (
  -- Any entry (IAU or invoice) pointing back at an advance settles it. Per
  -- 20260828000002 this set is empty / near-empty on the current corpus --
  -- see this file's header caveat.
  select distinct settles_entry_id
  from public.entries
  where settles_entry_id is not null
)
select
  a.id as entry_id,
  a.department_id,
  d.name as department_name,
  a.admin_head_id,
  ah.name as admin_head_name,
  a.vendor_id,
  v.display_name as vendor_display_name,
  a.amount as advance_amount,
  a.date as advance_date,
  (current_date - a.date) as days_outstanding,
  case
    when a.date is null then null
    when current_date - a.date <= 30 then '0-30'
    when current_date - a.date <= 60 then '31-60'
    when current_date - a.date <= 90 then '61-90'
    else '90+'
  end as age_bucket,
  apd.invoice_amount,
  a.event_id
from advances a
left join settled_advance_ids s on s.settles_entry_id = a.id
left join public.department d on d.id = a.department_id
left join public.admin_head ah on ah.id = a.admin_head_id
left join public.vendor v on v.id = a.vendor_id
left join public.advance_payment_detail apd on apd.entry_id = a.id
where s.settles_entry_id is null;

-- ----------------------------------------------------------------------------
-- v_reimbursement_profile -- A-10
-- ----------------------------------------------------------------------------
create view public.v_reimbursement_profile with (security_invoker = true) as
with reimb as (
  select
    e.id as entry_id,
    e.event_id,
    e.department_id,
    e.amount,
    e.date,
    rd.reimburse_to_vendor_id,
    rd.reimburse_to_raw,
    coalesce(
      case
        when rd.reimburse_to_vendor_id is not null then 'v:' || rd.reimburse_to_vendor_id
        else 'r:' || nullif(lower(regexp_replace(trim(coalesce(rd.reimburse_to_raw, '')), '\s+', ' ', 'g')), '')
      end,
      'r:(unspecified)'
    ) as reimbursee_key
  from public.entries e
  join public.reimbursement_detail rd on rd.entry_id = e.id
  where e.is_void = false
    and e.type = 'reimbursement'
),
dept_rank as (
  select
    reimbursee_key,
    event_id,
    department_id,
    row_number() over (
      partition by reimbursee_key, event_id
      order by count(*) desc, department_id asc nulls last
    ) as rn
  from reimb
  group by reimbursee_key, event_id, department_id
),
modal_dept as (
  select reimbursee_key, event_id, department_id
  from dept_rank
  where rn = 1
),
agg as (
  select
    reimbursee_key,
    event_id,
    count(*) as entry_count,
    coalesce(sum(amount), 0) as total_amount,
    min(date) as first_date,
    max(date) as last_date,
    max(reimburse_to_vendor_id) as reimburse_to_vendor_id,
    max(reimburse_to_raw) as reimburse_to_raw
  from reimb
  group by reimbursee_key, event_id
)
select
  a.reimbursee_key,
  coalesce(v.display_name, nullif(trim(a.reimburse_to_raw), ''), '(unspecified)') as reimbursee_name,
  a.reimburse_to_vendor_id,
  md.department_id,
  d.name as department_name,
  a.entry_count,
  a.total_amount,
  a.first_date,
  a.last_date,
  a.event_id
from agg a
left join modal_dept md
  on md.reimbursee_key = a.reimbursee_key
 and md.event_id is not distinct from a.event_id
left join public.vendor v on v.id = a.reimburse_to_vendor_id
left join public.department d on d.id = md.department_id;

-- ----------------------------------------------------------------------------
-- v_reimbursement_by_type -- A-10 companion
-- ----------------------------------------------------------------------------
create view public.v_reimbursement_by_type with (security_invoker = true) as
select
  e.event_id,
  coalesce(nullif(trim(rd.reimbursement_type), ''), '(unspecified)') as reimbursement_type,
  count(*) as entry_count,
  coalesce(sum(e.amount), 0) as total_amount
from public.entries e
join public.reimbursement_detail rd on rd.entry_id = e.id
where e.is_void = false
  and e.type = 'reimbursement'
group by e.event_id, coalesce(nullif(trim(rd.reimbursement_type), ''), '(unspecified)');

-- Brand-new objects -- a plain grant is all that's needed (no drop-and-recreate,
-- so nothing to re-grant on any other view here).
grant select on
  public.v_entry_type_by_department,
  public.v_outstanding_advance_ageing,
  public.v_reimbursement_profile,
  public.v_reimbursement_by_type
to authenticated;
