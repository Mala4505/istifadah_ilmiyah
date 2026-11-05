/**
 * Data loader for the "Tags: built vs maintained" report section
 * (docs/entry-tags-plan.md Phase 5). For the selected event: the tags active in it, each
 * tag's cost per event, and cost carried in from earlier events vs spent this event.
 *
 * Reads, all through the caller's RLS-bound client:
 *   1. tags_active_in_event(p_event_id)  } in parallel with the cached reference data
 *   2. tag_scope + tag_cost_by_event     } (events, departments, sub-departments)
 * Step 2 runs as one parallel batch inside loadTagsActiveInEvent, so the section costs two
 * round trips regardless of how many tags or events there are. The per-event sums come
 * pre-aggregated from the tag_cost_by_event view (security_invoker, non-voided only), so the
 * only JS work is arranging a few rows per tag -- no new SQL needed.
 *
 * Errors come back as plain-English strings (friendlyDataError inside the tag loaders).
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { formatINR } from '@/lib/reports/format'
import { loadTagReferenceData, loadTagsActiveInEvent } from '@/lib/tags/queries'
import {
  buildTagCostReport,
  tagCostSentence,
  type TagCostReport,
} from '@/lib/tags/reports-shared'

export type TagCostReportData = TagCostReport & {
  /** null when no event is selected. */
  eventName: string | null
  eventHijriYear: string | null
  /** One plain-English sentence under the chart (tagCostSentence). */
  insight: string | null
  error: string | null
}

const EMPTY_TOTALS: TagCostReport['totals'] = {
  tagCount: 0,
  carriedIn: 0,
  thisEvent: 0,
  later: 0,
  voidedCount: 0,
  newThisEventCount: 0,
  withoutCostCount: 0,
}

export async function loadTagCostReport(selectedEvent: Event | null): Promise<TagCostReportData> {
  const base: TagCostReportData = {
    rows: [],
    eventRows: [],
    totals: EMPTY_TOTALS,
    eventName: selectedEvent?.name ?? null,
    eventHijriYear: selectedEvent?.hijriYear ?? null,
    insight: null,
    error: null,
  }
  if (!selectedEvent) return base

  const supabase = await createClient()
  const [list, ref] = await Promise.all([
    loadTagsActiveInEvent(supabase, selectedEvent.id),
    loadTagReferenceData(supabase),
  ])

  const error = list.error ?? ref.error
  if (list.error) return { ...base, error: list.error }

  const deptNames = new Map(ref.allDepartments.map((d) => [d.id, d.name]))
  const subNames = new Map(ref.allSubDepartments.map((s) => [s.id, s.name]))
  // The selected event must be in the list even if the cached event list lags behind.
  const events = ref.events.some((e) => e.id === selectedEvent.id) ? ref.events : [...ref.events, selectedEvent]

  const report = buildTagCostReport({
    tags: list.tags,
    scope: list.scope,
    costs: list.costs,
    events,
    selectedEventId: selectedEvent.id,
    departmentName: (id) => deptNames.get(id) ?? `Department #${id}`,
    subDepartmentName: (id) => subNames.get(id) ?? `Sub-department #${id}`,
    formatMoney: formatINR,
  })

  return {
    ...report,
    eventName: selectedEvent.name,
    eventHijriYear: selectedEvent.hijriYear,
    insight: tagCostSentence(report.totals, selectedEvent.hijriYear, formatINR),
    error,
  }
}
