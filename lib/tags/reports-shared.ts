/**
 * Entry tags -- reports section (docs/entry-tags-plan.md, Phase 5; decisions 10, 11, 15).
 * Pure shaping logic for the "Tags: built vs maintained" report: the tags active in the
 * selected event, each tag's cost per event (built / maintained), and the split between
 * cost carried in from earlier events and cost spent in the selected event.
 *
 * Plain module on purpose -- no 'use client' / 'use server' -- so the Server Component
 * section, the server loader and unit tests can all import these VALUES.
 *
 * Voided entries are already excluded from `cost` by the tag_cost_by_event view
 * (decision 11); here they are only counted, for the small "N voided" note.
 */
import {
  buildCostSegments,
  compareEvents,
  formatCostSummary,
  groupScopeByDepartment,
  tagPeriodLabel,
  type CostRole,
  type CostSegment,
  type EventOrderRef,
  type TagCostRow,
  type TagRow,
  type TagScopeRow,
} from '@/lib/tags/shared'

/** Where an event sits relative to the selected event. */
export type EventRelation = 'earlier' | 'this' | 'later'

export interface TagReportEventRef extends EventOrderRef {
  name: string
}

export interface TagCostReportRow {
  tagId: number
  name: string
  /** "1448 → perpetual" */
  periodLabel: string
  /** "Sanitation (Washrooms) · Tents" -- empty when the scope is unknown to this user. */
  departmentsLabel: string
  /** One segment per event with non-voided cost, oldest first. */
  segments: CostSegment[]
  /** "built 1448 ₹5,00,000 · maintained 1449 ₹12,000" (decision 15). Empty when no cost. */
  costSummary: string
  /** Non-voided cost in events before the selected one. */
  carriedIn: number
  /** Non-voided cost in the selected event. */
  thisEvent: number
  /** Non-voided cost in events after the selected one (only when viewing an older event). */
  later: number
  /** Non-voided linked entries across every event. */
  entryCount: number
  /** Voided linked entries across every event -- never part of any cost. */
  voidedCount: number
  /** True when the tag's start event is the selected event. */
  startsThisEvent: boolean
}

export interface TagEventCostRow {
  eventId: number
  name: string
  hijriYear: string
  relation: EventRelation
  /** Cost on tags whose start event is this event. */
  built: number
  /** Cost on tags that started in an earlier event. */
  maintained: number
  total: number
  /** Tags with non-voided cost in this event. */
  tagCount: number
  voidedCount: number
}

export interface TagCostReportTotals {
  tagCount: number
  carriedIn: number
  thisEvent: number
  later: number
  voidedCount: number
  /** Tags whose start event is the selected event. */
  newThisEventCount: number
  /** Active tags with no non-voided linked entry in any event (e.g. built before this system). */
  withoutCostCount: number
}

export interface TagCostReport {
  rows: TagCostReportRow[]
  eventRows: TagEventCostRow[]
  totals: TagCostReportTotals
}

export interface BuildTagCostReportInput {
  tags: readonly TagRow[]
  scope: readonly Pick<TagScopeRow, 'tag_id' | 'department_id' | 'sub_department_id'>[]
  costs: readonly TagCostRow[]
  events: readonly TagReportEventRef[]
  selectedEventId: number
  departmentName: (id: number) => string
  subDepartmentName: (id: number) => string
  formatMoney: (n: number) => string
}

/** Where `event` sits relative to `selected`, by the same order as the tag period logic. */
export function eventRelation(event: EventOrderRef, selected: EventOrderRef): EventRelation {
  const c = compareEvents(event, selected)
  return c < 0 ? 'earlier' : c > 0 ? 'later' : 'this'
}

