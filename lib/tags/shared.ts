/**
 * Entry tags (docs/entry-tags-plan.md, Phase 2): row shapes and the pure logic the Tags
 * pages share. Plain module on purpose -- no 'use client' / 'use server' -- because Server
 * Components, Server Actions and Client Components all import these VALUES, and importing
 * a value from a 'use client' module into a Server Component crashes the production RSC
 * build. No generated DB types exist in this repo, so the rows are hand-written, in
 * lockstep with supabase/migrations/20261105100000_entry_tags.sql.
 */

/** Shown where a tag with no departments would otherwise show an empty cell or table. */
export const NO_DEPARTMENTS_HINT =
  'No departments yet. Link an entry or add a department so department users can see this tag.'

// ---- Row shapes (public.tag, tag_scope, tag_event_note, tag_cost_by_event) --------------

export interface TagRow {
  id: number
  name: string
  description: string | null
  start_event_id: number
  /** null = perpetual */
  end_event_id: number | null
  created_at: string
  updated_at: string
}

export type TagScopeSource = 'entry' | 'manual'

export interface TagScopeRow {
  id: number
  tag_id: number
  department_id: number
  /** null = the whole department */
  sub_department_id: number | null
  source: TagScopeSource
}

export interface TagEventNoteRow {
  tag_id: number
  event_id: number
  note: string
}

export interface TagCostRow {
  tag_id: number
  event_id: number
  /** Sum of the non-voided linked entries' amounts in that event. */
  cost: number
  entry_count: number
  voided_count: number
}

/** The slice of an event the tag logic needs. `Event` (lib/events/types.ts) satisfies it. */
export interface EventOrderRef {
  id: number
  hijriYear: string
  startsOn: string | null
}

export interface DepartmentRef {
  id: number
  name: string
}

export interface SubDepartmentRef {
  id: number
  name: string
  departmentId: number
}

/** Group rows by a key, preserving order (Map.groupBy needs Node 21; engines here say >=20). */
export function groupByKey<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const bucket = out.get(k)
    if (bucket) bucket.push(row)
    else out.set(k, [row])
  }
  return out
}

// ---- Event order ------------------------------------------------------------------------

/**
 * Negative when `a` is before `b`. Mirrors private.event_precedes in the migration: by
 * `starts_on` when both events have one and they differ, otherwise by `hijri_year` (shorter
 * string first, then text order, so '999' < '1448').
 */
export function compareEvents(a: EventOrderRef, b: EventOrderRef): number {
  if (a.id === b.id) return 0
  if (a.startsOn && b.startsOn && a.startsOn !== b.startsOn) return a.startsOn < b.startsOn ? -1 : 1
  if (a.hijriYear.length !== b.hijriYear.length) return a.hijriYear.length < b.hijriYear.length ? -1 : 1
  if (a.hijriYear === b.hijriYear) return 0
  return a.hijriYear < b.hijriYear ? -1 : 1
}

/** A new array, oldest event first. */
export function sortEventsAscending<T extends EventOrderRef>(events: readonly T[]): T[] {
  return [...events].sort(compareEvents)
}

/**
 * The events a tag is active in, oldest first: from its start event to its end event, or --
 * when perpetual -- to the newest event that exists. Empty when the start event is unknown.
 */
export function eventsInTagPeriod<T extends EventOrderRef>(
  events: readonly T[],
  startEventId: number,
  endEventId: number | null
): T[] {
  const start = events.find((e) => e.id === startEventId)
  if (!start) return []
  const end = endEventId === null ? null : events.find((e) => e.id === endEventId) ?? null
  return sortEventsAscending(events).filter(
    (e) => compareEvents(e, start) >= 0 && (end === null || compareEvents(e, end) <= 0)
  )
}

/** Event label as used in the event switcher: "Name (1448 H)". */
export function eventLabel(event: { name: string; hijriYear: string }): string {
  return `${event.name} (${event.hijriYear} H)`
}

