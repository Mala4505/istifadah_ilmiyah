-- Performance remediation plan (docs/performance-remediation-plan.md) 7.11.
--
-- document_extraction_document_idx (source_document_id) was added by
-- 20260817000002 to replace the plain index the old single-column unique
-- constraint provided implicitly. But that same migration also added
-- document_extraction_source_document_id_bill_index_key, a unique constraint
-- on (source_document_id, bill_index) -- and a btree backing a composite
-- unique constraint already supports both an equality filter and an ordered
-- fetch on its leading column alone. document_extraction_document_idx is a
-- pure duplicate: same leading column, strictly narrower, maintained on
-- every insert/update/delete for no read benefit over the constraint's own
-- index.
--
-- NOTE for whoever applies this: DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block, same caveat as the CREATE INDEX CONCURRENTLY statements
-- elsewhere in this plan (see 20260904000001's header note). Not verified
-- against a live plan -- review before applying.

DROP INDEX CONCURRENTLY IF EXISTS public.document_extraction_document_idx;
