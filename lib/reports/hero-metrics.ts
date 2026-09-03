import { addWeeks, differenceInCalendarISOWeeks, format, startOfISOWeek, subWeeks } from 'date-fns'
import { friendlyDataError } from '@/lib/friendly-error'
import { createClient } from '@/lib/supabase/server'

// Reports-page "overview" band (redesign approved as an HTML mockup, wired
// into the real page by a later pass). This module owns only the
// data-aggregation layer: 4 KPI tiles with weekly sparklines, a Hub-status
// composition breakdown, a document-pipeline stage-count breakdown, and a
// weekly cumulative-spend-vs-target-pace series. It deliberately mirrors the
// conventions of loadReportsData/loadAnalyticsData in
// app/(app)/reports/page.tsx: own `createClient()` call, `.returns<T[]>()`
// on every typed query, and every `.error` piped through `friendlyDataError`
// before it leaves this module -- this codebase's hard rule against ever
// showing a raw error string on screen applies here too.

// Matches the v_open_issues safety cap app/(app)/reports/page.tsx's
// loadReportsData already applies (ROW_CAP there) -- reused here only for
// the same view, via the same query shape.
const OPEN_ISSUES_ROW_CAP = 1000

// 8-12 point sparkline requested by the spec; 10 is the midpoint.
const TREND_WEEKS = 10

// Safety cap on the spend-trend week range (~5 years) in case an event's
// starts_on/ends_on ever end up implausibly far apart -- keeps a bad data
// entry from generating an unbounded bucket list.
const MAX_SPEND_TREND_WEEKS = 260

type HubStatusRow = {
  status_code: string
  status_label: string
  sort_order: number
  entry_count: number
}

type OpenIssueAmountRow = {
  amount_at_risk: number | null
  created_at: string
}

export type EntryRow = {
  id: number
  amount: number | null
  date: string | null
}

type SourceDocumentRow = {
  id: number
  entry_id: number | null
  upload_status: string
  uploaded_at: string
}

type ExtractionJoinRow = {
  source_document_id: number
  entry_id: number | null
  verified_at: string | null
}

type BudgetApprovedRow = {
  approved_amount: number | null
}

export type EventDatesRow = {
  starts_on: string | null
  ends_on: string | null
}

type WeekBucket = { start: Date; key: string; label: string }

export type HeroMetrics = {
  kpi: {
    totalSpend: number
    totalEntries: number
    openAmountAtRisk: number
    avgDaysToReview: number | null
    weeklySpendSeries: number[]
    weeklyEntrySeries: number[]
    weeklyAtRiskSeries: number[]
    weeklyAvgDaysSeries: number[]
  }
  hubStatus: { key: string; label: string; value: number; sortOrder: number }[]
  pipeline: { key: string; label: string; count: number }[]
  spendTrend: { weekLabel: string; weekStart: string; actual: number; target: number | null }[]
  errors: { kpi: string | null; hubStatus: string | null; pipeline: string | null; spendTrend: string | null }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000
}

/** `count` consecutive ISO-week buckets (Mon-Sun), oldest first, ending with
 *  the week containing `referenceDate`. Every bucket appears even when no
 *  data falls in it, so callers get a fixed-length series for a sparkline
 *  rather than a sparse list of only-weeks-with-data. */
function buildTrailingWeekBuckets(count: number, referenceDate: Date): WeekBucket[] {
  const lastWeekStart = startOfISOWeek(referenceDate)
  const buckets: WeekBucket[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const s = subWeeks(lastWeekStart, i)
    buckets.push({ start: s, key: format(s, 'yyyy-MM-dd'), label: format(s, 'MMM d') })
  }
  return buckets
}

/** Inclusive ISO-week buckets spanning [start, end], oldest first. Used for
 *  the spend-trend series, whose length follows an event's own duration
 *  rather than a fixed sparkline size. */
function buildWeekRange(start: Date, end: Date): WeekBucket[] {
  const first = startOfISOWeek(start)
  const last = startOfISOWeek(end)
  const weekCount = Math.min(MAX_SPEND_TREND_WEEKS, Math.max(0, differenceInCalendarISOWeeks(last, first)))
  const buckets: WeekBucket[] = []
  for (let i = 0; i <= weekCount; i += 1) {
    const s = addWeeks(first, i)
    buckets.push({ start: s, key: format(s, 'yyyy-MM-dd'), label: format(s, 'MMM d') })
  }
  return buckets
}

/**
 * Shared week-bucketing primitive. Every weekly series this module computes
 * (the four KPI sparklines and the spend-trend actual line) groups rows into
 * the same kind of fixed ISO-week buckets and reduces each bucket's rows the
 * same way -- only the reducer and the date accessor differ per caller.
 * Rows whose date falls outside the plotted bucket range are silently
 * dropped (not folded into an edge bucket), which matches a sparkline's
 * "trailing N weeks" framing.
 */
