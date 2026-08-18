import { describe, expect, it } from 'vitest'
import { buildExtractionBatchCustomId, parseExtractionBatchCustomId } from '@/lib/jobs/batch-custom-id'

// plan.md Phase 3 I16 / §8 point 8: Batch API results arrive in any order
// and must be matched back to the right source_document via custom_id,
// never by array position. These tests exercise the round trip and, more
// importantly, that decoding is strict about anything that doesn't look
// exactly like what this pipeline itself would have submitted.

describe('buildExtractionBatchCustomId', () => {
  it('encodes a source_document id into the expected shape', () => {
    expect(buildExtractionBatchCustomId(42)).toBe('extract-document-42')
  })

  it('round-trips through parseExtractionBatchCustomId', () => {
    const customId = buildExtractionBatchCustomId(987654)
    expect(parseExtractionBatchCustomId(customId)).toBe(987654)
  })
})

describe('parseExtractionBatchCustomId', () => {
  it('parses a well-formed custom_id back to its numeric id', () => {
    expect(parseExtractionBatchCustomId('extract-document-1')).toBe(1)
    expect(parseExtractionBatchCustomId('extract-document-2026081700')).toBe(2026081700)
  })

  it('rejects a custom_id with the wrong prefix', () => {
    expect(parseExtractionBatchCustomId('some-other-thing-42')).toBeNull()
    expect(parseExtractionBatchCustomId('document-42')).toBeNull()
  })

  it('rejects a custom_id missing the numeric suffix', () => {
    expect(parseExtractionBatchCustomId('extract-document-')).toBeNull()
    expect(parseExtractionBatchCustomId('extract-document-abc')).toBeNull()
  })

  it('rejects a zero or negative id (source_document ids are positive)', () => {
    expect(parseExtractionBatchCustomId('extract-document-0')).toBeNull()
    expect(parseExtractionBatchCustomId('extract-document--5')).toBeNull()
  })

  it('rejects a leading-zero id rather than silently coercing it', () => {
    // '007' as a distinct string from '7' would otherwise let two different
    // custom_ids decode to the same source_document id -- reject it instead
    // of guessing which one is "real".
    expect(parseExtractionBatchCustomId('extract-document-007')).toBeNull()
  })

  it('rejects a non-integer suffix', () => {
    expect(parseExtractionBatchCustomId('extract-document-4.5')).toBeNull()
  })

  it('rejects an id outside the safe integer range', () => {
    const tooLarge = `extract-document-${'9'.repeat(30)}`
    expect(parseExtractionBatchCustomId(tooLarge)).toBeNull()
  })

  it('rejects an empty string and other garbage input', () => {
    expect(parseExtractionBatchCustomId('')).toBeNull()
    expect(parseExtractionBatchCustomId('extract-document')).toBeNull()
    expect(parseExtractionBatchCustomId('random-noise')).toBeNull()
  })

  it('never returns a match by accident for a custom_id from a different scheme', () => {
    // Guards the "never by position, never by a loose guess" contract: a
    // custom_id that merely contains digits somewhere must not parse.
    expect(parseExtractionBatchCustomId('bill-42-of-8')).toBeNull()
  })
})
