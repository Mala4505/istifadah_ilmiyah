create table public.source_document (
  id bigint generated always as identity primary key,
  entry_id bigint references public.entries(id),   -- NULLABLE: documents arrive before entries
  storage_bucket text not null default 'invoice-documents',
  storage_path text not null unique,
  original_filename text not null,
  file_hash_sha256 text not null,
  mime_type text not null,
  page_count int,
  upload_status text not null default 'uploaded'
    check (upload_status in ('uploaded','processing','processed','failed')),
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','suggested','matched','no_entry_expected')),
  claimed_by uuid references auth.users(id),       -- two reviewers can't open the same doc
  claimed_at timestamptz,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now()
);
create index source_document_entry_idx on public.source_document (entry_id);
create index source_document_hash_idx on public.source_document (file_hash_sha256);
create index source_document_inbox_idx on public.source_document (match_status, uploaded_at)
  where match_status in ('unmatched','suggested');
create index source_document_claimed_by_idx on public.source_document (claimed_by)
  where claimed_by is not null;
create index source_document_uploaded_by_idx on public.source_document (uploaded_by)
  where uploaded_by is not null;

-- Only 3 of 21 sample PDF vendors matched an entry 1:1 (§1) -- entry_id is nullable and
-- match_status drives a document-inbox matching workflow rather than assuming every
-- document arrives with its entry already known.
