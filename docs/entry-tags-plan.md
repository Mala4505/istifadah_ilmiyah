# Entry tags — plan

Status: **all 5 phases built (2026-11-05), not browser-verified** (spec finalised 2026-11-05). Migration applied to staging only; production push pending. Follow-up migration `20261105110000_entry_tags_department_change.sql` (department change reaches the entry's tags) is applied to staging only; `20261105100000` is already live in production `public`, the follow-up is not.

## Why

Some expenses are one-off for an event but leave something behind: a washroom block that was
built, tent stock in a store room, equipment that was bought. Next year only maintenance is needed.
Today nothing carries that knowledge from one event to the next. A **tag** is a named record of
such a thing. It is linked to the entries that paid for it and to the departments it belongs to,
and it shows up in later events. When a similar request or bill comes in, the reviewer can see
"we already have this" and treat it as maintenance.

## Decisions (all confirmed by the user)

| # | Question | Decision |
|---|---|---|
| 1 | Where tag data lives | Separate tables. **No new column on `entries`**, so the Excel import can never overwrite tags. |
| 2 | Tag fields | Name, description, start event, optional end event (empty = perpetual). No "kind" field. |
| 3 | Departments | **Required**, at least one. A tag can span **many** departments. |
| 4 | Sub-departments | **Optional**. Taken from the entry if it has one. A missing sub-department never causes an error. |
| 5 | Sub-department set later | If a reviewer later sets a linked entry's sub-department, it is added to the tag automatically. |
| 6 | Entries | **Optional**. A tag can be just departments + description (e.g. something built before this system existed). |
| 7 | Linking an entry | Adds that entry's department (and sub-department, if set) to the tag automatically. |
| 8 | Unlinking an entry | Departments and sub-departments **stay** on the tag. Only a super-admin removes them, by hand. Any scope row (manual or entry-sourced) can be removed, except a tag's last department. |
| 9 | Which events' entries | The picker opens on the **current event**; the user can switch it to a previous event and tag older entries. If a linked entry's event is before the tag's start event, the start event **moves back** to it. |
| 10 | Active period | A tag shows in every event from its start event to its end event (or every later event if perpetual). Compare events by `event.starts_on` (fallback `hijri_year`). |
| 11 | Voided entries | Stay linked and are shown as voided; **excluded from cost totals**. |
| 12 | Yearly check | **Optional note only**: at most one free-text note per tag per event (e.g. "1449: 12 tents torn"). No status choices. |
| 13 | Permissions | **Super-admins only** create, edit, link, unlink and delete. Admins can **view all tags** (admins have no department assignment, so they see every department's tags, same as entries); department users see only tags touching their departments. |
| 14 | Where tags appear | Tags page, notice on the entries page, notice on the review screen, and a reports section. |
| 15 | Cost display | Per event: "built 1448 ₹X · maintained 1449 ₹Y". Use INR grouping (₹2,41,76,880) as on every other money field. |

## Data model

```
tag
  id               bigint identity pk
  name             text not null
  description      text
  start_event_id   bigint not null -> event(id)
  end_event_id     bigint null     -> event(id)     -- null = perpetual
  created_at/by, updated_at/by

tag_entry          (tag_id, entry_id) pk
  tag_id    -> tag(id) on delete cascade
  entry_id  -> entries(id)
  linked_at/by

tag_scope          one row per department or department+sub-department on the tag
  id               bigint identity pk
  tag_id           -> tag(id) on delete cascade
  department_id    bigint not null -> department(id)
  sub_department_id bigint null    -> sub_department(id)
  source           text check (source in ('entry','manual'))   -- how it got there
  unique (tag_id, department_id, sub_department_id)  -- use NULLS NOT DISTINCT

tag_event_note
  tag_id   -> tag(id) on delete cascade
  event_id -> event(id)
  note     text not null
  updated_at/by
  pk (tag_id, event_id)
```

Database behaviour:
- **Trigger on `tag_entry` insert**: upsert `tag_scope` with the entry's `department_id` and its
  `sub_department_id` (null if none). If the entry's event is before the tag's start event,
  move `tag.start_event_id` back to it.
- **Trigger on `entries` update of `sub_department_id`** (null → value): for every tag linked to
  that entry, upsert the matching `tag_scope` row. Never remove scope rows (decision 8).
- **Delete on `tag_entry`**: removes nothing from `tag_scope`.
- Check: `end_event_id`, when set, is not before `start_event_id`.
- View `tag_cost_by_event`: per tag per event, the sum of linked **non-voided** entries' amounts, plus a voided count.
- View or function "tags active in event X": tags whose period contains X.

RLS:
- Write on all four tables: `private.is_superadmin()`.
- Read: super-admins see everything. Admins see tags with a `tag_scope` department they can see.
  Reuse the set-based visibility pattern from
  `supabase/migrations/20261005120000_rls_set_based_visibility.sql`: no per-row function calls,
  which were the cause of the 8s timeouts.

Indexes: `tag_entry(entry_id)`, `tag_scope(department_id)`, `tag_scope(sub_department_id)`.

Staging: migrations must also work for the staging schema (`NEXT_PUBLIC_DB_SCHEMA`, see `docs/staging.md`).

## Phases

### Phase 1: schema
- Migration with the four tables, the triggers, the check, the cost view, the active-in-event
  function, RLS and indexes, as above.
- Load the `supabase-postgres-best-practices` skill first.
- SQL tests: linking an entry adds scope; an entry with no sub-department adds department-only
  scope without error; a sub-department set later is added to the tag; unlinking keeps scope; an
  older entry moves the start event back; voided entries are excluded from cost; an admin cannot
  write; an admin cannot see tags outside their departments.
- Apply with `npx supabase` (not bare `supabase`).

### Phase 2: tags page
- New route `app/(app)/tags`, plus a nav entry.
- List the tags active in the selected event, filterable by department and sub-department. Each
  row shows name, period ("1448 → perpetual"), departments, cost per event, and the current
  event's note.
- Super-admins can create and edit tags: name, description, start event, end event, departments
  and sub-departments (manual scope), and an entry picker. The picker defaults to the current
  event, can be switched to earlier events, and filters by department.
- Tag detail: linked entries grouped by event, voided entries marked as voided, a per-event note
  editor, and removal of manual scope.
- Show reference data as **tables**, not bullet lists. Use plain-English errors
  (`toastError` / `FriendlyError` / `friendlyDataError`).

### Phase 3: entries page
- Super-admins get **"Add to tag"** on an entry (row action and entry detail) and as a bulk action
  on selected entries. It picks an existing tag or creates one inline. The existing dialogs follow
  this pattern: `components/entries/bulk-void-dialog.tsx`, `bulk-enrichment-dialog.tsx`.
- Entry detail (`components/entries/detail/`) lists the tags the entry belongs to.
- Notice: when the department filter (or an entry's department) has tags active in the current
  event, show "Sanitation has 2 tags from earlier years: Washroom block (perpetual), …" with links
  to the tags page.
- Keep the existing filters and the KPI bar layout untouched (all 13 filters stay).

### Phase 4: review screen
- In `components/review/review-workspace.tsx`, when the entry's department or sub-department has
  active tags, show a compact notice in **one place**, not repeated across steps (see the
  no-duplicate-status rule). It lists the tag names and their current-event notes.
- Super-admins can link the entry to one of those tags from the notice.
- Owner decision 2026-11-05: the notice covers ALL entries linked to the bill (a bill inherits
  through its entries): tags active in the event touching any of their departments, once per tag,
  in the same single notice. "Linked" is per entry; on a multi-entry bill the Link action has a
  small select to choose the entry (default: the one whose department the tag covers).

### Phase 5: reports
- Add a section under `app/(app)/reports` + `lib/reports`: tags active in the event, the cost per
  event for each, and the totals carried in from earlier events. Use the existing shadcn/Recharts
  conventions.

## Owner decisions, 2026-11-05 (follow-ups)
- Any scope row (manual or entry-sourced) can be removed by a super-admin; the page warns that an
  entry-sourced row may come back if the entry is re-linked or its sub-department is set again.
- Moving a tag's start event later than a linked entry's event is allowed after a warning
  (checked in the updateTag server action; the form offers "Save anyway").

## Notes for the implementing session
- Run `graphify update .` after code changes.
- Subagents (if `exe-now` splits work) must be told **not to commit or push**. Don't use Agent
  worktree isolation in this repo.
- Never import a constant or function (not a component) from a `'use client'` module into a
  Server Component. Put shared values in a plain module.
- Default theme stays light.