/** "Sanitation (Washrooms, Drains) · Tents". */
export function departmentsLabel(
  scope: readonly Pick<TagScopeRow, 'department_id' | 'sub_department_id'>[],
  departmentName: (id: number) => string,
  subDepartmentName: (id: number) => string
): string {
  return groupScopeByDepartment(scope, departmentName, subDepartmentName)
    .map((g) => (g.subDepartmentNames.length > 0 ? `${g.departmentName} (${g.subDepartmentNames.join(', ')})` : g.departmentName))
    .join(' · ')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function buildTagCostReport(input: BuildTagCostReportInput): TagCostReport {
  const { tags, scope, costs, events, selectedEventId, departmentName, subDepartmentName, formatMoney } = input
  const eventById = new Map(events.map((e) => [e.id, e]))
  const selected = eventById.get(selectedEventId)

  const scopeByTag = new Map<number, Array<Pick<TagScopeRow, 'department_id' | 'sub_department_id'>>>()
  for (const row of scope) {
    const bucket = scopeByTag.get(row.tag_id)
    if (bucket) bucket.push(row)
    else scopeByTag.set(row.tag_id, [row])
  }
  const costsByTag = new Map<number, TagCostRow[]>()
  for (const row of costs) {
    const bucket = costsByTag.get(row.tag_id)
    if (bucket) bucket.push(row)
    else costsByTag.set(row.tag_id, [row])
  }

  const eventAgg = new Map<number, TagEventCostRow>()
  const rows: TagCostReportRow[] = []

  for (const tag of tags) {
    const tagCosts = costsByTag.get(tag.id) ?? []
    const segments = buildCostSegments(tag.start_event_id, tagCosts, events)
    let carriedIn = 0
    let thisEvent = 0
    let later = 0
    let entryCount = 0
    let voidedCount = 0

    for (const row of tagCosts) {
      const event = eventById.get(row.event_id)
      if (!event || !selected) continue
      const cost = Number(row.cost) || 0
      const active = Number(row.entry_count) || 0
      const voided = Number(row.voided_count) || 0
      const relation = eventRelation(event, selected)
      if (active > 0) {
        if (relation === 'earlier') carriedIn += cost
        else if (relation === 'this') thisEvent += cost
        else later += cost
      }
      entryCount += active
      voidedCount += voided

      let agg = eventAgg.get(event.id)
      if (!agg) {
        agg = {
          eventId: event.id,
          name: event.name,
          hijriYear: event.hijriYear,
          relation,
          built: 0,
          maintained: 0,
          total: 0,
          tagCount: 0,
          voidedCount: 0,
        }
        eventAgg.set(event.id, agg)
      }
      agg.voidedCount += voided
      if (active > 0) {
        const role: CostRole = row.event_id === tag.start_event_id ? 'built' : 'maintained'
        agg[role] = round2(agg[role] + cost)
        agg.total = round2(agg.total + cost)
        agg.tagCount += 1
      }
    }

    const start = eventById.get(tag.start_event_id) ?? null
    const end = tag.end_event_id === null ? null : eventById.get(tag.end_event_id) ?? null
    rows.push({
      tagId: tag.id,
      name: tag.name,
      periodLabel: tagPeriodLabel(start, end),
      departmentsLabel: departmentsLabel(scopeByTag.get(tag.id) ?? [], departmentName, subDepartmentName),
      segments,
      costSummary: formatCostSummary(segments, formatMoney),
      carriedIn: round2(carriedIn),
      thisEvent: round2(thisEvent),
      later: round2(later),
      entryCount,
      voidedCount,
      startsThisEvent: tag.start_event_id === selectedEventId,
    })
  }

  rows.sort((a, b) => b.carriedIn + b.thisEvent - (a.carriedIn + a.thisEvent) || a.name.localeCompare(b.name))

  const eventRows = [...eventAgg.values()]
    .filter((r) => r.total > 0 || r.voidedCount > 0)
    .sort((a, b) => compareEvents(eventById.get(a.eventId)!, eventById.get(b.eventId)!))

  const totals: TagCostReportTotals = {
    tagCount: rows.length,
    carriedIn: round2(rows.reduce((s, r) => s + r.carriedIn, 0)),
    thisEvent: round2(rows.reduce((s, r) => s + r.thisEvent, 0)),
    later: round2(rows.reduce((s, r) => s + r.later, 0)),
    voidedCount: rows.reduce((s, r) => s + r.voidedCount, 0),
    newThisEventCount: rows.filter((r) => r.startsThisEvent).length,
    withoutCostCount: rows.filter((r) => r.entryCount === 0).length,
  }

  return { rows, eventRows, totals }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

/**
 * "4 tags are active in 1449. ₹5,00,000 was spent on them in earlier events; ₹12,000 has
 * been spent this event, so 98% of their cost was carried in." (one sentence under the
 * chart, reporting-blueprint §6 fix #3).
 */
export function tagCostSentence(
  totals: TagCostReportTotals,
  eventHijriYear: string,
  formatMoney: (n: number) => string
): string {
  if (totals.tagCount === 0) return `No tags are active in ${eventHijriYear}.`
  const lead = `${totals.tagCount} ${plural(totals.tagCount, 'tag is', 'tags are')} active in ${eventHijriYear}.`
  const combined = totals.carriedIn + totals.thisEvent
  if (combined <= 0) {
    return `${lead} None of them has any (non-voided) linked spend up to this event yet.`
  }
  const share = Math.round((totals.carriedIn / combined) * 100)
  return `${lead} ${formatMoney(totals.carriedIn)} was spent on them in earlier events; ${formatMoney(
    totals.thisEvent
  )} has been spent this event, so ${share}% of their cost so far was carried in.`
}

/** "3 voided entries are linked to these tags and are left out of every cost above." */
export function voidedNote(voidedCount: number): string | null {
  if (voidedCount <= 0) return null
  return `${voidedCount} voided ${plural(voidedCount, 'entry is', 'entries are')} linked to these tags and ${plural(
    voidedCount,
    'is',
    'are'
  )} left out of every cost shown here.`
}