function bucketWeekly<T, R>(
  rows: T[],
  buckets: WeekBucket[],
  getDate: (row: T) => string | null | undefined,
  reducer: (rowsInBucket: T[]) => R
): R[] {
  const byKey = new Map<string, T[]>()
  for (const b of buckets) byKey.set(b.key, [])
  for (const row of rows) {
    const raw = getDate(row)
    if (!raw) continue
    const key = format(startOfISOWeek(new Date(raw)), 'yyyy-MM-dd')
    const bucketRows = byKey.get(key)
    if (bucketRows) bucketRows.push(row)
  }
  return buckets.map((b) => reducer(byKey.get(b.key) ?? []))
}

/**
 * Weekly cumulative spend-to-date vs. an even-pace target line. FIRST CUT --
 * flagged explicitly so its assumptions are easy to challenge or replace:
 *
 *  - Actual: entries (is_void = false) bucketed by ISO week of `date` and
 *    summed as a running total, so `actual` at week N is "everything spent
 *    from the start of the plotted range through week N," not a per-week
 *    delta -- this feeds an area chart of spend-to-date, not a bar chart of
 *    weekly spend.
 *  - Target: total approved budget for the event (v_budget_vs_actual's
 *    `approved_amount`, summed across budget heads -- reused rather than
 *    re-derived from `budget_allocation` directly) divided evenly across the
 *    number of ISO weeks between the event's starts_on and ends_on, then
 *    accumulated the same way as actual. "Evenly across weeks" is the
 *    simplest possible pace model -- it has no notion of seasonal spend
 *    patterns (e.g. a rush in the final week), so a target line that looks
 *    "behind pace" in week 2 of a 6-week event is not necessarily a real
 *    problem. This is the piece most worth a human's second look.
 *  - If starts_on or ends_on is null, or there is no approved budget at all,
 *    every point's `target` is null rather than a guessed number -- the UI
 *    side is built to render an honest actual-only line in that case.
 *  - The plotted week range follows the event's own start/end when both are
 *    known; it falls back to the entries' own min/max date only when the
 *    event has no dates at all, so an event with real dates always plots its
 *    full official span even before spend has started.
 */
export function computeSpendTrend(
  entryRows: EntryRow[],
  eventDates: EventDatesRow | null,
  approvedBudgetTotal: number | null
): HeroMetrics['spendTrend'] {
  let rangeStart: Date | null = eventDates?.starts_on ? new Date(eventDates.starts_on) : null
  let rangeEnd: Date | null = eventDates?.ends_on ? new Date(eventDates.ends_on) : null

  if (!rangeStart || !rangeEnd) {
    const dated = entryRows.filter((r): r is EntryRow & { date: string } => r.date !== null)
    if (dated.length > 0) {
      const times = dated.map((r) => new Date(r.date).getTime())
      rangeStart = rangeStart ?? new Date(Math.min(...times))
      rangeEnd = rangeEnd ?? new Date(Math.max(...times))
    }
  }

  if (!rangeStart || !rangeEnd || rangeStart.getTime() > rangeEnd.getTime()) return []

  const buckets = buildWeekRange(rangeStart, rangeEnd)
  if (buckets.length === 0) return []

  const hasTarget =
    eventDates?.starts_on != null && eventDates?.ends_on != null && approvedBudgetTotal !== null && approvedBudgetTotal > 0
  const targetWeekCount = hasTarget
    ? Math.max(1, differenceInCalendarISOWeeks(new Date(eventDates!.ends_on!), new Date(eventDates!.starts_on!)) + 1)
    : 0
  const perWeekTarget = hasTarget ? approvedBudgetTotal! / targetWeekCount : 0

  const weeklyTotals = bucketWeekly(
    entryRows,
    buckets,
    (r) => r.date,
    (rs) => rs.reduce((s, r) => s + (r.amount ?? 0), 0)
  )

  let running = 0
  return buckets.map((b, i) => {
    running += weeklyTotals[i] ?? 0
    return {
      weekLabel: b.label,
      weekStart: b.key,
      actual: round2(running),
      target: hasTarget ? round2(perWeekTarget * (i + 1)) : null,
    }
  })
}

/**
 * A-03 (reporting-blueprint.md §3, Family A) "at the current run rate, where
 * does this land?" — linear extrapolation of `actualToDate` across the full
 * event window, distinct from computeSpendTrend's target line above (which
 * models an even pace against the *budget*, not a projection from *actual*
 * spend). Exported so lib/reports/executive-brief.ts can call this at both
 * the whole-event grain (Brief's A-03 chart annotation) and the per-department
 * grain (E-01's "projected landing" column), rather than duplicating the
 * date math per caller.
 *
 * Returns null — never a guessed number — when the event's start/end dates
 * aren't both known, or when `referenceDate` falls at or before `starts_on`
 * (an event that hasn't started yet has no run rate to extrapolate from).
 * `fractionElapsed` is clamped to 1 once the event has ended, at which point
 * `projectedTotal` is just `actualToDate` itself.
 */
