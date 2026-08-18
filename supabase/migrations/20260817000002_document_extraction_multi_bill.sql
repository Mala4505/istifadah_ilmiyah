-- Phase 2 (plan.md §3): one source_document may contain several distinct
-- bills (a batch scan). document_extraction.source_document_id was `unique`,
-- so extraction could only ever write one header/total/line-item-set per
-- document no matter what the PDF actually contained (I8/I12). This lets one
-- source_document produce N document_extraction rows, one per bill.
--
-- Sorts strictly after both 20260817000001_* files (I17: they share a
-- timestamp prefix) by virtue of this file's 000002 suffix.

-- Default name for the inline `unique` on document_extraction.source_document_id
-- (20260808000021_document_extraction.sql) — Postgres's standard
-- <table>_<column>_key naming for a single-column unique constraint.
alter table public.document_extraction
  drop constraint document_extraction_source_document_id_key;

alter table public.document_extraction
  add column bill_index int not null default 0,
  add column page_number_start int,
  add column page_number_end int,
  add column entry_id bigint references public.entries(id);

-- Every existing document_extraction row was written under the old 1:1
-- constraint, so it is unambiguously bill_index 0 of a single-bill document.
-- Backfilling entry_id here (rather than leaving it null until the next
-- re-extraction) preserves rate_reference attribution in
-- private.verify_document_extraction for documents that were already
-- extracted before this migration ran and are not re-extracted afterward.
update public.document_extraction de
set entry_id = sd.entry_id
from public.source_document sd
where sd.id = de.source_document_id
  and de.entry_id is null
  and sd.entry_id is not null;

-- Replaces the old single-column unique — this is what extractAndPersist's
-- upsert conflicts on (one row per source_document per bill).
alter table public.document_extraction
  add constraint document_extraction_source_document_id_bill_index_key
    unique (source_document_id, bill_index);

-- The old unique constraint provided a plain source_document_id index
-- implicitly; dropping it removes that index too, so it needs restoring.
create index document_extraction_document_idx on public.document_extraction (source_document_id);

create index document_extraction_entry_idx on public.document_extraction (entry_id) where entry_id is not null;
