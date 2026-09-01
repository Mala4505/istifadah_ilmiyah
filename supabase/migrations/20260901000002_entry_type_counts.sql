-- Add a `type` dimension to v_entry_status_counts, mirroring the existing
-- `status` / `hub_status` branches (20260817000001 / 20260828000001), now
-- that public.entry_type (20260901000001) gives entries.type a label and
-- sort order to join against. Lets the Entries screen's status-count-chips
-- row (components/entries/status-count-chips.tsx) gain a clickable Type row
-- the same way it already has Status/Hub status rows, from the one existing
-- view rather than a separate query.
--
-- No numeric id exists for `type` (entries.type is a CHECK-constrained text
-- column, see 20260901000001's header) -- status_id is null for this branch
-- and the code itself (`status_code`) is what the Entries filter matches on
-- (`.eq('type', ...)` in applyEntriesFilters), same as the app already reads
-- `status_code`/`status_label` off every row regardless of dimension.
create or replace view public.v_entry_status_counts as
  select 'status'::text as dimension,
         e.status_id,
         coalesce(st.code, 'not_set'::text) as status_code,
         coalesce(st.label, 'Not set'::text) as status_label,
         coalesce(st.sort_order, 999) as sort_order,
         e.event_id,
         count(*) as entry_count
    from public.entries e
    left join public.entry_status st on st.id = e.status_id
   group by e.status_id, st.code, st.label, st.sort_order, e.event_id
  union all
  select 'hub_status'::text as dimension,
         e.hub_status_id as status_id,
         hs.code as status_code,
         hs.label as status_label,
         hs.sort_order,
         e.event_id,
         count(*) as entry_count
    from public.entries e
    join public.hub_status hs on hs.id = e.hub_status_id
   group by e.hub_status_id, hs.code, hs.label, hs.sort_order, e.event_id
  union all
  select 'type'::text as dimension,
         null::bigint as status_id,
         et.code as status_code,
         et.label as status_label,
         et.sort_order,
         e.event_id,
         count(*) as entry_count
    from public.entries e
    join public.entry_type et on et.code = e.type
   group by et.code, et.label, et.sort_order, e.event_id;
