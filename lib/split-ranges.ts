/**
 * Turns the free-text page-range input from the upload dropzone's "split
 * before uploading" panel into either a validated slice plan or a single
 * plain-English error (this repo's convention — see `lib/friendly-error.ts` —
 * no raw parser output on screen).
 *
 * Confirmed rules (plan "recursive-finding-yao"):
 *  - `start-end` tokens, or a bare `N` meaning `N-N`, comma-separated.
 *  - Ranges must be listed in page order, must not overlap, and must start at
 *    page 1.
 *  - A gap between two covered ranges — or before the first — is treated as a
 *    likely typo and blocks with an error naming the missing pages, rather
 *    than being guessed at.
 *  - Trailing pages the input doesn't mention are bundled automatically into
 *    one final range rather than dropped.
 *  - Every resulting range must be within `maxUploadPages`, so a bad manual
 *    split fails here with a fixable message instead of being rejected one
 *    file at a time by the ingest route after upload.
 *
 * Pure — no I/O, no pdf-lib. The actual slicing is `splitPdfByRanges` in
 * `lib/pdf-client.ts`, fed the `ranges` this returns.
 */

export type SplitRangesResult =
  | {
      ranges: Array<{ start: number; end: number }>
      /** True when a final range was appended to cover trailing pages the input left out. */
      autoBundledTail: boolean
    }
  | { error: string }

export function parseSplitRanges(
  input: string,
  pageCount: number,
  maxUploadPages: number
): SplitRangesResult {
  const tokens = input
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    return { error: 'Enter the page ranges for each part, e.g. 1-8, 9-20, 21-24.' }
  }

  const ranges: Array<{ start: number; end: number }> = []
  for (const token of tokens) {
    const dash = token.match(/^(\d+)\s*-\s*(\d+)$/)
    const single = token.match(/^(\d+)$/)

    let start: number
    let end: number
    if (dash) {
      start = Number(dash[1])
      end = Number(dash[2])
    } else if (single) {
      start = Number(single[1])
      end = start
    } else {
      return { error: `“${token}” isn’t a page range. Use numbers like 1-8, 9-20, 21-24.` }
    }

    if (start < 1) {
      return { error: 'Page numbers start at 1.' }
    }
    if (end < start) {
      return { error: `The range ${start}-${end} runs backwards — put the smaller page number first.` }
    }
    if (end > pageCount) {
      return { error: `This PDF only has ${pageCount} pages, but “${token}” goes past that.` }
    }
    ranges.push({ start, end })
  }

  // Listed in order, no overlaps: each range must start exactly where the
  // last one ended + 1. A start before that means an overlap or an
  // out-of-order list; a start after it means a gap (leading, when the first
  // range doesn't begin at page 1).
  let expectedNext = 1
  for (const { start, end } of ranges) {
    if (start < expectedNext) {
      return {
        error: `The parts overlap or aren’t in page order around page ${start}. List them from first page to last, and put each page in only one part.`,
      }
    }
    if (start > expectedNext) {
      const missingEnd = start - 1
      const label =
        expectedNext === missingEnd
          ? `Page ${expectedNext} isn’t`
          : `Pages ${expectedNext}–${missingEnd} aren’t`
      const them = expectedNext === missingEnd ? 'it' : 'them'
      return { error: `${label} in any part. Add ${them} to a range, or fix the page numbers.` }
    }
    expectedNext = end + 1
  }

  // Trailing pages the input didn't mention → one final auto-added part
  // (confirmed with the user: leftover trailing pages bundle, an internal gap
  // blocks).
  let autoBundledTail = false
  if (expectedNext <= pageCount) {
    ranges.push({ start: expectedNext, end: pageCount })
    autoBundledTail = true
  }

  // Every part — including an auto-added tail — must fit the upload limit, so
  // a bad split is caught here rather than one file at a time by the ingest
  // route after upload.
  for (const { start, end } of ranges) {
    const pages = end - start + 1
    if (pages > maxUploadPages) {
      return {
        error: `The part ${start}-${end} is ${pages} pages — still over the ${maxUploadPages}-page limit. Break it into smaller ranges.`,
      }
    }
  }

  return { ranges, autoBundledTail }
}
