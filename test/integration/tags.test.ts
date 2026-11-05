/**
 * Live integration suite for entry tags (docs/entry-tags-plan.md, phases 1-5), run through
 * the app's OWN query code against the STAGING schema.
 *
 * supabase/tests/entry_tags.test.sql already proves the SQL behaviour (triggers, guards,
 * policies) at the database level. This file proves the other half: that the PostgREST query
 * shapes the app sends -- rpc, embeds, .or() search, upsert onConflict, .in() batches -- work
 * against the real schema, come back in the shapes the TypeScript maps, and are bounded by
 * RLS the way the plan says, for superadmin / admin / dept users.
 *
 * It calls the real loaders (lib/tags/*-queries.ts, lib/reports/tags.ts) and the real server
 * actions (lib/actions/tags.ts). Only the Next.js request plumbing is replaced (vi.mock):
 *   - '@/lib/supabase/server'  createClient() -> the signed-in fixture user's staging client
 *   - '@/lib/export/auth'      requireSuperadmin() -> the fixture user's real role, unless a
 *                              test deliberately opens the gate to prove RLS is the boundary
 *   - '@/lib/events/current'   getAllEvents() / getSelectedEventId() read staging.event
 *   - '@/lib/cache/reference-data'  getCachedDepartments() without unstable_cache
 *   - 'next/cache'             revalidatePath() is a no-op
 *
 * SAFETY -- the project is shared with production:
 *   1. Every client here is built with db.schema = 'staging'. Nothing in this file reads
 *      or writes `public`/`private` tables through PostgREST, and the pg check at the end is
 *      a read-only transaction.
 *   2. Every row created is recorded in LEDGER and deleted by exact primary key in afterAll
 *      (which also runs when a test fails). `del()` refuses an empty id list.
 *   3. Fixture auth users are unavoidable (PostgREST needs a real JWT). Creating one fires
 *      private.handle_new_user, which writes a dept/INACTIVE row to public.staff_profile;
 *      this file never touches that row -- it goes with the auth user (FK on delete
 *      cascade), and the final check proves none is left behind.
 *   4. Fixture events/departments/sub-departments/entries are brand new staging rows, named
 *      `tags-it-<runId>`, so assertions never match anything someone else made.
 *
 *   npm run test:tags
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client as PgClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Request-context mocks (hoisted above the imports of the modules under test)
// ---------------------------------------------------------------------------
const ctx = vi.hoisted(() => ({
  client: null as unknown as import('@supabase/supabase-js').SupabaseClient,
  role: 'dept' as 'superadmin' | 'admin' | 'dept',
  /** true = requireSuperadmin() says yes whatever the role, so the DATABASE is the boundary. */
  gateOpen: false,
  selectedEventId: null as number | null,
  /** Reads staging.event for getAllEvents (service role, staging schema). */
  readEvents: null as unknown as () => Promise<unknown[]>,
}))

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ctx.client,
}))
vi.mock('@/lib/export/auth', () => ({
  requireSuperadmin: async () =>
    ctx.gateOpen || ctx.role === 'superadmin' ? { ok: true } : { ok: false, reason: 'not_admin' },
}))
vi.mock('@/lib/events/current', () => ({
  getAllEvents: async () => ctx.readEvents(),
  getSelectedEventId: async () => ctx.selectedEventId,
}))
vi.mock('@/lib/cache/reference-data', () => ({
  getCachedDepartments: async (supabase: SupabaseClient) => {
    const { data } = await supabase.from('department').select('id,name,is_active').order('name')
    return data ?? []
  },
}))

import {
  addTagScope,
  createTag,
  deleteTag,
  linkEntriesToTag,
  removeTagScope,
  saveTagEventNote,
  searchEntriesForTag,
  unlinkEntryFromTag,
  updateTag,
} from '@/lib/actions/tags'
import { linkEntriesInBatches, loadAddToTagOptionsInBatches } from '@/components/tags/tag-batches'
import { loadTagCostReport } from '@/lib/reports/tags'
import { TAG_ENTRIES_PER_CALL, TAG_ENTRY_LIMIT_MESSAGE } from '@/lib/tags/limits'
import { loadAddToTagOptions, loadEarlierTagSummaries, loadEntryTagSection } from '@/lib/tags/entries-queries'
import { loadTagDetail, loadTagsActiveInEvent, LINKED_ENTRY_COLUMNS } from '@/lib/tags/queries'
import { loadReviewTagNotice } from '@/lib/tags/review-queries'
import { buildStartEventWarning } from '@/lib/tags/start-event'
import type { Event } from '@/lib/events/types'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!
const DATABASE_URL = process.env.DATABASE_URL

if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
  throw new Error(
    'Tags integration suite needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ' +
      'and SUPABASE_SECRET_KEY in the repo-root .env. Run `npm run test:tags`.'
  )
}

/** The ONLY schema this file talks to. */
const SCHEMA = 'staging'
const DB = { schema: SCHEMA as 'public' }
const TAG = 'tags-it'
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const NAME = (label: string) => `${TAG}-${RUN_ID}-${label}`

const svc = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: DB,
})

ctx.readEvents = async () => {
  const { data, error } = await svc.from('event').select('*').order('hijri_year', { ascending: false })
  if (error) throw new Error(`readEvents: ${error.message}`)
  return (data ?? []).map(
    (r): Event => ({
      id: r.id,
      name: r.name,
      hijriYear: r.hijri_year,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      isCurrent: r.is_current,
      createdAt: r.created_at,
    })
  )
}

// ---------------------------------------------------------------------------
// Ledger + exact-key deletes
// ---------------------------------------------------------------------------
const LEDGER = {
  tags: [] as number[],
  entries: [] as number[],
  subDepartments: [] as number[],
  departments: [] as number[],
  events: [] as number[],
  staffProfiles: [] as string[],
  users: [] as string[],
}

async function del(table: string, ids: Array<number | string>) {
  if (ids.length === 0) return
  // Chunked: the bulk-link test creates ~1,000 entries, too many ids for one URL.
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    const { error } = await svc.from(table).delete().in('id', part)
    if (error) throw new Error(`cleanup ${SCHEMA}.${table} [${part.join(',')}]: ${error.message}`)
  }
}

/** Any tag created under this run's name prefix goes in the ledger, even one an action made. */
async function ledgerTagsByName(label: string): Promise<number[]> {
  const { data, error } = await svc.from('tag').select('id').eq('name', NAME(label))
  if (error) throw new Error(`ledgerTagsByName: ${error.message}`)
  const found = (data ?? []).map((r) => r.id as number)
  for (const tagId of found) if (!LEDGER.tags.includes(tagId)) LEDGER.tags.push(tagId)
  return found
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
type Role = 'superadmin' | 'admin' | 'dept'
type FixtureUser = { id: string; role: Role; client: SupabaseClient }

async function withAuthRetry<T extends { error: { message: string; status?: number } | null }>(
  fn: () => Promise<T>
): Promise<T> {
  const delays = [1500, 3000, 6000, 12000, 20000]
  for (let attempt = 0; ; attempt++) {
    let res: T
    try {
      res = await fn()
    } catch (e) {
      if (attempt >= delays.length || !/fetch failed|ETIMEDOUT|ECONNRESET|network/i.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, delays[attempt]))
      continue
    }
    const retryable = !!res.error && (res.error.status === 429 || /rate limit|fetch failed/i.test(res.error.message))
    if (!retryable || attempt >= delays.length) return res
    await new Promise((r) => setTimeout(r, delays[attempt]))
  }
}

