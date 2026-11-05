/**
 * Entry tags (docs/entry-tags-plan.md, Phase 3): the pure logic the Entries screens share --
 * the "tags from earlier years" notice, the Add-to-tag defaults and the tag ranking. Plain
 * module on purpose (no 'use client' / 'use server'): Server Components, Server Actions and
 * Client Components all import these VALUES. Row shapes and event ordering live in
 * lib/tags/shared.ts and are reused, not repeated.
 */
import type { Event } from '@/lib/events/types'
import {
  compareEvents,
  dedupeScopePicks,
  type DepartmentRef,
  type EventOrderRef,
  type ScopePick,
  type SubDepartmentRef,
} from '@/lib/tags/shared'

/** How many entry ids one request carries. Keeps PostgREST `in.(...)` URLs short. */
export const TAG_ENTRY_CHUNK = 200

/** A new array of consecutive slices of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number = TAG_ENTRY_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---- The "earlier years" notice ---------------------------------------------------------

/** A tag that is active in the selected event but started in an earlier one. */
export interface EarlierTagSummary {
  id: number
  name: string
  startEventId: number
  /** null = perpetual */
  endEventId: number | null
  /** "1448 → perpetual" / "1448 → 1450" / "1448 only" -- see tagPeriodLabel. */
  periodLabel: string
  /** Every department on the tag's scope (sub-departments collapse to their department). */
  departmentIds: number[]
}

export interface TagNoticeItem {
  id: number
  name: string
  /** What is shown in brackets after the name: "perpetual" or "1448 → 1450". */
  period: string
}

export interface TagNoticeGroup {
  departmentId: number
  departmentName: string
  tags: TagNoticeItem[]
}

/** "perpetual" for a tag with no end event, otherwise its full period label. */
export function noticePeriod(tag: Pick<EarlierTagSummary, 'endEventId' | 'periodLabel'>): string {
  return tag.endEventId === null ? 'perpetual' : tag.periodLabel
}

/**
 * One group per department that has at least one earlier-year tag active in the selected
 * event, in the order the departments are given. `excludeTagIds` drops tags the reader
 * already sees elsewhere (an entry's own tags on its detail page).
 */
export function buildEarlierTagNotices(
  tags: readonly EarlierTagSummary[],
  departments: readonly DepartmentRef[],
  excludeTagIds: ReadonlySet<number> = new Set()
): TagNoticeGroup[] {
  const groups: TagNoticeGroup[] = []
  const seen = new Set<number>()
  for (const department of departments) {
    if (seen.has(department.id)) continue
    seen.add(department.id)
    const matching = tags
      .filter((t) => !excludeTagIds.has(t.id) && t.departmentIds.includes(department.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t): TagNoticeItem => ({ id: t.id, name: t.name, period: noticePeriod(t) }))
    if (matching.length > 0) groups.push({ departmentId: department.id, departmentName: department.name, tags: matching })
  }
  return groups
}

/** "Sanitation has 2 tags from earlier years" (the tag list follows it, as links). */
export function noticeHeadline(group: Pick<TagNoticeGroup, 'departmentName' | 'tags'>): string {
  const n = group.tags.length
  return `${group.departmentName} has ${n} ${n === 1 ? 'tag' : 'tags'} from earlier years`
}

/** The whole sentence as plain text -- "Sanitation has 2 tags from earlier years: Washroom block (perpetual), …". */
export function noticeText(group: TagNoticeGroup): string {
  return `${noticeHeadline(group)}: ${group.tags.map((t) => `${t.name} (${t.period})`).join(', ')}`
}

// ---- Add to tag -------------------------------------------------------------------------

/** An existing tag as the Add-to-tag picker lists it. */
export interface TagOption {
  id: number
  name: string
  description: string | null
  periodLabel: string
  departmentIds: number[]
}

export interface RankedTagOption extends TagOption {
  /** The tag already covers one of the entries' departments. */
  matches: boolean
}

/** Tags that touch one of `departmentIds` first, then everything else; each half by name. */
export function rankTagsForDepartments(tags: readonly TagOption[], departmentIds: readonly number[]): RankedTagOption[] {
  const wanted = new Set(departmentIds)
  return tags
    .map((t): RankedTagOption => ({ ...t, matches: t.departmentIds.some((d) => wanted.has(d)) }))
    .sort((a, b) => Number(b.matches) - Number(a.matches) || a.name.localeCompare(b.name))
}

