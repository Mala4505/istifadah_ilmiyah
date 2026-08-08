-- The unified record (§3.4). Indexes live in the next migration
-- (20260808000014_entries_indexes.sql) so this file is the table shape alone.
create table public.entries (
  id bigint generated always as identity primary key,

  -- identity
  type text not null default 'invoice'
    check (type in ('invoice','reimbursement','advance_payment')),
  ubbl_number text not null unique,      -- normalized to text on import; see note below
  main_number text unique,               -- unique enforced: duplicates are a real integrity signal

  -- classification (import-owned)
  department_id bigint references public.department(id),
  budget_head_id bigint references public.budget_head(id),
  invoice_number text,
  vendor_id bigint references public.vendor(id),
  vendor_raw text,                       -- exactly as exported, always preserved
  date date,

  -- money: BOTH sides, per the Main Reconciliation contract
  tenant_amount numeric(14,2),
  main_amount numeric(14,2),
  amount_variance numeric(14,2) generated always as (
    case when tenant_amount is not null and main_amount is not null
         then tenant_amount - main_amount end
  ) stored,
  variance_reason text,                  -- the export's 'Reason' column

  -- status (import-owned, raw always kept)
  tenant_status_id bigint references public.entry_status(id),
  main_status_id bigint references public.entry_status(id),
  tenant_status_raw text,
  main_status_raw text,

  -- Hub enrichment (never touched by import)
  head_id bigint references public.head(id),
  zone_id bigint references public.zone(id),
  hub_reference text,                    -- the 'new' column, until you define it
  enrichment_note text,

  -- Hub-OWNED status: set here, exported outward. Never written by import.
  hub_status_id bigint not null default 1 references public.hub_status(id),
  hub_status_changed_at timestamptz,
  hub_status_changed_by uuid references auth.users(id),
  hub_status_note text,
  hub_status_exported_at timestamptz,    -- null = pending export
  hub_status_export_batch_id bigint references public.status_export_batch(id),

  -- advance settlement
  settles_entry_id bigint references public.entries(id),   -- this invoice settles that advance

  -- lifecycle
  is_void boolean not null default false, -- soft delete only; financial rows are never hard-deleted
  void_reason text,

  -- provenance
  source text not null default 'import' check (source in ('import','manual','api')),
  import_batch_id bigint references public.import_batch(id),
  budget_head_raw text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

-- Deferred FK: public.import_row_log.entry_id could not reference this table at
-- creation time in 20260808000011_import_batch_and_row_log.sql because it did not
-- exist yet. Added in 20260808000014_entries_indexes.sql, immediately after this
-- table's own indexes.

-- `ubbl_number` normalization is mandatory, not cosmetic (§3.4). The export mixes
-- integers (202608051) and strings (ADP_202608054); the importer runs a single
-- normalizeId() -- reject non-finite, reject decimals, String(Math.trunc(n)) for
-- numbers, .trim() for strings -- before anything else runs, so this unique
-- constraint never sees '202608051' and '202608051.0' as different values.
--
-- Namespace collision check: because ADP_202608054 appears as a UBBL on one row and a
-- Main Number on another, the importer asserts after each batch that no value exists
-- in both ubbl_number and main_number across different rows, and raises a `high`
-- exception if it does. Nothing in the system may join on a bare "number".
