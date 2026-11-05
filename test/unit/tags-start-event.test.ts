import { describe, expect, it } from 'vitest'
import { buildStartEventWarning } from '@/lib/tags/start-event'

const e1447 = { id: 1, hijriYear: '1447', startsOn: '2025-06-01' }
const e1448 = { id: 2, hijriYear: '1448', startsOn: '2026-06-01' }
const e1449 = { id: 3, hijriYear: '1449', startsOn: null }
const e1450 = { id: 4, hijriYear: '1450', startsOn: null }

describe('buildStartEventWarning', () => {
  it('returns null when there are no linked entries', () => {
    expect(buildStartEventWarning(e1448, [])).toBeNull()
  })

  it('returns null when every entry is in the start event or later', () => {
    expect(buildStartEventWarning(e1448, [e1448, e1449, e1450])).toBeNull()
  })

  it('counts entries from earlier events and names the earliest one', () => {
    const warning = buildStartEventWarning(e1449, [e1448, e1447, e1448, e1449, e1450])
    expect(warning).toMatchObject({ entryCount: 3, earliestHijriYear: '1447', startHijriYear: '1449' })
    expect(warning?.message).toContain('3 linked entries')
    expect(warning?.message).toContain('1447 H')
    expect(warning?.message).toContain('1449 H')
  })

  it('uses singular wording for one entry', () => {
    const warning = buildStartEventWarning(e1450, [e1449])
    expect(warning?.entryCount).toBe(1)
    expect(warning?.message).toContain('1 linked entry,')
  })

  it('compares by hijri year when starts_on is missing', () => {
    expect(buildStartEventWarning(e1449, [e1450])).toBeNull()
    expect(buildStartEventWarning(e1450, [e1449])).not.toBeNull()
  })
})
