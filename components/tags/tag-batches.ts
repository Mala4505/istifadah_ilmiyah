import {
  createTag,
  getAddToTagOptions,
  linkEntriesToTag,
  type CreateTagInput,
} from '@/lib/actions/tags'
import { chunk, mergeAddToTagOptions, TAG_ENTRY_CHUNK, type AddToTagOptions } from '@/lib/tags/entries-shared'
import { TAG_ENTRIES_PER_CALL } from '@/lib/tags/limits'

/**
 * Client-side batching for the Tags server actions. Each action accepts at most
 * TAG_ENTRIES_PER_CALL entries (lib/tags/limits.ts) and says so in plain English if asked for
 * more -- so the screens never ask: a selection of 3,000 entries goes out as several calls
 * that each stay under the cap, and the results are added up here. Not a 'use client' module
 * (no hooks); it is only imported by client components.
 */

export type BatchLinkResult =
  | { ok: true; linked: number }
  /** `linked` is how many were added by earlier batches before this one failed. */
  | { ok: false; error: string; linked: number }

/** Links `entryIds` to a tag, TAG_ENTRY_CHUNK at a time. `linked` counts only newly linked entries. */
export async function linkEntriesInBatches(tagId: number, entryIds: readonly number[]): Promise<BatchLinkResult> {
  let linked = 0
  for (const ids of chunk([...new Set(entryIds)], TAG_ENTRY_CHUNK)) {
    const result = await linkEntriesToTag({ tagId, entryIds: ids })
    if (!result.ok) return { ok: false, error: result.error, linked }
    linked += result.linked
  }
  return { ok: true, linked }
}

export type BatchCreateResult =
  | { ok: true; tagId: number; linked: number; entryError?: string }
  | { ok: false; error: string }

/**
 * Creates the tag with the first batch of entries and links the rest in further calls. A
 * failure after the tag exists is reported as `entryError` on a successful result (the tag is
 * there; some entries are not), never as a failure.
 */
export async function createTagInBatches(input: Omit<CreateTagInput, 'entryIds'>, entryIds: readonly number[]): Promise<BatchCreateResult> {
  const [first = [], ...rest] = chunk([...new Set(entryIds)], TAG_ENTRY_CHUNK)
  const created = await createTag({ ...input, entryIds: first })
  if (!created.ok) return created
  if (created.entryError) return { ok: true, tagId: created.tagId, linked: created.linked, entryError: created.entryError }
  let linked = created.linked
  for (const ids of rest) {
    const result = await linkEntriesToTag({ tagId: created.tagId, entryIds: ids })
    if (!result.ok) {
      return {
        ok: true,
        tagId: created.tagId,
        linked,
        entryError: `The tag was created, but some entries could not be added. ${result.error}`,
      }
    }
    linked += result.linked
  }
  return { ok: true, tagId: created.tagId, linked }
}

export type BatchOptionsResult = { ok: true; options: AddToTagOptions } | { ok: false; error: string }

/** The Add-to-tag options for a selection of any size: one call per TAG_ENTRIES_PER_CALL, merged. */
export async function loadAddToTagOptionsInBatches(entryIds: readonly number[]): Promise<BatchOptionsResult> {
  const parts: AddToTagOptions[] = []
  for (const ids of chunk([...new Set(entryIds)], TAG_ENTRIES_PER_CALL)) {
    const result = await getAddToTagOptions({ entryIds: ids })
    if (!result.ok) return result
    parts.push(result.options)
  }
  if (parts.length === 0) return { ok: false, error: 'Pick at least one entry.' }
  return { ok: true, options: mergeAddToTagOptions(parts) }
}
