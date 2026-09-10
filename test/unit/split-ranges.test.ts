import { describe, expect, it } from 'vitest'
import { parseSplitRanges } from '@/lib/split-ranges'

// plan "recursive-finding-yao" §2: free-text page ranges → validated slice
// plan or one plain-English error. Trailing uncovered pages auto-bundle; an
// internal (or leading) gap blocks; any resulting part over the limit blocks.

describe('parseSplitRanges', () => {
  it('parses a clean fully-covering set of ranges', () => {
    const result = parseSplitRanges('1-8, 9-20, 21-24', 24, 20)
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 8 },
        { start: 9, end: 20 },
        { start: 21, end: 24 },
      ],
      autoBundledTail: false,
    })
  })

  it('treats a bare number as a single-page range', () => {
    const result = parseSplitRanges('1-19, 20', 20, 20)
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 19 },
        { start: 20, end: 20 },
      ],
      autoBundledTail: false,
    })
  })

  it('tolerates whitespace around numbers and dashes', () => {
    const result = parseSplitRanges('  1 - 8 ,9-16 ', 16, 20)
    expect(result).toMatchObject({ ranges: [{ start: 1, end: 8 }, { start: 9, end: 16 }] })
  })

  it('auto-bundles trailing pages the input left out into one final range', () => {
    const result = parseSplitRanges('1-8, 9-20', 32, 20)
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 8 },
        { start: 9, end: 20 },
        { start: 21, end: 32 },
      ],
      autoBundledTail: true,
    })
  })

  it('blocks an internal gap and names the missing pages', () => {
    const result = parseSplitRanges('1-8, 15-20', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('9–14') })
  })

  it('names a single missing page in the singular', () => {
    const result = parseSplitRanges('1-8, 10-20', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('Page 9 isn’t') })
  })

  it('blocks a leading gap (first range not starting at page 1)', () => {
    const result = parseSplitRanges('3-10, 11-20', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('Pages 1–2 aren’t') })
  })

  it('blocks overlapping ranges', () => {
    const result = parseSplitRanges('1-10, 8-20', 20, 20)
    expect(result).toMatchObject({ error: expect.stringMatching(/overlap|page order/) })
  })

  it('blocks out-of-order ranges', () => {
    const result = parseSplitRanges('9-20, 1-8', 20, 20)
    expect('error' in result).toBe(true)
  })

  it('blocks a resulting range that is still over the page limit', () => {
    const result = parseSplitRanges('1-24', 24, 20)
    expect(result).toEqual({ error: expect.stringContaining('over the 20-page limit') })
  })

  it('blocks an auto-bundled tail that is over the page limit', () => {
    const result = parseSplitRanges('1-20', 50, 20)
    expect(result).toEqual({ error: expect.stringContaining('21-50') })
  })

  it('rejects a range that runs backwards', () => {
    const result = parseSplitRanges('9-2', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('backwards') })
  })

  it('rejects a range past the end of the document', () => {
    const result = parseSplitRanges('1-8, 9-40', 24, 20)
    expect(result).toEqual({ error: expect.stringContaining('only has 24 pages') })
  })

  it('rejects page 0', () => {
    const result = parseSplitRanges('0-8', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('start at 1') })
  })

  it('rejects non-numeric tokens', () => {
    const result = parseSplitRanges('1-8, abc', 20, 20)
    expect(result).toEqual({ error: expect.stringContaining('isn’t a page range') })
  })

  it('rejects empty input', () => {
    expect(parseSplitRanges('', 20, 20)).toEqual({ error: expect.stringContaining('Enter the page ranges') })
    expect(parseSplitRanges('   ,  ', 20, 20)).toEqual({ error: expect.stringContaining('Enter the page ranges') })
  })
})
