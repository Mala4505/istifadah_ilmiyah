-- §4.4 / §10.2 Reporting views.
--
-- A Postgres view bypasses RLS by default -- it runs with the privileges of whoever
-- created it, not whoever queries it. Every view below is created `with
-- (security_invoker = true)` so it runs as the calling user and the underlying table
-- RLS policies (20260808000026) apply. Checked explicitly on day 5: query each view as
-- a department-1 reviewer and confirm no department-2 rows appear.

-- ----------------------------------------------------------------------------
-- v_entry_enriched -- the one join every other view builds on.
-- ----------------------------------------------------------------------------
create view public.v_entry_enriched with (security_invoker = true) as
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
  e.tenant_amount,
  e.main_amount,
  e.amount_variance,
  e.variance_reason,
  e.tenant_status_id,
  ts.code as tenant_status_code,
  ts.label as tenant_status_label,
  e.main_status_id,
  ms.code as main_status_code,
  ms.label as main_status_label,
  e.tenant_status_raw,
  e.main_status_raw,
  e.head_id,
  h.name as head_name,
  e.zone_id,
  z.name as zone_name,
  e.hub_reference,
  e.enrichment_note,
  e.hub_status_id,
  hs.code as hub_status_code,
  hs.label as hub_status_label,
  e.hub_status_changed_at,
  e.hub_status_changed_by,
  e.hub_status_note,
  e.hub_status_exported_at,
  e.settles_entry_id,
  e.is_void,
  e.void_reason,
  e.source,
  e.import_batch_id,
  e.created_at,
  e.updated_at,
  coalesce(doc.document_count, 0) as document_count
from public.entries e
left join public.department d on d.id = e.department_id
left join public.budget_head bh on bh.id = e.budget_head_id
left join public.vendor v on v.id = e.vendor_id
left join public.entry_status ts on ts.id = e.tenant_status_id
left join public.entry_status ms on ms.id = e.main_status_id
left join public.head h on h.id = e.head_id
left join public.zone z on z.id = e.zone_id
left join public.hub_status hs on hs.id = e.hub_status_id
left join (
  select sd.entry_id, count(*) as document_count
  from public.source_document sd
  where sd.entry_id is not null
  group by sd.entry_id
) doc on doc.entry_id = e.id;

-- ----------------------------------------------------------------------------
-- v_budget_vs_actual -- per budget head: latest allocation vs sum(tenant_amount).
-- Returns 'no approved budget' rather than -100% when approved_amount = 0 (§3.5).
-- ----------------------------------------------------------------------------
create view public.v_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (ba.budget_head_id)
    ba.budget_head_id, ba.as_of, ba.request_amount, ba.approved_amount,
    ba.utilised_amount, ba.balance_amount
  from public.budget_allocation ba
  order by ba.budget_head_id, ba.as_of desc, ba.id desc
),
actual_spend as (
  select e.budget_head_id, sum(e.tenant_amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.budget_head_id is not null
  group by e.budget_head_id
)
select
  bh.id as budget_head_id,
  bh.raw_label,
  bh.short_label,
  bh.department_id,
  la.as_of,
  la.request_amount,
  la.approved_amount,
  la.utilised_amount,
  la.balance_amount,
  coalesce(asp.actual_amount, 0) as actual_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case
    when la.approved_amount is null or la.approved_amount = 0 then null
    else round(coalesce(asp.actual_amount, 0) / la.approved_amount * 100, 2)
  end as pct_of_approved,
  case
    when la.approved_amount is null or la.approved_amount = 0 then 'no approved budget'
    else null
  end as budget_status_note
from public.budget_head bh
left join latest_allocation la on la.budget_head_id = bh.id
left join actual_spend asp on asp.budget_head_id = bh.id;

-- ----------------------------------------------------------------------------
-- v_vendor_spend -- per vendor: entry count, total, first/last date, document coverage %.
-- ----------------------------------------------------------------------------
create view public.v_vendor_spend with (security_invoker = true) as
select
  v.id as vendor_id,
  v.display_name,
  v.normalized_name,
  v.is_confirmed,
  count(e.id) as entry_count,
  sum(e.tenant_amount) as total_tenant_amount,
  sum(e.main_amount) as total_main_amount,
  min(e.date) as first_entry_date,
  max(e.date) as last_entry_date,
  count(distinct sd.entry_id) as entries_with_documents,
  case when count(e.id) = 0 then null
       else round(count(distinct sd.entry_id)::numeric / count(e.id) * 100, 2)
  end as document_coverage_pct
from public.vendor v
left join public.entries e on e.vendor_id = v.id and e.is_void = false
left join public.source_document sd on sd.entry_id = e.id
group by v.id, v.display_name, v.normalized_name, v.is_confirmed;

-- ----------------------------------------------------------------------------
-- v_zone_spend -- per zone: total and entry count. Null zone reported as 'unassigned'
-- so gaps in enrichment are visible rather than invisible.
-- ----------------------------------------------------------------------------
create view public.v_zone_spend with (security_invoker = true) as
select
  z.id as zone_id,
  coalesce(z.name, 'unassigned') as zone_name,
  z.zone_number,
  e.department_id,
  count(e.id) as entry_count,
  sum(e.tenant_amount) as total_tenant_amount,
  sum(e.main_amount) as total_main_amount
from public.entries e
left join public.zone z on z.id = e.zone_id
where e.is_void = false
group by z.id, z.name, z.zone_number, e.department_id;

-- ----------------------------------------------------------------------------
-- v_tenant_main_variance -- entries where amount_variance <> 0, or present on one
-- side only, with variance_reason.
-- ----------------------------------------------------------------------------
create view public.v_tenant_main_variance with (security_invoker = true) as
select
  e.id as entry_id,
  e.ubbl_number,
  e.main_number,
  e.department_id,
  e.budget_head_id,
  e.vendor_id,
  e.date,
  e.tenant_amount,
  e.main_amount,
  e.amount_variance,
  e.variance_reason,
  e.tenant_status_id,
  e.main_status_id,
  case
    when e.tenant_amount is not null and e.main_amount is null then 'tenant_only'
    when e.tenant_amount is null and e.main_amount is not null then 'main_only'
    when e.amount_variance is not null and e.amount_variance <> 0 then 'amount_mismatch'
    else 'other'
  end as variance_type
from public.entries e
where e.is_void = false
  and (
    (e.amount_variance is not null and e.amount_variance <> 0)
    or (e.tenant_amount is not null and e.main_amount is null)
    or (e.tenant_amount is null and e.main_amount is not null)
  );

-- ----------------------------------------------------------------------------
-- v_hub_status_ageing -- days each entry has sat in awaiting verification/validation,
-- bucketed 0-2 / 3-7 / 8+. Answers "what are the modules waiting on?"
-- ----------------------------------------------------------------------------
create view public.v_hub_status_ageing with (security_invoker = true) as
select
  e.id as entry_id,
  e.department_id,
  e.ubbl_number,
  e.hub_status_id,
  hs.code as hub_status_code,
  hs.label as hub_status_label,
  e.hub_status_changed_at,
  extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at))::int as days_in_status,
  case
    when extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at)) <= 2 then '0-2'
    when extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at)) <= 7 then '3-7'
    else '8+'
  end as age_bucket
