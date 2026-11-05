'use server'

/**
 * Server actions for the Tags pages (docs/entry-tags-plan.md, Phase 2). Super-admin only:
 * every action runs requireSuperadmin() before it touches anything, and the tables' RLS
 * (private.is_superadmin()) is the real boundary behind that. Raw errors go to logRawError;
 * the client routes whatever comes back through toastError, so the screen only ever shows
 * plain English.
 *
 * What lives in the database, not here: audit columns (created_by, updated_by, linked_by,
 * ... are stamped by triggers -- never sent), scope rows added by linking an entry (the
 * tag_entry insert trigger), moving the start event back for an older entry, and the
 * "a tag keeps at least one department" / "end event not before start event" guards. This
 * file only maps those database refusals to friendly sentences.
 *
 * A tag may be CREATED with no departments (owner decision 2026-11-05): they arrive from the
 * entries linked to it, or a super-admin adds them on the tag page. The database only blocks
 * deleting a tag's LAST department row, never creating a tag without one. createTag inserts the
 * tag, then any scope rows, and deletes the just-created tag if the scope insert fails
 * (compensating), so a half-made tag is never left behind. Until it has a department only
 * super-admins and admins can see it (department users see tags through tag_scope).
 */

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSuperadmin } from '@/lib/export/auth'
import { friendlyErrorMessage, logRawError } from '@/lib/friendly-error'
import { buildIlikeOrFilter } from '@/lib/postgrest-filter'
import { getAllEvents, getSelectedEventId } from '@/lib/events/current'
import { loadAddToTagOptions } from '@/lib/tags/entries-queries'
import { TAG_ENTRY_CHUNK, chunk, type AddToTagOptions } from '@/lib/tags/entries-shared'
import {
  INVALID_TAG_REQUEST,
  TAG_ENTRIES_PER_CALL,
  TAG_SCOPE_PICKS_MAX,
  duplicateTagMessage,
  entryCountError,
  newTagInputError,
} from '@/lib/tags/limits'
import { fetchAllPages } from '@/lib/tags/paging'
import {
  TAG_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  TAG_NOTE_MAX,
  compareEvents,
  dedupeScopePicks,
  type EventOrderRef,
} from '@/lib/tags/shared'
import { buildStartEventWarning, type StartEventWarning } from '@/lib/tags/start-event'

export type TagActionResult = { ok: true } | { ok: false; error: string }
/**
 * updateTag can also answer "the start event is later than a linked entry's event": `error`
 * carries the same sentence (so any caller that only reads `error` still shows it), and
 * `startEventWarning` lets the form offer "Save anyway" (resend with confirmStartAfterEntries).
 */
export type UpdateTagResult = TagActionResult | { ok: false; error: string; startEventWarning: StartEventWarning }
/**
 * `linked` is how many entries were linked to the new tag; `entryError` is set when the tag was
 * made but its entries could not be linked.
 */
export type CreateTagResult =
  | { ok: true; tagId: number; linked: number; entryError?: string }
  | { ok: false; error: string }
/** linkEntriesToTag: `linked` counts only the entries newly added, not ones already on the tag. */
export type LinkEntriesResult = { ok: true; linked: number } | { ok: false; error: string }

const SUPERADMIN_ONLY = 'Only a super-admin can change tags.'
const TAGS_PATH = '/tags'

const id = z.number().int().positive()
const nullableId = z.number().int().positive().nullable()

async function gate(): Promise<string | null> {
  const result = await requireSuperadmin()
  return result.ok ? null : SUPERADMIN_ONLY
}

function refresh(tagId?: number) {
  revalidatePath(TAGS_PATH)
  if (tagId !== undefined) revalidatePath(`${TAGS_PATH}/${tagId}`)
}

/**
 * Database refusals that have a specific, actionable answer. Anything else goes through
 * friendlyErrorMessage (which also hides constraint names and JSON).
 */
function mapTagError(raw: string, context: string): string {
  logRawError(context, raw)
  if (/at least one department/i.test(raw)) {
    return 'A tag must keep at least one department. Add another department first, then remove this one.'
  }
  if (/end event cannot be before/i.test(raw)) {
    return 'The end event cannot be before the start event.'
  }
  const duplicate = duplicateTagMessage(raw)
  if (duplicate) return duplicate
  return friendlyErrorMessage(raw)
}

