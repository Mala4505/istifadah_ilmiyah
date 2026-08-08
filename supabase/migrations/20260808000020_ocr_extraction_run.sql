create table public.ocr_extraction_run (
  id bigint generated always as identity primary key,
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  model text not null,
  run_reason text not null check (run_reason in ('initial','auto_escalation','manual_reescalation')),
  triggered_by uuid references auth.users(id),
  api_request_id text,                    -- Batch API custom_id
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed')),
  raw_response_jsonb jsonb,
  legibility text check (legibility in ('clear','partial','poor')),
  extraction_confidence numeric(4,3),
  contains_non_latin_script boolean not null default false,
  input_tokens int, output_tokens int, cost_usd numeric(10,6),   -- cost visible per document
  error_message text,
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index ocr_run_document_idx on public.ocr_extraction_run (source_document_id);
create index ocr_run_pending_idx on public.ocr_extraction_run (created_at) where status = 'pending';
create index ocr_run_triggered_by_idx on public.ocr_extraction_run (triggered_by)
  where triggered_by is not null;

-- raw_response_jsonb is retained indefinitely (§4.4d) -- lets reprocessing happen
-- without ever re-billing the Claude API.
