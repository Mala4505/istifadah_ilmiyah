/**
 * One set of size limits for the Tags server actions and the screens that call them, with the
 * plain-English sentence for each. Plain module -- no 'use client' / 'use server' (a 'use
 * server' file may only export async functions, and a 'use client' module's values must not
 * be imported into Server Components) -- so actions, client components and tests all share
 * the same numbers.
 *
 * The screens never offer or send more than a limit: they split long selections into batches
 * of TAG_ENTRY_CHUNK (lib/tags/entries-shared.ts, 200, comfortably under the cap) or
 * TAG_ENTRIES_PER_CALL. The actions still re-check, because an action is a public endpoint.
 */

/** Most entry ids one Tags server action call (create, link, add-to-tag options) accepts. */
export const TAG_ENTRIES_PER_CALL = 1000

/** Most department / sub-department rows a new tag can be created with (none is fine). */
export const TAG_SCOPE_PICKS_MAX = 200

/** Shown when a request fails validation for a reason the screens cannot normally produce. */
export const INVALID_TAG_REQUEST = 'That request was not valid. Refresh the page and try again.'

const grouped = (n: number) => n.toLocaleString('en-IN')

export const TAG_ENTRY_LIMIT_MESSAGE = `That is too many entries at once. Choose up to ${grouped(TAG_ENTRIES_PER_CALL)} at a time.`
export const TAG_SCOPE_LIMIT_MESSAGE = `That is too many departments for one tag. Add up to ${grouped(TAG_SCOPE_PICKS_MAX)}.`

/**
 * Null when `count` entry ids are acceptable, otherwise the sentence to show. `required`
 * (default true) means at least one id is needed; creating a tag passes false because a tag
 * can be made with no entries.
 */
export function entryCountError(count: number, options: { required?: boolean } = {}): string | null {
  const { required = true } = options
  if (required && count === 0) return 'Pick at least one entry.'
  if (count > TAG_ENTRIES_PER_CALL) return TAG_ENTRY_LIMIT_MESSAGE
  return null
}

/**
 * The checks createTag runs before anything is written. Null = fine. A tag may be made with
 * no departments at all (they arrive from the entries linked to it, or are added by hand on
 * the tag page), so an empty scope is valid; only too many is refused.
 */
export function newTagInputError(input: {
  name: string
  scopeCount: number
  entryCount: number
  nameMax: number
}): string | null {
  const name = input.name.trim()
  if (name === '') return 'Give the tag a name.'
  if (name.length > input.nameMax) return 'The tag name is too long.'
  if (input.scopeCount > TAG_SCOPE_PICKS_MAX) return TAG_SCOPE_LIMIT_MESSAGE
  return entryCountError(input.entryCount, { required: false })
}

/**
 * The plain-English sentence for a database duplicate-key refusal on the tag tables, told
 * apart by constraint name, or null when `raw` is not a duplicate-key error. The scope table
 * and the entry link table have different answers: linking an entry that is already linked is
 * not "that department is already on this tag".
 */
export function duplicateTagMessage(raw: string): string | null {
  if (/tag_scope_tag_department_sub_department_key/i.test(raw)) return 'That department is already on this tag.'
  if (/tag_entry_pkey/i.test(raw)) return 'That entry is already linked to this tag.'
  if (/duplicate key/i.test(raw)) return 'That is already on this tag.'
  return null
}