const nameField = z.string().trim().min(1, 'Give the tag a name.').max(TAG_NAME_MAX, 'The tag name is too long.')
const descriptionField = z
  .string()
  .trim()
  .max(TAG_DESCRIPTION_MAX, 'The description is too long.')
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))

const scopePickSchema = z.object({ departmentId: id, subDepartmentId: nullableId })

/** Both events must exist and the end must not be before the start. */
async function checkPeriod(
  supabase: Awaited<ReturnType<typeof createClient>>,
  startEventId: number,
  endEventId: number | null
): Promise<string | null> {
  const ids = endEventId === null ? [startEventId] : [startEventId, endEventId]
  const { data, error } = await supabase.from('event').select('id, hijri_year, starts_on').in('id', ids)
  if (error) return mapTagError(error.message, 'tags.checkPeriod')
  const events: EventOrderRef[] = (data ?? []).map((e) => ({
    id: e.id as number,
    hijriYear: e.hijri_year as string,
    startsOn: (e.starts_on as string | null) ?? null,
  }))
  const start = events.find((e) => e.id === startEventId)
  if (!start) return 'The start event could not be found.'
  if (endEventId !== null) {
    const end = events.find((e) => e.id === endEventId)
    if (!end) return 'The end event could not be found.'
    if (compareEvents(end, start) < 0) return 'The end event cannot be before the start event.'
  }
  return null
}

/** Every sub-department must belong to the department it is paired with. */
async function checkScopePicks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  picks: ReadonlyArray<{ departmentId: number; subDepartmentId: number | null }>
): Promise<string | null> {
  const subIds = [...new Set(picks.flatMap((p) => (p.subDepartmentId === null ? [] : [p.subDepartmentId])))]
  if (subIds.length === 0) return null
  const { data, error } = await supabase.from('sub_department').select('id, department_id').in('id', subIds)
  if (error) return mapTagError(error.message, 'tags.checkScopePicks')
  const departmentOf = new Map((data ?? []).map((s) => [s.id as number, s.department_id as number]))
  for (const pick of picks) {
    if (pick.subDepartmentId === null) continue
    if (departmentOf.get(pick.subDepartmentId) !== pick.departmentId) {
      return 'A sub-department does not belong to the department it was paired with.'
    }
  }
  return null
}

/**
 * Links entries to a tag and reports how many were NEW. Entries already on the tag are
 * skipped by the database (ON CONFLICT DO NOTHING, so a double click, a stale picker or a
 * race with another tab is not an error) and are not returned, which is what makes the count
 * honest. The tag_entry insert trigger adds each new entry's department / sub-department to
 * the tag's scope and moves its start event back for an older entry; none of that is
 * duplicated here. Returns the raw message on failure -- callers pass it through mapTagError.
 */
async function insertTagEntries(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tagId: number,
  entryIds: readonly number[]
): Promise<{ linked: number; error: string | null }> {
  let linked = 0
  for (const ids of chunk([...new Set(entryIds)], TAG_ENTRY_CHUNK)) {
    const { data, error } = await supabase
      .from('tag_entry')
      .upsert(
        ids.map((entryId) => ({ tag_id: tagId, entry_id: entryId })),
        { onConflict: 'tag_id,entry_id', ignoreDuplicates: true }
      )
      .select('entry_id')
    if (error) return { linked, error: error.message }
    linked += (data ?? []).length
  }
  return { linked, error: null }
}

// ---------------------------------------------------------------------------------------
// Tag: create / update / delete
// ---------------------------------------------------------------------------------------

const createSchema = z.object({
  name: nameField,
  description: descriptionField,
  startEventId: id,
  endEventId: nullableId,
  scope: z.array(scopePickSchema).max(TAG_SCOPE_PICKS_MAX).default([]),
  entryIds: z.array(id).max(TAG_ENTRIES_PER_CALL).default([]),
})

export interface CreateTagInput {
  name: string
  description: string | null
  startEventId: number
  endEventId: number | null
  /** May be empty: departments then come from the linked entries, or are added by hand later. */
  scope: Array<{ departmentId: number; subDepartmentId: number | null }>
  entryIds: number[]
}

