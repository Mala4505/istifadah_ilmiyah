create table public.budget_allocation (
  id bigint generated always as identity primary key,
  budget_head_id bigint not null references public.budget_head(id),
  import_batch_id bigint not null references public.import_batch(id),
  as_of date not null,
  request_amount numeric(14,2),
  approved_amount numeric(14,2),
  utilised_amount numeric(14,2),         -- as reported by the source
  balance_amount numeric(14,2),
  created_at timestamptz not null default now(),
  unique (budget_head_id, import_batch_id)
);
create index budget_allocation_head_date_idx on public.budget_allocation (budget_head_id, as_of desc);
create index budget_allocation_batch_idx on public.budget_allocation (import_batch_id);

-- Append-only snapshots. Current position = latest row per head. Burn-over-time comes
-- free from the history, which a single mutable row could not give you.
--
-- FLAG, not a blocker: in the sample, approved_amount = 0 on every head while
-- utilised is already well into the requested amount. v_budget_vs_actual (see
-- 20260808000028_reporting_views.sql) renders 'no approved budget' rather than -100%
-- when approved_amount is null or 0 (§3.5).
