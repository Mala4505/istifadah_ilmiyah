-- Give the auto-added statuses the label the portal actually rendered.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- resolveStatus auto-inserts any status code an import has not seen before,
-- which is the designed behaviour: a new vocabulary word should arrive with
-- the data, not wait on someone to type it into a settings screen. But it
-- used to insert the SLUG as the label too (`values ($1, $1, ...)`), so the
-- list read:
--
--     Paid                    <- curated by hand
--     subject_to_approval     <- auto-added, and looks broken next to it
--
-- The readable text was never missing: the portal sent "Subject to Approval",
-- and it was already being stored verbatim on entries.status_raw. It was
-- simply not carried across to the label. resolveStatus now takes the
-- rendered text as `displayLabel`, so statuses added from here on arrive
-- readable.
--
-- This backfills the ones already created, sourcing each label from the most
-- common entries.status_raw among the entries actually carrying that status
-- -- i.e. from the portal's own words, not from a guess made here.
--
-- Only rows where label = code are touched, which is precisely the
-- auto-inserted signature; a hand-curated label ("Sent to Main", whose code
-- is `sent_main`) can never match that test and is left alone.
-- ---------------------------------------------------------------------------

begin;

with portal_wording as (
  select e.status_id,
         e.status_raw,
         row_number() over (
           partition by e.status_id order by count(*) desc, e.status_raw
         ) as rn
    from public.entries e
   where e.status_id is not null and e.status_raw is not null and e.status_raw <> ''
   group by e.status_id, e.status_raw
)
update public.entry_status s
   set label = w.status_raw
  from portal_wording w
 where w.status_id = s.id
   and w.rn = 1
   and s.label = s.code           -- auto-inserted signature; curated rows differ
   and w.status_raw <> s.code;    -- no-op if the portal's text IS the slug

-- Anything still wearing its slug has no entry pointing at it yet (e.g. a
-- status seen once in a rolled-back dry run), so there is no portal wording
-- to recover. Fall back to a readable Title Case of the slug rather than
-- leaving `verification_stage_4` on screen. initcap() over the
-- underscores-to-spaces form is enough here; the next import that actually
-- meets the status will overwrite nothing, since these rows then no longer
-- match the label = code test.
update public.entry_status
   set label = initcap(replace(code, '_', ' '))
 where label = code
   and code <> initcap(replace(code, '_', ' '));

commit;