export async function createTag(input: CreateTagInput): Promise<CreateTagResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  // The checks a person can actually trip get their own plain sentence; the schema below is a
  // backstop for malformed calls, and its raw messages are never shown.
  const inputError = newTagInputError({
    name: typeof input?.name === 'string' ? input.name : '',
    scopeCount: Array.isArray(input?.scope) ? input.scope.length : 0,
    entryCount: Array.isArray(input?.entryIds) ? input.entryIds.length : 0,
    nameMax: TAG_NAME_MAX,
  })
  if (inputError) return { ok: false, error: inputError }
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: INVALID_TAG_REQUEST }
  const { name, description, startEventId, endEventId, entryIds } = parsed.data
  const scope = dedupeScopePicks(parsed.data.scope)

  const supabase = await createClient()
  const periodError = await checkPeriod(supabase, startEventId, endEventId)
  if (periodError) return { ok: false, error: periodError }
  const scopeError = await checkScopePicks(supabase, scope)
  if (scopeError) return { ok: false, error: scopeError }

  // 1. The tag. Audit columns are stamped by the database, so none are sent.
  const { data: created, error: insertError } = await supabase
    .from('tag')
    .insert({ name, description, start_event_id: startEventId, end_event_id: endEventId })
    .select('id')
    .single()
  if (insertError || !created) {
    return { ok: false, error: mapTagError(insertError?.message ?? 'no row returned', 'tags.create') }
  }
  const tagId = created.id as number

  // 2. Its departments, if any were given. A failure here deletes the tag again, so the person
  //    never ends up with a tag that is missing the departments they asked for.
  const { error: scopeInsertError } =
    scope.length === 0
      ? { error: null }
      : await supabase.from('tag_scope').insert(
          scope.map((pick) => ({
            tag_id: tagId,
            department_id: pick.departmentId,
            sub_department_id: pick.subDepartmentId,
            source: 'manual' as const,
          }))
        )
  if (scopeInsertError) {
    const message = mapTagError(scopeInsertError.message, 'tags.create.scope')
    const { error: rollbackError } = await supabase.from('tag').delete().eq('id', tagId)
    if (rollbackError) {
      logRawError('tags.create.rollback', rollbackError.message)
      refresh()
      return {
        ok: false,
        error: `${message} The tag was started but could not be cleaned up -- delete "${name}" from the Tags page and try again.`,
      }
    }
    return { ok: false, error: message }
  }

  // 3. Optional entries. The tag_entry insert trigger adds each entry's department /
  //    sub-department to the tag and moves the start event back for older entries.
  let entryError: string | undefined
  let linked = 0
  if (entryIds.length > 0) {
    const result = await insertTagEntries(supabase, tagId, entryIds)
    linked = result.linked
    if (result.error) {
      entryError = `The tag was created, but the entries could not be linked: ${mapTagError(result.error, 'tags.create.entries')}`
    }
  }

  refresh(tagId)
  return entryError ? { ok: true, tagId, linked, entryError } : { ok: true, tagId, linked }
}

const updateSchema = z.object({
  tagId: id,
  name: nameField,
  description: descriptionField,
  startEventId: id,
  endEventId: nullableId,
  confirmStartAfterEntries: z.boolean().optional(),
})

/**
 * Warn-but-allow (owner decision 2026-11-05): a start event later than the event of any
 * linked entry needs the caller to confirm. Only checked when the start event actually
 * changes, so editing a name never re-raises it. Returns null when there is nothing to warn
 * about; a read failure comes back as a plain-English error string instead.
 */
