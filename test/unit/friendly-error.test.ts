import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { extractionFailureGuidance, friendlyErrorMessage, logRawError } from '@/lib/friendly-error'

/**
 * The contract these tests pin down: nothing that reaches the screen through
 * friendlyErrorMessage still reads as plumbing. Braces, constraint names,
 * SQLSTATE codes, stack frames and serialized provider payloads must all be
 * replaced — not merely shortened — because the whole point is that an
 * operator can read and act on what they see.
 */

const GENERIC = 'Something went wrong. Try again — if it keeps happening, contact an admin.'

function assertReadable(text: string) {
  expect(text).not.toMatch(/[{}]/)
  expect(text).not.toMatch(/\bPGRST\d+\b/)
  expect(text).not.toMatch(/constraint "/)
  expect(text.length).toBeLessThanOrEqual(160)
}

describe('friendlyErrorMessage', () => {
  it('replaces a serialized provider error body rather than printing the JSON', () => {
    const raw = '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'
    const result = friendlyErrorMessage(raw)
    expect(result).toBe('The service is busy right now. Wait a minute and try again.')
    assertReadable(result)
  })

  it('falls back to the generic sentence for a JSON blob with nothing readable inside', () => {
    const result = friendlyErrorMessage('{"a":{"b":[1,2,3]}}')
    expect(result).toBe(GENERIC)
    assertReadable(result)
  })

  it('never leaks braces even when JSON.parse fails on a truncated blob', () => {
    const result = friendlyErrorMessage('{"error":{"message":"boom", tru')
    assertReadable(result)
  })

  it.each([
    ['duplicate key value violates unique constraint "entries_ubbl_number_key"', 'duplicate'],
    ['new row for relation "entries" violates check constraint "entries_type_check"', 'allowed'],
    ['null value in column "amount" of relation "entries" violates not-null constraint', 'required field'],
    ['insert or update on table "entries" violates foreign key constraint "entries_vendor_id_fkey"', 'doesn’t exist yet'],
    ['new row violates row-level security policy for table "entries"', 'permission'],
    ['JSON object requested, multiple (or no) rows returned (PGRST116)', 'couldn’t be found'],
    ['canceling statement due to statement timeout', 'took too long'],
    ['TypeError: fetch failed', 'Couldn’t reach the server'],
    ['Could not find the function public.verify_document_extraction in the schema cache', 'out of step'],
  ])('rewrites %s', (raw, expectedFragment) => {
    const result = friendlyErrorMessage(raw)
    expect(result).toContain(expectedFragment)
    assertReadable(result)
  })

  it('passes a short, already-human sentence through unchanged', () => {
    const raw = 'A note is required to change Hub status.'
    expect(friendlyErrorMessage(raw)).toBe(raw)
  })

  it('generalises an over-long human sentence rather than wrapping a paragraph in a toast', () => {
    expect(friendlyErrorMessage('x'.repeat(200))).toBe(GENERIC)
  })

  it.each([null, undefined, '', '   '])('returns the generic sentence for %p', (raw) => {
    expect(friendlyErrorMessage(raw)).toBe(GENERIC)
  })
})

describe('extractionFailureGuidance', () => {
  it('reads through a serialized batch error to the actionable cause', () => {
    const raw = '{"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}'
    const result = extractionFailureGuidance(raw)
    expect(result).toContain('busy')
    expect(result).not.toMatch(/[{}]/)
  })

  it('tells a reviewer what to do when nothing was recorded', () => {
    expect(extractionFailureGuidance(null)).toContain('Re-run extraction')
  })

  it('never echoes the raw payload', () => {
    const raw = '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens exceeded"}}'
    expect(extractionFailureGuidance(raw)).not.toMatch(/[{}]/)
  })
})

describe('logRawError', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('logs the raw text under its context and returns it unchanged', () => {
    expect(logRawError('documents.attachDocument', 'permission denied for table entries')).toBe(
      'permission denied for table entries'
    )
    expect(console.error).toHaveBeenCalledWith(
      '[documents.attachDocument]',
      'permission denied for table entries'
    )
  })

  it('stays quiet when there is nothing to log', () => {
    expect(logRawError('ctx', null)).toBeNull()
    expect(console.error).not.toHaveBeenCalled()
  })
})