export function computeProjectedLanding(
  actualToDate: number,
  eventDates: EventDatesRow | null,
  referenceDate: Date = new Date()
): { fractionElapsed: number; projectedTotal: number } | null {
  if (!eventDates?.starts_on || !eventDates?.ends_on) return null
  const start = new Date(eventDates.starts_on).getTime()
  const end = new Date(eventDates.ends_on).getTime()
  if (!(end > start)) return null
  const now = referenceDate.getTime()
  if (now <= start) return null
  const fractionElapsed = Math.min(1, (now - start) / (end - start))
  return { fractionElapsed, projectedTotal: actualToDate / fractionElapsed }
}

export async function loadHeroMetrics(eventId: number | null): Promise<HeroMetrics> {
  const supabase = await createClient()

  const [entriesRes, issuesRes, hubStatusRes, budgetRes, sourceDocRes, eventRes] = await Promise.all([
    supabase.from('entries').select('id, amount, date').eq('event_id', eventId).eq('is_void', false).returns<EntryRow[]>(),
    // Phase 0 §0.2 eventId-null-vs-not branch, copied verbatim from
    // loadReportsData (app/(app)/reports/page.tsx) rather than simplified --
    // a plain `.eq('event_id', eventId)` would silently drop
    // document-/batch-level exceptions and vendor-level flags that have no
    // traceable event, undercounting "Open ₹ at risk".
    eventId === null
      ? supabase.from('v_open_issues').select('amount_at_risk, created_at').limit(OPEN_ISSUES_ROW_CAP).returns<OpenIssueAmountRow[]>()
      : supabase
          .from('v_open_issues')
          .select('amount_at_risk, created_at')
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(OPEN_ISSUES_ROW_CAP)
          .returns<OpenIssueAmountRow[]>(),
    supabase
      .from('v_entry_status_counts')
      .select('status_code, status_label, sort_order, entry_count')
      .eq('dimension', 'hub_status')
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true })
      .returns<HubStatusRow[]>(),
    supabase.from('v_budget_vs_actual').select('approved_amount').eq('event_id', eventId).returns<BudgetApprovedRow[]>(),
    supabase
      .from('source_document')
      .select('id, entry_id, upload_status, uploaded_at')
      .eq('event_id', eventId)
      .returns<SourceDocumentRow[]>(),
    eventId === null
      ? Promise.resolve({ data: null, error: null } as { data: EventDatesRow | null; error: { message: string } | null })
      : supabase.from('event').select('starts_on, ends_on').eq('id', eventId).maybeSingle(),
  ])

  // document_extraction has no event_id column of its own (only the six
  // tables listed in 20260822000005_event_scoping.sql got one) -- scoped via
  // the source_document ids already fetched above, following the same
  // fetch-ids-then-.in() pattern as lib/actions/documents.ts's
  // getInboxMatchCandidates rather than an embedded-resource filter.
  const docIds = (sourceDocRes.data ?? []).map((d) => d.id)
  const extractionRes =
    docIds.length === 0
      ? { data: [] as ExtractionJoinRow[], error: null as { message: string } | null }
      : await supabase
          .from('document_extraction')
          .select('source_document_id, entry_id, verified_at')
          .in('source_document_id', docIds)
          .returns<ExtractionJoinRow[]>()

  const entriesErr = friendlyDataError(entriesRes.error, 'heroMetrics:entriesRes')
  const issuesErr = friendlyDataError(issuesRes.error, 'heroMetrics:issuesRes')
  const hubStatusErr = friendlyDataError(hubStatusRes.error, 'heroMetrics:hubStatusRes')
  const budgetErr = friendlyDataError(budgetRes.error, 'heroMetrics:budgetRes')
  const sourceDocErr = friendlyDataError(sourceDocRes.error, 'heroMetrics:sourceDocRes')
  const extractionErr = friendlyDataError(extractionRes.error, 'heroMetrics:extractionRes')
  const eventErr = friendlyDataError(eventRes.error, 'heroMetrics:eventRes')

  const entryRows = entriesRes.data ?? []
  const issueRows = issuesRes.data ?? []
  const hubStatusRows = hubStatusRes.data ?? []
  const budgetRows = budgetRes.data ?? []
  const sourceDocRows = sourceDocRes.data ?? []
  const extractionRows = extractionRes.data ?? []
  const eventDates = eventRes.data ?? null

  // ---- KPI tiles -----------------------------------------------------------

  const totalSpend = round2(entryRows.reduce((s, r) => s + (r.amount ?? 0), 0))
  const totalEntries = entryRows.length
  const openAmountAtRisk = round2(issueRows.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0))

  const uploadedAtById = new Map(sourceDocRows.map((d) => [d.id, d.uploaded_at]))
  const verifiedExtractions = extractionRows
    .filter((e) => e.verified_at !== null)
    .map((e) => ({ verifiedAt: e.verified_at as string, uploadedAt: uploadedAtById.get(e.source_document_id) }))
    .filter((e): e is { verifiedAt: string; uploadedAt: string } => e.uploadedAt !== undefined)

  const avgDaysToReview =
    verifiedExtractions.length === 0
      ? null
      : round2(verifiedExtractions.reduce((s, e) => s + daysBetween(e.uploadedAt, e.verifiedAt), 0) / verifiedExtractions.length)

  const trailingWeeks = buildTrailingWeekBuckets(TREND_WEEKS, new Date())

  const weeklySpendSeries = bucketWeekly(
    entryRows,
    trailingWeeks,
    (r) => r.date,
    (rs) => round2(rs.reduce((s, r) => s + (r.amount ?? 0), 0))
  )
  const weeklyEntrySeries = bucketWeekly(
    entryRows,
    trailingWeeks,
    (r) => r.date,
    (rs) => rs.length
  )
  const weeklyAtRiskSeries = bucketWeekly(
    issueRows,
    trailingWeeks,
    (r) => r.created_at,
    (rs) => round2(rs.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0))
  )
  // An empty week bucket reduces to 0, not null, to keep this a plain
  // number[] per the export shape -- a sparkline week with no verifications
  // reads as "0 days," which is a judgment call worth a second look rather
  // than a hidden gap.
  const weeklyAvgDaysSeries = bucketWeekly(
    verifiedExtractions,
    trailingWeeks,
    (r) => r.verifiedAt,
    (rs) => (rs.length === 0 ? 0 : round2(rs.reduce((s, r) => s + daysBetween(r.uploadedAt, r.verifiedAt), 0) / rs.length))
  )

  // ---- Hub-status composition ------------------------------------------------

  const hubStatus = hubStatusRows.map((r) => ({
    key: r.status_code,
    label: r.status_label,
    value: r.entry_count,
    sortOrder: r.sort_order,
  }))

  // ---- Document pipeline -----------------------------------------------------

  const uploaded = sourceDocRows.length
  const extracted = sourceDocRows.filter((d) => d.upload_status === 'processed').length

  const extractionsByDoc = new Map<number, ExtractionJoinRow[]>()
  for (const e of extractionRows) {
    const arr = extractionsByDoc.get(e.source_document_id) ?? []
    arr.push(e)
    extractionsByDoc.set(e.source_document_id, arr)
  }

  let verifiedCount = 0
  let matchedCount = 0
  for (const doc of sourceDocRows) {
    const bills = extractionsByDoc.get(doc.id) ?? []
    // A document with zero extraction rows yet does not count as verified --
    // `bills.length > 0` guards that, matching the spec's explicit note.
    if (bills.length > 0 && bills.every((b) => b.verified_at !== null)) verifiedCount += 1
    // coalesce(document_extraction.entry_id, source_document.entry_id), same
    // pattern as 20260821000002_entry_id_coalesce_fix.sql, applied per
    // document: a multi-bill document counts as matched once any one of its
    // bills has a per-bill match, or the legacy doc-level entry_id is set.
    if (doc.entry_id !== null || bills.some((b) => b.entry_id !== null)) matchedCount += 1
  }

  const pipeline = [
    { key: 'uploaded', label: 'Uploaded', count: uploaded },
    { key: 'extracted', label: 'Extracted', count: extracted },
    { key: 'verified', label: 'Verified', count: verifiedCount },
    { key: 'matched', label: 'Matched to entry', count: matchedCount },
  ]

  // ---- Weekly spend trend ------------------------------------------------

  const approvedBudgetTotal = budgetRows.reduce((sum, r) => sum + (r.approved_amount ?? 0), 0)
  const hasApprovedBudget = budgetRows.some((r) => r.approved_amount !== null) && approvedBudgetTotal > 0

  const spendTrend = computeSpendTrend(entryRows, eventDates, hasApprovedBudget ? approvedBudgetTotal : null)

  return {
    kpi: {
      totalSpend,
      totalEntries,
      openAmountAtRisk,
      avgDaysToReview,
      weeklySpendSeries,
      weeklyEntrySeries,
      weeklyAtRiskSeries,
      weeklyAvgDaysSeries,
    },
    hubStatus,
    pipeline,
    spendTrend,
    errors: {
      kpi: entriesErr ?? issuesErr ?? sourceDocErr ?? extractionErr,
      hubStatus: hubStatusErr,
      pipeline: sourceDocErr ?? extractionErr,
      spendTrend: entriesErr ?? eventErr ?? budgetErr,
    },
  }
}