async function checkStartEventAgainstLinkedEntries(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tagId: number,
  startEventId: number
): Promise<{ warning: StartEventWarning | null; error: string | null }> {
  type LinkWithEvent = { entry_id: number; entries: { event_id: number | null } | null }
  const [tagResult, linkResult, events] = await Promise.all([
    supabase.from('tag').select('start_event_id').eq('id', tagId).maybeSingle(),
    // One paged read of the links with each entry's event embedded (tag_entry -> entries is a
    // many-to-one FK): no second lookup by id list, and no 1,000-row cut-off.
    fetchAllPages<LinkWithEvent>(
      (from, to) =>
        supabase
          .from('tag_entry')
          .select('entry_id, entries(event_id)')
          .eq('tag_id', tagId)
          .order('entry_id')
          .range(from, to) as unknown as PromiseLike<{ data: LinkWithEvent[] | null; error: { message: string } | null }>
    ),
    getAllEvents(),
  ])
  if (tagResult.error) return { warning: null, error: mapTagError(tagResult.error.message, 'tags.update.current') }
  if (linkResult.error) return { warning: null, error: mapTagError(linkResult.error.message, 'tags.update.links') }
  if (!tagResult.data) return { warning: null, error: 'That tag no longer exists.' }
  if ((tagResult.data.start_event_id as number) === startEventId) return { warning: null, error: null }
  if (linkResult.data.length === 0) return { warning: null, error: null }

  const eventById = new Map<number, EventOrderRef>(
    events.map((e) => [e.id, { id: e.id, hijriYear: e.hijriYear, startsOn: e.startsOn }])
  )
  const startEvent = eventById.get(startEventId)
  if (!startEvent) return { warning: null, error: null }
  const entryEvents = linkResult.data.flatMap((r) => {
    const eventId = r.entries?.event_id ?? null
    const event = eventId === null ? undefined : eventById.get(eventId)
    return event ? [event] : []
  })
  return { warning: buildStartEventWarning(startEvent, entryEvents), error: null }
}

export async function updateTag(input: {
  tagId: number
  name: string
  description: string | null
  startEventId: number
  endEventId: number | null
  /** Set by the form's "Save anyway" after the warning was shown. */
  confirmStartAfterEntries?: boolean
}): Promise<UpdateTagResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }
  const { tagId, name, description, startEventId, endEventId, confirmStartAfterEntries } = parsed.data

  const supabase = await createClient()
  const periodError = await checkPeriod(supabase, startEventId, endEventId)
  if (periodError) return { ok: false, error: periodError }

  if (!confirmStartAfterEntries) {
    const check = await checkStartEventAgainstLinkedEntries(supabase, tagId, startEventId)
    if (check.error) return { ok: false, error: check.error }
    if (check.warning) return { ok: false, error: check.warning.message, startEventWarning: check.warning }
  }

  const { data, error } = await supabase
    .from('tag')
    .update({ name, description, start_event_id: startEventId, end_event_id: endEventId })
    .eq('id', tagId)
    .select('id')
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.update') }
  if (!data || data.length === 0) return { ok: false, error: 'That tag no longer exists.' }
  refresh(tagId)
  return { ok: true }
}

export async function deleteTag(input: { tagId: number }): Promise<TagActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = z.object({ tagId: id }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That tag could not be found.' }

  const supabase = await createClient()
  // tag_scope, tag_entry and tag_event_note cascade; the entries themselves are untouched.
  const { data, error } = await supabase.from('tag').delete().eq('id', parsed.data.tagId).select('id')
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.delete') }
  if (!data || data.length === 0) return { ok: false, error: 'That tag no longer exists.' }
  refresh()
  return { ok: true }
}

// ---------------------------------------------------------------------------------------
// Scope (manual departments / sub-departments)
// ---------------------------------------------------------------------------------------

const addScopeSchema = z.object({ tagId: id, departmentId: id, subDepartmentId: nullableId })

export async function addTagScope(input: {
  tagId: number
  departmentId: number
  subDepartmentId: number | null
}): Promise<TagActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = addScopeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Pick a department to add.' }
  const { tagId, departmentId, subDepartmentId } = parsed.data

  const supabase = await createClient()
  const scopeError = await checkScopePicks(supabase, [{ departmentId, subDepartmentId }])
  if (scopeError) return { ok: false, error: scopeError }

  const { error } = await supabase
    .from('tag_scope')
    .insert({ tag_id: tagId, department_id: departmentId, sub_department_id: subDepartmentId, source: 'manual' })
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.addScope') }
  refresh(tagId)
  return { ok: true }
}

/**
 * Removes one scope row, whether it was added by hand or came from a linked entry (owner
 * decision, 2026-11-05). An entry-sourced row can come back if that entry is linked again or
 * its sub-department is set again -- the tag page says so. The database refuses to delete a
 * tag's last department row; mapTagError turns that into a friendly sentence.
 */
