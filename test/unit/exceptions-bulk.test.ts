/**
 * Unit tests for the Exceptions bulk-resolve helpers
 * (docs/hub-screen-certification.md §3.5):
 *  - describeSelectionSpan: the mixed-types / mixed-severities detector the
 *    confirm dialog warns from.
 *  - shapeBatchResolveResult: turning a returning `.select('id')` into the
 *    {updated, skipped} pair the action reports.
 */
import { describe, it, expect } from 'vitest'
import { describeSelectionSpan, shapeBatchResolveResult } from '@/components/exceptions/bulk-selection'
import { parseQueueSort, sortQueue, type QueueSortRow } from '@/components/exceptions/queue-sort'

describe('describeSelectionSpan', () => {
  it('flags nothing for a single homogeneous row', () => {
    const span = describeSelectionSpan([{ exception_type: 'new_vendor', severity: 'low' }])
    expect(span.mixedTypes).toBe(false)
    expect(span.mixedSeverities).toBe(false)
    expect(span.shouldWarn).toBe(false)
    expect(span.types).toEqual(['new_vendor'])
    expect(span.severities).toEqual(['low'])
  })

  it('flags nothing when every row shares one type and one severity', () => {
    const span = describeSelectionSpan([
      { exception_type: 'new_vendor', severity: 'low' },
      { exception_type: 'new_vendor', severity: 'low' },
      { exception_type: 'new_vendor', severity: 'low' },
    ])
    expect(span.shouldWarn).toBe(false)
  })

  it('detects mixed exception types', () => {
    const span = describeSelectionSpan([
      { exception_type: 'new_vendor', severity: 'low' },
      { exception_type: 'new_budget_head', severity: 'low' },
    ])
    expect(span.mixedTypes).toBe(true)
    expect(span.mixedSeverities).toBe(false)
    expect(span.shouldWarn).toBe(true)
    expect(span.types).toEqual(['new_vendor', 'new_budget_head'])
  })

  it('detects mixed severities', () => {
    const span = describeSelectionSpan([
      { exception_type: 'new_vendor', severity: 'high' },
      { exception_type: 'new_vendor', severity: 'low' },
    ])
    expect(span.mixedSeverities).toBe(true)
    expect(span.mixedTypes).toBe(false)
    expect(span.shouldWarn).toBe(true)
  })

  it('preserves first-seen order and de-duplicates', () => {
    const span = describeSelectionSpan([
      { exception_type: 'b', severity: 'medium' },
      { exception_type: 'a', severity: 'high' },
      { exception_type: 'b', severity: 'medium' },
      { exception_type: 'a', severity: 'high' },
    ])
    expect(span.types).toEqual(['b', 'a'])
    expect(span.severities).toEqual(['medium', 'high'])
  })

  it('treats an empty selection as not-mixed', () => {
    const span = describeSelectionSpan([])
    expect(span.shouldWarn).toBe(false)
    expect(span.types).toEqual([])
  })
})

describe('shapeBatchResolveResult', () => {
  it('reports every requested row as updated when all came back', () => {
    const result = shapeBatchResolveResult([1, 2, 3], [{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(result).toEqual({ updated: 3, skipped: 0 })
  })

  it('counts rows that were not returned as skipped (already closed / RLS)', () => {
    const result = shapeBatchResolveResult([1, 2, 3, 4], [{ id: 1 }, { id: 3 }])
    expect(result).toEqual({ updated: 2, skipped: 2 })
  })

  it('reports all skipped when nothing came back', () => {
    const result = shapeBatchResolveResult([9, 10], [])
    expect(result).toEqual({ updated: 0, skipped: 2 })
  })

  it('ignores stray ids in the response that were never requested', () => {
    const result = shapeBatchResolveResult([1, 2], [{ id: 1 }, { id: 2 }, { id: 99 }])
    expect(result).toEqual({ updated: 2, skipped: 0 })
  })

  it('does not double-count a duplicated request id', () => {
    const result = shapeBatchResolveResult([1, 1, 2], [{ id: 1 }, { id: 2 }])
    expect(result).toEqual({ updated: 2, skipped: 0 })
  })
})

describe('parseQueueSort', () => {
  it('defaults to severity/desc', () => {
    expect(parseQueueSort(undefined, undefined)).toEqual({ column: 'severity', direction: 'desc' })
  })
  it('rejects an unknown column and direction', () => {
    expect(parseQueueSort('nonsense', 'sideways')).toEqual({ column: 'severity', direction: 'desc' })
  })
  it('accepts a known column + direction', () => {
    expect(parseQueueSort('detected_at', 'asc')).toEqual({ column: 'detected_at', direction: 'asc' })
  })
})

describe('sortQueue', () => {
  const rows: QueueSortRow[] = [
    { id: 1, severity: 'low', exception_type: 'new_vendor', amount_at_risk: 5, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, severity: 'high', exception_type: 'ocr_total_vs_amount', amount_at_risk: null, created_at: '2026-01-03T00:00:00Z' },
    { id: 3, severity: 'high', exception_type: 'line_item_tally_mismatch', amount_at_risk: 100, created_at: '2026-01-02T00:00:00Z' },
    { id: 4, severity: 'medium', exception_type: 'new_budget_head', amount_at_risk: 50, created_at: '2026-01-04T00:00:00Z' },
  ]

  it('default severity sort: rank desc, then amount desc (nulls last), stable id tiebreak', () => {
    const out = sortQueue(rows, 'severity', 'desc').map((r) => r.id)
    expect(out).toEqual([3, 2, 4, 1])
  })

  it('detected_at asc orders by created_at then id', () => {
    const out = sortQueue(rows, 'detected_at', 'asc').map((r) => r.id)
    expect(out).toEqual([1, 3, 2, 4])
  })

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.id)
    sortQueue(rows, 'detected_at', 'desc')
    expect(rows.map((r) => r.id)).toEqual(before)
  })
})
