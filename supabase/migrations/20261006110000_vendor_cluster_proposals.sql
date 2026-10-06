-- Vendor clustering detection -- PROPOSALS ONLY (MASTER-PLAN.md Phase 2 item 4,
-- "Invoice OCR Technical Spec.md" §4.5). Never auto-merges: an admin accepts
-- (sets vendor.cluster_group_id) or dismisses each proposal from
-- Settings -> Vendors (components/admin/vendor-cluster-proposals.tsx).
--
-- Why not reuse B-07's v_vendor_shared_identity_edges
-- (20260903000008_related_party_gstin_views.sql)? That view is a REPORT: exact
-- GSTIN / raw phone / trimmed address only, over every vendor row, with no
-- notion of "already merged" or "a human said these are different". A proposal
-- queue needs:
--   * GSTIN PAN-part match (chars 3-12) -- same PAN, different state code /
--     entity suffix, the "Al Burhan family" case the spec calls out;
--   * phone normalized to its last 10 digits (same rule as
--     20261005090948_vendor_gstin_phone_from_bills.sql);
--   * address normalized (lowercase, punctuation collapsed) plus trigram
--     near-match, not only exact;
--   * near-duplicate normalized_name (trigram similarity);
--   * endpoints projected to their merge ROOT (coalesce(cluster_group_id, id)),
--     dropping pairs already in the same cluster;
--   * dismissed pairs filtered out.
-- B-07 is left untouched so the report keeps its documented semantics.
--
-- Connected-component grouping (A~B, B~C => {A,B,C}) happens app-side
-- (lib/vendor-clusters/group.ts), same reasoning as B-07's loader.

-- ----------------------------------------------------------------------------
-- 1. Dismissals: one row per unordered ROOT pair an admin has said is NOT the
--    same economic entity. Pair-level (not cluster-level) so a dismissed
--    cluster stays dismissed, while a genuinely NEW edge (a new vendor, or a
--    phone filled in later) still surfaces as a fresh proposal.
-- ----------------------------------------------------------------------------
create table public.vendor_cluster_dismissal (
  vendor_id_a bigint not null references public.vendor(id) on delete cascade,
  vendor_id_b bigint not null references public.vendor(id) on delete cascade,
  dismissed_by uuid references public.staff_profile(id) on delete set null default auth.uid(),
  dismissed_at timestamptz not null default now(),
  primary key (vendor_id_a, vendor_id_b),
  constraint vendor_cluster_dismissal_ordered check (vendor_id_a < vendor_id_b)
);
-- PK covers vendor_id_a lookups; FK on vendor_id_b needs its own index.
create index vendor_cluster_dismissal_b_idx on public.vendor_cluster_dismissal (vendor_id_b);
create index vendor_cluster_dismissal_dismissed_by_idx on public.vendor_cluster_dismissal (dismissed_by);

alter table public.vendor_cluster_dismissal enable row level security;

-- Set-based: the helper is wrapped in a scalar subquery so it runs once per
-- statement (initPlan), never per row.
create policy vendor_cluster_dismissal_select_admin on public.vendor_cluster_dismissal
  for select to authenticated
  using ((select private.is_admin_or_above()));

create policy vendor_cluster_dismissal_insert_admin on public.vendor_cluster_dismissal
  for insert to authenticated
  with check ((select private.is_admin_or_above()));

create policy vendor_cluster_dismissal_delete_admin on public.vendor_cluster_dismissal
  for delete to authenticated
  using ((select private.is_admin_or_above()));

grant select, insert, delete on public.vendor_cluster_dismissal to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Trigram index for the address near-match branch. Expression must match
--    the view's `lower(address)` verbatim for the planner to use it.
--    (normalized_name already has vendor_trgm_idx from 20260808000008.)
-- ----------------------------------------------------------------------------
create index if not exists vendor_address_trgm_idx
  on public.vendor using gin (lower(address) extensions.gin_trgm_ops)
  where address is not null;