export async function removeTagScope(input: { tagId: number; scopeId: number }): Promise<TagActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = z.object({ tagId: id, scopeId: id }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That department could not be found.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tag_scope')
    .delete()
    .eq('id', parsed.data.scopeId)
    .eq('tag_id', parsed.data.tagId)
    .select('id')
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.removeScope') }
  if (!data || data.length === 0) {
    return { ok: false, error: 'That department is no longer on this tag.' }
  }
  refresh(parsed.data.tagId)
  return { ok: true }
}

// ---------------------------------------------------------------------------------------
// Entries (link / unlink / search)
// ---------------------------------------------------------------------------------------

/**
 * Links up to TAG_ENTRIES_PER_CALL entries to a tag (the screens split longer selections into
 * batches). Entries already on the tag are skipped, not an error; `linked` counts only the
 * ones newly added so the success message is honest.
 */
export async function linkEntriesToTag(input: { tagId: number; entryIds: number[] }): Promise<LinkEntriesResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const countError = entryCountError(Array.isArray(input?.entryIds) ? input.entryIds.length : 0)
  if (countError) return { ok: false, error: countError }
  const parsed = z.object({ tagId: id, entryIds: z.array(id).min(1).max(TAG_ENTRIES_PER_CALL) }).safeParse(input)
  if (!parsed.success) return { ok: false, error: INVALID_TAG_REQUEST }
  const { tagId, entryIds } = parsed.data

  const supabase = await createClient()
  const result = await insertTagEntries(supabase, tagId, entryIds)
  if (result.error) {
    // Earlier batches may already have been linked: refresh so the page shows them.
    if (result.linked > 0) refresh(tagId)
    return { ok: false, error: mapTagError(result.error, 'tags.link') }
  }
  if (result.linked > 0) refresh(tagId)
  return { ok: true, linked: result.linked }
}

/** Unlinks one entry. The departments it added stay on the tag (decision 8). */
export async function unlinkEntryFromTag(input: { tagId: number; entryId: number }): Promise<TagActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = z.object({ tagId: id, entryId: id }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That entry could not be found.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tag_entry')
    .delete()
    .eq('tag_id', parsed.data.tagId)
    .eq('entry_id', parsed.data.entryId)
    .select('entry_id')
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.unlink') }
  if (!data || data.length === 0) return { ok: false, error: 'That entry is no longer linked to this tag.' }
  refresh(parsed.data.tagId)
  return { ok: true }
}

export interface PickerEntry {
  id: number
  ubblNumber: string
  date: string | null
  amount: number | null
  vendor: string | null
  departmentName: string | null
  subDepartmentName: string | null
  statusLabel: string | null
  /** Already linked to the tag being edited (always false while creating). */
  alreadyLinked: boolean
}

export type SearchEntriesResult = { ok: true; entries: PickerEntry[]; truncated: boolean } | { ok: false; error: string }

const PICKER_LIMIT = 100

const searchSchema = z.object({
  eventId: id,
  departmentId: nullableId,
  subDepartmentId: nullableId,
  search: z.string().trim().max(100).default(''),
  tagId: nullableId,
})

/**
 * Entries for the picker: one event at a time (the picker opens on the current event and can
 * be switched to an earlier one), optionally filtered by department / sub-department / a
 * typed term. Voided entries are not offered. Read-only, but gated like the rest -- only a
 * super-admin ever opens the picker.
 */
