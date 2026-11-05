/**
 * Entry tags on the review screen (docs/entry-tags-plan.md, Phase 4): the pure logic that
 * turns the raw tag rows for a bill's linked entries into the notice's table rows. Plain
 * module on purpose -- no 'use client' / 'use server' -- because the review page (a Server
 * Component) builds the rows and the notice (a Client Component) re-sorts them against the
 * live sub-department pick, and importing a value from a 'use client' module into a Server
 * Component crashes the production RSC build.
 *
 * A bill can cover several entries, and entries are the unit people tag, so the notice looks
 * at ALL of the bill's entries (owner decision 2026-11-05): it gathers their distinct
 * departments and lists every tag, active in the selected event, that touches ANY of them --
 * once per tag, in the one notice. "Linked" is per entry.
 *
 * "Active in the current event" is decided by the database (rpc tags_active_in_event), so
 * nothing here re-derives a tag's period; the active tag list is an input.
 */
import { tagPeriodLabel, type DepartmentRef, type EventOrderRef, type TagRow } from '@/lib/tags/shared'

/** One of the bill's linked entries, as the notice needs it. Serialisable. */
export interface ReviewNoticeEntry {
  entryId: number
  ubblNumber: string
  amount: number | null
  /** null = the entry has no department yet. */
  departmentId: number | null
  /** null = no sub-department picked. */
  subDepartmentId: number | null
}

/** One tag_scope row inside one of the bill's departments, with its sub-department name if any. */
export interface ReviewTagScopeInput {
  tag_id: number
  department_id: number
  /** null = the whole department. */
  sub_department_id: number | null
  sub_department_name: string | null
}

/** What a tag covers inside one of the bill's departments. */
export interface ReviewTagCoverage {
  departmentId: number
  departmentName: string
  /** True when the tag covers the whole department (a scope row with no sub-department). */
  coversWholeDepartment: boolean
  /** Sub-departments of this department on the tag, sorted by name. */
  subDepartments: Array<{ id: number; name: string }>
}

/** One row of the review-screen tag notice. Serialisable: it crosses the RSC boundary. */
export interface ReviewTagRow {
  tagId: number
  name: string
  /** "1448 → perpetual", "1448 → 1450", "1448 only". */
  periodLabel: string
  /** The tag's note for the current event, or null when there is none. */
  note: string | null
  /** One item per bill department the tag touches, sorted by department name. */
  coverage: ReviewTagCoverage[]
  /** The bill's entries that are already linked to this tag. */
  linkedEntryIds: number[]
}

export interface ReviewTagNoticeData {
  /** The distinct departments of the bill's entries, sorted by name, for the heading. */
  departments: DepartmentRef[]
  /** Every entry linked to the bill (the Link action picks one of these). */
  entries: ReviewNoticeEntry[]
  rows: ReviewTagRow[]
  /** Plain-English load error (already through friendlyDataError), or null. */
  error: string | null
}