-- ----------------------------------------------------------------------------
-- 3. v_vendor_cluster_candidate_edges
--    One row per (root pair, reason). A pair matching on phone AND name gives
--    two rows; the UI shows every reason.
--      reason       detail
--      gstin        the shared full GSTIN
--      gstin_pan    the shared PAN (GSTIN chars 3-12)
--      phone        the shared 10-digit number
--      address      the shared / near-identical normalized address
--      similar_name "<name a> ~ <name b>" with similarity score in `score`
--
--    Thresholds (judgment calls, tune here):
--      name similarity    >= 0.6 on normalized_name, both >= 4 chars
--      address similarity >= 0.8 on lower(address), both >= 12 chars
--    `%` pre-filters at pg_trgm's default 0.3 (index-assisted); the explicit
--    similarity() check then applies the real threshold. A SET clause for
--    pg_trgm.similarity_threshold is not used: Supabase's migration role
--    cannot apply it at CREATE time (see 20260908000003).
-- ----------------------------------------------------------------------------
create view public.v_vendor_cluster_candidate_edges with (security_invoker = true) as
-- `not materialized`: v is referenced many times, which would otherwise make
-- Postgres materialize it and lose the trigram indexes on the self-joins.
with v as not materialized (
  select
    vd.id,
    coalesce(vd.cluster_group_id, vd.id) as root_id,
    vd.normalized_name,
    nullif(upper(regexp_replace(coalesce(vd.gstin, ''), '\s', '', 'g')), '') as gstin,
    nullif(right(regexp_replace(coalesce(vd.phone, ''), '\D', '', 'g'), 10), '') as phone10,
    nullif(trim(regexp_replace(lower(coalesce(vd.address, '')), '[^a-z0-9]+', ' ', 'g')), '') as address_norm,
    lower(vd.address) as address_lower
  from public.vendor vd
),
raw_edges as (
  -- Exact GSTIN.
  select a.root_id as ra, b.root_id as rb, 'gstin'::text as reason, a.gstin as detail, null::real as score
  from v a
  join v b on b.gstin = a.gstin and b.id > a.id
  where a.gstin is not null and length(a.gstin) = 15

  union all
  -- Same PAN (GSTIN chars 3-12), different full GSTIN.
  select a.root_id, b.root_id, 'gstin_pan', substr(a.gstin, 3, 10), null
  from v a
  join v b
    on substr(b.gstin, 3, 10) = substr(a.gstin, 3, 10)
   and b.gstin <> a.gstin
   and b.id > a.id
  where length(a.gstin) = 15 and length(b.gstin) = 15
    and substr(a.gstin, 3, 10) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'

  union all
  -- Same phone (last 10 digits; shorter numbers are too ambiguous).
  select a.root_id, b.root_id, 'phone', a.phone10, null
  from v a
  join v b on b.phone10 = a.phone10 and b.id > a.id
  where length(a.phone10) = 10

  union all
  -- Same normalized address.
  select a.root_id, b.root_id, 'address', a.address_norm, null
  from v a
  join v b on b.address_norm = a.address_norm and b.id > a.id
  where length(a.address_norm) >= 12

  union all
  -- Near-identical address (trigram), excluding exact normalized matches above.
  select a.root_id, b.root_id, 'address', a.address_norm,
         extensions.similarity(a.address_lower, b.address_lower)
  from v a
  join v b
    on b.address_lower operator(extensions.%) a.address_lower
   and b.id > a.id
  where length(a.address_norm) >= 12
    and length(b.address_norm) >= 12
    and b.address_norm is distinct from a.address_norm
    and extensions.similarity(a.address_lower, b.address_lower) >= 0.8

  union all
  -- Near-duplicate names.
  select a.root_id, b.root_id, 'similar_name',
         a.normalized_name || ' ~ ' || b.normalized_name,
         extensions.similarity(a.normalized_name, b.normalized_name)
  from v a
  join v b
    on b.normalized_name operator(extensions.%) a.normalized_name
   and b.id > a.id
  where length(a.normalized_name) >= 4
    and length(b.normalized_name) >= 4
    and extensions.similarity(a.normalized_name, b.normalized_name) >= 0.6
),
root_edges as (
  select
    least(ra, rb) as vendor_id_a,
    greatest(ra, rb) as vendor_id_b,
    reason,
    detail,
    score
  from raw_edges
  where ra <> rb -- already in the same cluster
)
select distinct on (re.vendor_id_a, re.vendor_id_b, re.reason)
  re.vendor_id_a,
  re.vendor_id_b,
  re.reason,
  re.detail,
  re.score
from root_edges re
where not exists (
  select 1
  from public.vendor_cluster_dismissal d
  where d.vendor_id_a = re.vendor_id_a
    and d.vendor_id_b = re.vendor_id_b
)
order by re.vendor_id_a, re.vendor_id_b, re.reason, re.score desc nulls first;

grant select on public.v_vendor_cluster_candidate_edges to authenticated;
