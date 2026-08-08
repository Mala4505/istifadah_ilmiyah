create table public.reconciliation_exception (
  id bigint generated always as identity primary key,
  entry_id bigint references public.entries(id) on delete cascade,
  document_extraction_id bigint references public.document_extraction(id) on delete cascade,
  import_batch_id bigint references public.import_batch(id) on delete cascade,
  exception_type text not null check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_tenant_amount','tenant_vs_main_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other')),
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  amount_at_risk numeric(14,2),
  description text,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  dedup_key text unique,
  created_at timestamptz not null default now()
);
create index recon_exception_open_idx on public.reconciliation_exception (status, severity, amount_at_risk desc)
  where status = 'open';
create index recon_exception_entry_idx on public.reconciliation_exception (entry_id) where entry_id is not null;
create index recon_exception_extraction_idx on public.reconciliation_exception (document_extraction_id)
  where document_extraction_id is not null;
create index recon_exception_batch_idx on public.reconciliation_exception (import_batch_id)
  where import_batch_id is not null;
create index recon_exception_resolved_by_idx on public.reconciliation_exception (resolved_by)
  where resolved_by is not null;
