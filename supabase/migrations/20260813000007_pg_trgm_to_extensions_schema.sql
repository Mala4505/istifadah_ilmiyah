-- `supabase db advisors` flags pg_trgm living in the `public` schema
-- (extension_in_public, WARN, 2026-08-13 Phase 1A verification pass): an
-- extension's functions/operators sit alongside application objects in the
-- schema every role can reach, which is unnecessary surface area once the
-- extension itself is relocatable (pg_trgm is). Moving it to a dedicated
-- `extensions` schema is the standard Supabase remediation.
--
-- vendor_trgm_idx (20260808000008_vendor_and_alias.sql) is the only object
-- built on pg_trgm's gin_trgm_ops operator class. Postgres index entries
-- reference the operator class by OID, not by schema-qualified name, so
-- relocating the extension does not require rebuilding the index.
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
