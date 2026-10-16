import { describe, expect, it } from 'vitest'
import { decideWritable } from '@/lib/auth/scope-rules'

describe('decideWritable', () => {
  it('reports a row the caller cannot see as not_found, whatever the role', () => {
    expect(decideWritable({ found: false, eventIsCurrent: true, role: 'admin' })).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(decideWritable({ found: false, eventIsCurrent: true, role: 'superadmin' })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('allows an admin in the current event', () => {
    expect(decideWritable({ found: true, eventIsCurrent: true, role: 'admin' })).toEqual({ ok: true })
  })

  it('refuses an admin or dept user in a closed event, allows a superadmin (D5)', () => {
    expect(decideWritable({ found: true, eventIsCurrent: false, role: 'admin' })).toEqual({
      ok: false,
      reason: 'closed_event',
    })
    expect(decideWritable({ found: true, eventIsCurrent: false, role: 'dept' })).toEqual({
      ok: false,
      reason: 'closed_event',
    })
    expect(decideWritable({ found: true, eventIsCurrent: false, role: 'superadmin' })).toEqual({ ok: true })
  })

  it('fails closed when the event cannot be resolved (non-superadmin)', () => {
    expect(decideWritable({ found: true, eventIsCurrent: null, role: 'admin' })).toEqual({
      ok: false,
      reason: 'closed_event',
    })
    expect(decideWritable({ found: true, eventIsCurrent: undefined, role: null })).toEqual({
      ok: false,
      reason: 'closed_event',
    })
  })

  it('refuses a verified row only when asked to, and only for non-superadmins', () => {
    const base = { found: true, eventIsCurrent: true, verified: true }
    expect(decideWritable({ ...base, role: 'admin' })).toEqual({ ok: true })
    expect(decideWritable({ ...base, role: 'admin', refuseVerified: true })).toEqual({
      ok: false,
      reason: 'verified',
    })
    expect(decideWritable({ ...base, role: 'superadmin', refuseVerified: true })).toEqual({ ok: true })
  })

  it('checks the event before the verified rule', () => {
    expect(
      decideWritable({ found: true, eventIsCurrent: false, role: 'admin', verified: true, refuseVerified: true })
    ).toEqual({ ok: false, reason: 'closed_event' })
  })
})
