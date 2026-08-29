/**
 * Pure helpers for the Exceptions bulk-resolve flow
 * (docs/hub-screen-certification.md §3.5).
 *
 * Kept framework-free so both the client dialog and the unit tests can import
 * them without pulling in React or the Supabase server client.
 */

export interface SelectionSpanInput {
  exception_type: string
  severity: string
}

export interface SelectionSpan {
  /** More than one distinct exception_type in the selection. */
  mixedTypes: boolean
  /** More than one distinct severity in the selection. */
  mixedSeverities: boolean
  /** Distinct exception types, in first-seen order. */
  types: string[]
  /** Distinct severities, in first-seen order. */
  severities: string[]
  /** True when either axis is mixed — the dialog should warn. */
  shouldWarn: boolean
}

/**
 * Describe how wide a bulk selection spans. The batch resolve applies one
 * shared note to every row, so a selection that mixes exception types or
 * severities is a signal the operator may be closing unrelated items with a
 * single justification — the dialog surfaces this before submit.
 */
export function describeSelectionSpan(rows: SelectionSpanInput[]): SelectionSpan {
  const types: string[] = []
  const severities: string[] = []
  for (const row of rows) {
    if (!types.includes(row.exception_type)) types.push(row.exception_type)
    if (!severities.includes(row.severity)) severities.push(row.severity)
  }
  const mixedTypes = types.length > 1
  const mixedSeverities = severities.length > 1
  return {
    mixedTypes,
    mixedSeverities,
    types,
    severities,
    shouldWarn: mixedTypes || mixedSeverities,
  }
}

export interface BatchResolveResult {
  /** Rows the update actually changed (were still `open`). */
  updated: number
  /** Requested rows the update did not touch (already closed, or RLS-blocked). */
  skipped: number
}

/**
 * Shape a batch `.update(...).in('id', ids).eq('status','open').select('id')`
 * response into an operator-facing {updated, skipped} pair. `requestedIds` is
 * the de-duplicated id list the action was asked to close; `updatedRows` is
 * whatever came back from the returning `select`.
 */
export function shapeBatchResolveResult(
  requestedIds: number[],
  updatedRows: { id: number }[]
): BatchResolveResult {
  const requested = new Set(requestedIds)
  const updated = new Set(updatedRows.map((r) => r.id).filter((id) => requested.has(id)))
  return {
    updated: updated.size,
    skipped: Math.max(0, requested.size - updated.size),
  }
}
