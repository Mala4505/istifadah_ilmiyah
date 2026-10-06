/**
 * Multi-select Status / Department filters on /entries
 * (docs/hub-screen-certification.md §4.11): comma-joined ids in state and URL,
 * single values stay backwards-compatible, `.in()` for several ids.
 */
import { describe, it, expect } from 'vitest'
import { joinMultiValue, parseMultiValue, toggleMultiValue, DEFAULT_FILTERS } from '@/components/entries/types'
import { applyEntriesFilters, type EntriesQueryBuilder } from '@/components/entries/query'
import { buildFilterSummary, clearFilterChip } from '@/components/entries/filter-bar'

function recordingBuilder() {
  const calls: [string, ...unknown[]][] = []
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ['eq', 'in', 'gte', 'lte', 'or', 'is', 'gt']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  return { builder: builder as unknown as EntriesQueryBuilder, calls }
}

describe('parseMultiValue / joinMultiValue / toggleMultiValue', () => {
  it('reads a legacy single value as a one-element list', () => {
    expect(parseMultiValue('3')).toEqual(['3'])
  })

  it('splits, trims, dedupes and drops non-numeric parts', () => {
    expect(parseMultiValue(' 3, 7,3,,abc,9 ')).toEqual(['3', '7', '9'])
    expect(parseMultiValue(null)).toEqual([])
    expect(parseMultiValue('')).toEqual([])
  })

  it('toggles an id in and out', () => {
    expect(toggleMultiValue('', '4')).toBe('4')
    expect(toggleMultiValue('4', '5')).toBe('4,5')
    expect(toggleMultiValue('4,5', '4')).toBe('5')
    expect(joinMultiValue([])).toBe('')
  })
})

describe('applyEntriesFilters multi-select', () => {
  it('uses .eq for a single status id (unchanged behaviour)', () => {
    const { builder, calls } = recordingBuilder()
    applyEntriesFilters(builder, { ...DEFAULT_FILTERS, status: '3' })
    expect(calls).toContainEqual(['eq', 'status_id', '3'])
  })

  it('uses .in for several status and department ids', () => {
    const { builder, calls } = recordingBuilder()
    applyEntriesFilters(builder, { ...DEFAULT_FILTERS, status: '3,7', department: '1,2' })
    expect(calls).toContainEqual(['in', 'status_id', ['3', '7']])
    expect(calls).toContainEqual(['in', 'department_id', ['1', '2']])
  })
})

describe('filter chips', () => {
  const options = {
    departments: [
      { id: 1, label: 'Kitchen' },
      { id: 2, label: 'Venue' },
    ],
    budgetHeads: [],
    adminHeads: [],
    zones: [],
    statuses: [{ id: 3, label: 'Pending' }],
    entryTypes: [],
  }

  it('renders one chip per selected id, and removing one keeps the rest', () => {
    const filters = { ...DEFAULT_FILTERS, department: '1,2' }
    const chips = buildFilterSummary(filters, options).filter((c) => c.key === 'department')
    expect(chips.map((c) => c.label)).toEqual(['Kitchen', 'Venue'])
    expect(clearFilterChip(chips[0]!, filters)).toEqual({ department: '2' })
  })

  it('clears a plain chip back to its default', () => {
    const filters = { ...DEFAULT_FILTERS, showVoided: true }
    const chip = buildFilterSummary(filters, options).find((c) => c.key === 'showVoided')!
    expect(clearFilterChip(chip, filters)).toEqual({ showVoided: false })
  })
})