/** Department-only scope picks for the entries given (one per distinct department, by id). */
export function defaultScopeFromEntries(entries: ReadonlyArray<{ department_id: number | null }>): ScopePick[] {
  const ids = [...new Set(entries.flatMap((e) => (e.department_id === null ? [] : [e.department_id])))]
  ids.sort((a, b) => a - b)
  return dedupeScopePicks(ids.map((departmentId) => ({ departmentId, subDepartmentId: null })))
}

/**
 * The start event a new tag opens with: the oldest event among the entries being tagged
 * (linking an older entry would move the start back to it anyway), else the selected
 * event. Null when neither is known.
 */
export function defaultStartEventId(
  entryEventIds: readonly number[],
  events: readonly EventOrderRef[],
  selectedEventId: number | null
): number | null {
  const wanted = new Set(entryEventIds)
  let oldest: EventOrderRef | null = null
  for (const event of events) {
    if (!wanted.has(event.id)) continue
    if (oldest === null || compareEvents(event, oldest) < 0) oldest = event
  }
  return oldest?.id ?? selectedEventId
}

/** Everything the Add-to-tag dialog needs, loaded when it opens (see getAddToTagOptions). */
export interface AddToTagOptions {
  events: Event[]
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  tags: TagOption[]
  selectedEventId: number | null
  /** Department-only picks taken from the entries being tagged. */
  defaultScope: ScopePick[]
  /** The start event a new tag should open with. */
  defaultStartEventId: number | null
  /** How many of the requested entries this user could actually read. */
  entryCount: number
}

/**
 * Success line after linking. `linked` counts only the entries newly added; `requested` is how
 * many were picked, so ones already on the tag are reported as skipped rather than counted.
 * `Added 3 entries to "Washroom block".` / `... 2 were already on it.`
 */
export function addedToTagMessage(linked: number, tagName: string, requested: number = linked): string {
  if (linked === 0) {
    return requested === 1
      ? `That entry was already on "${tagName}".`
      : `Those entries were already on "${tagName}".`
  }
  const base = `Added ${linked.toLocaleString('en-IN')} ${linked === 1 ? 'entry' : 'entries'} to "${tagName}".`
  const skipped = requested - linked
  return skipped > 0 ? `${base} ${skipped.toLocaleString('en-IN')} ${skipped === 1 ? 'was' : 'were'} already on it.` : base
}

/** Success line on the tag page: `Linked 3 entries.` (+ how many were already linked). */
export function linkedEntriesMessage(linked: number, requested: number = linked): string {
  if (linked === 0) return requested === 1 ? 'That entry was already linked.' : 'Those entries were already linked.'
  const base = `Linked ${linked.toLocaleString('en-IN')} ${linked === 1 ? 'entry' : 'entries'}.`
  const skipped = requested - linked
  return skipped > 0 ? `${base} ${skipped.toLocaleString('en-IN')} ${skipped === 1 ? 'was' : 'were'} already linked.` : base
}

/**
 * Joins the Add-to-tag options loaded for several batches of the same selection (one server
 * call carries at most TAG_ENTRIES_PER_CALL entries). Events, departments and tags are the
 * same in every batch, so the first is the base; the entry-derived parts are combined: the
 * department picks are the union, the start event is the oldest among the batches that
 * actually had readable entries, and the entry count is the sum.
 */
export function mergeAddToTagOptions(parts: readonly AddToTagOptions[]): AddToTagOptions {
  const [first, ...rest] = parts
  if (!first) throw new Error('mergeAddToTagOptions needs at least one batch')
  if (rest.length === 0) return first

  const departmentIds = [...new Set(parts.flatMap((p) => p.defaultScope.map((s) => s.departmentId)))].sort((a, b) => a - b)
  const withEntries = parts.filter((p) => p.entryCount > 0 && p.defaultStartEventId !== null)
  const startCandidates = withEntries.map((p) => p.defaultStartEventId as number)
  return {
    ...first,
    defaultScope: dedupeScopePicks(departmentIds.map((departmentId) => ({ departmentId, subDepartmentId: null }))),
    defaultStartEventId:
      startCandidates.length > 0
        ? defaultStartEventId(startCandidates, first.events, first.selectedEventId)
        : first.defaultStartEventId,
    entryCount: parts.reduce((sum, p) => sum + p.entryCount, 0),
  }
}