export async function searchEntriesForTag(input: {
  eventId: number
  departmentId: number | null
  subDepartmentId: number | null
  search: string
  tagId: number | null
}): Promise<SearchEntriesResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = searchSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That search is not valid.' }
  const { eventId, departmentId, subDepartmentId, search, tagId } = parsed.data

  const supabase = await createClient()
  let query = supabase
    .from('v_entry_enriched')
    .select(
      'id, ubbl_number, date, amount, vendor_display_name, vendor_raw, department_name, sub_department_name, status_label'
    )
    .eq('event_id', eventId)
    .eq('is_void', false)
  if (departmentId !== null) query = query.eq('department_id', departmentId)
  if (subDepartmentId !== null) query = query.eq('sub_department_id', subDepartmentId)
  if (search) {
    query = query.or(
      buildIlikeOrFilter(['ubbl_number', 'invoice_number', 'vendor_display_name', 'vendor_raw'], search)
    )
  }
  const { data, error } = await query.order('id', { ascending: false }).limit(PICKER_LIMIT + 1)
  if (error) return { ok: false, error: mapTagError(error.message, 'tags.searchEntries') }

  const rows = (data ?? []) as unknown as Array<{
    id: number
    ubbl_number: string
    date: string | null
    amount: number | null
    vendor_display_name: string | null
    vendor_raw: string | null
    department_name: string | null
    sub_department_name: string | null
    status_label: string | null
  }>
  const truncated = rows.length > PICKER_LIMIT
  const page = truncated ? rows.slice(0, PICKER_LIMIT) : rows

  let linked = new Set<number>()
  if (tagId !== null && page.length > 0) {
    const { data: linkRows, error: linkError } = await supabase
      .from('tag_entry')
      .select('entry_id')
      .eq('tag_id', tagId)
      .in(
        'entry_id',
        page.map((r) => r.id)
      )
    // Without this lookup every entry would look unlinked and could be picked again.
    if (linkError) return { ok: false, error: mapTagError(linkError.message, 'tags.searchEntries.linked') }
    linked = new Set((linkRows ?? []).map((r) => r.entry_id as number))
  }

  return {
    ok: true,
    truncated,
    entries: page.map((r) => ({
      id: r.id,
      ubblNumber: r.ubbl_number,
      date: r.date,
      amount: r.amount,
      vendor: r.vendor_display_name ?? r.vendor_raw,
      departmentName: r.department_name,
      subDepartmentName: r.sub_department_name,
      statusLabel: r.status_label,
      alreadyLinked: linked.has(r.id),
    })),
  }
}

// ---------------------------------------------------------------------------------------
// Add to tag (Entries screens, Phase 3)
// ---------------------------------------------------------------------------------------

export type AddToTagOptionsActionResult = { ok: true; options: AddToTagOptions } | { ok: false; error: string }

/**
 * What the Add-to-tag dialog needs when it opens: events, departments, existing tags, and
 * defaults taken from the entries being tagged. Read-only, but gated like the rest -- only a
 * super-admin ever opens the dialog, and the list of every tag is not for anyone else.
 */
export async function getAddToTagOptions(input: { entryIds: number[] }): Promise<AddToTagOptionsActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const countError = entryCountError(Array.isArray(input?.entryIds) ? input.entryIds.length : 0)
  if (countError) return { ok: false, error: countError }
  const parsed = z.object({ entryIds: z.array(id).min(1).max(TAG_ENTRIES_PER_CALL) }).safeParse(input)
  if (!parsed.success) return { ok: false, error: INVALID_TAG_REQUEST }

  const supabase = await createClient()
  const selectedEventId = await getSelectedEventId()
  // Failures arrive already friendly (and logged) from friendlyDataError.
  return loadAddToTagOptions(supabase, [...new Set(parsed.data.entryIds)], selectedEventId)
}

// ---------------------------------------------------------------------------------------
// Per-event note (at most one per tag per event)
// ---------------------------------------------------------------------------------------

const noteSchema = z.object({
  tagId: id,
  eventId: id,
  note: z.string().trim().max(TAG_NOTE_MAX, 'The note is too long.'),
})

/** Saves the note for one tag in one event. An empty note removes it. */
export async function saveTagEventNote(input: { tagId: number; eventId: number; note: string }): Promise<TagActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = noteSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }
  const { tagId, eventId, note } = parsed.data

  const supabase = await createClient()
  if (note === '') {
    const { error } = await supabase.from('tag_event_note').delete().eq('tag_id', tagId).eq('event_id', eventId)
    if (error) return { ok: false, error: mapTagError(error.message, 'tags.note.delete') }
  } else {
    const { error } = await supabase
      .from('tag_event_note')
      .upsert({ tag_id: tagId, event_id: eventId, note }, { onConflict: 'tag_id,event_id' })
    if (error) return { ok: false, error: mapTagError(error.message, 'tags.note.save') }
  }
  refresh(tagId)
  return { ok: true }
}
