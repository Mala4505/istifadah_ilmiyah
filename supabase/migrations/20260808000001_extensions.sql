-- Extensions used across the schema.
--
-- pg_trgm: trigram similarity index on vendor.normalized_name (see
-- 20260808000008_vendor_and_alias.sql), used for fuzzy vendor-name lookups during
-- import/OCR identity resolution. Fuzzy match only ever *suggests* a match to a human;
-- the resolution rule never auto-merges on it (§3.2).
create extension if not exists pg_trgm;