/** The distinct departments of a set of entries, sorted by name. Entries with none are skipped. */
export function distinctEntryDepartments(
  entries: readonly Pick<ReviewNoticeEntry, 'departmentId'>[],
  departmentName: (id: number) => string | null
): DepartmentRef[] {
  const seen = new Map<number, DepartmentRef>()
  for (const entry of entries) {
    if (entry.departmentId === null || seen.has(entry.departmentId)) continue
    seen.set(entry.departmentId, {
      id: entry.departmentId,
      name: departmentName(entry.departmentId) ?? 'Unnamed department',
    })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The tags to show for a bill: those active in the current event (`activeTags`, as the rpc
 * returned them) that have at least one scope row in ANY of the bill's departments, each tag
 * once however many departments or entries it matches. Scope rows from other departments must
 * already be filtered out by the caller's query, but are ignored here too so the function is
 * safe on any input. A missing sub-department never matters -- department membership alone
 * puts a tag on the notice.
 */
export function buildReviewTagRows(input: {
  departments: readonly DepartmentRef[]
  activeTags: readonly Pick<TagRow, 'id' | 'name' | 'start_event_id' | 'end_event_id'>[]
  scope: readonly ReviewTagScopeInput[]
  notes: readonly { tag_id: number; note: string }[]
  /** tag_entry rows for the bill's entries. */
  links: readonly { tag_id: number; entry_id: number }[]
  events: readonly Pick<EventOrderRef, 'id' | 'hijriYear'>[]
}): ReviewTagRow[] {
  const { departments, activeTags, scope, notes, links, events } = input
  const eventById = new Map(events.map((e) => [e.id, e]))
  const noteByTag = new Map(notes.map((n) => [n.tag_id, n.note]))
  const departmentById = new Map(departments.map((d) => [d.id, d]))

  const linkedByTag = new Map<number, Set<number>>()
  for (const link of links) {
    let set = linkedByTag.get(link.tag_id)
    if (!set) {
      set = new Set()
      linkedByTag.set(link.tag_id, set)
    }
    set.add(link.entry_id)
  }

  // tag -> department -> { whole, subs }
  const scopeByTag = new Map<number, Map<number, { whole: boolean; subs: Map<number, string> }>>()
  for (const row of scope) {
    if (!departmentById.has(row.department_id)) continue
    let byDepartment = scopeByTag.get(row.tag_id)
    if (!byDepartment) {
      byDepartment = new Map()
      scopeByTag.set(row.tag_id, byDepartment)
    }
    let bucket = byDepartment.get(row.department_id)
    if (!bucket) {
      bucket = { whole: false, subs: new Map() }
      byDepartment.set(row.department_id, bucket)
    }
    if (row.sub_department_id === null) bucket.whole = true
    else bucket.subs.set(row.sub_department_id, row.sub_department_name ?? 'Unnamed sub-department')
  }

  const rows: ReviewTagRow[] = []
  const emitted = new Set<number>()
  for (const tag of activeTags) {
    if (emitted.has(tag.id)) continue
    const byDepartment = scopeByTag.get(tag.id)
    if (!byDepartment) continue
    emitted.add(tag.id)
    const coverage: ReviewTagCoverage[] = [...byDepartment]
      .map(([departmentId, bucket]) => ({
        departmentId,
        departmentName: departmentById.get(departmentId)?.name ?? 'Unnamed department',
        coversWholeDepartment: bucket.whole,
        subDepartments: [...bucket.subs]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.departmentName.localeCompare(b.departmentName))
    rows.push({
      tagId: tag.id,
      name: tag.name,
      periodLabel: tagPeriodLabel(
        eventById.get(tag.start_event_id) ?? null,
        tag.end_event_id === null ? null : eventById.get(tag.end_event_id) ?? { id: tag.end_event_id, hijriYear: '?' }
      ),
      note: noteByTag.get(tag.id) ?? null,
      coverage,
      linkedEntryIds: [...(linkedByTag.get(tag.id) ?? [])].sort((a, b) => a - b),
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** How well a tag row fits one entry: 2 = its department and sub-department, 1 = its department only, 0 = neither. */
export function tagRowEntryFit(
  row: Pick<ReviewTagRow, 'coverage'>,
  entry: Pick<ReviewNoticeEntry, 'departmentId' | 'subDepartmentId'>
): 0 | 1 | 2 {
  if (entry.departmentId === null) return 0
  const cover = row.coverage.find((c) => c.departmentId === entry.departmentId)
  if (!cover) return 0
  if (cover.coversWholeDepartment) return 2
  if (entry.subDepartmentId !== null && cover.subDepartments.some((s) => s.id === entry.subDepartmentId)) return 2
  return 1
}

/**
 * Whether a tag row applies directly to an entry: a tag on the whole department applies to
 * every sub-department; with no sub-department picked, only whole-department tags count.
 */
export function tagRowMatchesEntry(
  row: Pick<ReviewTagRow, 'coverage'>,
  entry: Pick<ReviewNoticeEntry, 'departmentId' | 'subDepartmentId'>
): boolean {
  return tagRowEntryFit(row, entry) === 2
}

/**
 * Display order: tags that match any of the bill's entries (using their LIVE sub-department
 * picks) first, then the rest; by name within each group. Returns a new array.
 */
export function orderReviewTagRows(
  rows: readonly ReviewTagRow[],
  entries: readonly Pick<ReviewNoticeEntry, 'departmentId' | 'subDepartmentId'>[]
): ReviewTagRow[] {
  const rank = (row: ReviewTagRow) => (entries.some((e) => tagRowMatchesEntry(row, e)) ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * The entries a tag can still be linked from: the bill's entries minus those already linked
 * (`linkedEntryIds` from the server plus anything linked in this session).
 */
export function unlinkedEntriesForTag<T extends Pick<ReviewNoticeEntry, 'entryId'>>(
  entries: readonly T[],
  linkedEntryIds: ReadonlySet<number>
): T[] {
  return entries.filter((e) => !linkedEntryIds.has(e.entryId))
}

/**
 * The entry the Link select should start on: the one whose department (and, better, whose
 * sub-department) the tag covers. Ties go to the earlier entry in `candidates`, which the page
 * orders largest amount first. Null when there is no candidate.
 */
export function defaultLinkEntryId<T extends Pick<ReviewNoticeEntry, 'entryId' | 'departmentId' | 'subDepartmentId'>>(
  row: Pick<ReviewTagRow, 'coverage'>,
  candidates: readonly T[]
): number | null {
  let best: T | null = null
  let bestFit = -1
  for (const entry of candidates) {
    const fit = tagRowEntryFit(row, entry)
    if (fit > bestFit) {
      best = entry
      bestFit = fit
    }
  }
  return best?.entryId ?? null
}

/**
 * "Whole department", or the sub-department names ("Tents, Washrooms"), or both. With
 * `includeDepartment` (a bill spanning several departments) each part is prefixed with its
 * department: "Sanitation: Tents; Venue Setup: Whole department".
 */
export function reviewTagCoverageLabel(row: Pick<ReviewTagRow, 'coverage'>, includeDepartment = false): string {
  const parts = row.coverage.map((c) => {
    const names = c.subDepartments.map((s) => s.name)
    const text = c.coversWholeDepartment
      ? names.length > 0
        ? `Whole department, ${names.join(', ')}`
        : 'Whole department'
      : names.length > 0
        ? names.join(', ')
        : 'Whole department'
    return includeDepartment ? `${c.departmentName}: ${text}` : text
  })
  return parts.join('; ')
}

/**
 * "Sanitation has 2 tags on record" for one department; "This bill's 2 departments have 3
 * tags on record" for several. Not "from earlier years": a tag can start in the current event.
 */
export function reviewTagNoticeHeading(departmentNames: readonly string[], count: number): string {
  const names = departmentNames.map((n) => n.trim()).filter(Boolean)
  const noun = count === 1 ? 'tag' : 'tags'
  if (departmentNames.length > 1) {
    return `This bill's ${departmentNames.length} departments have ${count} ${noun} on record`
  }
  const who = names[0] ?? 'This department'
  return `${who} has ${count} ${noun} on record`
}