async function makeUser(label: string, role: Role, departmentIds: number[]): Promise<FixtureUser> {
  const email = `${TAG}-${label}-${RUN_ID}@rls-test.example.com`
  const password = `Tags!${RUN_ID}${Math.random().toString(36).slice(2, 10)}`
  const { data, error } = await withAuthRetry(() =>
    svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${TAG} ${label}` } })
  )
  if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message}`)
  const id = data.user.id
  LEDGER.users.push(id)

  // Staging access = a row in staging.staff_profile (docs/staging.md "Logins").
  const { error: spErr } = await svc
    .from('staff_profile')
    .insert({ id, display_name: `${TAG} ${label} ${RUN_ID}`, role, is_active: true })
  if (spErr) throw new Error(`staging.staff_profile(${label}): ${spErr.message}`)
  LEDGER.staffProfiles.push(id)

  if (departmentIds.length > 0) {
    // staff_department cascades from staging.staff_profile.
    const { error: sdErr } = await svc
      .from('staff_department')
      .insert(departmentIds.map((department_id) => ({ staff_id: id, department_id })))
    if (sdErr) throw new Error(`staging.staff_department(${label}): ${sdErr.message}`)
  }

  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: DB,
  })
  const { error: signInErr } = await withAuthRetry(() => client.auth.signInWithPassword({ email, password }))
  if (signInErr) throw new Error(`signIn(${label}): ${signInErr.message}`)
  return { id, role, client }
}

async function insertOne<T extends Record<string, unknown>>(table: string, row: T, ledger: number[]): Promise<number> {
  const { data, error } = await svc.from(table).insert(row).select('id').single()
  if (error || !data) throw new Error(`insert ${SCHEMA}.${table}: ${error?.message}`)
  ledger.push(data.id as number)
  return data.id as number
}

function as(user: FixtureUser, opts: { gateOpen?: boolean } = {}) {
  ctx.client = user.client
  ctx.role = user.role
  ctx.gateOpen = opts.gateOpen ?? false
}

// ---------------------------------------------------------------------------
// The world (built once in beforeAll)
// ---------------------------------------------------------------------------
const W = {} as {
  evCur: Event
  evOld: Event
  evMid: Event
  deptA: number
  deptB: number
  deptC: number
  subA1: number
  subA2: number
  subB1: number
  eA_cur: number
  eA_old: number
  eA_void: number
  eB_cur: number
  eC_cur: number
  superadmin: FixtureUser
  admin: FixtureUser
  dept: FixtureUser
  /** T1: manual A/A2, start evMid, linked eA_cur (+ later eA_old, eA_void). Visible to dept. */
  t1: number
  /** T2: manual B/B1, start evCur, linked eB_cur. Hidden from dept. */
  t2: number
  /** T3: manual C, start evMid, linked eC_cur, has a note. Hidden from dept. */
  t3: number
  /** T4: manual A (whole), start evCur, linked eB_cur. Visible to dept, its entry is not. */
  t4: number
}

const depName = (id: number) =>
  id === W.deptA ? NAME('dept-a') : id === W.deptB ? NAME('dept-b') : id === W.deptC ? NAME('dept-c') : null

let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined

beforeAll(async () => {
  // logRawError prints every refusal; the refusals below are expected, keep the log readable.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const { data: cur, error: curErr } = await svc.from('event').select('*').eq('is_current', true).maybeSingle()
  if (curErr || !cur) throw new Error(`staging has no current event: ${curErr?.message ?? 'none'}`)
  const events = (await ctx.readEvents()) as Event[]
  W.evCur = events.find((e) => e.id === cur.id)!
  ctx.selectedEventId = W.evCur.id

  // Two earlier events. starts_on stays null, so order falls to hijri_year (both < 1448).
  const taken = new Set(events.map((e) => e.hijriYear))
  let base = 1200 + Math.floor(Math.random() * 200)
  while (taken.has(String(base)) || taken.has(String(base + 1))) base += 2
  const evOldId = await insertOne('event', { name: NAME('event-old'), hijri_year: String(base), is_current: false }, LEDGER.events)
  const evMidId = await insertOne('event', { name: NAME('event-mid'), hijri_year: String(base + 1), is_current: false }, LEDGER.events)
  const all = (await ctx.readEvents()) as Event[]
  W.evOld = all.find((e) => e.id === evOldId)!
  W.evMid = all.find((e) => e.id === evMidId)!

  W.deptA = await insertOne('department', { name: NAME('dept-a'), external_code: NAME('a') }, LEDGER.departments)
  W.deptB = await insertOne('department', { name: NAME('dept-b'), external_code: NAME('b') }, LEDGER.departments)
  W.deptC = await insertOne('department', { name: NAME('dept-c'), external_code: NAME('c') }, LEDGER.departments)
  W.subA1 = await insertOne('sub_department', { department_id: W.deptA, name: NAME('sub-a1') }, LEDGER.subDepartments)
  W.subA2 = await insertOne('sub_department', { department_id: W.deptA, name: NAME('sub-a2') }, LEDGER.subDepartments)
  W.subB1 = await insertOne('sub_department', { department_id: W.deptB, name: NAME('sub-b1') }, LEDGER.subDepartments)

  const entry = (label: string, departmentId: number, subId: number | null, eventId: number, amount: string, isVoid = false) =>
    insertOne(
      'entries',
      {
        ubbl_number: NAME(`ubbl-${label}`),
        department_id: departmentId,
        sub_department_id: subId,
        event_id: eventId,
        type: 'invoice',
        source: 'manual',
        amount,
        is_void: isVoid,
        vendor_raw: NAME(`vendor-${label}`),
      },
      LEDGER.entries
    )
  W.eA_cur = await entry('a-cur', W.deptA, W.subA1, W.evCur.id, '100.00')
  W.eA_old = await entry('a-old', W.deptA, null, W.evOld.id, '50.00')
  W.eA_void = await entry('a-void', W.deptA, null, W.evCur.id, '7.00', true)
  W.eB_cur = await entry('b-cur', W.deptB, W.subB1, W.evCur.id, '200.00')
  W.eC_cur = await entry('c-cur', W.deptC, null, W.evCur.id, '300.00')

  W.superadmin = await makeUser('superadmin', 'superadmin', [])
  W.admin = await makeUser('admin', 'admin', [])
  W.dept = await makeUser('dept', 'dept', [W.deptA])
})