from public.entries e
join public.hub_status hs on hs.id = e.hub_status_id
where e.is_void = false
  and hs.code in ('awaiting_verification', 'awaiting_validation');

-- ----------------------------------------------------------------------------
-- v_open_issues -- reconciliation_exception UNION flags, ordered by severity then
-- amount at risk.
-- ----------------------------------------------------------------------------
create view public.v_open_issues with (security_invoker = true) as
select * from (
  select
    'reconciliation_exception'::text as source_table,
    re.id,
    re.entry_id,
    re.exception_type as issue_type,
    re.severity,
    re.amount_at_risk,
    re.description,
    re.status,
    re.created_at
  from public.reconciliation_exception re
  where re.status = 'open'
  union all
  select
    'flags'::text as source_table,
    f.id,
    f.entry_id,
    f.flag_type as issue_type,
    f.severity,
    f.amount_at_risk,
    f.description,
    f.status,
    f.created_at
  from public.flags f
  where f.status = 'open'
) combined
-- Postgres forbids expressions in a UNION's ORDER BY (only output column names/ordinals
-- are allowed there) -- wrapped in a subquery so the CASE expression is legal here.
order by
  case severity when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
  amount_at_risk desc nulls last;

-- ----------------------------------------------------------------------------
-- v_review_queue -- unverified extractions ordered by exception severity desc,
-- confidence asc, amount desc (§7).
-- ----------------------------------------------------------------------------
create view public.v_review_queue with (security_invoker = true) as
select
  de.id as document_extraction_id,
  de.source_document_id,
  sd.entry_id,
  sd.original_filename,
  de.current_extraction_run_id,
  r.extraction_confidence,
  r.legibility,
  de.total_amount_ocr,
  de.vendor_name_ocr,
  de.invoice_number_ocr,
  de.created_at,
  coalesce(iss.max_severity_rank, 0) as max_open_severity_rank,
  coalesce(iss.open_issue_count, 0) as open_issue_count
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join (
  select
    re.entry_id,
    count(*) as open_issue_count,
    max(case re.severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) as max_severity_rank
  from public.reconciliation_exception re
  where re.status = 'open' and re.entry_id is not null
  group by re.entry_id
) iss on iss.entry_id = sd.entry_id
where de.verified_at is null
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  de.total_amount_ocr desc nulls last;

-- ----------------------------------------------------------------------------
-- v_extraction_correction -- §9.2, verbatim. Nearly free: the _ocr/_verified twin
-- columns already carry it, so the correction log is a view rather than a new pipeline.
-- ----------------------------------------------------------------------------
create view public.v_extraction_correction with (security_invoker = true) as
select de.id, de.source_document_id, r.model, r.run_reason,
       de.verified_at, de.verified_by, f.field, f.ocr_value, f.verified_value
  from public.document_extraction de
  join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
 cross join lateral (values
       ('vendor_name',    de.vendor_name_ocr,        de.vendor_name_verified),
       ('invoice_number', de.invoice_number_ocr,     de.invoice_number_verified),
       ('invoice_date',   de.invoice_date_ocr::text, de.invoice_date_verified::text),
       ('subtotal',       de.subtotal_ocr::text,     de.subtotal_verified::text),
       ('tax_amount',     de.tax_amount_ocr::text,   de.tax_amount_verified::text),
       ('total_amount',   de.total_amount_ocr::text, de.total_amount_verified::text),
       ('vendor_gstin',   de.vendor_gstin_ocr,       de.vendor_gstin_verified)
     ) as f(field, ocr_value, verified_value)
 where de.verified_at is not null
   and f.ocr_value is distinct from f.verified_value;

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in 20260808000026_rls_policies.sql
-- ran *before* any of these views existed, so it does not cover them. Without an
-- explicit grant here, PostgREST would return "permission denied" for every one of
-- these views even though security_invoker RLS would otherwise allow the row.
grant select on
  public.v_entry_enriched,
  public.v_budget_vs_actual,
  public.v_vendor_spend,
  public.v_zone_spend,
  public.v_tenant_main_variance,
  public.v_hub_status_ageing,
  public.v_open_issues,
  public.v_review_queue,
  public.v_extraction_correction
to authenticated;
