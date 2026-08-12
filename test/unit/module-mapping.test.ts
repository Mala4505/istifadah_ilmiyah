/**
 * test/unit/module-mapping.test.ts
 *
 * Unit tests for parseDepartmentalRow's `type` derivation rule (MASTER-PLAN
 * §3.6 point 6, resolved 2026-08-12 in §18 Phase 3): ADP_ -> advance_payment,
 * RB -> reimbursement, no matching prefix -> invoice. Pure function, no DB.
 */

import { describe, expect, it } from 'vitest'
import { parseDepartmentalRow } from '@/lib/module-mapping'

function entryRow(ubblNumber: string) {
  return {
    Srno: '',
    'Budget Head': '',
    Department: 'Venue Setup',
    'UBBL Number': ubblNumber,
    'Vendor Name': 'Test Vendor',
  }
}

describe('parseDepartmentalRow — type derivation', () => {
  it('classifies an ADP_-prefixed UBBL as advance_payment', () => {
    const { row } = parseDepartmentalRow(entryRow('ADP_202608054'))
    expect(row.entry?.type).toBe('advance_payment')
  })

  it('classifies an RB-prefixed UBBL as reimbursement', () => {
    const { row } = parseDepartmentalRow(entryRow('RB202608054'))
    expect(row.entry?.type).toBe('reimbursement')
  })

  it('classifies a plain UBBL as invoice', () => {
    const { row } = parseDepartmentalRow(entryRow('202608054'))
    expect(row.entry?.type).toBe('invoice')
  })

  it('checks the ADP_ prefix before the RB prefix', () => {
    // No real UBBL is expected to match both, but the order is what the
    // implementation comment promises — pin it so a future edit can't
    // silently reorder the branches.
    const { row } = parseDepartmentalRow(entryRow('ADP_RB202608054'))
    expect(row.entry?.type).toBe('advance_payment')
  })
})