// ---- Period label -----------------------------------------------------------------------

/**
 * "1448 → perpetual", "1448 → 1450", or "1448 only" when it starts and ends in the same
 * event. Events are labelled by Hijri year here, as in the event switcher ("... (1448 H)").
 */
export function tagPeriodLabel(
  start: Pick<EventOrderRef, 'id' | 'hijriYear'> | null | undefined,
  end: Pick<EventOrderRef, 'id' | 'hijriYear'> | null | undefined
): string {
  const startLabel = start?.hijriYear ?? '?'
  if (!end) return `${startLabel} → perpetual`
  if (start && end.id === start.id) return `${startLabel} only`
  return `${startLabel} → ${end.hijriYear}`
}

// ---- Cost per event ---------------------------------------------------------------------

export type CostRole = 'built' | 'maintained'

export interface CostSegment {
  eventId: number
  hijriYear: string
  /** 'built' for the tag's start event, 'maintained' for every other event. */
  role: CostRole
  cost: number
  entryCount: number
}

/**
 * One segment per event in which the tag has at least one non-voided linked entry, oldest
 * first. Voided entries never count (decision 11): an event with only voided entries has no
 * segment. Events missing from `events` are dropped rather than guessed at.
 */
export function buildCostSegments(
  startEventId: number,
  costs: readonly Pick<TagCostRow, 'event_id' | 'cost' | 'entry_count'>[],
  events: readonly EventOrderRef[]
): CostSegment[] {
  const byId = new Map(events.map((e) => [e.id, e]))
  const segments: Array<CostSegment & { ref: EventOrderRef }> = []
  for (const row of costs) {
    if (Number(row.entry_count) <= 0) continue
    const ref = byId.get(row.event_id)
    if (!ref) continue
    segments.push({
      ref,
      eventId: row.event_id,
      hijriYear: ref.hijriYear,
      role: row.event_id === startEventId ? 'built' : 'maintained',
      cost: Number(row.cost) || 0,
      entryCount: Number(row.entry_count),
    })
  }
  segments.sort((a, b) => compareEvents(a.ref, b.ref))
  return segments.map((s) => ({
    eventId: s.eventId,
    hijriYear: s.hijriYear,
    role: s.role,
    cost: s.cost,
    entryCount: s.entryCount,
  }))
}

/** "built 1448 ₹5,00,000 · maintained 1449 ₹12,000". Empty string when there are no segments. */
export function formatCostSummary(segments: readonly CostSegment[], formatMoney: (n: number) => string): string {
  return segments.map((s) => `${s.role} ${s.hijriYear} ${formatMoney(s.cost)}`).join(' · ')
}

// ---- Scope ------------------------------------------------------------------------------

export interface ScopeGroup {
  departmentId: number
  departmentName: string
  /** Sub-department names, sorted; empty when the tag covers the department as a whole. */
  subDepartmentNames: string[]
}

/** Groups scope rows by department for display: "Sanitation" + its sub-departments. */
export function groupScopeByDepartment(
  scope: readonly Pick<TagScopeRow, 'department_id' | 'sub_department_id'>[],
  departmentName: (id: number) => string,
  subDepartmentName: (id: number) => string
): ScopeGroup[] {
  const groups = new Map<number, ScopeGroup>()
  for (const row of scope) {
    let group = groups.get(row.department_id)
    if (!group) {
      group = {
        departmentId: row.department_id,
        departmentName: departmentName(row.department_id),
        subDepartmentNames: [],
      }
      groups.set(row.department_id, group)
    }
    if (row.sub_department_id !== null) {
      const name = subDepartmentName(row.sub_department_id)
      if (!group.subDepartmentNames.includes(name)) group.subDepartmentNames.push(name)
    }
  }
  const result = [...groups.values()]
  for (const group of result) group.subDepartmentNames.sort((a, b) => a.localeCompare(b))
  return result.sort((a, b) => a.departmentName.localeCompare(b.departmentName))
}