afterAll(async () => {
  const problems: string[] = []
  for (const u of [W.superadmin, W.admin, W.dept]) if (u) await u.client.auth.signOut().catch(() => {})
  for (const step of [
    // tag first: tag_scope / tag_entry / tag_event_note cascade, and tag_entry -> entries is
    // NO ACTION, so entries can only go once their links are gone.
    async () => {
      await ledgerTagsByName('rollback') // a failed compensating delete must not leak a tag
      await del('tag', LEDGER.tags)
    },
    () => del('entries', LEDGER.entries),
    // staff_profile before department: staff_department (cascades from staff_profile)
    // references department with NO ACTION.
    () => del('staff_profile', LEDGER.staffProfiles),
    () => del('sub_department', LEDGER.subDepartments),
    () => del('department', LEDGER.departments),
    () => del('event', LEDGER.events),
    async () => {
      for (const id of LEDGER.users) {
        const { error } = await withAuthRetry(() => svc.auth.admin.deleteUser(id))
        if (error) throw new Error(`auth user ${id}: ${error.message}`)
      }
    },
  ]) {
    try {
      await step()
    } catch (e) {
      problems.push((e as Error).message)
    }
  }

  // Prove nothing is left: staging rows by exact id, and the public.staff_profile rows the
  // sign-up trigger made (read-only transaction; nothing is written outside staging).
  const leftovers: string[] = []
  const check = async (table: string, ids: Array<number | string>) => {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await svc.from(table).select('id').in('id', ids.slice(i, i + 200))
      if (error) leftovers.push(`${table}: ${error.message}`)
      else if ((data ?? []).length > 0) leftovers.push(`${table}: ${data!.map((r) => r.id).join(',')}`)
    }
  }
  await check('tag', LEDGER.tags)
  await check('entries', LEDGER.entries)
  await check('sub_department', LEDGER.subDepartments)
  await check('department', LEDGER.departments)
  await check('event', LEDGER.events)
  await check('staff_profile', LEDGER.staffProfiles)
  if (DATABASE_URL && LEDGER.users.length > 0) {
    const pg = new PgClient({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
    try {
      await pg.connect()
      await pg.query('begin read only')
      const { rows } = await pg.query('select id from public.staff_profile where id = any($1::uuid[])', [LEDGER.users])
      if (rows.length > 0) leftovers.push(`public.staff_profile (sign-up trigger): ${rows.map((r) => r.id).join(',')}`)
      await pg.query('rollback')
    } finally {
      await pg.end().catch(() => {})
    }
  }
  consoleErrorSpy?.mockRestore()
  if (problems.length > 0 || leftovers.length > 0) {
    throw new Error(`tags suite cleanup: ${[...problems, ...leftovers].join(' | ')}`)
  }
})

// ---------------------------------------------------------------------------
// Helpers for assertions
// ---------------------------------------------------------------------------
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
const ourTags = () => [W.t1, W.t2, W.t3, W.t4]

async function scopeOf(tagId: number) {
  const { data, error } = await svc
    .from('tag_scope')
    .select('id, department_id, sub_department_id, source')
    .eq('tag_id', tagId)
    .order('id')
  if (error) throw new Error(error.message)
  return data ?? []
}

async function tagRow(tagId: number) {
  const { data, error } = await svc.from('tag').select('*').eq('id', tagId).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

// ===========================================================================
describe('entry tags against staging, through the app code (superadmin / admin / dept)', () => {
  // -------------------------------------------------------------------------
  // Server actions: create (with compensating delete), link, start event move-back
  // -------------------------------------------------------------------------
  it('createTag inserts the tag + scope, links entries, and the trigger adds entry scope', async () => {
    as(W.superadmin)
    const r1 = await createTag({
      name: NAME('t1'),
      description: 'Washroom block',
      startEventId: W.evMid.id,
      endEventId: null,
      scope: [{ departmentId: W.deptA, subDepartmentId: W.subA2 }],
      entryIds: [W.eA_cur],
    })
    await ledgerTagsByName('t1')
    expect(r1).toMatchObject({ ok: true })
    if (!r1.ok) return
    expect(r1.entryError).toBeUndefined()
    W.t1 = r1.tagId

    const scope1 = await scopeOf(W.t1)
    expect(scope1.map((s) => [s.department_id, s.sub_department_id, s.source])).toEqual([
      [W.deptA, W.subA2, 'manual'],
      [W.deptA, W.subA1, 'entry'], // from eA_cur via tag_entry_after_insert
    ])
    const t1 = await tagRow(W.t1)
    // Audit columns are stamped server-side with the caller's id.
    expect(t1?.created_by).toBe(W.superadmin.id)
    expect(t1?.start_event_id).toBe(W.evMid.id) // eA_cur is the current event: no move

    const mk = async (label: string, departmentId: number, sub: number | null, start: number, entries: number[]) => {
      const r = await createTag({
        name: NAME(label),
        description: null,
        startEventId: start,
        endEventId: null,
        scope: [{ departmentId, subDepartmentId: sub }],
        entryIds: entries,
      })
      await ledgerTagsByName(label)
      expect(r, label).toMatchObject({ ok: true })
      if (!r.ok) throw new Error(r.error)
      expect(r.entryError, label).toBeUndefined()
      return r.tagId
    }
    W.t2 = await mk('t2', W.deptB, W.subB1, W.evCur.id, [W.eB_cur])
    W.t3 = await mk('t3', W.deptC, null, W.evMid.id, [W.eC_cur])
    W.t4 = await mk('t4', W.deptA, null, W.evCur.id, [W.eB_cur])

    // T2's entry is B/B1 = its manual row already -> ON CONFLICT DO NOTHING, still one row.
    expect((await scopeOf(W.t2)).map((s) => [s.department_id, s.sub_department_id])).toEqual([[W.deptB, W.subB1]])
    // T4 picked up department B from eB_cur.
    expect((await scopeOf(W.t4)).map((s) => [s.department_id, s.sub_department_id, s.source])).toEqual([
      [W.deptA, null, 'manual'],
      [W.deptB, W.subB1, 'entry'],
    ])
  })

  it('createTag deletes the just-made tag when its scope insert fails (compensating delete)', async () => {
    as(W.superadmin)
    // A department id that does not exist passes checkScopePicks (it only checks
    // sub-departments) and fails at the tag_scope FK -> step 2 of createTag fails.
    const r = await createTag({
      name: NAME('rollback'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: 2_000_000_000, subDepartmentId: null }],
      entryIds: [],
    })
    const left = await ledgerTagsByName('rollback')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).not.toMatch(/tag_scope|foreign key|violates|\{/i) // plain English only
    expect(r.error).not.toMatch(/could not be cleaned up/)
    expect(left).toEqual([]) // the half-made tag is gone
  })

  it('createTag validates a sub-department against its department before writing anything', async () => {
    as(W.superadmin)
    const r = await createTag({
      name: NAME('badpair'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: W.deptB, subDepartmentId: W.subA1 }],
      entryIds: [],
    })
    expect(await ledgerTagsByName('badpair')).toEqual([])
    expect(r).toEqual({ ok: false, error: 'A sub-department does not belong to the department it was paired with.' })
  })

  it('linking an older entry moves the start event back and adds its department scope', async () => {
    as(W.superadmin)
    const r = await linkEntriesToTag({ tagId: W.t1, entryIds: [W.eA_old, W.eA_void, W.eA_cur] }) // eA_cur already linked
    expect(r).toEqual({ ok: true, linked: 2 }) // only the NEWLY linked entries are counted
    expect((await tagRow(W.t1))?.start_event_id).toBe(W.evOld.id)
    expect((await scopeOf(W.t1)).map((s) => [s.department_id, s.sub_department_id, s.source])).toEqual([
      [W.deptA, W.subA2, 'manual'],
      [W.deptA, W.subA1, 'entry'],
      [W.deptA, null, 'entry'], // eA_old has no sub-department -> department-only row
    ])
    // Double click / stale picker: everything already linked -> still ok, nothing duplicated.
    expect(await linkEntriesToTag({ tagId: W.t1, entryIds: [W.eA_old] })).toEqual({ ok: true, linked: 0 })
    const { data: links } = await svc.from('tag_entry').select('entry_id').eq('tag_id', W.t1)
    expect(sorted((links ?? []).map((l) => l.entry_id))).toEqual(sorted([W.eA_cur, W.eA_old, W.eA_void]))
  })

  // -------------------------------------------------------------------------
  // Query shapes: rpc, list loader, cost view, detail loader
  // -------------------------------------------------------------------------
  it('rpc tags_active_in_event returns TagRow-shaped rows and respects the period', async () => {
    const raw = await W.superadmin.client.rpc('tags_active_in_event', { p_event_id: W.evCur.id })
    expect(raw.error).toBeNull()
    const mine = (raw.data as Array<Record<string, unknown>>).filter((t) => ourTags().includes(t.id as number))
    expect(sorted(mine.map((t) => t.id as number))).toEqual(sorted(ourTags()))
    for (const t of mine) {
      expect(typeof t.id).toBe('number')
      expect(typeof t.name).toBe('string')
      expect(typeof t.start_event_id).toBe('number')
      expect(t.end_event_id).toBeNull()
      expect(typeof t.created_at).toBe('string')
      expect(typeof t.updated_at).toBe('string')
      expect('description' in t).toBe(true)
    }

    const activeIn = async (eventId: number) => {
      const { data, error } = await W.superadmin.client.rpc('tags_active_in_event', { p_event_id: eventId })
      expect(error).toBeNull()
      return sorted((data as Array<{ id: number }>).map((t) => t.id).filter((id) => ourTags().includes(id)))
    }
    expect(await activeIn(W.evOld.id)).toEqual([W.t1]) // T1's start moved back to evOld
    expect(await activeIn(W.evMid.id)).toEqual(sorted([W.t1, W.t3]))
  })

  it('loadTagsActiveInEvent: scope, cost (non-voided only) and notes in the mapped shapes', async () => {
    as(W.superadmin)
    expect(await saveTagEventNote({ tagId: W.t1, eventId: W.evCur.id, note: 'Painted this year' })).toEqual({ ok: true })

    const list = await loadTagsActiveInEvent(W.superadmin.client, W.evCur.id)
    expect(list.error).toBeNull()
    expect(list.tags.map((t) => t.id).filter((id) => ourTags().includes(id)).length).toBe(4)
    const names = list.tags.map((t) => t.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))

    const t1Scope = list.scope.filter((s) => s.tag_id === W.t1)
    expect(t1Scope).toHaveLength(3)
    for (const s of t1Scope) expect(Object.keys(s).sort()).toEqual(['department_id', 'id', 'source', 'sub_department_id', 'tag_id'])

    const t1Costs = list.costs.filter((c) => c.tag_id === W.t1).sort((a, b) => a.event_id - b.event_id)
    expect(t1Costs).toEqual(
      [
        { tag_id: W.t1, event_id: W.evCur.id, cost: 100, entry_count: 1, voided_count: 1 },
        { tag_id: W.t1, event_id: W.evOld.id, cost: 50, entry_count: 1, voided_count: 0 },
      ].sort((a, b) => a.event_id - b.event_id)
    )
    expect(list.notesByTag.get(W.t1)).toBe('Painted this year')
  })

  it('loadTagDetail maps the tag, linked entries (v_entry_enriched) and costs', async () => {
    const d = await loadTagDetail(W.superadmin.client, W.t1)
    expect(d.error).toBeNull()
    expect(d.tag?.id).toBe(W.t1)
    expect(d.tag?.start_event_id).toBe(W.evOld.id)
    expect(sorted(d.entries.map((e) => e.id))).toEqual(sorted([W.eA_cur, W.eA_old, W.eA_void]))
    expect(d.hiddenEntryCount).toBe(0)
    const cols = LINKED_ENTRY_COLUMNS.split(',').map((c) => c.trim()).sort()
    for (const e of d.entries) expect(Object.keys(e).sort()).toEqual(cols)
    const aCur = d.entries.find((e) => e.id === W.eA_cur)!
    expect(aCur).toMatchObject({
      ubbl_number: NAME('ubbl-a-cur'),
      event_id: W.evCur.id,
      amount: 100,
      is_void: false,
      department_id: W.deptA,
      department_name: NAME('dept-a'),
      sub_department_id: W.subA1,
      sub_department_name: NAME('sub-a1'),
      vendor_raw: NAME('vendor-a-cur'),
    })
    expect(d.entries.find((e) => e.id === W.eA_void)?.is_void).toBe(true)
    expect(d.notes).toEqual([{ tag_id: W.t1, event_id: W.evCur.id, note: 'Painted this year' }])

    // An id that does not exist: no error, just no tag.
    const none = await loadTagDetail(W.superadmin.client, 2_000_000_000)
    expect(none).toMatchObject({ tag: null, error: null })
  })

  // -------------------------------------------------------------------------
  // Notes: upsert on (tag_id, event_id), empty deletes
  // -------------------------------------------------------------------------
  it('saveTagEventNote upserts one row per (tag, event) and an empty note deletes it', async () => {
    as(W.superadmin)
    expect(await saveTagEventNote({ tagId: W.t3, eventId: W.evCur.id, note: 'first' })).toEqual({ ok: true })
    expect(await saveTagEventNote({ tagId: W.t3, eventId: W.evCur.id, note: '  second  ' })).toEqual({ ok: true })
    const { data: saved } = await svc
      .from('tag_event_note')
      .select('note, updated_by')
      .eq('tag_id', W.t3)
      .eq('event_id', W.evCur.id)
    expect(saved).toEqual([{ note: 'second', updated_by: W.superadmin.id }])

    expect(await saveTagEventNote({ tagId: W.t3, eventId: W.evMid.id, note: 'other event' })).toEqual({ ok: true })
    expect(await saveTagEventNote({ tagId: W.t3, eventId: W.evMid.id, note: '   ' })).toEqual({ ok: true })
    const { data: remaining } = await svc.from('tag_event_note').select('event_id').eq('tag_id', W.t3)
    expect(remaining).toEqual([{ event_id: W.evCur.id }]) // the mid-event note was removed; T3 keeps its current note

    // Deleting a note that is not there is still ok (idempotent).
    expect(await saveTagEventNote({ tagId: W.t3, eventId: W.evMid.id, note: '' })).toEqual({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Entry picker (v_entry_enriched + .or() search)
  // -------------------------------------------------------------------------
  it('searchEntriesForTag: event / department / sub-department filters, .or() search, alreadyLinked', async () => {
    as(W.superadmin)
    const search = async (over: Partial<Parameters<typeof searchEntriesForTag>[0]>) => {
      const r = await searchEntriesForTag({
        eventId: W.evCur.id,
        departmentId: W.deptA,
        subDepartmentId: null,
        search: '',
        tagId: null,
        ...over,
      })
      if (!r.ok) throw new Error(`search failed: ${r.error}`)
      return r
    }

    const deptA = await search({})
    expect(deptA.entries.map((e) => e.id)).toEqual([W.eA_cur]) // voided eA_void not offered
    expect(deptA.truncated).toBe(false)
    expect(deptA.entries[0]).toEqual({
      id: W.eA_cur,
      ubblNumber: NAME('ubbl-a-cur'),
      date: null,
      amount: 100,
      vendor: NAME('vendor-a-cur'), // vendor_display_name null -> vendor_raw
      departmentName: NAME('dept-a'),
      subDepartmentName: NAME('sub-a1'),
      statusLabel: null,
      alreadyLinked: false,
    })

    expect((await search({ subDepartmentId: W.subA1 })).entries.map((e) => e.id)).toEqual([W.eA_cur])
    expect((await search({ subDepartmentId: W.subA2 })).entries).toEqual([])
    expect((await search({ eventId: W.evOld.id })).entries.map((e) => e.id)).toEqual([W.eA_old])

    // .or() over ubbl_number / invoice_number / vendor_display_name / vendor_raw, any department.
    const byUbbl = await search({ departmentId: null, search: `${RUN_ID}-ubbl-b` })
    expect(byUbbl.entries.map((e) => e.id)).toEqual([W.eB_cur])
    const byVendor = await search({ departmentId: null, search: `${RUN_ID}-VENDOR-C` }) // ilike: case-insensitive
    expect(byVendor.entries.map((e) => e.id)).toEqual([W.eC_cur])
    // Filter-grammar characters are data, not syntax: no widening, no PostgREST error.
    expect((await search({ departmentId: null, search: `${RUN_ID},id.gt.0` })).entries).toEqual([])
    expect((await search({ departmentId: null, search: `${RUN_ID}%` })).entries).toEqual([])

    const withTag = await search({ departmentId: null, search: RUN_ID, tagId: W.t1 })
    const linked = new Map(withTag.entries.map((e) => [e.id, e.alreadyLinked]))
    expect(linked.get(W.eA_cur)).toBe(true)
    expect(linked.get(W.eB_cur)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Unlink / remove scope
  // -------------------------------------------------------------------------
  it('unlinkEntryFromTag removes the link but keeps the department it added', async () => {
    as(W.superadmin)
    expect(await unlinkEntryFromTag({ tagId: W.t4, entryId: W.eB_cur })).toEqual({ ok: true })
    expect((await scopeOf(W.t4)).map((s) => s.department_id)).toEqual([W.deptA, W.deptB]) // decision 8
    expect(await unlinkEntryFromTag({ tagId: W.t4, entryId: W.eB_cur })).toEqual({
      ok: false,
      error: 'That entry is no longer linked to this tag.',
    })
    // Put it back for the RLS tests below.
    expect(await linkEntriesToTag({ tagId: W.t4, entryIds: [W.eB_cur] })).toEqual({ ok: true, linked: 1 })
  })

  it('removeTagScope removes any row (manual or entry-sourced) but never the last one', async () => {
    as(W.superadmin)
    // addTagScope then remove it again (manual round-trip), and a duplicate add is friendly.
    expect(await addTagScope({ tagId: W.t2, departmentId: W.deptC, subDepartmentId: null })).toEqual({ ok: true })
    expect(await addTagScope({ tagId: W.t2, departmentId: W.deptC, subDepartmentId: null })).toEqual({
      ok: false,
      error: 'That department is already on this tag.',
    })
    const added = (await scopeOf(W.t2)).find((s) => s.department_id === W.deptC)!
    expect(added.source).toBe('manual')
    expect(await removeTagScope({ tagId: W.t2, scopeId: added.id })).toEqual({ ok: true })

    // An entry-sourced row can be removed (owner decision 2026-11-05).
    const entryRow = (await scopeOf(W.t1)).find((s) => s.sub_department_id === W.subA1)!
    expect(entryRow.source).toBe('entry')
    expect(await removeTagScope({ tagId: W.t1, scopeId: entryRow.id })).toEqual({ ok: true })

    // Wrong tag id for a real scope row: matched nothing, nothing removed.
    const t2Only = (await scopeOf(W.t2))[0]!
    expect(await removeTagScope({ tagId: W.t1, scopeId: t2Only.id })).toEqual({
      ok: false,
      error: 'That department is no longer on this tag.',
    })

    // T2's last department: the trigger refuses, mapped to a friendly sentence.
    expect(await scopeOf(W.t2)).toHaveLength(1)
    expect(await removeTagScope({ tagId: W.t2, scopeId: t2Only.id })).toEqual({
      ok: false,
      error: 'A tag must keep at least one department. Add another department first, then remove this one.',
    })
    expect(await scopeOf(W.t2)).toHaveLength(1)
  })

  it("an entry's sub-department set later adds the matching scope row to its tags", async () => {
    // Fixture entry, service role: this is the export/import path, not a user write.
    const { error } = await svc.from('entries').update({ sub_department_id: W.subA1 }).eq('id', W.eA_old)
    expect(error).toBeNull()
    const rows = (await scopeOf(W.t1)).map((s) => [s.department_id, s.sub_department_id, s.source])
    expect(rows).toContainEqual([W.deptA, W.subA1, 'entry']) // back, after the removal above
  })

  // -------------------------------------------------------------------------
  // Start-event warning (updateTag) -- pure helper + real linked entries
  // -------------------------------------------------------------------------
  it('updateTag warns when the new start event is later than a linked entry, saves when confirmed', async () => {
    as(W.superadmin)
    const base = { tagId: W.t1, name: NAME('t1'), description: 'Washroom block', endEventId: null }

    // Name-only edit: start unchanged -> no warning even though entries span events.
    expect(await updateTag({ ...base, startEventId: W.evOld.id })).toEqual({ ok: true })

    const ref = (e: Event) => ({ id: e.id, hijriYear: e.hijriYear, startsOn: e.startsOn })
    const expected = buildStartEventWarning(ref(W.evCur), [ref(W.evCur), ref(W.evOld), ref(W.evCur)])
    expect(expected?.entryCount).toBe(1)

    const warned = await updateTag({ ...base, startEventId: W.evCur.id })
    expect(warned.ok).toBe(false)
    expect('startEventWarning' in warned && warned.startEventWarning).toEqual(expected)
    expect((await tagRow(W.t1))?.start_event_id).toBe(W.evOld.id) // not saved

    // End before start: refused before any write.
    expect(await updateTag({ ...base, startEventId: W.evMid.id, endEventId: W.evOld.id })).toEqual({
      ok: false,
      error: 'The end event cannot be before the start event.',
    })

    expect(await updateTag({ ...base, startEventId: W.evCur.id, confirmStartAfterEntries: true })).toEqual({ ok: true })
    expect((await tagRow(W.t1))?.start_event_id).toBe(W.evCur.id)
    const { data } = await W.superadmin.client.rpc('tags_active_in_event', { p_event_id: W.evOld.id })
    expect((data as Array<{ id: number }>).map((t) => t.id)).not.toContain(W.t1)

    // Restore evMid as the start (earlier than evCur, later than the evOld entry -> confirm).
    expect(await updateTag({ ...base, startEventId: W.evMid.id, confirmStartAfterEntries: true })).toEqual({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Entries-screen loaders
  // -------------------------------------------------------------------------
  it('entries loaders: earlier-year tags, entry tag section, add-to-tag options', async () => {
    // Superadmin: earlier-year tags active in evCur = those that started before it (T1, T3).
    const earlier = await loadEarlierTagSummaries(W.superadmin.client, W.evCur.id)
    expect(earlier.error).toBeNull()
    const mine = earlier.tags.filter((t) => ourTags().includes(t.id))
    expect(sorted(mine.map((t) => t.id))).toEqual(sorted([W.t1, W.t3]))
    const t1 = mine.find((t) => t.id === W.t1)!
    expect(t1).toMatchObject({ startEventId: W.evMid.id, endEventId: null, departmentIds: [W.deptA] })
    expect(t1.periodLabel).toContain(W.evMid.hijriYear)

    // Dept user (A): T3 (dept C) is hidden.
    const deptEarlier = await loadEarlierTagSummaries(W.dept.client, W.evCur.id)
    expect(deptEarlier.error).toBeNull()
    expect(deptEarlier.tags.filter((t) => ourTags().includes(t.id)).map((t) => t.id)).toEqual([W.t1])

    const section = await loadEntryTagSection(W.dept.client, {
      entryId: W.eA_cur,
      departmentId: W.deptA,
      departmentName: NAME('dept-a'),
      selectedEventId: W.evCur.id,
    })
    expect(section.error).toBeNull()
    expect(section.tags).toEqual([
      expect.objectContaining({ id: W.t1, name: NAME('t1'), description: 'Washroom block', departmentNames: [NAME('dept-a')] }),
    ])
    // Already linked to T1 -> no "earlier years" notice for it.
    expect(section.notices.flatMap((g) => g.tags.map((t) => t.id))).not.toContain(W.t1)

    // An unlinked dept-A entry in evCur would get the notice: use eA_void (linked) vs a check
    // on the notice builder input through the loader with an entry not on T1.
    const sectionB = await loadEntryTagSection(W.superadmin.client, {
      entryId: W.eB_cur,
      departmentId: W.deptA, // pretend the entry sits in A: T1 (A, earlier) is not linked to it
      departmentName: NAME('dept-a'),
      selectedEventId: W.evCur.id,
    })
    expect(sectionB.error).toBeNull()
    expect(sorted(sectionB.tags.map((t) => t.id).filter((id) => ourTags().includes(id)))).toEqual(sorted([W.t2, W.t4]))
    expect(sectionB.notices.flatMap((g) => g.tags.map((t) => t.id))).toContain(W.t1)

    const opts = await loadAddToTagOptions(W.superadmin.client, [W.eA_cur, W.eA_old, W.eB_cur], W.evCur.id)
    expect(opts.ok).toBe(true)
    if (!opts.ok) return
    expect(opts.options.entryCount).toBe(3)
    expect(opts.options.defaultScope).toEqual(
      sorted([W.deptA, W.deptB]).map((departmentId) => ({ departmentId, subDepartmentId: null }))
    )
    expect(opts.options.defaultStartEventId).toBe(W.evOld.id)
    expect(sorted(opts.options.tags.map((t) => t.id).filter((id) => ourTags().includes(id)))).toEqual(sorted(ourTags()))
    expect(opts.options.departments.some((d) => d.id === W.deptA)).toBe(true)
    expect(opts.options.subDepartments.find((s) => s.id === W.subA1)).toEqual({
      id: W.subA1,
      name: NAME('sub-a1'),
      departmentId: W.deptA,
    })
  })

  // -------------------------------------------------------------------------
  // Review notice (multi-department .in() + embedded sub_department(name))
  // -------------------------------------------------------------------------
  it('review notice: tag_scope embed resolves sub-department names; one call covers many departments', async () => {
    // The raw embed, exactly as review-queries.ts sends it: many-to-one -> an object, not an array.
    const raw = await W.admin.client
      .from('tag_scope')
      .select('tag_id, department_id, sub_department_id, sub_department(name)')
      .in('department_id', [W.deptA, W.deptB])
    expect(raw.error).toBeNull()
    const b1 = (raw.data as unknown as Array<Record<string, unknown>>).find(
      (r) => r.tag_id === W.t2 && r.sub_department_id === W.subB1
    )
    expect(b1?.sub_department).toEqual({ name: NAME('sub-b1') })

    const entries = [
      { entryId: W.eA_cur, ubblNumber: NAME('ubbl-a-cur'), amount: 100, departmentId: W.deptA, subDepartmentId: W.subA1 },
      { entryId: W.eB_cur, ubblNumber: NAME('ubbl-b-cur'), amount: 200, departmentId: W.deptB, subDepartmentId: W.subB1 },
    ]
    const notice = await loadReviewTagNotice(W.admin.client, {
      eventId: W.evCur.id,
      entries,
      departmentName: depName,
    })
    expect(notice?.error).toBeNull()
    const rows = notice!.rows.filter((r) => ourTags().includes(r.tagId))
    // T3 is dept C only: not on a bill whose entries are in A and B.
    expect(sorted(rows.map((r) => r.tagId))).toEqual(sorted([W.t1, W.t2, W.t4]))

    const r1 = rows.find((r) => r.tagId === W.t1)!
    expect(r1.note).toBe('Painted this year')
    expect(r1.linkedEntryIds).toEqual([W.eA_cur])
    expect(r1.coverage).toEqual([
      {
        departmentId: W.deptA,
        departmentName: NAME('dept-a'),
        coversWholeDepartment: true,
        subDepartments: [
          { id: W.subA1, name: NAME('sub-a1') },
          { id: W.subA2, name: NAME('sub-a2') },
        ],
      },
    ])
    const r2 = rows.find((r) => r.tagId === W.t2)!
    expect(r2.coverage).toEqual([
      { departmentId: W.deptB, departmentName: NAME('dept-b'), coversWholeDepartment: false, subDepartments: [{ id: W.subB1, name: NAME('sub-b1') }] },
    ])
    expect(r2.linkedEntryIds).toEqual([W.eB_cur])
    const r4 = rows.find((r) => r.tagId === W.t4)!
    expect(r4.coverage.map((c) => c.departmentId).sort()).toEqual(sorted([W.deptA, W.deptB]))

    // Nothing to look up -> null, no queries.
    expect(await loadReviewTagNotice(W.admin.client, { eventId: null, entries, departmentName: depName })).toBeNull()
    expect(
      await loadReviewTagNotice(W.admin.client, {
        eventId: W.evCur.id,
        entries: [{ ...entries[0]!, departmentId: null }],
        departmentName: depName,
      })
    ).toBeNull()

    // Dept user (A) on the same bill: T2 (B only) is hidden, T1 and T4 (both touch A) show.
    const deptNotice = await loadReviewTagNotice(W.dept.client, { eventId: W.evCur.id, entries, departmentName: depName })
    expect(deptNotice?.error).toBeNull()
    expect(sorted(deptNotice!.rows.filter((r) => ourTags().includes(r.tagId)).map((r) => r.tagId))).toEqual(
      sorted([W.t1, W.t4])
    )
  })

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------
  it('loadTagCostReport: carried-in vs this-event cost per tag', async () => {
    as(W.superadmin)
    const report = await loadTagCostReport(W.evCur)
    expect(report.error).toBeNull()
    expect(report.eventName).toBe(W.evCur.name)
    const mine = report.rows.filter((r) => ourTags().includes(r.tagId))
    expect(sorted(mine.map((r) => r.tagId))).toEqual(sorted(ourTags()))
    const t1 = mine.find((r) => r.tagId === W.t1)!
    expect(t1).toMatchObject({ carriedIn: 50, thisEvent: 100 })
    const t3 = mine.find((r) => r.tagId === W.t3)!
    expect(t3).toMatchObject({ carriedIn: 0, thisEvent: 300 })
  })

  // -------------------------------------------------------------------------
  // RLS through the same query shapes
  // -------------------------------------------------------------------------
  it('admin reads every tag, scope, link, note and cost row', async () => {
    const c = W.admin.client
    const tags = await c.from('tag').select('id').in('id', ourTags())
    expect(tags.error).toBeNull()
    expect(sorted((tags.data ?? []).map((r) => r.id))).toEqual(sorted(ourTags()))
    const list = await loadTagsActiveInEvent(c, W.evCur.id)
    expect(list.error).toBeNull()
    expect(sorted(list.tags.map((t) => t.id).filter((id) => ourTags().includes(id)))).toEqual(sorted(ourTags()))
    expect(list.notesByTag.get(W.t3)).toBe('second')
    expect(list.costs.find((r) => r.tag_id === W.t3 && r.event_id === W.evCur.id)?.cost).toBe(300)
    const detail = await loadTagDetail(c, W.t4)
    expect(detail.error).toBeNull()
    expect(detail.entries.map((e) => e.id)).toEqual([W.eB_cur])
  })

  it('admin cannot write: insert -> 42501, update/delete -> 0 rows; nothing lands', async () => {
    const c = W.admin.client
    const before = await tagRow(W.t1)

    const ins = await c.from('tag').insert({ name: NAME('admin-ins'), start_event_id: W.evCur.id }).select('id')
    expect(ins.error?.code).toBe('42501')
    expect(await ledgerTagsByName('admin-ins')).toEqual([])

    const upd = await c.from('tag').update({ name: NAME('admin-upd') }).eq('id', W.t1).select('id')
    expect(upd.error).toBeNull()
    expect(upd.data).toEqual([])
    const delTag = await c.from('tag').delete().eq('id', W.t1).select('id')
    expect(delTag.error).toBeNull()
    expect(delTag.data).toEqual([])
    expect((await tagRow(W.t1))?.name).toBe(before?.name)

    const scopeIns = await c.from('tag_scope').insert({ tag_id: W.t1, department_id: W.deptC, sub_department_id: null, source: 'manual' })
    expect(scopeIns.error?.code).toBe('42501')
    const scopeDel = await c.from('tag_scope').delete().eq('tag_id', W.t1).select('id')
    expect(scopeDel.error).toBeNull()
    expect(scopeDel.data).toEqual([])

    const linkIns = await c.from('tag_entry').insert({ tag_id: W.t2, entry_id: W.eA_cur })
    expect(linkIns.error?.code).toBe('42501')
    const linkDel = await c.from('tag_entry').delete().eq('tag_id', W.t1).eq('entry_id', W.eA_cur).select('entry_id')
    expect(linkDel.error).toBeNull()
    expect(linkDel.data).toEqual([])

    const noteUp = await c
      .from('tag_event_note')
      .upsert({ tag_id: W.t1, event_id: W.evCur.id, note: 'admin' }, { onConflict: 'tag_id,event_id' })
    expect(noteUp.error?.code).toBe('42501')
    const noteDel = await c.from('tag_event_note').delete().eq('tag_id', W.t1).eq('event_id', W.evCur.id).select('tag_id')
    expect(noteDel.error).toBeNull()
    expect(noteDel.data).toEqual([])

    // Ground truth, service role.
    // A/A2 manual, A (whole) entry, A/A1 entry (re-added by the sub-department trigger).
    expect(await scopeOf(W.t1)).toHaveLength(3)
    const { data: links } = await svc.from('tag_entry').select('entry_id').eq('tag_id', W.t1)
    expect((links ?? []).length).toBe(3)
    const { data: notes } = await svc.from('tag_event_note').select('note').eq('tag_id', W.t1)
    expect(notes).toEqual([{ note: 'Painted this year' }])
  })

  it('with the app gate forced open, the actions still fail for admin (RLS is the real boundary)', async () => {
    as(W.admin, { gateOpen: true })
    const created = await createTag({
      name: NAME('admin-action'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: W.deptA, subDepartmentId: null }],
      entryIds: [],
    })
    expect(await ledgerTagsByName('admin-action')).toEqual([])
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error).not.toMatch(/row-level security|42501|policy/i)

    expect((await updateTag({ tagId: W.t1, name: NAME('x'), description: null, startEventId: W.evMid.id, endEventId: null })).ok).toBe(false)
    expect((await deleteTag({ tagId: W.t1 })).ok).toBe(false)
    expect((await addTagScope({ tagId: W.t1, departmentId: W.deptC, subDepartmentId: null })).ok).toBe(false)
    expect((await linkEntriesToTag({ tagId: W.t2, entryIds: [W.eA_cur] })).ok).toBe(false)
    expect((await unlinkEntryFromTag({ tagId: W.t1, entryId: W.eA_cur })).ok).toBe(false)
    expect((await saveTagEventNote({ tagId: W.t1, eventId: W.evCur.id, note: 'admin' })).ok).toBe(false)
    expect(await tagRow(W.t1)).toMatchObject({ name: NAME('t1') })

    // And with the gate closed (the real app), every action stops before the database.
    as(W.admin)
    expect(await deleteTag({ tagId: W.t1 })).toEqual({ ok: false, error: 'Only a super-admin can change tags.' })
    as(W.dept)
    expect(
      await searchEntriesForTag({ eventId: W.evCur.id, departmentId: null, subDepartmentId: null, search: '', tagId: null })
    ).toEqual({ ok: false, error: 'Only a super-admin can change tags.' })
  })

  it('dept user sees only tags touching their departments -- no scope/notes/links/cost for hidden tags', async () => {
    const c = W.dept.client
    const tags = await c.from('tag').select('id').in('id', ourTags())
    expect(tags.error).toBeNull()
    expect(sorted((tags.data ?? []).map((r) => r.id))).toEqual(sorted([W.t1, W.t4]))

    const rpc = await c.rpc('tags_active_in_event', { p_event_id: W.evCur.id })
    expect(rpc.error).toBeNull()
    expect(sorted((rpc.data as Array<{ id: number }>).map((t) => t.id).filter((id) => ourTags().includes(id)))).toEqual(
      sorted([W.t1, W.t4])
    )

    for (const hidden of [W.t2, W.t3]) {
      for (const [table, cols] of [
        ['tag_scope', 'id'],
        ['tag_entry', 'entry_id'],
        ['tag_event_note', 'note'],
        ['tag_cost_by_event', 'cost'],
      ] as const) {
        const r = await c.from(table).select(cols).eq('tag_id', hidden)
        expect(r.error, `${table} for hidden tag`).toBeNull()
        expect(r.data, `${table} for hidden tag ${hidden}`).toEqual([])
      }
      const detail = await loadTagDetail(c, hidden)
      expect(detail).toMatchObject({ tag: null, error: null })
    }
    // Ground truth: T3 really has a note, scope, a link and cost.
    const { data: t3note } = await svc.from('tag_event_note').select('note').eq('tag_id', W.t3)
    expect(t3note).toEqual([{ note: 'second' }])

    // T4 is visible (scope A) and shows ALL its departments, but its only entry is in B:
    // the link row is visible, the entry and its cost are not (entries RLS + security_invoker).
    const t4 = await loadTagDetail(c, W.t4)
    expect(t4.error).toBeNull()
    expect(t4.tag?.id).toBe(W.t4)
    expect(t4.scope.map((s) => s.department_id).sort()).toEqual(sorted([W.deptA, W.deptB]))
    expect(t4.entries).toEqual([])
    expect(t4.hiddenEntryCount).toBe(1)
    expect(t4.costs).toEqual([])

    // T1: all its entries are in A, so the dept user's totals match the superadmin's.
    const list = await loadTagsActiveInEvent(c, W.evCur.id)
    expect(list.error).toBeNull()
    expect(list.costs.find((r) => r.tag_id === W.t1 && r.event_id === W.evCur.id)).toMatchObject({
      cost: 100,
      entry_count: 1,
      voided_count: 1,
    })
    expect(list.notesByTag.get(W.t1)).toBe('Painted this year')
    expect(list.notesByTag.has(W.t3)).toBe(false)

    // Dept writes are refused like admin's.
    const ins = await c.from('tag_entry').insert({ tag_id: W.t1, entry_id: W.eA_old })
    expect(ins.error?.code).toBe('42501')
    const upd = await c.from('tag').update({ name: NAME('dept-upd') }).eq('id', W.t1).select('id')
    expect(upd.error).toBeNull()
    expect(upd.data).toEqual([])
  })

  it('deleteTag (superadmin) cascades scope, links and notes; entries stay', async () => {
    as(W.superadmin)
    expect(await deleteTag({ tagId: W.t3 })).toEqual({ ok: true })
    expect(await tagRow(W.t3)).toBeNull()
    for (const table of ['tag_scope', 'tag_entry', 'tag_event_note'] as const) {
      const { data } = await svc.from(table).select('tag_id').eq('tag_id', W.t3)
      expect(data, table).toEqual([])
    }
    const { data: entry } = await svc.from('entries').select('id').eq('id', W.eC_cur)
    expect(entry).toEqual([{ id: W.eC_cur }])
    expect(await deleteTag({ tagId: W.t3 })).toEqual({ ok: false, error: 'That tag no longer exists.' })
  })

  // -------------------------------------------------------------------------
  // Department change reaches the entry's tags (20261105110000_entry_tags_department_change)
  // -------------------------------------------------------------------------
  it('an entry department changed later adds the new department to its tags and keeps the old', async () => {
    as(W.superadmin)
    const eDc = await insertOne(
      'entries',
      {
        ubbl_number: NAME('ubbl-dc'),
        department_id: W.deptA,
        event_id: W.evCur.id,
        type: 'invoice',
        source: 'manual',
        amount: '5.00',
        vendor_raw: NAME('vendor-dc'),
      },
      LEDGER.entries
    )
    const created = await createTag({
      name: NAME('t5'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: W.deptA, subDepartmentId: null }],
      entryIds: [eDc],
    })
    await ledgerTagsByName('t5')
    expect(created).toMatchObject({ ok: true, linked: 1 })
    if (!created.ok) return
    const rows = async () => (await scopeOf(created.tagId)).map((s) => [s.department_id, s.sub_department_id, s.source])
    expect(await rows()).toEqual([[W.deptA, null, 'manual']])

    // Department only -- no sub-department change at all (service role: the export/import path).
    const move1 = await svc.from('entries').update({ department_id: W.deptC }).eq('id', eDc)
    expect(move1.error).toBeNull()
    expect(await rows()).toEqual([
      [W.deptA, null, 'manual'], // the old department stays (decision 8)
      [W.deptC, null, 'entry'],
    ])

    // A sub-department of the OLD department left on the entry is not paired with the new one.
    const back = await svc.from('entries').update({ sub_department_id: W.subA1, department_id: W.deptA }).eq('id', eDc)
    expect(back.error).toBeNull()
    const move2 = await svc.from('entries').update({ department_id: W.deptB }).eq('id', eDc)
    expect(move2.error).toBeNull()
    const after = await rows()
    expect(after).toContainEqual([W.deptB, null, 'entry'])
    expect(after).not.toContainEqual([W.deptB, W.subA1, 'entry'])
    expect(after).toContainEqual([W.deptA, null, 'manual'])
    expect(after).toContainEqual([W.deptC, null, 'entry'])
  })

  // -------------------------------------------------------------------------
  // More than 1,000 links: paging, chunked lookups, batching, plain-English limits
  // -------------------------------------------------------------------------
  it('a tag linked to more than 1,000 entries: batched linking, paged detail, start-event check, honest counts', async () => {
    as(W.superadmin)
    const COUNT = TAG_ENTRIES_PER_CALL + 10
    const OLD_TAIL = 5 // the highest-id entries are in the older event: they sit on page 2 of the links
    const ids: number[] = []
    for (let start = 0; start < COUNT; start += 500) {
      const rows = Array.from({ length: Math.min(500, COUNT - start) }, (_, k) => {
        const i = start + k
        return {
          ubbl_number: NAME(`bulk-${i}`),
          department_id: W.deptA,
          event_id: i >= COUNT - OLD_TAIL ? W.evOld.id : W.evCur.id,
          type: 'invoice',
          source: 'manual',
          amount: '1.00',
        }
      })
      const { data, error } = await svc.from('entries').insert(rows).select('id')
      if (error) throw new Error(`bulk entries: ${error.message}`)
      for (const r of data ?? []) {
        ids.push(r.id as number)
        LEDGER.entries.push(r.id as number)
      }
    }
    expect(ids).toHaveLength(COUNT)

    // Over the per-call cap: a plain sentence, nothing written, no zod text.
    const tooMany = await linkEntriesToTag({ tagId: W.t4, entryIds: ids.slice(0, TAG_ENTRIES_PER_CALL + 1) })
    expect(tooMany).toEqual({ ok: false, error: TAG_ENTRY_LIMIT_MESSAGE })
    expect(await linkEntriesToTag({ tagId: W.t4, entryIds: [] })).toEqual({ ok: false, error: 'Pick at least one entry.' })
    const overCreate = await createTag({
      name: NAME('over-cap'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: W.deptA, subDepartmentId: null }],
      entryIds: ids.slice(0, TAG_ENTRIES_PER_CALL + 1),
    })
    expect(overCreate).toEqual({ ok: false, error: TAG_ENTRY_LIMIT_MESSAGE })
    expect(await ledgerTagsByName('over-cap')).toEqual([])

    // Add-to-tag options for >1,000 entries: several calls under the cap, merged.
    const opts = await loadAddToTagOptionsInBatches(ids)
    expect(opts.ok).toBe(true)
    if (opts.ok) {
      expect(opts.options.entryCount).toBe(COUNT)
      expect(opts.options.defaultScope).toEqual([{ departmentId: W.deptA, subDepartmentId: null }])
      expect(opts.options.defaultStartEventId).toBe(W.evOld.id) // the oldest of all batches
      // Every tag is listed, none lost to the row cap (t3 was deleted by the test above).
      expect(sorted(opts.options.tags.map((t) => t.id).filter((id) => ourTags().includes(id)))).toEqual(
        sorted(ourTags().filter((id) => id !== W.t3))
      )
    }

    // Create + link through the client batching.
    const created = await createTag({
      name: NAME('big'),
      description: null,
      startEventId: W.evCur.id,
      endEventId: null,
      scope: [{ departmentId: W.deptA, subDepartmentId: null }],
      entryIds: ids.slice(0, 100),
    })
    await ledgerTagsByName('big')
    expect(created).toMatchObject({ ok: true, linked: 100 })
    if (!created.ok) return
    const bigTag = created.tagId

    const rest = await linkEntriesInBatches(bigTag, ids) // the first 100 are already linked
    expect(rest).toEqual({ ok: true, linked: COUNT - 100 })
    expect(await linkEntriesInBatches(bigTag, ids)).toEqual({ ok: true, linked: 0 }) // nothing new the second time
    const { count } = await svc.from('tag_entry').select('entry_id', { count: 'exact', head: true }).eq('tag_id', bigTag)
    expect(count).toBe(COUNT)
    expect((await tagRow(bigTag))?.start_event_id).toBe(W.evOld.id) // moved back by the older tail

    // Detail loader: every linked entry comes back, in display order, none hidden.
    const detail = await loadTagDetail(W.superadmin.client, bigTag)
    expect(detail.error).toBeNull()
    expect(detail.entries).toHaveLength(COUNT)
    expect(detail.hiddenEntryCount).toBe(0)
    expect(new Set(detail.entries.map((e) => e.id)).size).toBe(COUNT)
    expect(detail.costs.reduce((sum, c) => sum + c.cost, 0)).toBe(COUNT) // 1.00 each, none voided

    // The start-event warning sees the entries on page 2 of the links: only the OLD_TAIL
    // ones are older than evMid, and they are the last ids.
    const base = { tagId: bigTag, name: NAME('big'), description: null, endEventId: null }
    const warned = await updateTag({ ...base, startEventId: W.evMid.id })
    expect(warned.ok).toBe(false)
    expect('startEventWarning' in warned && warned.startEventWarning.entryCount).toBe(OLD_TAIL)
    expect((await tagRow(bigTag))?.start_event_id).toBe(W.evOld.id) // not saved
    expect(await updateTag({ ...base, startEventId: W.evMid.id, confirmStartAfterEntries: true })).toEqual({ ok: true })
  })
})
