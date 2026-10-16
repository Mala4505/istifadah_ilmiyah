import { describe, expect, it } from 'vitest'
import {
  MAX_SEARCH_TERM_LENGTH,
  buildIlikeOrFilter,
  escapeLikeLiteral,
  quotePostgrestValue,
  quotedContainsPattern,
} from '@/lib/postgrest-filter'

describe('quotePostgrestValue', () => {
  it('wraps in double quotes and escapes backslash and quote', () => {
    expect(quotePostgrestValue('abc')).toBe('"abc"')
    expect(quotePostgrestValue('a"b')).toBe('"a\\"b"')
    expect(quotePostgrestValue('a\\b')).toBe('"a\\\\b"')
  })
})

describe('escapeLikeLiteral', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLikeLiteral('50%_off\\')).toBe('50\\%\\_off\\\\')
  })
})

describe('buildIlikeOrFilter', () => {
  it('builds one quoted condition per column', () => {
    expect(buildIlikeOrFilter(['a', 'b'], 'acme')).toBe('a.ilike."%acme%",b.ilike."%acme%"')
  })

  it('keeps filter-grammar delimiters inside the quotes (no injected conditions)', () => {
    const term = 'x%,id.gt.0,vendor_raw.ilike.%'
    const filter = buildIlikeOrFilter(['ubbl_number'], term)
    // Exactly one condition: the whole hostile term sits inside one quoted value.
    expect(filter.startsWith('ubbl_number.ilike."')).toBe(true)
    expect(filter.endsWith('"')).toBe(true)
    // Outside quotes there must be no comma, i.e. no second condition.
    const outsideQuotes = filter.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    expect(outsideQuotes).toBe('ubbl_number.ilike.""')
  })

  it('cannot break out of the quotes with a double quote', () => {
    const filter = buildIlikeOrFilter(['a'], 'x",id.gt.0,"y')
    const outsideQuotes = filter.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    expect(outsideQuotes).toBe('a.ilike.""')
  })

  it('matches wildcards literally', () => {
    // % in the term is escaped for LIKE (\%), then doubled for the filter grammar (\\%).
    expect(buildIlikeOrFilter(['a'], '10%')).toBe('a.ilike."%10\\\\%%"')
  })

  it('caps the term length', () => {
    const filter = quotedContainsPattern('z'.repeat(MAX_SEARCH_TERM_LENGTH + 500))
    expect(filter.length).toBe(MAX_SEARCH_TERM_LENGTH + 4) // 2 quotes + 2 percent signs
  })
})