/**
 * The ids of tags that touch the chosen department and/or sub-department. No filter keeps all.
 * With a sub-department chosen, a tag that covers the chosen department as a whole (a scope
 * row with no sub-department) also matches -- it covers every sub-department in it. That only
 * applies when the department is chosen too: a sub-department alone cannot say which
 * department a department-wide row would have to belong to.
 */
export function filterTagIdsByScope(
  scope: readonly Pick<TagScopeRow, 'tag_id' | 'department_id' | 'sub_department_id'>[],
  filter: { departmentId: number | null; subDepartmentId: number | null }
): Set<number> | null {
  const { departmentId, subDepartmentId } = filter
  if (departmentId === null && subDepartmentId === null) return null
  const ids = new Set<number>()
  for (const row of scope) {
    if (departmentId !== null && row.department_id !== departmentId) continue
    if (subDepartmentId !== null) {
      const sameSub = row.sub_department_id === subDepartmentId
      const wholeDepartment = departmentId !== null && row.sub_department_id === null
      if (!sameSub && !wholeDepartment) continue
    }
    ids.add(row.tag_id)
  }
  return ids
}

// ---- Linked entries ---------------------------------------------------------------------

export interface LinkedEntryLike {
  event_id: number
  amount: number | null
  is_void: boolean
}

export interface EntryTotals {
  /** Sum of non-voided amounts. */
  total: number
  activeCount: number
  voidedCount: number
}

/** Cost totals for a set of entries. Voided entries are counted but never summed (decision 11). */
export function summarizeEntries(entries: readonly Pick<LinkedEntryLike, 'amount' | 'is_void'>[]): EntryTotals {
  let total = 0
  let activeCount = 0
  let voidedCount = 0
  for (const entry of entries) {
    if (entry.is_void) {
      voidedCount += 1
      continue
    }
    activeCount += 1
    total += Number(entry.amount) || 0
  }
  return { total, activeCount, voidedCount }
}

/**
 * Newest date first, entries with no date last, then highest id first -- the order the tag
 * page lists linked entries in. A new array. (Done in code, not in the query, because the
 * linked entries are read in chunks and stitched together.)
 */
export function sortLinkedEntries<T extends { id: number; date: string | null }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1
      if (b.date === null) return -1
      return a.date < b.date ? 1 : -1
    }
    return b.id - a.id
  })
}

export interface EventEntryGroup<T, E extends EventOrderRef = EventOrderRef> {
  event: E
  entries: T[]
}

/** Groups entries by event, oldest event first. Entries whose event is unknown are dropped. */
export function groupEntriesByEvent<T extends LinkedEntryLike, E extends EventOrderRef>(
  entries: readonly T[],
  events: readonly E[]
): EventEntryGroup<T, E>[] {
  const byId = new Map(events.map((e) => [e.id, e]))
  const groups = new Map<number, EventEntryGroup<T, E>>()
  for (const entry of entries) {
    const event = byId.get(entry.event_id)
    if (!event) continue
    let group = groups.get(event.id)
    if (!group) {
      group = { event, entries: [] }
      groups.set(event.id, group)
    }
    group.entries.push(entry)
  }
  return [...groups.values()].sort((a, b) => compareEvents(a.event, b.event))
}

// ---- Validation messages shared by the form and the actions ------------------------------

export const TAG_NAME_MAX = 200
export const TAG_DESCRIPTION_MAX = 2000
export const TAG_NOTE_MAX = 2000

/** A scope pick as the create form and the actions pass it around. */
export interface ScopePick {
  departmentId: number
  subDepartmentId: number | null
}

/** Drops repeated (department, sub-department) pairs, keeping the first. */
export function dedupeScopePicks(picks: readonly ScopePick[]): ScopePick[] {
  const seen = new Set<string>()
  const out: ScopePick[] = []
  for (const pick of picks) {
    const key = `${pick.departmentId}:${pick.subDepartmentId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pick)
  }
  return out
}
