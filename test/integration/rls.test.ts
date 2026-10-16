/**
 * Live RLS suite — MASTER-PLAN §11.1 Day 7 exit ("RLS suite as three users"), §4.1–§4.4c,
 * updated for the superadmin/admin/dept role model (20260819000003_role_rbac_v2.sql).
 *
 * This runs against the REAL Supabase project (there is only one, dev + prod, §2), so
 * every rule below is a safety rule, not a style preference:
 *
 *   1. Every row this file writes is created by this file, tagged `rls-test-<runId>`,
 *      recorded in the LEDGER, and deleted by its exact primary key in `finally` /
 *      `afterAll`. No test ever writes to, updates, or deletes a row it did not create.
 *   2. `del()` refuses to issue a DELETE with an empty id list — an unfiltered or
 *      accidentally-empty delete cannot be expressed through it.
 *   3. Pre-existing `entries`, `staff_profile`, `department`, `vendor` and `auth.users`
 *      rows are read-only here, and are never even matched: assertions filter by the
 *      fixture ids/department ids created in the same test.
 *   4. Fixture departments are brand new, so a "dept user scoped to department A" in this
 *      suite can see no production data at all, whatever the policies say.
 *
 * The three roles under the current model are `superadmin` (full access, including user
 * management), `admin` (every cross-department action EXCEPT user management — genuinely
 * new/distinct capability vs. the old model, where only the single top role had breadth),
 * and `dept` (create + view entries in one or more assigned departments only; every
 * verify/attach/resolve/bulk-edit capability the old `reviewer` role additionally had is
 * now admin/superadmin-only). `staff_department` is a new junction table: a `dept` user
 * may hold zero, one, or multiple department rows simultaneously; `admin`/`superadmin`
 * hold none — their breadth comes from the role itself via `private.is_admin_or_above()`.
 * A fourth, deactivated staff user (role `dept`) is created only by the tests that need
 * one.
 *
 * Source of truth for expected behaviour is the migrations, not the plan's snippets:
 *   supabase/migrations/20260808000026_rls_policies.sql   (table policies + grants)
 *   supabase/migrations/20260808000027_storage_policies.sql
 *   supabase/migrations/20260811000003_entries_restructure.sql (current `entries` shape)
 *   supabase/migrations/20260811000004_reporting_views_update.sql (security_invoker views)
 *   supabase/migrations/20260819000002_manual_entries.sql (entries_insert)
 *   supabase/migrations/20260819000003_role_rbac_v2.sql (the superadmin/admin/dept split)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client as PgClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!

if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
  throw new Error(
    'RLS integration suite needs NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY. ' +
      'Copy .env to the repo root and run `npm run test:rls`.'
  )
}

const BUCKET = 'invoice-documents'
const TAG = 'rls-test'
/** Unique per `npm run test:rls` invocation, so two concurrent runs cannot collide. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Service-role client — bypasses RLS (§4.5). Used ONLY to build and tear down fixtures
 *  and to verify ground truth after a policy-gated write. Never used to assert a policy. */
const svc = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ---------------------------------------------------------------------------
// Cleanup ledger — everything this file ever creates, so afterAll can prove it is gone
// ---------------------------------------------------------------------------
const LEDGER = {
  entries: [] as number[],
  departments: [] as number[],
  zones: [] as number[],
  heads: [] as number[],
  vendors: [] as number[],
  jobs: [] as number[],
  users: [] as string[],
  objects: [] as string[],
  // [security-audit 2026-10-15] additions
  events: [] as number[],
  exceptions: [] as number[],
  flags: [] as number[],
  scrapeTokens: [] as number[],
  authAttempts: [] as number[],
  apiLogs: [] as number[],
  boardPacks: [] as number[],
  importBatches: [] as number[],
  statusBatches: [] as number[],
  /** Paths inside the `board-packs` bucket (BUCKET above is invoice-documents). */
  boardPackObjects: [] as string[],
  sourceDocuments: [] as number[],
}

/**
 * `entries.event_id` and `source_document.event_id` are NOT NULL (event scoping,
 * 20260822000005). Event rows are pre-existing production data — read-only here,
 * same as staff/department/vendor — so fixtures BORROW the current event's id
 * rather than creating one (an `event` insert would have to reason about the
 * `is_current` partial-unique index). Assertions never filter by event, so which
 * event the fixture rows sit in is immaterial to every test.
 */
let _eventIdPromise: Promise<number> | undefined
async function getEventId(): Promise<number> {
  if (!_eventIdPromise) {
    _eventIdPromise = (async () => {
      const { data, error } = await svc
        .from('event')
        .select('id')
        .order('is_current', { ascending: false })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (error || !data) {
        throw new Error(`getEventId: no event row to borrow (${error?.message ?? 'empty'})`)
      }
      return data.id as number
    })()
  }
  return _eventIdPromise
}

/** Delete by exact primary key only. An empty id list is a no-op, never a bare DELETE. */
async function del(table: string, ids: Array<number | string>) {
  if (ids.length === 0) return
  if (table === 'source_document') {
    // document_extraction_line_item.document_page_id -> document_page is NO ACTION, so a bare
    // delete of a document that has line items fails (the delete_source_document RPC clears the
    // line items first for the same reason). Do the same here, by exact page ids.
    const { data: pages, error: pagesError } = await svc.from('document_page').select('id').in('source_document_id', ids)
    if (pagesError) throw new Error(`cleanup document_page lookup [${ids.join(',')}]: ${pagesError.message}`)
    const pageIds = (pages ?? []).map((p) => p.id as number)
    if (pageIds.length > 0) {
      const { error: liError } = await svc.from('document_extraction_line_item').delete().in('document_page_id', pageIds)
      if (liError) throw new Error(`cleanup line items of pages [${pageIds.join(',')}]: ${liError.message}`)
    }
  }
  const { error } = await svc.from(table).delete().in('id', ids)
  if (error) throw new Error(`cleanup ${table} [${ids.join(',')}]: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
type Fixture = {
  suffix: string
  deptA: number
  deptB: number
  entryA: number
  entryB: number
  superadminUser: FixtureUser
  adminUser: FixtureUser
  deptUser: FixtureUser
  inactive?: FixtureUser
  /** Storage paths created during the test, removed on cleanup. */
  objects: string[]
  /** source_document ids created via `insertBill` during the test. Cascade-deleted
   *  (bills, entry_bill_link, ...) on cleanup. */
  sourceDocuments: number[]
  /** Create a source_document + one bill inside this fixture's lifecycle. */
  makeBill: () => Promise<{ sourceDocumentId: number; billId: number }>
  cleanup: () => Promise<void>
}

type FixtureUser = { id: string; email: string; client: SupabaseClient }

/**
 * GoTrue rate-limits `admin.createUser` and `signInWithPassword` on a short
 * window. Each fixture makes 3-4 users, so a full run does ~70 auth calls in a
 * minute — enough to trip a 429. Retry those two calls (only) with backoff;
 * everything else fails fast as before.
 */
async function withAuthRetry<T extends { error: { message: string; status?: number } | null }>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const delays = [1500, 3000, 6000, 12000, 20000]
  for (let attempt = 0; ; attempt++) {
    let res: T
    try {
      res = await fn()
    } catch (e) {
      // A thrown `fetch failed` (transient GoTrue network blip) is retried the
      // same way a returned 429 is; anything else rethrows immediately.
      if (attempt >= delays.length || !/fetch failed|ETIMEDOUT|ECONNRESET|network/i.test(String(e))) {
        throw e
      }
      await new Promise((r) => setTimeout(r, delays[attempt]))
      continue
    }
    const msg = res.error?.message ?? ''
    const retryable =
      !!res.error && (res.error.status === 429 || /rate limit|fetch failed/i.test(msg))
    if (!retryable || attempt >= delays.length) return res
    await new Promise((r) => setTimeout(r, delays[attempt]))
  }
}

async function makeUser(
  suffix: string,
  label: string,
  role: 'superadmin' | 'admin' | 'dept',
  departmentIds: number[],
  isActive: boolean
): Promise<FixtureUser> {
  const email = `${TAG}-${label}-${suffix}@rls-test.example.com`
  const password = `Rls!${RUN_ID}${Math.random().toString(36).slice(2, 10)}`

  const { data, error } = await withAuthRetry(`createUser(${label})`, () =>
    svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `${TAG} ${label} ${suffix}` },
    })
  )
  if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message}`)
  const id = data.user.id
  LEDGER.users.push(id)

  // `private.handle_new_user()` lands the profile as dept/inactive by default
  // (20260819000003_role_rbac_v2.sql §5). Set the role/active state explicitly by exact
  // id rather than relying on user_metadata plumbing, so the test's premise is never in
  // doubt. its_number is deliberately left NULL — the 8-digit ITS namespace is real
  // identity data and this suite must not squat on a value in it.
  const { error: upErr } = await svc
    .from('staff_profile')
    .update({ role, is_active: isActive })
    .eq('id', id)
  if (upErr) throw new Error(`staff_profile setup(${label}): ${upErr.message}`)

  // department_id no longer lives on staff_profile — department membership is now the
  // staff_department junction table, and a dept user may hold zero, one, or several rows.
  // Written via the service-role client (bypasses RLS), same as the rest of fixture setup.
  if (departmentIds.length > 0) {
    const { error: sdErr } = await svc
      .from('staff_department')
      .insert(departmentIds.map((department_id) => ({ staff_id: id, department_id })))
    if (sdErr) throw new Error(`staff_department setup(${label}): ${sdErr.message}`)
  }

  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await withAuthRetry(`signIn(${label})`, () =>
    client.auth.signInWithPassword({ email, password })
  )
  if (signInErr) throw new Error(`signIn(${label}): ${signInErr.message}`)

  return { id, email, client }
}

async function insertDepartment(suffix: string, letter: string): Promise<number> {
  const { data, error } = await svc
    .from('department')
    .insert({ name: `${TAG}-dept-${letter}-${suffix}`, external_code: `${TAG}-${letter}-${suffix}` })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert department ${letter}: ${error?.message}`)
  LEDGER.departments.push(data.id)
  return data.id
}

async function insertEntry(suffix: string, letter: string, departmentId: number): Promise<number> {
  const { data, error } = await svc
    .from('entries')
    .insert({
      ubbl_number: `${TAG}-${suffix}-${letter}`,
      department_id: departmentId,
      event_id: await getEventId(),
      type: 'invoice',
      source: 'manual',
      amount: letter === 'a' ? '111.11' : '222.22',
      vendor_raw: `${TAG} vendor ${letter}`,
      // main_number left null on purpose: that is what puts these rows into
      // v_department_audit_variance for the security_invoker check below.
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert entry ${letter}: ${error?.message}`)
  LEDGER.entries.push(data.id)
  return data.id
}

/** A source_document + one bill (document_extraction). Everything hanging off the
 *  source_document row — bills, entry_bill_link, reconciliation_exception, ... —
 *  is `on delete cascade`, so cleanup only has to delete the source_document. */
async function insertBill(
  suffix: string,
  tracker: number[]
): Promise<{ sourceDocumentId: number; billId: number }> {
  const { data: sd, error: sdErr } = await svc
    .from('source_document')
    .insert({
      event_id: await getEventId(),
      storage_path: `${TAG}/${suffix}/doc.pdf`,
      original_filename: `${TAG}-${suffix}.pdf`,
      file_hash_sha256: `${TAG}${suffix}`.padEnd(64, '0').slice(0, 64),
      mime_type: 'application/pdf',
    })
    .select('id')
    .single()
  if (sdErr || !sd) throw new Error(`insert source_document: ${sdErr?.message}`)
  tracker.push(sd.id)
  LEDGER.sourceDocuments.push(sd.id)

  const { data: bill, error: billErr } = await svc
    .from('document_extraction')
    .insert({ source_document_id: sd.id, bill_index: 0, total_amount_ocr: '333.33' })
    .select('id')
    .single()
  if (billErr || !bill) throw new Error(`insert document_extraction: ${billErr?.message}`)
  return { sourceDocumentId: sd.id as number, billId: bill.id as number }
}

/**
 * Builds a complete, self-contained world for ONE test and tears it down afterwards.
 * Nothing is shared between tests — every test that calls this gets its own departments,
 * entries and users, so tests can be re-run and reordered freely.
 */
async function withFixture(
  opts: { inactive?: boolean },
  run: (fx: Fixture) => Promise<void>
): Promise<void> {
  const suffix = `${RUN_ID}${Math.random().toString(36).slice(2, 6)}`
  const objects: string[] = []
  let fx: Fixture | undefined

  const created = {
    entries: [] as number[],
    departments: [] as number[],
    users: [] as string[],
    sourceDocuments: [] as number[],
  }

  const cleanup = async () => {
    const problems: string[] = []
    // Order matters: storage objects, then entries (entry_change_log cascades and
    // entries.updated_by references auth.users), then staff_profile, then auth users,
    // then the now-unreferenced departments. staff_department rows are NOT deleted
    // explicitly here — the table's staff_id FK is `references staff_profile(id) on
    // delete cascade` (20260819000003 §1), so deleting the staff_profile row below
    // cascades them away automatically; adding an explicit delete step would be redundant.
    if (objects.length > 0) {
      const { error } = await svc.storage.from(BUCKET).remove(objects)
      if (error) problems.push(`storage: ${error.message}`)
    }
    for (const step of [
      // source_document first: entry_bill_link / document_extraction / ... all
      // cascade from it, so this clears the bill side before the entries go.
      () => del('source_document', created.sourceDocuments),
      () => del('entries', created.entries),
      async () => {
        if (created.users.length === 0) return
        const { error } = await svc.from('staff_profile').delete().in('id', created.users)
        if (error) throw new Error(`staff_profile: ${error.message}`)
      },
      async () => {
        for (const id of created.users) {
          const { error } = await withAuthRetry(`deleteUser(${id})`, () =>
            svc.auth.admin.deleteUser(id)
          )
          if (error) throw new Error(`auth user ${id}: ${error.message}`)
        }
      },
      () => del('department', created.departments),
    ]) {
      try {
        await step()
      } catch (e) {
        problems.push((e as Error).message)
      }
    }
    if (problems.length > 0) throw new Error(`fixture cleanup failed: ${problems.join(' | ')}`)
  }

  try {
    const deptA = await insertDepartment(suffix, 'a')
    created.departments.push(deptA)
    const deptB = await insertDepartment(suffix, 'b')
    created.departments.push(deptB)

    const entryA = await insertEntry(suffix, 'a', deptA)
    created.entries.push(entryA)
    const entryB = await insertEntry(suffix, 'b', deptB)
    created.entries.push(entryB)

    const superadminUser = await makeUser(suffix, 'superadmin', 'superadmin', [], true)
    created.users.push(superadminUser.id)
    const adminUser = await makeUser(suffix, 'admin', 'admin', [], true)
    created.users.push(adminUser.id)
    const deptUser = await makeUser(suffix, 'dept', 'dept', [deptA], true)
    created.users.push(deptUser.id)

    let inactive: FixtureUser | undefined
    if (opts.inactive) {
      inactive = await makeUser(suffix, 'inactive', 'dept', [deptA], false)
      created.users.push(inactive.id)
    }

    fx = {
      suffix,
      deptA,
      deptB,
      entryA,
      entryB,
      superadminUser,
      adminUser,
      deptUser,
      inactive,
      objects,
      sourceDocuments: created.sourceDocuments,
      makeBill: () => insertBill(suffix, created.sourceDocuments),
      cleanup,
    }
    await run(fx)
  } finally {
    // Sign out every session before the accounts disappear.
    for (const u of [fx?.superadminUser, fx?.adminUser, fx?.deptUser, fx?.inactive]) {
      if (u) await u.client.auth.signOut().catch(() => {})
    }
    await cleanup()
  }
}

/** Ground truth, read with the service role (RLS bypassed) — used to prove that a write
 *  a policy was supposed to block really did not land. */
async function readEntry(id: number) {
  const { data, error } = await svc
    .from('entries')
    .select('id,department_id,remark,is_void,amount')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`readEntry(${id}): ${error.message}`)
  return data
}

const ids = (rows: Array<{ id: number }> | null) => (rows ?? []).map((r) => r.id).sort()
/** Same shape as `ids`, for the two entries type-detail tables (20260827000001) whose
 *  primary key is `entry_id`, not `id`. */
const entryIds = (rows: Array<{ entry_id: number }> | null) =>
  (rows ?? []).map((r) => r.entry_id).sort()

// ===========================================================================
describe('RLS as three users (superadmin / admin / dept)', () => {
  // -------------------------------------------------------------------------
  // 1. Department scoping on `entries` — §4.2 entries_select, updated by role_rbac_v2
  // -------------------------------------------------------------------------
  it('scopes entries SELECT to the caller department; admin/superadmin see across departments', async () => {
    await withFixture({}, async (fx) => {
      const scope = (c: SupabaseClient) =>
        c.from('entries').select('id,department_id').in('department_id', [fx.deptA, fx.deptB])

      const dept = await scope(fx.deptUser.client)
      expect(dept.error).toBeNull()
      expect(ids(dept.data)).toEqual([fx.entryA])

      // admin/superadmin breadth now comes from the role itself, via
      // private.is_admin_or_above() short-circuiting can_see_department() — not from a
      // null department_id (that column is gone) or an "all departments" row.
      const admin = await scope(fx.adminUser.client)
      expect(admin.error).toBeNull()
      expect(ids(admin.data)).toEqual([fx.entryA, fx.entryB].sort())

      const superadmin = await scope(fx.superadminUser.client)
      expect(superadmin.error).toBeNull()
      expect(ids(superadmin.data)).toEqual([fx.entryA, fx.entryB].sort())

      // Targeting department B's row directly must also return nothing, not an error —
      // a filtered-out row is indistinguishable from a non-existent one.
      const direct = await fx.deptUser.client.from('entries').select('id').eq('id', fx.entryB)
      expect(direct.error).toBeNull()
      expect(direct.data).toEqual([])
    })
  })

  it('lets a dept user assigned to multiple departments see rows in both, but not a third', async () => {
    await withFixture({}, async (fx) => {
      // Standalone department + entry + user, built and torn down within this test only
      // (same one-off-row pattern the vendor/zone/job_queue tests below use), since a
      // multi-department dept user has no place in the standard three-user fixture.
      const deptC = await insertDepartment(fx.suffix, 'c')
      const entryC = await insertEntry(fx.suffix, 'c', deptC)
      const deptAB = await makeUser(fx.suffix, 'dept-ab', 'dept', [fx.deptA, fx.deptB], true)

      try {
        const seen = await deptAB.client
          .from('entries')
          .select('id,department_id')
          .in('department_id', [fx.deptA, fx.deptB, deptC])
        expect(seen.error).toBeNull()
        expect(ids(seen.data)).toEqual([fx.entryA, fx.entryB].sort())

        // Direct lookup on the third department's row confirms it, not a coincidence of
        // the .in() filter.
        const direct = await deptAB.client.from('entries').select('id').eq('id', entryC)
        expect(direct.error).toBeNull()
        expect(direct.data).toEqual([])
      } finally {
        await deptAB.client.auth.signOut().catch(() => {})
        await del('entries', [entryC])
        LEDGER.entries = LEDGER.entries.filter((e) => e !== entryC)
        await svc.from('staff_profile').delete().eq('id', deptAB.id)
        await svc.auth.admin.deleteUser(deptAB.id)
        LEDGER.users = LEDGER.users.filter((u) => u !== deptAB.id)
        await del('department', [deptC])
        LEDGER.departments = LEDGER.departments.filter((d) => d !== deptC)
      }
    })
  })

  // -------------------------------------------------------------------------
  // 2. Role enforcement on writes — §4.2 entries_update, updated by role_rbac_v2 §6b
  // -------------------------------------------------------------------------
  it('enforces role on entries UPDATE: dept has none, admin and superadmin have both', async () => {
    await withFixture({}, async (fx) => {
      // dept: is_admin_or_above() fails -> USING fails -> zero rows matched, even for
      // its own department. This is the confirmed "view + create only" restriction —
      // dept behaves like the OLD viewer did, for every department including its own.
      const deptOwn = await fx.deptUser.client
        .from('entries')
        .update({ remark: 'dept-should-not-land' })
        .eq('id', fx.entryA)
        .select('id')
      expect(deptOwn.error).toBeNull()
      expect(deptOwn.data).toEqual([])
      expect((await readEntry(fx.entryA))?.remark).toBeNull()

      const deptOther = await fx.deptUser.client
        .from('entries')
        .update({ remark: 'dept-cross-department-should-not-land' })
        .eq('id', fx.entryB)
        .select('id')
      expect(deptOther.error).toBeNull()
      expect(deptOther.data).toEqual([])
      expect((await readEntry(fx.entryB))?.remark).toBeNull()

      // admin: across departments — genuinely new/different from the old model, where
      // only the single top role had this.
      const adminA = await fx.adminUser.client
        .from('entries')
        .update({ remark: `${TAG}-admin-a` })
        .eq('id', fx.entryA)
        .select('id')
      expect(adminA.error).toBeNull()
      expect(ids(adminA.data)).toEqual([fx.entryA])
      expect((await readEntry(fx.entryA))?.remark).toBe(`${TAG}-admin-a`)

      const adminB = await fx.adminUser.client
        .from('entries')
        .update({ remark: `${TAG}-admin-b` })
        .eq('id', fx.entryB)
        .select('id')
      expect(adminB.error).toBeNull()
      expect(ids(adminB.data)).toEqual([fx.entryB])

      // superadmin: across departments too.
      const superA = await fx.superadminUser.client
        .from('entries')
        .update({ remark: `${TAG}-superadmin-a` })
        .eq('id', fx.entryA)
        .select('id')
      expect(superA.error).toBeNull()
      expect(ids(superA.data)).toEqual([fx.entryA])
      expect((await readEntry(fx.entryA))?.remark).toBe(`${TAG}-superadmin-a`)

      const superB = await fx.superadminUser.client
        .from('entries')
        .update({ remark: `${TAG}-superadmin-b` })
        .eq('id', fx.entryB)
        .select('id')
      expect(superB.error).toBeNull()
      expect(ids(superB.data)).toEqual([fx.entryB])
      expect((await readEntry(fx.entryB))?.remark).toBe(`${TAG}-superadmin-b`)
    })
  })

  // NOTE on the old "blocks a reviewer from moving a row out of their department"
  // (entries_update WITH CHECK) test: under the new model there is no actor left for
  // whom that scenario is even reachable. can_see_department(dept_id) for admin/superadmin
  // short-circuits true via is_admin_or_above() *for any dept_id* — their department
  // reach is role-wide, not scoped — while the one role that IS department-scoped
  // (dept) has zero entries_update access at all (blocked by USING before WITH CHECK is
  // ever evaluated, per the test above). So there is no role that both (a) can update a
  // row and (b) is restricted to a specific department by can_see_department. The WITH
  // CHECK clause still runs, it just never actually restricts anyone under this model.
  // This test documents that resulting (confirmed, intentional) behaviour instead of an
  // anti-escalation boundary, since the boundary itself no longer has a subject.
  it('lets admin and superadmin move an entries row across departments (their reach is role-wide, not department-scoped)', async () => {
    await withFixture({}, async (fx) => {
      const movedByAdmin = await fx.adminUser.client
        .from('entries')
        .update({ department_id: fx.deptB })
        .eq('id', fx.entryA)
        .select('id')
      expect(movedByAdmin.error).toBeNull()
      expect(ids(movedByAdmin.data)).toEqual([fx.entryA])
      expect((await readEntry(fx.entryA))?.department_id).toBe(fx.deptB)

      const movedBack = await fx.superadminUser.client
        .from('entries')
        .update({ department_id: fx.deptA })
        .eq('id', fx.entryA)
        .select('id')
      expect(movedBack.error).toBeNull()
      expect(ids(movedBack.data)).toEqual([fx.entryA])
      expect((await readEntry(fx.entryA))?.department_id).toBe(fx.deptA)
    })
  })

  // -------------------------------------------------------------------------
  // 3. No delete policy anywhere — §4.2, §4.4d
  // -------------------------------------------------------------------------
  it('rejects entries DELETE for every role — loudly, not as a silent no-op', async () => {
    await withFixture({}, async (fx) => {
      for (const [label, user] of [
        ['dept', fx.deptUser],
        ['admin', fx.adminUser],
        ['superadmin', fx.superadminUser],
      ] as const) {
        const res = await user.client.from('entries').delete().eq('id', fx.entryA).select('id')
        // `revoke delete on all tables ... from authenticated` (end of
        // 20260808000026) makes this a hard privilege error rather than
        // "no policy matched, zero rows affected". That distinction is the point:
        // a future accidental delete policy fails loudly instead of going live.
        expect(res.error, `${label} delete should error`).not.toBeNull()
        expect(res.error?.code, `${label} delete code`).toBe('42501')
        expect(res.error?.message ?? '').toMatch(/permission denied|row-level security/i)
        expect(await readEntry(fx.entryA), `${label}: row must survive`).not.toBeNull()
      }
    })
  })

  // -------------------------------------------------------------------------
  // entries_insert — role_rbac_v2 §6a repoints this at is_staff(), so dept/admin/
  // superadmin can all insert, scoped by can_see_department.
  // -------------------------------------------------------------------------
  it('lets dept/admin/superadmin insert manual entries scoped to a department they can see', async () => {
    await withFixture({}, async (fx) => {
      const inserted: number[] = []
      const track = (id: number) => {
        inserted.push(id)
        LEDGER.entries.push(id)
      }

      try {
        const deptIns = await fx.deptUser.client
          .from('entries')
          .insert({
            ubbl_number: `${TAG}-${fx.suffix}-insert-dept`,
            event_id: await getEventId(),
            department_id: fx.deptA,
            source: 'manual',
            amount: '1.00',
          })
          .select('id')
        expect(deptIns.error).toBeNull()
        expect((deptIns.data ?? []).length).toBe(1)
        if (deptIns.data?.[0]) track(deptIns.data[0].id)

        const adminIns = await fx.adminUser.client
          .from('entries')
          .insert({
            ubbl_number: `${TAG}-${fx.suffix}-insert-admin`,
            event_id: await getEventId(),
            department_id: fx.deptB,
            source: 'manual',
            amount: '1.00',
          })
          .select('id')
        expect(adminIns.error).toBeNull()
        expect((adminIns.data ?? []).length).toBe(1)
        if (adminIns.data?.[0]) track(adminIns.data[0].id)

        const superIns = await fx.superadminUser.client
          .from('entries')
          .insert({
            ubbl_number: `${TAG}-${fx.suffix}-insert-superadmin`,
            event_id: await getEventId(),
            department_id: fx.deptA,
            source: 'manual',
            amount: '1.00',
          })
          .select('id')
        expect(superIns.error).toBeNull()
        expect((superIns.data ?? []).length).toBe(1)
        if (superIns.data?.[0]) track(superIns.data[0].id)
      } finally {
        await del('entries', inserted)
        LEDGER.entries = LEDGER.entries.filter((e) => !inserted.includes(e))
      }
    })
  })

  it('blocks a dept user from inserting into a department they are not assigned to (can_see_department)', async () => {
    await withFixture({}, async (fx) => {
      const res = await fx.deptUser.client
        .from('entries')
        .insert({
          ubbl_number: `${TAG}-${fx.suffix}-insert-dept-other`,
          event_id: await getEventId(),
          department_id: fx.deptB,
          source: 'manual',
          amount: '1.00',
        })
        .select('id')
      expect(res.error).not.toBeNull()
      expect(res.error?.code).toBe('42501')

      const { data } = await svc
        .from('entries')
        .select('id')
        .like('ubbl_number', `${TAG}-${fx.suffix}-insert-dept-other%`)
      expect(data).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 4. Storage bucket policies -- security audit H1 (2026-10-15): the bucket is now
  //    reachable ONLY through the service role (signed upload/read URLs are issued by
  //    server code). No signed-in role may list, download, upload, replace or delete
  //    objects directly, and anon never could. Migration:
  //    20261015100000_security_critical_fixes.sql (drops the four storage.objects policies
  //    from 20260808000027 and sets the bucket's size + MIME limits).
  // -------------------------------------------------------------------------
  it('locks invoice-documents to the service role: no direct storage access for any signed-in role', async () => {
    await withFixture({ inactive: true }, async (fx) => {
      const path = `${TAG}/${fx.suffix}/invoice.pdf`
      fx.objects.push(path)
      LEDGER.objects.push(path)

      // The bucket only accepts application/pdf once the H1 migration is live, so the
      // seed (and every attempted write below) declares that type. Content is a tiny
      // fake PDF -- storage checks the declared type, not the bytes.
      const pdf = (label: string) =>
        new Blob([`%PDF-1.4\n% ${TAG} ${label}`], { type: 'application/pdf' })
      const store = (c: SupabaseClient) => c.storage.from(BUCKET)

      // Seed through the service role -- the only path the app itself uses.
      const seed = await svc.storage.from(BUCKET).upload(path, pdf('v1'), { contentType: 'application/pdf' })
      expect(seed.error, `service-role seed: ${seed.error?.message}`).toBeNull()

      const stillV1 = async () => {
        const got = await svc.storage.from(BUCKET).download(path)
        expect(got.error, 'object must still exist').toBeNull()
        expect(await got.data?.text()).toContain(`${TAG} v1`)
      }

      const roles: Array<[string, SupabaseClient]> = [
        ['dept', fx.deptUser.client],
        ['admin', fx.adminUser.client],
        ['superadmin', fx.superadminUser.client],
        ['deactivated staff', fx.inactive!.client],
      ]

      for (const [label, client] of roles) {
        // select: download is denied and list shows nothing (RLS filters rather than errors).
        expect((await store(client).download(path)).error, `${label} must not download`).not.toBeNull()
        const listed = await store(client).list(`${TAG}/${fx.suffix}`)
        expect(listed.data ?? [], `${label} must not list objects`).toEqual([])

        // insert: a brand-new object is refused.
        const newPath = `${TAG}/${fx.suffix}/new-${label.replace(/\s+/g, '-')}.pdf`
        fx.objects.push(newPath)
        LEDGER.objects.push(newPath)
        const ins = await store(client).upload(newPath, pdf(`new ${label}`), { contentType: 'application/pdf' })
        expect(ins.error, `${label} must not upload`).not.toBeNull()

        // update: replacing an existing object (upsert needs INSERT + UPDATE) is refused,
        // and the original bytes survive.
        const rep = await store(client).upload(path, pdf(`replace ${label}`), {
          contentType: 'application/pdf',
          upsert: true,
        })
        expect(rep.error, `${label} must not replace`).not.toBeNull()
        await stillV1()

        // delete: the storage API answers a blocked remove with an empty result rather
        // than an error, so the real assertion is that the object survives. Includes
        // admin and superadmin -- the "admins delete documents" policy is gone too; the
        // app deletes through the service role (lib/storage.ts deleteDocument).
        await store(client).remove([path])
        await stillV1()
      }

      // An unauthenticated caller gets nothing either.
      const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      expect((await anon.storage.from(BUCKET).download(path)).error).not.toBeNull()
      expect((await anon.storage.from(BUCKET).list(`${TAG}/${fx.suffix}`)).data ?? []).toEqual([])
      const anonUp = await anon.storage
        .from(BUCKET)
        .upload(`${TAG}/${fx.suffix}/anon.pdf`, pdf('anon'), { contentType: 'application/pdf' })
      expect(anonUp.error).not.toBeNull()
      await anon.storage.from(BUCKET).remove([path])
      await stillV1()

      // The service role still has full control (this is what signed URLs and
      // lib/storage.ts rely on): it can replace and delete.
      const svcReplace = await svc.storage.from(BUCKET).upload(path, pdf('v2'), {
        contentType: 'application/pdf',
        upsert: true,
      })
      expect(svcReplace.error, `service-role replace: ${svcReplace.error?.message}`).toBeNull()
      const svcRemove = await svc.storage.from(BUCKET).remove([path])
      expect(svcRemove.error).toBeNull()
      expect((await svc.storage.from(BUCKET).download(path)).error).not.toBeNull()

      // Nothing left for cleanup to chase, but the paths stay registered anyway.
      const stray = await svc.storage.from(BUCKET).list(`${TAG}/${fx.suffix}`)
      expect(stray.data ?? []).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 5. security_invoker reporting views — §4.4
  // -------------------------------------------------------------------------
  it('keeps security_invoker reporting views department-scoped for a dept user', async () => {
    await withFixture({}, async (fx) => {
      // v_entry_enriched — the join every other view builds on.
      const enriched = await fx.deptUser.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(enriched.error).toBeNull()
      expect(ids(enriched.data)).toEqual([fx.entryA])

      // v_department_audit_variance — both fixture entries qualify (main_number null,
      // not void), so anything other than [entryA] here is a genuine leak.
      const variance = await fx.deptUser.client
        .from('v_department_audit_variance')
        .select('entry_id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(variance.error).toBeNull()
      expect((variance.data ?? []).map((r) => r.entry_id).sort()).toEqual([fx.entryA])

      // Admin and superadmin see both through the same view.
      const adminView = await fx.adminUser.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(ids(adminView.data)).toEqual([fx.entryA, fx.entryB].sort())

      const superadminView = await fx.superadminUser.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(ids(superadminView.data)).toEqual([fx.entryA, fx.entryB].sort())
    })
  })

  // -------------------------------------------------------------------------
  // 6. Everything else in 20260808000026 that the brief did not name
  // -------------------------------------------------------------------------
  it('lets staff read only their own staff_profile and blocks a dept user from escalating role/is_active', async () => {
    await withFixture({}, async (fx) => {
      const all = [fx.superadminUser.id, fx.adminUser.id, fx.deptUser.id]

      const own = await fx.deptUser.client.from('staff_profile').select('id,role').in('id', all)
      expect(own.error).toBeNull()
      expect((own.data ?? []).map((r) => r.id)).toEqual([fx.deptUser.id])

      const asAdmin = await fx.adminUser.client.from('staff_profile').select('id').in('id', all)
      expect((asAdmin.data ?? []).map((r) => r.id).sort()).toEqual([...all].sort())

      const asSuperadmin = await fx.superadminUser.client
        .from('staff_profile')
        .select('id')
        .in('id', all)
      expect((asSuperadmin.data ?? []).map((r) => r.id).sort()).toEqual([...all].sort())

      // A dept user may edit their own row...
      const rename = await fx.deptUser.client
        .from('staff_profile')
        .update({ display_name: `${TAG}-renamed` })
        .eq('id', fx.deptUser.id)
        .select('id')
      expect(rename.error).toBeNull()
      expect((rename.data ?? []).length).toBe(1)

      // ...but not the locked columns. staff_profile.department_id is gone entirely —
      // the locked set is now just (role, is_active). This is §4.4c ("manage users,
      // roles, department assignment" is admin-only) enforced in the database, not just
      // hidden in the UI.
      for (const patch of [
        { role: 'admin' },
        { role: 'superadmin' },
        { is_active: false },
        { is_active: true, role: 'admin' },
      ]) {
        const esc = await fx.deptUser.client
          .from('staff_profile')
          .update(patch)
          .eq('id', fx.deptUser.id)
          .select('id')
        expect(esc.error, `escalation via ${JSON.stringify(patch)} must fail`).not.toBeNull()
        expect(esc.error?.code).toBe('42501')
      }

      const { data: stored } = await svc
        .from('staff_profile')
        .select('role,is_active')
        .eq('id', fx.deptUser.id)
        .single()
      expect(stored).toMatchObject({ role: 'dept', is_active: true })
    })
  })

  // This is the core new boundary the whole migration exists to enforce, so it gets its
  // own dedicated test rather than living inline in the escalation test above.
  it('blocks admin from escalating itself to superadmin and from editing any other staff row at all', async () => {
    await withFixture({}, async (fx) => {
      // admin cannot promote itself.
      const selfEscalate = await fx.adminUser.client
        .from('staff_profile')
        .update({ role: 'superadmin' })
        .eq('id', fx.adminUser.id)
        .select('id')
      expect(selfEscalate.error).not.toBeNull()
      expect(selfEscalate.error?.code).toBe('42501')

      // admin can still rename itself (a non-locked field) — same shape as any staff
      // member editing their own row.
      const selfRename = await fx.adminUser.client
        .from('staff_profile')
        .update({ display_name: `${TAG}-admin-renamed` })
        .eq('id', fx.adminUser.id)
        .select('id')
      expect(selfRename.error).toBeNull()
      expect((selfRename.data ?? []).length).toBe(1)

      // admin cannot touch another user's row at all — not even a non-role field.
      // staff_profile_update's USING clause is `id = auth.uid() or is_superadmin()`
      // (pinned, NOT the widened is_admin() alias); admin is neither for someone else's
      // row, so zero rows match — this is a USING-level exclusion, not just the
      // locked-field WITH CHECK failing.
      const otherRename = await fx.adminUser.client
        .from('staff_profile')
        .update({ display_name: `${TAG}-should-not-land` })
        .eq('id', fx.deptUser.id)
        .select('id')
      expect(otherRename.error).toBeNull()
      expect(otherRename.data).toEqual([])
      const { data: deptStored } = await svc
        .from('staff_profile')
        .select('display_name')
        .eq('id', fx.deptUser.id)
        .single()
      expect(deptStored?.display_name).not.toBe(`${TAG}-should-not-land`)

      const otherEscalate = await fx.adminUser.client
        .from('staff_profile')
        .update({ role: 'superadmin', is_active: false })
        .eq('id', fx.deptUser.id)
        .select('id')
      expect(otherEscalate.error).toBeNull()
      expect(otherEscalate.data).toEqual([])

      // superadmin CAN edit another user's role/is_active — the actual, intended
      // user-management capability.
      const superEdits = await fx.superadminUser.client
        .from('staff_profile')
        .update({ role: 'admin', is_active: false })
        .eq('id', fx.deptUser.id)
        .select('id')
      expect(superEdits.error).toBeNull()
      expect((superEdits.data ?? []).map((r) => r.id)).toEqual([fx.deptUser.id])
      const { data: afterSuper } = await svc
        .from('staff_profile')
        .select('role,is_active')
        .eq('id', fx.deptUser.id)
        .single()
      expect(afterSuper).toMatchObject({ role: 'admin', is_active: false })
    })
  })

  // -------------------------------------------------------------------------
  // staff_department — new junction table, no equivalent in the old suite.
  // -------------------------------------------------------------------------
  it('exposes staff_department correctly: staff read own rows, admin/superadmin read all, only superadmin writes', async () => {
    await withFixture({}, async (fx) => {
      // fx.deptUser already has exactly one staff_department row (deptA). Build a second
      // dept user scoped to deptB so there is "another user's" row to prove invisible.
      const dept2 = await makeUser(fx.suffix, 'dept2', 'dept', [fx.deptB], true)
      LEDGER.users.push(dept2.id)

      try {
        const own = await fx.deptUser.client
          .from('staff_department')
          .select('staff_id,department_id')
          .in('staff_id', [fx.deptUser.id, dept2.id])
        expect(own.error).toBeNull()
        expect((own.data ?? []).map((r) => r.staff_id)).toEqual([fx.deptUser.id])

        const asAdmin = await fx.adminUser.client
          .from('staff_department')
          .select('staff_id,department_id')
          .in('staff_id', [fx.deptUser.id, dept2.id])
        expect((asAdmin.data ?? []).map((r) => r.staff_id).sort()).toEqual(
          [fx.deptUser.id, dept2.id].sort()
        )

        const asSuperadmin = await fx.superadminUser.client
          .from('staff_department')
          .select('staff_id,department_id')
          .in('staff_id', [fx.deptUser.id, dept2.id])
        expect((asSuperadmin.data ?? []).map((r) => r.staff_id).sort()).toEqual(
          [fx.deptUser.id, dept2.id].sort()
        )

        // dept and admin both fail to write staff_department — even their own row.
        // NOTE: INSERT's WITH CHECK evaluates the specific new row being inserted, so a
        // failing check is a hard 42501 error. UPDATE/DELETE's USING clause instead acts
        // as a row filter over EXISTING rows — a uniformly-false is_superadmin() gate
        // just matches zero rows, with no error, mirroring the dept/viewer
        // entries_update precedent earlier in this file. Grants exist at the table level
        // for all four verbs (role_rbac_v2 §1's explicit `grant ... update, delete`), so
        // it is RLS alone drawing this distinction, not a revoked privilege.
        for (const [label, user] of [
          ['dept', fx.deptUser],
          ['admin', fx.adminUser],
        ] as const) {
          const insertAttempt = await user.client
            .from('staff_department')
            .insert({ staff_id: user.id, department_id: fx.deptB })
            .select()
          expect(insertAttempt.error, `${label} insert should error`).not.toBeNull()
          expect(insertAttempt.error?.code).toBe('42501')

          const updateAttempt = await user.client
            .from('staff_department')
            .update({ department_id: fx.deptB })
            .eq('staff_id', user.id)
            .select()
          expect(updateAttempt.error, `${label} update should not error`).toBeNull()
          expect(updateAttempt.data, `${label} update should match zero rows`).toEqual([])

          const deleteAttempt = await user.client
            .from('staff_department')
            .delete()
            .eq('staff_id', user.id)
            .select()
          expect(deleteAttempt.error, `${label} delete should not error`).toBeNull()
          expect(deleteAttempt.data, `${label} delete should match zero rows`).toEqual([])
        }

        // The dept user's real row must have survived every rejected attempt.
        const { data: survives } = await svc
          .from('staff_department')
          .select('staff_id,department_id')
          .eq('staff_id', fx.deptUser.id)
        expect(survives).toEqual([{ staff_id: fx.deptUser.id, department_id: fx.deptA }])

        // superadmin CAN insert/update/delete. Uses a fresh department to avoid a
        // primary-key collision with dept2's existing (dept2, deptB) row, since the
        // table's only columns are the composite primary key.
        const deptC = await insertDepartment(fx.suffix, 'c')

        const superInsert = await fx.superadminUser.client
          .from('staff_department')
          .insert({ staff_id: dept2.id, department_id: deptC })
          .select()
        expect(superInsert.error).toBeNull()
        expect((superInsert.data ?? []).length).toBe(1)

        const superUpdate = await fx.superadminUser.client
          .from('staff_department')
          .update({ department_id: fx.deptA })
          .eq('staff_id', dept2.id)
          .eq('department_id', deptC)
          .select()
        expect(superUpdate.error).toBeNull()
        expect((superUpdate.data ?? []).length).toBe(1)

        const superDelete = await fx.superadminUser.client
          .from('staff_department')
          .delete()
          .eq('staff_id', dept2.id)
          .eq('department_id', fx.deptA)
          .select()
        expect(superDelete.error).toBeNull()
        expect((superDelete.data ?? []).length).toBe(1)

        await del('department', [deptC])
        LEDGER.departments = LEDGER.departments.filter((d) => d !== deptC)
      } finally {
        await dept2.client.auth.signOut().catch(() => {})
        await svc.from('staff_profile').delete().eq('id', dept2.id)
        await svc.auth.admin.deleteUser(dept2.id)
        LEDGER.users = LEDGER.users.filter((u) => u !== dept2.id)
      }
    })
  })

  it('restricts vendor merges to admin-or-above (vendor_update_admin) while all staff can read vendors', async () => {
    await withFixture({}, async (fx) => {
      const { data: vendor, error: vErr } = await svc
        .from('vendor')
        .insert({
          display_name: `${TAG} vendor ${fx.suffix}`,
          normalized_name: `${TAG} vendor ${fx.suffix}`,
        })
        .select('id')
        .single()
      if (vErr || !vendor) throw new Error(`fixture vendor: ${vErr?.message}`)
      LEDGER.vendors.push(vendor.id)

      try {
        // vendor has no department_id and deliberately spans departments (§3.2).
        const read = await fx.deptUser.client.from('vendor').select('id').eq('id', vendor.id)
        expect(ids(read.data)).toEqual([vendor.id])

        const deptUpd = await fx.deptUser.client
          .from('vendor')
          .update({ is_confirmed: true })
          .eq('id', vendor.id)
          .select('id')
        expect(deptUpd.error).toBeNull()
        expect(deptUpd.data).toEqual([])

        const adminUpd = await fx.adminUser.client
          .from('vendor')
          .update({ is_confirmed: true })
          .eq('id', vendor.id)
          .select('id')
        expect(adminUpd.error).toBeNull()
        expect(ids(adminUpd.data)).toEqual([vendor.id])

        // superadmin retains the same capability admin now shares.
        const superUpd = await fx.superadminUser.client
          .from('vendor')
          .update({ is_confirmed: false })
          .eq('id', vendor.id)
          .select('id')
        expect(superUpd.error).toBeNull()
        expect(ids(superUpd.data)).toEqual([vendor.id])
      } finally {
        await del('vendor', [vendor.id])
        LEDGER.vendors = LEDGER.vendors.filter((v) => v !== vendor.id)
      }
    })
  })

  it('exposes zone and admin_head org-wide to all staff, independent of department', async () => {
    // 20260913000001_admin_head_zone_drop_department.sql dropped
    // department_id from both tables entirely -- they'd been seeded under
    // department_id=1 ('Venue Setup') for every row since day one, which
    // this same RLS gate had made a real visibility bug (a dept-role
    // account not assigned to department 1 saw zero admin_head/zone rows).
    // Replaces the old "scopes zone by department" test, which no longer
    // applies -- zone_select/admin_head_select are now staff-wide, same
    // shape as department_select.
    await withFixture({}, async (fx) => {
      const zoneNumber = 900000 + Math.floor(Math.random() * 90000)
      const headNumber = 900000 + Math.floor(Math.random() * 90000)
      const { data: zones, error: zErr } = await svc
        .from('zone')
        .insert([{ zone_number: zoneNumber, name: `${TAG}-zone-${fx.suffix}` }])
        .select('id')
      if (zErr || !zones) throw new Error(`fixture zone: ${zErr?.message}`)
      LEDGER.zones.push(...zones.map((z) => z.id))

      const { data: heads, error: hErr } = await svc
        .from('admin_head')
        .insert([{ head_number: headNumber, name: `${TAG}-head-${fx.suffix}` }])
        .select('id')
      if (hErr || !heads) throw new Error(`fixture admin_head: ${hErr?.message}`)
      LEDGER.heads.push(...heads.map((h) => h.id))

      try {
        // fx.deptUser is assigned only to deptA (not any special "zone
        // department") -- seeing these rows anyway is exactly what "org-wide"
        // means now.
        const seenZone = await fx.deptUser.client.from('zone').select('id').eq('id', zones[0]!.id)
        expect(seenZone.error).toBeNull()
        expect(ids(seenZone.data)).toEqual([zones[0]!.id])

        const seenHead = await fx.deptUser.client.from('admin_head').select('id').eq('id', heads[0]!.id)
        expect(seenHead.error).toBeNull()
        expect(ids(seenHead.data)).toEqual([heads[0]!.id])

        // department itself is a deliberate exception (documented JUDGEMENT CALL in
        // 20260808000026): all active staff read the full department list, because
        // scoping the dimension table would be circular. Asserted so the exception is
        // recorded behaviour rather than an accident.
        const depts = await fx.deptUser.client
          .from('department')
          .select('id')
          .in('id', [fx.deptA, fx.deptB])
        expect(ids(depts.data)).toEqual([fx.deptA, fx.deptB].sort())
      } finally {
        await del('zone', zones.map((z) => z.id))
        LEDGER.zones = LEDGER.zones.filter((z) => !zones.some((x) => x.id === z))
        await del('admin_head', heads.map((h) => h.id))
        LEDGER.heads = LEDGER.heads.filter((h) => !heads.some((x) => x.id === h))
      }
    })
  })

  it('exposes job_queue to admin-or-above only (job_queue_select_admin)', async () => {
    await withFixture({}, async (fx) => {
      // status 'dead' is terminal, so no worker will ever claim this fixture row.
      const { data: job, error: jErr } = await svc
        .from('job_queue')
        .insert({
          job_type: 'poll_batch',
          payload: { rls_test: RUN_ID, suffix: fx.suffix },
          status: 'dead',
          last_error: `${TAG} fixture — never executed`,
        })
        .select('id')
        .single()
      if (jErr || !job) throw new Error(`fixture job: ${jErr?.message}`)
      LEDGER.jobs.push(job.id)

      try {
        const asDept = await fx.deptUser.client.from('job_queue').select('id').eq('id', job.id)
        expect(asDept.error).toBeNull()
        expect(asDept.data).toEqual([])

        const asAdmin = await fx.adminUser.client.from('job_queue').select('id').eq('id', job.id)
        expect(asAdmin.error).toBeNull()
        expect(ids(asAdmin.data)).toEqual([job.id])

        const asSuperadmin = await fx.superadminUser.client.from('job_queue').select('id').eq('id', job.id)
        expect(asSuperadmin.error).toBeNull()
        expect(ids(asSuperadmin.data)).toEqual([job.id])
      } finally {
        await del('job_queue', [job.id])
        LEDGER.jobs = LEDGER.jobs.filter((j) => j !== job.id)
      }
    })
  })

  it('hides everything from a deactivated staff account and from an anonymous caller', async () => {
    await withFixture({ inactive: true }, async (fx) => {
      const dead = fx.inactive!.client
      // is_staff() is false, so can_see_department() is false for every department.
      const deadEntries = await dead.from('entries').select('id').in('department_id', [fx.deptA, fx.deptB])
      expect(deadEntries.error).toBeNull()
      expect(deadEntries.data).toEqual([])

      const deadDepts = await dead.from('department').select('id').in('id', [fx.deptA, fx.deptB])
      expect(deadDepts.data).toEqual([])

      const deadView = await dead
        .from('v_entry_enriched')
        .select('id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(deadView.data).toEqual([])

      // The deactivated user can still see their own staff_profile row — that policy
      // is `id = auth.uid() or is_admin_or_above()`, deliberately not gated on
      // is_active, so a superadmin can reactivate them and they can see their own
      // status meanwhile.
      const ownProfile = await dead.from('staff_profile').select('id,is_active').eq('id', fx.inactive!.id)
      expect(ownProfile.error).toBeNull()
      expect(ownProfile.data).toEqual([{ id: fx.inactive!.id, is_active: false }])

      // Same non-gating-on-is_active property holds for staff_department_select
      // (`staff_id = auth.uid() or is_admin_or_above()`) — the deactivated account can
      // still see its own department assignment.
      const deadOwnDept = await dead
        .from('staff_department')
        .select('staff_id,department_id')
        .eq('staff_id', fx.inactive!.id)
      expect(deadOwnDept.error).toBeNull()
      expect(deadOwnDept.data).toEqual([{ staff_id: fx.inactive!.id, department_id: fx.deptA }])

      const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const anonEntries = await anon.from('entries').select('id').in('department_id', [fx.deptA, fx.deptB])
      // Every policy is `to authenticated`; anon matches none of them.
      expect(anonEntries.data ?? []).toEqual([])
      const anonView = await anon.from('v_entry_enriched').select('id').limit(1)
      expect(anonView.data ?? []).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 7. reimbursement_detail / advance_payment_detail — 1:1 class-table-inheritance
  //    extension tables (20260827000001_entries_type_detail_tables.sql). Each policy
  //    is a join back to `entries` and `private.can_see_department(e.department_id)`,
  //    the exact same shape as entries_select, so the assertions mirror section 1
  //    above almost exactly. Neither table's `entry_id` FK is ON DELETE CASCADE, so
  //    rows inserted here are deleted in this test's own `finally`, before
  //    withFixture's outer cleanup deletes fx.entryA/fx.entryB.
  // -------------------------------------------------------------------------
  it('scopes reimbursement_detail SELECT to the caller department; admin/superadmin see across departments', async () => {
    await withFixture({}, async (fx) => {
      const { error: insAErr } = await svc.from('reimbursement_detail').insert({
        entry_id: fx.entryA,
        sr_no: `${TAG}-${fx.suffix}-a`,
        reimbursement_type: 'staff',
      })
      if (insAErr) throw new Error(`fixture reimbursement_detail A: ${insAErr.message}`)
      const { error: insBErr } = await svc.from('reimbursement_detail').insert({
        entry_id: fx.entryB,
        sr_no: `${TAG}-${fx.suffix}-b`,
        reimbursement_type: 'staff',
      })
      if (insBErr) throw new Error(`fixture reimbursement_detail B: ${insBErr.message}`)

      try {
        const scope = (c: SupabaseClient) =>
          c.from('reimbursement_detail').select('entry_id').in('entry_id', [fx.entryA, fx.entryB])

        const dept = await scope(fx.deptUser.client)
        expect(dept.error).toBeNull()
        expect(entryIds(dept.data)).toEqual([fx.entryA])

        const admin = await scope(fx.adminUser.client)
        expect(admin.error).toBeNull()
        expect(entryIds(admin.data)).toEqual([fx.entryA, fx.entryB].sort())

        const superadmin = await scope(fx.superadminUser.client)
        expect(superadmin.error).toBeNull()
        expect(entryIds(superadmin.data)).toEqual([fx.entryA, fx.entryB].sort())

        // Direct lookup on department B's row must also return nothing, not an
        // error — a filtered-out row is indistinguishable from a non-existent one.
        const direct = await fx.deptUser.client
          .from('reimbursement_detail')
          .select('entry_id')
          .eq('entry_id', fx.entryB)
        expect(direct.error).toBeNull()
        expect(direct.data).toEqual([])
      } finally {
        const { error } = await svc
          .from('reimbursement_detail')
          .delete()
          .in('entry_id', [fx.entryA, fx.entryB])
        if (error) throw new Error(`cleanup reimbursement_detail: ${error.message}`)
      }
    })
  })

  it('scopes advance_payment_detail SELECT to the caller department; admin/superadmin see across departments', async () => {
    await withFixture({}, async (fx) => {
      const { error: insAErr } = await svc.from('advance_payment_detail').insert({
        entry_id: fx.entryA,
        invoice_amount: '111.11',
      })
      if (insAErr) throw new Error(`fixture advance_payment_detail A: ${insAErr.message}`)
      const { error: insBErr } = await svc.from('advance_payment_detail').insert({
        entry_id: fx.entryB,
        invoice_amount: '222.22',
      })
      if (insBErr) throw new Error(`fixture advance_payment_detail B: ${insBErr.message}`)

      try {
        const scope = (c: SupabaseClient) =>
          c.from('advance_payment_detail').select('entry_id').in('entry_id', [fx.entryA, fx.entryB])

        const dept = await scope(fx.deptUser.client)
        expect(dept.error).toBeNull()
        expect(entryIds(dept.data)).toEqual([fx.entryA])

        const admin = await scope(fx.adminUser.client)
        expect(admin.error).toBeNull()
        expect(entryIds(admin.data)).toEqual([fx.entryA, fx.entryB].sort())

        const superadmin = await scope(fx.superadminUser.client)
        expect(superadmin.error).toBeNull()
        expect(entryIds(superadmin.data)).toEqual([fx.entryA, fx.entryB].sort())

        // Direct lookup on department B's row must also return nothing, not an
        // error — same "filtered-out row, not a missing one" shape as above.
        const direct = await fx.deptUser.client
          .from('advance_payment_detail')
          .select('entry_id')
          .eq('entry_id', fx.entryB)
        expect(direct.error).toBeNull()
        expect(direct.data).toEqual([])
      } finally {
        const { error } = await svc
          .from('advance_payment_detail')
          .delete()
          .in('entry_id', [fx.entryA, fx.entryB])
        if (error) throw new Error(`cleanup advance_payment_detail: ${error.message}`)
      }
    })
  })
})

// ===========================================================================
// entry_bill_link — entries <-> bills many-to-many (20260908000001 / ...0003).
// Writes are RPC-only (reviewer/admin gated); the SELECT policy scopes PER ROW
// (can_see_source_document AND can_see_entry); can_see_source_document reads the
// junction with OR semantics across every linked entry's department.
// ===========================================================================
describe('entry_bill_link (entries <-> bills M:N)', () => {
  it('RPC-gates writes to reviewer/admin, scopes the junction SELECT per row, and blocks direct writes', async () => {
    await withFixture({}, async (fx) => {
      const { sourceDocumentId, billId } = await fx.makeBill()

      // --- 1. the link RPC enforces the reviewer/admin role -------------
      // (checked before visibility, so no assignee/link setup is needed to
      //  see this rejection).
      const deptRpc = await fx.deptUser.client.rpc('set_bill_entry_links', {
        p_document_extraction_id: billId,
        p_entry_ids: [fx.entryA],
      })
      expect(deptRpc.error, 'a dept user must not be able to link bills to entries').not.toBeNull()

      // --- 2. a privileged reviewer CAN link, across two departments ----
      // superadmin (not admin): a plain admin cannot see an unassigned,
      // not-yet-linked document — that is the pre-existing "unmatched docs are
      // the non-admin triage pool" rule in can_see_source_document, unchanged
      // by this feature. Real admin reviewers reach such a doc via assignment.
      const writeRpc = await fx.superadminUser.client.rpc('set_bill_entry_links', {
        p_document_extraction_id: billId,
        p_entry_ids: [fx.entryA, fx.entryB],
      })
      expect(writeRpc.error).toBeNull()

      const truth = await svc
        .from('entry_bill_link')
        .select('entry_id')
        .eq('document_extraction_id', billId)
      expect(new Set((truth.data ?? []).map((r) => r.entry_id))).toEqual(
        new Set([fx.entryA, fx.entryB])
      )

      // --- 3. SELECT policy scopes PER ROW ------------------------------
      // dept-A user sees the entryA link only; superadmin sees both.
      const deptRows = await fx.deptUser.client
        .from('entry_bill_link')
        .select('entry_id')
        .eq('document_extraction_id', billId)
      expect(deptRows.error).toBeNull()
      expect((deptRows.data ?? []).map((r) => r.entry_id)).toEqual([fx.entryA])

      const superRows = await fx.superadminUser.client
        .from('entry_bill_link')
        .select('entry_id')
        .eq('document_extraction_id', billId)
      expect(new Set((superRows.data ?? []).map((r) => r.entry_id))).toEqual(
        new Set([fx.entryA, fx.entryB])
      )

      // A direct lookup on the dept-B row returns nothing, not an error —
      // filtered out, not missing.
      const deptBRow = await fx.deptUser.client
        .from('entry_bill_link')
        .select('entry_id')
        .eq('document_extraction_id', billId)
        .eq('entry_id', fx.entryB)
      expect(deptBRow.error).toBeNull()
      expect(deptBRow.data).toEqual([])

      // --- 4. can_see_source_document reads the junction with OR semantics
      // The bill carries no entry_id column at all; the dept-A user can still
      // read it because one of its links points at a dept-A entry.
      const deptDoc = await fx.deptUser.client
        .from('document_extraction')
        .select('id')
        .eq('id', billId)
      expect(deptDoc.error).toBeNull()
      expect(deptDoc.data).toHaveLength(1)

      // --- 5. direct INSERT / DELETE on entry_bill_link is blocked ----
      // for every authenticated role (writes are RPC-only).
      for (const u of [fx.deptUser, fx.adminUser, fx.superadminUser]) {
        const ins = await u.client.from('entry_bill_link').insert({
          entry_id: fx.entryA,
          source_document_id: sourceDocumentId,
          document_extraction_id: billId,
        })
        expect(ins.error, 'direct INSERT on entry_bill_link must be denied').not.toBeNull()

        await u.client.from('entry_bill_link').delete().eq('document_extraction_id', billId)
      }
      // Ground truth: nothing was actually deleted by those attempts.
      const afterDeletes = await svc
        .from('entry_bill_link')
        .select('id')
        .eq('document_extraction_id', billId)
      expect(afterDeletes.data ?? [], 'direct DELETE on entry_bill_link must be a no-op').toHaveLength(2)

      // --- 6. detach via the RPC ------------------------------------
      const detach = await fx.superadminUser.client.rpc('remove_bill_entry_link', {
        p_document_extraction_id: billId,
        p_entry_id: fx.entryB,
      })
      expect(detach.error).toBeNull()
      const afterDetach = await svc
        .from('entry_bill_link')
        .select('entry_id')
        .eq('document_extraction_id', billId)
      expect((afterDetach.data ?? []).map((r) => r.entry_id)).toEqual([fx.entryA])
    })
  })
})

// ===========================================================================
// [security-audit 2026-10-15] regression suites (Phase 8 of docs/security-audit-fix-plan.md)
// ===========================================================================
// Everything below was written BEFORE the three security migrations were pushed:
//   20261015100000_security_critical_fixes.sql   (C1 / H1 / H3 / L11)
//   20261015110000_security_rls_hardening.sql    (M2 / M3 / M4 / M11 / D4 / L17)
//   20261015120000_login_lockout_hook.sql        (M9 / D8)
//   20261015130000_pending_upload.sql            (4.3)
// so these tests FAIL against a database that does not have them yet -- that is the point.
// Run `npm run test:rls` only after the push.
//
// Same safety rules as the rest of this file (see the header): every row is created here,
// tagged `rls-test-<runId>`, recorded in the LEDGER and deleted by exact primary key. The
// real `is_current` event is NEVER modified -- "closed event" scenarios use a brand-new
// fixture event inserted with is_current = false (the partial unique index on is_current
// only constrains the `true` rows). Pre-existing singleton rows (app_settings) are only
// ever probed with writes that cannot succeed even if a policy were wrong.
// ===========================================================================

const AUDIT = '[security-audit 2026-10-15]'

const anonClient = () =>
  createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const numeric = (a: number, b: number) => a - b

/** Remove ids from a LEDGER list in place (they were deleted by the test itself). */
function forget(list: Array<number | string>, removed: Array<number | string>) {
  for (const r of removed) {
    const i = list.indexOf(r)
    if (i >= 0) list.splice(i, 1)
  }
}

/** Insert one fixture row with the service role and record its id in every given list. */
async function insertTracked(table: string, row: Record<string, unknown>, ...trackers: number[][]): Promise<number> {
  const { data, error } = await svc.from(table).insert(row).select('id').single()
  if (error || !data) throw new Error(`fixture ${table}: ${error?.message ?? 'no row returned'}`)
  for (const t of trackers) t.push(data.id as number)
  return data.id as number
}

/**
 * "The database refused this write": either an error came back, or it silently affected no
 * rows. Which of the two a table gives depends on whether the role also holds the table
 * privilege (Supabase's default privileges differ per table age), so both count -- the
 * assertions that matter are the ground-truth reads that follow.
 */
const refused = (res: { error: unknown; data: unknown }) =>
  res.error !== null && res.error !== undefined
    ? true
    : Array.isArray(res.data)
      ? res.data.length === 0
      : !res.data

/** Delete fixture rows by exact id and drop them from the ledger. */
async function dropTracked(table: string, ledgerList: number[], idList: number[]) {
  await del(table, idList)
  forget(ledgerList, idList)
}

/**
 * A brand-new event with is_current = FALSE. Never touches the real current event
 * (the `event_one_current` partial unique index only constrains is_current = true rows,
 * so inserting a second false row is always legal).
 */
async function createClosedEvent(): Promise<number> {
  const tag = `${TAG}-${RUN_ID}${Math.random().toString(36).slice(2, 6)}`
  const { data, error } = await svc
    .from('event')
    .insert({ name: `${tag} closed fixture`, hijri_year: tag, is_current: false })
    .select('id,is_current')
    .single()
  if (error || !data) throw new Error(`closed-event fixture: ${error?.message ?? 'no row returned'}`)
  LEDGER.events.push(data.id as number)
  if (data.is_current) throw new Error('closed-event fixture came back is_current=true -- refusing to continue')
  return data.id as number
}

/** Runs `run` with a fixture closed event, and deletes the event afterwards (by id). The
 *  caller must have removed every entry / document / batch that points at it first --
 *  nest `withFixture` INSIDE this so its cleanup runs before the event is deleted. */
async function withClosedEvent(run: (closedEventId: number) => Promise<void>) {
  const id = await createClosedEvent()
  try {
    await run(id)
  } finally {
    await dropTracked('event', LEDGER.events, [id])
  }
}

/** Like insertEntry, but in an explicit event (and recorded in the ledger). */
async function insertEntryInEvent(
  suffix: string,
  letter: string,
  departmentId: number,
  eventId: number
): Promise<number> {
  return insertTracked(
    'entries',
    {
      ubbl_number: `${TAG}-${suffix}-${letter}`,
      department_id: departmentId,
      event_id: eventId,
      type: 'invoice',
      source: 'manual',
      amount: '55.55',
      vendor_raw: `${TAG} vendor ${letter}`,
    },
    LEDGER.entries
  )
}

type DocFixture = {
  sourceDocumentId: number
  billId: number
  pageId: number
  lineItemId: number
  storagePath: string
}

/** source_document + one bill + one page + one line item, in an explicit event, optionally
 *  assigned to staff and/or already verified. Everything cascades from the source_document. */
async function insertDocumentIn(
  suffix: string,
  label: string,
  eventId: number,
  tracker: number[],
  opts: { assignTo?: string[]; verifiedBy?: string } = {}
): Promise<DocFixture> {
  const storagePath = `${TAG}/${suffix}/${label}.pdf`
  const sourceDocumentId = await insertTracked(
    'source_document',
    {
      event_id: eventId,
      storage_path: storagePath,
      original_filename: `${TAG}-${suffix}-${label}.pdf`,
      file_hash_sha256: `${TAG}${suffix}${label}`.replace(/[^a-z0-9]/gi, '').padEnd(64, '0').slice(0, 64),
      mime_type: 'application/pdf',
    },
    LEDGER.sourceDocuments
  )
  tracker.push(sourceDocumentId)

  if (opts.assignTo && opts.assignTo.length > 0) {
    const { error } = await svc
      .from('source_document_assignee')
      .insert(opts.assignTo.map((staff_id) => ({ source_document_id: sourceDocumentId, staff_id })))
    if (error) throw new Error(`fixture source_document_assignee: ${error.message}`)
  }

  const bill: Record<string, unknown> = {
    source_document_id: sourceDocumentId,
    bill_index: 0,
    total_amount_ocr: '333.33',
  }
  if (opts.verifiedBy) {
    bill.verified_at = new Date().toISOString()
    bill.verified_by = opts.verifiedBy
  }
  const { data: billRow, error: billErr } = await svc.from('document_extraction').insert(bill).select('id').single()
  if (billErr || !billRow) throw new Error(`fixture document_extraction: ${billErr?.message}`)

  const { data: pageRow, error: pageErr } = await svc
    .from('document_page')
    .insert({ source_document_id: sourceDocumentId, page_number: 1 })
    .select('id')
    .single()
  if (pageErr || !pageRow) throw new Error(`fixture document_page: ${pageErr?.message}`)

  const { data: liRow, error: liErr } = await svc
    .from('document_extraction_line_item')
    .insert({
      document_extraction_id: billRow.id,
      document_page_id: pageRow.id,
      line_order: 0,
      description_ocr: `${TAG} line ${label}`,
    })
    .select('id')
    .single()
  if (liErr || !liRow) throw new Error(`fixture line item: ${liErr?.message}`)

  return {
    sourceDocumentId,
    billId: billRow.id as number,
    pageId: pageRow.id as number,
    lineItemId: liRow.id as number,
    storagePath,
  }
}

/** One extra signed-in user for a single test (e.g. a second admin), removed afterwards.
 *  The extra user must not write to rows that outlive `run` (entries.updated_by etc. point
 *  at auth.users) -- use it for reads, RPCs on documents, and as a document assignee. */
async function withExtraUser(
  fx: Fixture,
  label: string,
  role: 'superadmin' | 'admin' | 'dept',
  departmentIds: number[],
  run: (u: FixtureUser) => Promise<void>
) {
  const u = await makeUser(fx.suffix, label, role, departmentIds, true)
  try {
    await run(u)
  } finally {
    await u.client.auth.signOut().catch(() => {})
    await svc.from('staff_profile').delete().eq('id', u.id)
    await withAuthRetry(`deleteUser(${u.id})`, () => svc.auth.admin.deleteUser(u.id))
    forget(LEDGER.users, [u.id])
  }
}

async function docExists(id: number): Promise<boolean> {
  const { data, error } = await svc.from('source_document').select('id').eq('id', id).maybeSingle()
  if (error) throw new Error(`docExists(${id}): ${error.message}`)
  return !!data
}

/** Which of `idList` does `client` see in `table`, matched on column `col`? (numeric ascending) */
async function seenIds(client: SupabaseClient, table: string, col: string, idList: number[]): Promise<number[]> {
  const { data, error } = await client.from(table).select(col).in(col, idList)
  expect(error, `${table} select`).toBeNull()
  return ((data ?? []) as unknown as Array<Record<string, number>>).map((r) => r[col]!).sort(numeric)
}

/** Direct database connection (DATABASE_URL), used ONLY for read-only catalog queries and
 *  for transactions that are always rolled back. Never issues a committing write. */
async function withPg<T>(run: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    return await run(c)
  } finally {
    await c.end()
  }
}
const itPg = process.env.DATABASE_URL ? it : it.skip

// ===========================================================================
describe(`${AUDIT} C1: a caller can never choose their own role`, () => {
  const newEmail = (label: string, suffix: string) => `${TAG}-${label}-${suffix}@rls-test.example.com`
  const newPassword = () => `Rls!${RUN_ID}${Math.random().toString(36).slice(2, 10)}`
  const freshSuffix = () => `${RUN_ID}${Math.random().toString(36).slice(2, 6)}`

  async function dropUser(id: string) {
    await svc.from('staff_profile').delete().eq('id', id)
    await withAuthRetry(`deleteUser(${id})`, () => svc.auth.admin.deleteUser(id))
    forget(LEDGER.users, [id])
  }

  it('ignores role / is_active / department_ids / its_number / contact_email supplied in user_metadata', async () => {
    const suffix = freshSuffix()
    const deptId = await insertDepartment(suffix, 'c1')
    let userId: string | undefined
    try {
      // user_metadata is exactly what a public signUp() lets the caller choose.
      const { data, error } = await withAuthRetry('createUser(c1-meta)', () =>
        svc.auth.admin.createUser({
          email: newEmail('c1-meta', suffix),
          password: newPassword(),
          email_confirm: true,
          user_metadata: {
            full_name: `${TAG} c1 meta ${suffix}`,
            role: 'superadmin',
            is_active: true,
            department_ids: [deptId],
            its_number: '00000001',
            contact_email: `${TAG}-forged@rls-test.example.com`,
          },
        })
      )
      if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
      userId = data.user.id
      LEDGER.users.push(userId)

      const { data: profile, error: pErr } = await svc
        .from('staff_profile')
        .select('role,is_active,its_number,contact_email')
        .eq('id', userId)
        .single()
      expect(pErr).toBeNull()
      expect(profile).toEqual({ role: 'dept', is_active: false, its_number: null, contact_email: null })

      const { data: depts } = await svc.from('staff_department').select('department_id').eq('staff_id', userId)
      expect(depts, 'no department may be granted from user_metadata').toEqual([])
    } finally {
      if (userId) await dropUser(userId)
      await dropTracked('department', LEDGER.departments, [deptId])
    }
  })

  it('an anonymous signUp() with escalated metadata cannot produce a privileged account', async () => {
    const suffix = freshSuffix()
    const anon = anonClient()
    const res = await anon.auth.signUp({
      email: newEmail('c1-signup', suffix),
      password: newPassword(),
      options: { data: { full_name: `${TAG} c1 signup`, role: 'superadmin', is_active: true } },
    })
    const createdId = res.data.user?.id
    if (createdId) LEDGER.users.push(createdId)
    try {
      if (createdId) {
        // Public signup is OFF in production (owner decision D1), so this branch only runs if
        // someone turns it back on -- in which case the trigger itself must still hold.
        const { data: profile } = await svc
          .from('staff_profile')
          .select('role,is_active')
          .eq('id', createdId)
          .maybeSingle()
        expect(profile, 'a self-registered account must land as inactive dept').toMatchObject({
          role: 'dept',
          is_active: false,
        })
      } else {
        expect(res.error, 'signup should be refused outright while it is disabled').not.toBeNull()
      }
    } finally {
      if (createdId) await dropUser(createdId)
    }
  })

  it('createUser with app_metadata still lands as an inactive dept: GoTrue stores app_metadata after the insert, so createStaffUser promotes the profile itself', async () => {
    const suffix = freshSuffix()
    const deptId = await insertDepartment(suffix, 'c1b')
    let userId: string | undefined
    try {
      const { data, error } = await withAuthRetry('createUser(c1-app)', () =>
        svc.auth.admin.createUser({
          email: newEmail('c1-app', suffix),
          password: newPassword(),
          email_confirm: true,
          user_metadata: { full_name: `${TAG} c1 app ${suffix}` },
          app_metadata: { role: 'admin', is_active: true, department_ids: [deptId] },
        })
      )
      if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
      userId = data.user.id
      LEDGER.users.push(userId)

      const { data: profile } = await svc.from('staff_profile').select('role,is_active').eq('id', userId).single()
      // The trigger can never grant access, whichever metadata field it is offered; the
      // privileged promotion happens in createStaffUser (lib/actions/admin.ts) with the service key.
      expect(profile).toEqual({ role: 'dept', is_active: false })
      const { data: depts } = await svc.from('staff_department').select('department_id').eq('staff_id', userId)
      expect(depts).toEqual([])
    } finally {
      if (userId) await dropUser(userId)
      await dropTracked('department', LEDGER.departments, [deptId])
    }
  })
})

// ===========================================================================
describe(`${AUDIT} H1: invoice-documents bucket configuration`, () => {
  // The direct-access denial matrix (dept / admin / superadmin / deactivated / anon) lives in
  // section 4 above ("locks invoice-documents to the service role"). This only adds what that
  // test does not look at: the bucket's own limits.
  it('is private, capped at 32 MiB and accepts application/pdf only', async () => {
    const { data, error } = await svc.storage.getBucket(BUCKET)
    expect(error).toBeNull()
    expect(data?.public).toBe(false)
    expect(data?.file_size_limit).toBe(33554432)
    expect(data?.allowed_mime_types).toEqual(['application/pdf'])
  })
})

// ===========================================================================
describe(`${AUDIT} H3 / D5: delete_source_document and cancel_source_document_jobs`, () => {
  it('refuse a document the caller cannot see, and any closed-event document unless superadmin', async () => {
    await withClosedEvent(async (closedEventId) => {
      await withFixture({}, async (fx) => {
        const currentEventId = await getEventId()

        await withExtraUser(fx, 'adminB', 'admin', [], async (adminB) => {
          // --- (a) cross-assignee: a document assigned ONLY to admin B -------------------
          const docB = await insertDocumentIn(fx.suffix, 'assigned-b', currentEventId, fx.sourceDocuments, {
            assignTo: [adminB.id],
          })
          const hidden = await fx.adminUser.client.from('source_document').select('id').eq('id', docB.sourceDocumentId)
          expect(hidden.data, 'admin A must not even see admin B\'s document').toEqual([])

          const delA = await fx.adminUser.client.rpc('delete_source_document', { p_id: docB.sourceDocumentId })
          expect(delA.error?.code, 'admin A deleting B\'s document').toBe('42501')
          expect(await docExists(docB.sourceDocumentId), 'document must survive').toBe(true)

          const cancelA = await fx.adminUser.client.rpc('cancel_source_document_jobs', { p_id: docB.sourceDocumentId })
          expect(cancelA.error?.code, 'admin A cancelling B\'s document work').toBe('42501')

          // dept has no delete power at all (role check in the public wrapper).
          const delDept = await fx.deptUser.client.rpc('delete_source_document', { p_id: docB.sourceDocumentId })
          expect(delDept.error).not.toBeNull()
          // anon cannot even call it (EXECUTE revoked, 1.4); any error is a pass, survival is the point.
          const delAnon = await anonClient().rpc('delete_source_document', { p_id: docB.sourceDocumentId })
          expect(delAnon.error).not.toBeNull()
          expect(await docExists(docB.sourceDocumentId), 'document must survive dept + anon attempts').toBe(true)

          // The assignee CAN delete it (current event, visible, unverified).
          const delB = await adminB.client.rpc('delete_source_document', { p_id: docB.sourceDocumentId })
          expect(delB.error).toBeNull()
          expect(delB.data, 'returns the storage path for the caller to remove').toBe(docB.storagePath)
          expect(await docExists(docB.sourceDocumentId)).toBe(false)
        })

        // --- (b) closed event: visible to the admin, still refused -----------------------
        const docClosed = await insertDocumentIn(fx.suffix, 'closed', closedEventId, fx.sourceDocuments, {
          assignTo: [fx.adminUser.id],
        })
        const visible = await fx.adminUser.client.from('source_document').select('id').eq('id', docClosed.sourceDocumentId)
        expect(ids(visible.data), 'assigned admin sees the document (so the refusal below is about the event)').toEqual([
          docClosed.sourceDocumentId,
        ])

        const delClosed = await fx.adminUser.client.rpc('delete_source_document', { p_id: docClosed.sourceDocumentId })
        expect(delClosed.error?.code).toBe('42501')
        expect(delClosed.error?.message ?? '').toMatch(/closed/i)
        expect(await docExists(docClosed.sourceDocumentId)).toBe(true)

        const cancelClosed = await fx.adminUser.client.rpc('cancel_source_document_jobs', {
          p_id: docClosed.sourceDocumentId,
        })
        expect(cancelClosed.error?.code).toBe('42501')

        // superadmin may act in a closed event: cancel reports 0 queued jobs, delete succeeds.
        const cancelSuper = await fx.superadminUser.client.rpc('cancel_source_document_jobs', {
          p_id: docClosed.sourceDocumentId,
        })
        expect(cancelSuper.error).toBeNull()
        expect(cancelSuper.data).toBe(0)

        const delSuper = await fx.superadminUser.client.rpc('delete_source_document', {
          p_id: docClosed.sourceDocumentId,
        })
        expect(delSuper.error).toBeNull()
        expect(delSuper.data).toBe(docClosed.storagePath)
        expect(await docExists(docClosed.sourceDocumentId)).toBe(false)

        // --- (c) a document that no longer exists is still an idempotent no-op ----------
        const gone = await fx.adminUser.client.rpc('delete_source_document', { p_id: docClosed.sourceDocumentId })
        expect(gone.error).toBeNull()
        expect(gone.data).toBeNull()
      })
    })
  })
})

// ===========================================================================
describe(`${AUDIT} document visibility: department + assignee scoping`, () => {
  it('scopes source_document / document_page / document_extraction / line items identically per caller', async () => {
    await withFixture({}, async (fx) => {
      const eventId = await getEventId()
      await withExtraUser(fx, 'adminB', 'admin', [], async (adminB) => {
        const sfx = fx.suffix
        const docs = {
          // unassigned + unlinked: the "triage pool" -- dept sees it, admins do not.
          pool: await insertDocumentIn(sfx, 'pool', eventId, fx.sourceDocuments),
          // unassigned, linked to a dept-A entry / a dept-B entry.
          linkedA: await insertDocumentIn(sfx, 'linked-a', eventId, fx.sourceDocuments),
          linkedB: await insertDocumentIn(sfx, 'linked-b', eventId, fx.sourceDocuments),
          // assigned to admin A only.
          assigned: await insertDocumentIn(sfx, 'assigned', eventId, fx.sourceDocuments, {
            assignTo: [fx.adminUser.id],
          }),
        }
        const { error: linkErr } = await svc.from('entry_bill_link').insert([
          {
            entry_id: fx.entryA,
            source_document_id: docs.linkedA.sourceDocumentId,
            document_extraction_id: docs.linkedA.billId,
          },
          {
            entry_id: fx.entryB,
            source_document_id: docs.linkedB.sourceDocumentId,
            document_extraction_id: docs.linkedB.billId,
          },
        ])
        if (linkErr) throw new Error(`fixture entry_bill_link: ${linkErr.message}`)

        type Name = keyof typeof docs
        const expected: Record<string, Name[]> = {
          dept: ['pool', 'linkedA'],
          admin: ['linkedA', 'linkedB', 'assigned'],
          adminB: ['linkedA', 'linkedB'],
          superadmin: ['pool', 'linkedA', 'linkedB', 'assigned'],
        }
        const callers: Array<[string, SupabaseClient]> = [
          ['dept', fx.deptUser.client],
          ['admin', fx.adminUser.client],
          ['adminB', adminB.client],
          ['superadmin', fx.superadminUser.client],
        ]
        const pick = (names: Name[], f: (d: DocFixture) => number) => names.map((n) => f(docs[n])).sort(numeric)
        const all = Object.keys(docs) as Name[]

        for (const [label, client] of callers) {
          const want = expected[label]!
          expect(
            await seenIds(client, 'source_document', 'id', all.map((n) => docs[n].sourceDocumentId)),
            `${label}: source_document`
          ).toEqual(pick(want, (d) => d.sourceDocumentId))
          expect(
            await seenIds(client, 'document_page', 'id', all.map((n) => docs[n].pageId)),
            `${label}: document_page`
          ).toEqual(pick(want, (d) => d.pageId))
          expect(
            await seenIds(client, 'document_extraction', 'id', all.map((n) => docs[n].billId)),
            `${label}: document_extraction`
          ).toEqual(pick(want, (d) => d.billId))
          expect(
            await seenIds(
              client,
              'document_extraction_line_item',
              'id',
              all.map((n) => docs[n].lineItemId)
            ),
            `${label}: document_extraction_line_item`
          ).toEqual(pick(want, (d) => d.lineItemId))
        }

        // Writes follow visibility: admin B cannot touch admin A's assigned bill or its lines;
        // dept cannot write at all, even to a bill it can see.
        const patchBill = (c: SupabaseClient, id: number) =>
          c.from('document_extraction').update({ notes_verified: `${TAG}-should-not-land` }).eq('id', id).select('id')
        const bForeign = await patchBill(adminB.client, docs.assigned.billId)
        expect(bForeign.error).toBeNull()
        expect(bForeign.data).toEqual([])
        const dSeen = await patchBill(fx.deptUser.client, docs.linkedA.billId)
        expect(dSeen.error).toBeNull()
        expect(dSeen.data).toEqual([])
        const liForeign = await adminB.client
          .from('document_extraction_line_item')
          .update({ description_verified: `${TAG}-should-not-land` })
          .eq('id', docs.assigned.lineItemId)
          .select('id')
        expect(liForeign.error).toBeNull()
        expect(liForeign.data).toEqual([])
        const { data: truth } = await svc
          .from('document_extraction')
          .select('id,notes_verified')
          .in('id', [docs.assigned.billId, docs.linkedA.billId])
        expect((truth ?? []).every((r) => r.notes_verified === null)).toBe(true)
      })
    })
  })
})

// ===========================================================================
describe(`${AUDIT} M2 / M3 / D5: closed events are read-only in the database`, () => {
  it('sanity: there is exactly one current event and the fixtures borrow it', async () => {
    const { data, error } = await svc.from('event').select('id').eq('is_current', true)
    expect(error).toBeNull()
    expect(data ?? [], 'the suite needs a current event; non-superadmin writes are impossible without one').toHaveLength(1)
    expect(data![0]!.id).toBe(await getEventId())
  })

  it('entries: admin and dept cannot write into or move rows to a closed event; superadmin can', async () => {
    await withClosedEvent(async (closedEventId) => {
      await withFixture({}, async (fx) => {
        const extraEntries: number[] = []
        try {
          const entryClosed = await insertEntryInEvent(fx.suffix, 'closed', fx.deptA, closedEventId)
          extraEntries.push(entryClosed)
          const remarkOf = async (id: number) => (await readEntry(id))?.remark ?? null

          // UPDATE in a closed event: zero rows for admin and dept (USING filters them out).
          for (const [label, user] of [
            ['admin', fx.adminUser],
            ['dept', fx.deptUser],
          ] as const) {
            const upd = await user.client
              .from('entries')
              .update({ remark: `${TAG}-${label}-closed-should-not-land` })
              .eq('id', entryClosed)
              .select('id')
            expect(upd.error, `${label} closed-event update`).toBeNull()
            expect(upd.data, `${label} closed-event update must match no rows`).toEqual([])
          }
          expect(await remarkOf(entryClosed)).toBeNull()

          // ...but a superadmin may edit a closed event (D5).
          const superUpd = await fx.superadminUser.client
            .from('entries')
            .update({ remark: `${TAG}-superadmin-closed` })
            .eq('id', entryClosed)
            .select('id')
          expect(superUpd.error).toBeNull()
          expect(ids(superUpd.data)).toEqual([entryClosed])
          expect(await remarkOf(entryClosed)).toBe(`${TAG}-superadmin-closed`)

          // Current-event writes are unaffected (the positive control).
          const adminCurrent = await fx.adminUser.client
            .from('entries')
            .update({ remark: `${TAG}-admin-current` })
            .eq('id', fx.entryA)
            .select('id')
          expect(adminCurrent.error).toBeNull()
          expect(ids(adminCurrent.data)).toEqual([fx.entryA])

          // INSERT into a closed event: refused for admin and for dept (in its own department).
          for (const [label, user, dept] of [
            ['admin', fx.adminUser, fx.deptA],
            ['dept', fx.deptUser, fx.deptA],
          ] as const) {
            const ins = await user.client
              .from('entries')
              .insert({
                ubbl_number: `${TAG}-${fx.suffix}-closed-ins-${label}`,
                event_id: closedEventId,
                department_id: dept,
                source: 'manual',
                amount: '1.00',
              })
              .select('id')
            expect(ins.error, `${label} insert into closed event`).not.toBeNull()
            expect(ins.error?.code).toBe('42501')
          }
          const { data: leaked } = await svc
            .from('entries')
            .select('id')
            .like('ubbl_number', `${TAG}-${fx.suffix}-closed-ins-%`)
          expect(leaked, 'no row may have landed').toEqual([])

          // superadmin may insert into a closed event.
          const superIns = await fx.superadminUser.client
            .from('entries')
            .insert({
              ubbl_number: `${TAG}-${fx.suffix}-closed-ins-super`,
              event_id: closedEventId,
              department_id: fx.deptA,
              source: 'manual',
              amount: '1.00',
            })
            .select('id')
          expect(superIns.error).toBeNull()
          expect((superIns.data ?? []).length).toBe(1)
          if (superIns.data?.[0]) {
            extraEntries.push(superIns.data[0].id as number)
            LEDGER.entries.push(superIns.data[0].id as number)
          }

          // An admin cannot MOVE a current-event entry into the closed event (with check).
          const moveIn = await fx.adminUser.client
            .from('entries')
            .update({ event_id: closedEventId })
            .eq('id', fx.entryA)
            .select('id')
          expect(moveIn.error).not.toBeNull()
          expect(moveIn.error?.code).toBe('42501')
          const { data: stillThere } = await svc.from('entries').select('event_id').eq('id', fx.entryA).single()
          expect(stillThere?.event_id).toBe(await getEventId())
        } finally {
          await dropTracked('entries', LEDGER.entries, extraEntries)
        }
      })
    })
  })

  it('document_extraction, line items and the verify RPC: closed event denied for admin, allowed for superadmin; verified bills survive an admin delete', async () => {
    await withClosedEvent(async (closedEventId) => {
      await withFixture({}, async (fx) => {
        const currentEventId = await getEventId()
        const sfx = fx.suffix
        const mine = [fx.adminUser.id]
        const closed = await insertDocumentIn(sfx, 'm2-closed', closedEventId, fx.sourceDocuments, { assignTo: mine })
        const open = await insertDocumentIn(sfx, 'm2-open', currentEventId, fx.sourceDocuments, { assignTo: mine })
        const verified = await insertDocumentIn(sfx, 'm3-verified', currentEventId, fx.sourceDocuments, {
          assignTo: mine,
          verifiedBy: fx.superadminUser.id,
        })
        const verifiedClosed = await insertDocumentIn(sfx, 'm3-verified-closed', closedEventId, fx.sourceDocuments, {
          assignTo: mine,
          verifiedBy: fx.superadminUser.id,
        })
        const unverifiedToDelete = await insertDocumentIn(sfx, 'm3-unverified', currentEventId, fx.sourceDocuments, {
          assignTo: mine,
        })
        const unverifiedClosedToDelete = await insertDocumentIn(sfx, 'm3-unverified-closed', closedEventId, fx.sourceDocuments, {
          assignTo: mine,
        })
        const billExists = async (id: number) =>
          !!(await svc.from('document_extraction').select('id').eq('id', id).maybeSingle()).data

        // --- document_extraction UPDATE ---------------------------------------------------
        const patch = (c: SupabaseClient, id: number, note: string) =>
          c.from('document_extraction').update({ notes_verified: note }).eq('id', id).select('id')

        const adminClosed = await patch(fx.adminUser.client, closed.billId, `${TAG}-admin-closed`)
        expect(adminClosed.error).toBeNull()
        expect(adminClosed.data, 'admin update of a closed-event bill matches no rows').toEqual([])
        const adminOpen = await patch(fx.adminUser.client, open.billId, `${TAG}-admin-open`)
        expect(adminOpen.error).toBeNull()
        expect(ids(adminOpen.data), 'current-event write is unaffected').toEqual([open.billId])
        const superClosed = await patch(fx.superadminUser.client, closed.billId, `${TAG}-super-closed`)
        expect(superClosed.error).toBeNull()
        expect(ids(superClosed.data), 'superadmin may edit a closed event').toEqual([closed.billId])

        // --- line items: insert / update / delete -----------------------------------------
        const insLine = await fx.adminUser.client
          .from('document_extraction_line_item')
          .insert({ document_extraction_id: closed.billId, line_order: 9, description_ocr: `${TAG} extra` })
          .select('id')
        expect(insLine.error, 'admin line-item insert into a closed-event bill').not.toBeNull()
        expect(insLine.error?.code).toBe('42501')

        const updLine = await fx.adminUser.client
          .from('document_extraction_line_item')
          .update({ description_verified: `${TAG}-admin-closed` })
          .eq('id', closed.lineItemId)
          .select('id')
        expect(updLine.error).toBeNull()
        expect(updLine.data).toEqual([])

        const delLine = await fx.adminUser.client
          .from('document_extraction_line_item')
          .delete()
          .eq('id', closed.lineItemId)
          .select('id')
        expect(delLine.error).toBeNull()
        expect(delLine.data).toEqual([])
        const { data: lineTruth } = await svc
          .from('document_extraction_line_item')
          .select('id,description_verified')
          .eq('id', closed.lineItemId)
          .single()
        expect(lineTruth?.description_verified).toBeNull()

        const adminOpenLine = await fx.adminUser.client
          .from('document_extraction_line_item')
          .update({ description_verified: `${TAG}-admin-open` })
          .eq('id', open.lineItemId)
          .select('id')
        expect(adminOpenLine.error).toBeNull()
        expect(ids(adminOpenLine.data), 'current-event line write is unaffected').toEqual([open.lineItemId])

        const superLine = await fx.superadminUser.client
          .from('document_extraction_line_item')
          .update({ description_verified: `${TAG}-super-closed` })
          .eq('id', closed.lineItemId)
          .select('id')
        expect(superLine.error).toBeNull()
        expect(ids(superLine.data)).toEqual([closed.lineItemId])

        // --- verify RPC ---------------------------------------------------------------------
        const verifyArgs = (billId: number) => ({
          p_document_extraction_id: billId,
          p_header: {},
          p_line_items: [],
        })
        const adminVerify = await fx.adminUser.client.rpc('verify_document_extraction', verifyArgs(closed.billId))
        expect(adminVerify.error, 'admin verify of a closed-event bill').not.toBeNull()
        expect(adminVerify.error?.code).toBe('42501')
        expect(adminVerify.error?.message ?? '').toMatch(/closed event/i)
        // The superadmin is let through the event guard. What the private function then does with
        // an empty header is its own business; the only claim here is "not the closed-event refusal".
        const superVerify = await fx.superadminUser.client.rpc('verify_document_extraction', verifyArgs(closed.billId))
        expect(superVerify.error?.message ?? '').not.toMatch(/closed event/i)

        // --- M3: only a superadmin can delete a VERIFIED bill -------------------------------
        const delVerified = await fx.adminUser.client
          .from('document_extraction')
          .delete()
          .eq('id', verified.billId)
          .select('id')
        expect(delVerified.error).toBeNull()
        expect(delVerified.data, 'admin delete of a verified bill matches no rows').toEqual([])
        expect(await billExists(verified.billId), 'verified bill must survive').toBe(true)

        const delVerifiedClosed = await fx.adminUser.client
          .from('document_extraction')
          .delete()
          .eq('id', verifiedClosed.billId)
          .select('id')
        expect(delVerifiedClosed.data).toEqual([])
        const delUnverifiedClosed = await fx.adminUser.client
          .from('document_extraction')
          .delete()
          .eq('id', unverifiedClosedToDelete.billId)
          .select('id')
        expect(delUnverifiedClosed.data, 'closed-event bill is protected even when unverified').toEqual([])
        expect(await billExists(unverifiedClosedToDelete.billId)).toBe(true)

        // clear_bill_rate_reference_links (the skip-page helper) carries the same two guards.
        const clearVerified = await fx.adminUser.client.rpc('clear_bill_rate_reference_links', {
          p_document_extraction_id: verified.billId,
        })
        expect(clearVerified.error?.code).toBe('42501')
        expect(clearVerified.error?.message ?? '').toMatch(/verified/i)
        const clearClosed = await fx.adminUser.client.rpc('clear_bill_rate_reference_links', {
          p_document_extraction_id: unverifiedClosedToDelete.billId,
        })
        expect(clearClosed.error?.code).toBe('42501')
        expect(clearClosed.error?.message ?? '').toMatch(/closed event/i)

        // Positive controls: an admin CAN delete an unverified current-event bill (skip page)...
        const delOk = await fx.adminUser.client
          .from('document_extraction')
          .delete()
          .eq('id', unverifiedToDelete.billId)
          .select('id')
        expect(delOk.error).toBeNull()
        expect(ids(delOk.data)).toEqual([unverifiedToDelete.billId])
        // ...and a superadmin can delete a verified one, even in a closed event.
        const delSuper = await fx.superadminUser.client
          .from('document_extraction')
          .delete()
          .eq('id', verifiedClosed.billId)
          .select('id')
        expect(delSuper.error).toBeNull()
        expect(ids(delSuper.data)).toEqual([verifiedClosed.billId])
        expect(await billExists(verifiedClosed.billId)).toBe(false)
      })
    })
  })
})

// ===========================================================================
describe(`${AUDIT} M4 / D4: reconciliation_exception and flags`, () => {
  it('reconciliation_exception: no delete, resolver cannot be forged, targets are scoped, dept sees its own only', async () => {
    await withClosedEvent(async (closedEventId) => {
      await withFixture({}, async (fx) => {
        const exceptionIds: number[] = []
        const extraEntries: number[] = []
        try {
          await withExtraUser(fx, 'adminB', 'admin', [], async (adminB) => {
            const eventId = await getEventId()
            const entryClosed = await insertEntryInEvent(fx.suffix, 'exc-closed', fx.deptB, closedEventId)
            extraEntries.push(entryClosed)
            const docOther = await insertDocumentIn(fx.suffix, 'exc-other', eventId, fx.sourceDocuments, {
              assignTo: [adminB.id],
            })

            const mk = (label: string, target: Record<string, unknown>) =>
              insertTracked(
                'reconciliation_exception',
                { exception_type: 'other', description: `${TAG} ${label}`, dedup_key: `${TAG}-${fx.suffix}-${label}`, ...target },
                exceptionIds,
                LEDGER.exceptions
              )
            const exA = await mk('a', { entry_id: fx.entryA })
            const exB = await mk('b', { entry_id: fx.entryB })
            const exClosed = await mk('closed', { entry_id: entryClosed })
            const exDocB = await mk('docb', { document_extraction_id: docOther.billId })
            const probe = [exA, exB, exClosed, exDocB]

            // --- select scoping (D4) ------------------------------------------------------
            const sel = (c: SupabaseClient) => c.from('reconciliation_exception').select('id').in('id', probe)
            const asDept = await sel(fx.deptUser.client)
            expect(asDept.error).toBeNull()
            expect(ids(asDept.data), 'dept sees only exceptions on its own department\'s entries').toEqual([exA])
            for (const [label, user] of [
              ['admin', fx.adminUser],
              ['superadmin', fx.superadminUser],
            ] as const) {
              const r = await sel(user.client)
              expect(r.error).toBeNull()
              expect((r.data ?? []).map((x) => x.id).sort(numeric), `${label} sees everything`).toEqual(
                [...probe].sort(numeric)
              )
            }

            // --- delete is denied for every role ---------------------------------------------
            for (const [label, user] of [
              ['dept', fx.deptUser],
              ['admin', fx.adminUser],
              ['superadmin', fx.superadminUser],
            ] as const) {
              const del1 = await user.client.from('reconciliation_exception').delete().eq('id', exA).select('id')
              expect(del1.error, `${label} delete must be refused`).not.toBeNull()
              expect(del1.error?.code).toBe('42501')
            }
            const { data: stillA } = await svc.from('reconciliation_exception').select('id').eq('id', exA)
            expect(stillA).toHaveLength(1)

            // --- a forged resolver is overwritten ------------------------------------------
            const resolved = await fx.adminUser.client
              .from('reconciliation_exception')
              .update({
                status: 'resolved',
                resolved_by: fx.deptUser.id,
                resolved_at: '2000-01-01T00:00:00Z',
                resolution_note: `${TAG} resolved`,
              })
              .eq('id', exA)
              .select('id,resolved_by,resolved_at,status')
            expect(resolved.error).toBeNull()
            expect(resolved.data).toHaveLength(1)
            expect(resolved.data![0]!.status).toBe('resolved')
            expect(resolved.data![0]!.resolved_by, 'resolver is the real caller').toBe(fx.adminUser.id)
            expect(new Date(resolved.data![0]!.resolved_at as string).getTime()).toBeGreaterThan(Date.now() - 10 * 60_000)

            // Without a status change the resolver columns are pinned.
            const pinned = await fx.adminUser.client
              .from('reconciliation_exception')
              .update({ resolved_by: fx.deptUser.id, resolved_at: '2001-01-01T00:00:00Z', resolution_note: `${TAG} again` })
              .eq('id', exA)
              .select('resolved_by')
            expect(pinned.error).toBeNull()
            expect(pinned.data![0]!.resolved_by).toBe(fx.adminUser.id)

            // The type and the target cannot be rewritten.
            for (const patch of [
              { exception_type: 'new_vendor' },
              { entry_id: fx.entryB },
              { document_extraction_id: docOther.billId },
            ]) {
              const bad = await fx.adminUser.client
                .from('reconciliation_exception')
                .update(patch)
                .eq('id', exA)
                .select('id')
              expect(bad.error, `rewriting ${JSON.stringify(patch)} must fail`).not.toBeNull()
              expect(bad.error?.code).toBe('42501')
            }
            const { data: truthA } = await svc
              .from('reconciliation_exception')
              .select('exception_type,entry_id,document_extraction_id')
              .eq('id', exA)
              .single()
            expect(truthA).toEqual({ exception_type: 'other', entry_id: fx.entryA, document_extraction_id: null })

            // --- insert: invisible target / closed event / dept ---------------------------------
            const tryInsert = async (c: SupabaseClient, label: string, target: Record<string, unknown>) => {
              const res = await c
                .from('reconciliation_exception')
                .insert({
                  exception_type: 'other',
                  description: `${TAG} insert ${label}`,
                  dedup_key: `${TAG}-${fx.suffix}-ins-${label}`,
                  ...target,
                })
                .select('id')
              if (res.data?.[0]) {
                exceptionIds.push(res.data[0].id as number)
                LEDGER.exceptions.push(res.data[0].id as number)
              }
              return res
            }
            const invisible = await tryInsert(fx.adminUser.client, 'invisible', {
              document_extraction_id: docOther.billId,
            })
            expect(invisible.error, 'insert on a bill the admin cannot see').not.toBeNull()
            expect(invisible.error?.code).toBe('42501')
            const closedIns = await tryInsert(fx.adminUser.client, 'closed', { entry_id: entryClosed })
            expect(closedIns.error, 'admin insert on a closed-event entry').not.toBeNull()
            expect(closedIns.error?.code).toBe('42501')
            const deptIns = await tryInsert(fx.deptUser.client, 'dept', { entry_id: fx.entryA })
            expect(deptIns.error, 'dept may not raise exceptions').not.toBeNull()
            expect(deptIns.error?.code).toBe('42501')
            const { data: nothing } = await svc
              .from('reconciliation_exception')
              .select('id')
              .like('dedup_key', `${TAG}-${fx.suffix}-ins-%`)
            expect(nothing, 'none of the refused inserts may have landed').toEqual([])

            const okAdmin = await tryInsert(fx.adminUser.client, 'ok-admin', { entry_id: fx.entryA })
            expect(okAdmin.error, 'admin may raise an exception on a visible current-event entry').toBeNull()
            const okSuper = await tryInsert(fx.superadminUser.client, 'ok-super', { entry_id: entryClosed })
            expect(okSuper.error, 'superadmin may raise one in a closed event').toBeNull()

            // --- closed-event update ----------------------------------------------------------
            const adminCl = await fx.adminUser.client
              .from('reconciliation_exception')
              .update({ resolution_note: `${TAG}-admin-closed` })
              .eq('id', exClosed)
              .select('id')
            expect(adminCl.error).toBeNull()
            expect(adminCl.data).toEqual([])
            const superCl = await fx.superadminUser.client
              .from('reconciliation_exception')
              .update({ resolution_note: `${TAG}-super-closed` })
              .eq('id', exClosed)
              .select('id')
            expect(superCl.error).toBeNull()
            expect(ids(superCl.data)).toEqual([exClosed])
          })
        } finally {
          await dropTracked('reconciliation_exception', LEDGER.exceptions, exceptionIds)
          await dropTracked('entries', LEDGER.entries, extraEntries)
        }
      })
    })
  })

  it('flags: no delete / insert, resolver cannot be forged, closed events are superadmin-only, dept sees its own only', async () => {
    await withClosedEvent(async (closedEventId) => {
      await withFixture({}, async (fx) => {
        const flagIds: number[] = []
        const extraEntries: number[] = []
        try {
          const entryClosed = await insertEntryInEvent(fx.suffix, 'flag-closed', fx.deptB, closedEventId)
          extraEntries.push(entryClosed)
          const mk = (label: string, entryId: number | null) =>
            insertTracked(
              'flags',
              {
                flag_type: 'duplicate_payment',
                entry_id: entryId,
                description: `${TAG} ${label}`,
                dedup_key: `${TAG}-${fx.suffix}-flag-${label}`,
              },
              flagIds,
              LEDGER.flags
            )
          const flA = await mk('a', fx.entryA)
          const flB = await mk('b', fx.entryB)
          const flVendor = await mk('vendor', null)
          const flClosed = await mk('closed', entryClosed)
          const probe = [flA, flB, flVendor, flClosed]

          const sel = (c: SupabaseClient) => c.from('flags').select('id').in('id', probe)
          const asDept = await sel(fx.deptUser.client)
          expect(asDept.error).toBeNull()
          expect(ids(asDept.data), 'dept sees only flags on its own department\'s entries').toEqual([flA])
          for (const [label, user] of [
            ['admin', fx.adminUser],
            ['superadmin', fx.superadminUser],
          ] as const) {
            const r = await sel(user.client)
            expect((r.data ?? []).map((x) => x.id).sort(numeric), `${label} sees everything`).toEqual(
              [...probe].sort(numeric)
            )
          }

          // delete + insert are not available to any signed-in role
          for (const [label, user] of [
            ['dept', fx.deptUser],
            ['admin', fx.adminUser],
            ['superadmin', fx.superadminUser],
          ] as const) {
            const d = await user.client.from('flags').delete().eq('id', flA).select('id')
            expect(d.error, `${label} flag delete`).not.toBeNull()
            expect(d.error?.code).toBe('42501')
            const i = await user.client
              .from('flags')
              .insert({
                flag_type: 'rate_drift',
                entry_id: fx.entryA,
                description: `${TAG} forged`,
                dedup_key: `${TAG}-${fx.suffix}-flag-forged-${label}`,
              })
              .select('id')
            if (i.data?.[0]) {
              flagIds.push(i.data[0].id as number)
              LEDGER.flags.push(i.data[0].id as number)
            }
            expect(i.error, `${label} flag insert`).not.toBeNull()
            expect(i.error?.code).toBe('42501')
          }

          // dept cannot update (reviewer-or-admin only)
          const deptUpd = await fx.deptUser.client
            .from('flags')
            .update({ status: 'dismissed' })
            .eq('id', flA)
            .select('id')
          expect(deptUpd.error).toBeNull()
          expect(deptUpd.data).toEqual([])

          // forged resolver is overwritten
          const dismissed = await fx.adminUser.client
            .from('flags')
            .update({ status: 'dismissed', resolved_by: fx.deptUser.id, resolved_at: '2000-01-01T00:00:00Z' })
            .eq('id', flA)
            .select('id,resolved_by,resolved_at,status')
          expect(dismissed.error).toBeNull()
          expect(dismissed.data![0]!.resolved_by).toBe(fx.adminUser.id)
          expect(new Date(dismissed.data![0]!.resolved_at as string).getTime()).toBeGreaterThan(Date.now() - 10 * 60_000)

          // type / target are immutable
          for (const patch of [{ flag_type: 'rate_drift' }, { entry_id: fx.entryB }, { dedup_key: `${TAG}-x-${fx.suffix}` }]) {
            const bad = await fx.adminUser.client.from('flags').update(patch).eq('id', flA).select('id')
            expect(bad.error, `rewriting ${JSON.stringify(patch)} must fail`).not.toBeNull()
            expect(bad.error?.code).toBe('42501')
          }

          // closed event: admin matches nothing, superadmin may resolve
          const adminCl = await fx.adminUser.client.from('flags').update({ status: 'confirmed' }).eq('id', flClosed).select('id')
          expect(adminCl.error).toBeNull()
          expect(adminCl.data).toEqual([])
          const superCl = await fx.superadminUser.client.from('flags').update({ status: 'confirmed' }).eq('id', flClosed).select('id')
          expect(superCl.error).toBeNull()
          expect(ids(superCl.data)).toEqual([flClosed])
        } finally {
          // flags.entry_id has no cascade: they must go before their entries.
          await dropTracked('flags', LEDGER.flags, flagIds)
          await dropTracked('entries', LEDGER.entries, extraEntries)
        }
      })
    })
  })
})

// ===========================================================================
describe(`${AUDIT} M11 / D4: board packs and import/export logs are admin-or-above only`, () => {
  it('board_pack table and the board-packs bucket: dept and anon read nothing, admin does, nobody writes', async () => {
    await withFixture({}, async (fx) => {
      const packIds: number[] = []
      const objectPath = `${TAG}-${fx.suffix}/pack.xlsx`
      LEDGER.boardPackObjects.push(objectPath)
      try {
        const packId = await insertTracked(
          'board_pack',
          { xlsx_path: objectPath, kpi_snapshot: { rls_test: RUN_ID } },
          LEDGER.boardPacks
        )
        packIds.push(packId)
        const up = await svc.storage
          .from('board-packs')
          .upload(objectPath, new Blob([`${TAG} board pack ${fx.suffix}`], { type: 'text/plain' }), {
            contentType: 'text/plain',
          })
        expect(up.error, `service-role seed: ${up.error?.message}`).toBeNull()

        const anon = anonClient()
        // table SELECT
        for (const [label, client, expectRows] of [
          ['dept', fx.deptUser.client, false],
          ['anon', anon, false],
          ['admin', fx.adminUser.client, true],
          ['superadmin', fx.superadminUser.client, true],
        ] as const) {
          const r = await client.from('board_pack').select('id').eq('id', packId)
          if (expectRows) {
            expect(r.error).toBeNull()
            expect(ids(r.data), `${label} reads board_pack`).toEqual([packId])
          } else {
            expect(r.data ?? [], `${label} must not read board_pack`).toEqual([])
          }
        }
        // bucket objects
        for (const [label, client, allowed] of [
          ['dept', fx.deptUser.client, false],
          ['anon', anon, false],
          ['admin', fx.adminUser.client, true],
          ['superadmin', fx.superadminUser.client, true],
        ] as const) {
          const dl = await client.storage.from('board-packs').download(objectPath)
          if (allowed) expect(dl.error, `${label} downloads the pack`).toBeNull()
          else expect(dl.error, `${label} must not download the pack`).not.toBeNull()
          const listed = await client.storage.from('board-packs').list(`${TAG}-${fx.suffix}`)
          expect((listed.data ?? []).length > 0, `${label} lists the pack`).toBe(allowed)
        }
        // nobody signed in can write the table or the bucket
        for (const [label, user] of [
          ['dept', fx.deptUser],
          ['admin', fx.adminUser],
          ['superadmin', fx.superadminUser],
        ] as const) {
          const ins = await user.client.from('board_pack').insert({ xlsx_path: `${TAG}-forged-${fx.suffix}`, kpi_snapshot: {} }).select('id')
          if (ins.data?.[0]) {
            packIds.push(ins.data[0].id as number)
            LEDGER.boardPacks.push(ins.data[0].id as number)
          }
          expect(refused(ins), `${label} board_pack insert`).toBe(true)
          const upd = await user.client.from('board_pack').update({ pdf_path: 'x' }).eq('id', packId).select('id')
          expect(refused(upd), `${label} board_pack update`).toBe(true)
          const del1 = await user.client.from('board_pack').delete().eq('id', packId).select('id')
          expect(refused(del1), `${label} board_pack delete`).toBe(true)
          const upload = await user.client.storage
            .from('board-packs')
            .upload(`${TAG}-${fx.suffix}/forged-${label}.xlsx`, new Blob(['x'], { type: 'text/plain' }), {
              contentType: 'text/plain',
            })
          LEDGER.boardPackObjects.push(`${TAG}-${fx.suffix}/forged-${label}.xlsx`)
          expect(upload.error, `${label} board-packs upload`).not.toBeNull()
        }
        const { data: truth } = await svc.from('board_pack').select('id,pdf_path').eq('id', packId).single()
        expect(truth?.pdf_path, 'row must be untouched').toBeNull()
      } finally {
        await dropTracked('board_pack', LEDGER.boardPacks, packIds)
        const gone = await svc.storage.from('board-packs').remove(
          LEDGER.boardPackObjects.filter((p) => p.startsWith(`${TAG}-${fx.suffix}/`))
        )
        if (gone.error) throw new Error(`cleanup board-packs: ${gone.error.message}`)
        forget(
          LEDGER.boardPackObjects,
          LEDGER.boardPackObjects.filter((p) => p.startsWith(`${TAG}-${fx.suffix}/`))
        )
      }
    })
  })

  it('import_batch, import_row_log, status_export_batch and status_export_row: dept reads nothing, admin does, nobody writes', async () => {
    await withFixture({}, async (fx) => {
      const eventId = await getEventId()
      const batchIds: number[] = []
      const exportIds: number[] = []
      try {
        const batchId = await insertTracked(
          'import_batch',
          {
            source_system: 'departmental',
            source_filename: `${TAG}-${fx.suffix}.xlsx`,
            file_hash_sha256: `${TAG}${fx.suffix}`.padEnd(64, '0').slice(0, 64),
            mode: 'dry_run',
            event_id: eventId,
          },
          LEDGER.importBatches
        )
        batchIds.push(batchId)
        const logId = await insertTracked(
          'import_row_log',
          { import_batch_id: batchId, row_number: 1, raw_row_jsonb: { rls_test: RUN_ID }, action: 'skipped_header' },
          []
        )
        const exportId = await insertTracked(
          'status_export_batch',
          { target_system: 'departmental', row_count: 1, event_id: eventId },
          LEDGER.statusBatches
        )
        exportIds.push(exportId)
        const exportRowId = await insertTracked(
          'status_export_row',
          {
            status_export_batch_id: exportId,
            entry_id: fx.entryA,
            ubbl_number: `${TAG}-${fx.suffix}-a`,
            hub_status_code: 'rls_test',
            changed_at: new Date().toISOString(),
          },
          []
        )

        const probes: Array<[string, number]> = [
          ['import_batch', batchId],
          ['import_row_log', logId],
          ['status_export_batch', exportId],
          ['status_export_row', exportRowId],
        ]
        for (const [table, id] of probes) {
          const asDept = await fx.deptUser.client.from(table).select('id').eq('id', id)
          expect(asDept.data ?? [], `dept must not read ${table}`).toEqual([])
          for (const [label, user] of [
            ['admin', fx.adminUser],
            ['superadmin', fx.superadminUser],
          ] as const) {
            const r = await user.client.from(table).select('id').eq('id', id)
            expect(r.error, `${label} ${table}`).toBeNull()
            expect(ids(r.data), `${label} reads ${table}`).toEqual([id])
          }
          const asAnon = await anonClient().from(table).select('id').eq('id', id)
          expect(asAnon.data ?? [], `anon must not read ${table}`).toEqual([])

          // no signed-in role can write these tables directly
          for (const [label, user] of [
            ['dept', fx.deptUser],
            ['admin', fx.adminUser],
          ] as const) {
            const upd = await user.client.from(table).update({ id }).eq('id', id).select('id')
            expect((upd.data ?? []).length, `${label} update ${table} must change nothing`).toBe(0)
            const del1 = await user.client.from(table).delete().eq('id', id).select('id')
            expect((del1.data ?? []).length, `${label} delete ${table} must change nothing`).toBe(0)
          }
        }
        const ins = await fx.adminUser.client
          .from('import_batch')
          .insert({
            source_system: 'departmental',
            source_filename: `${TAG}-forged.xlsx`,
            file_hash_sha256: 'f'.repeat(64),
            event_id: eventId,
          })
          .select('id')
        expect(ins.error, 'admin import_batch insert (imports run over the service role)').not.toBeNull()
      } finally {
        // status_export_row (cascades from its batch) references entries -> drop batches first.
        await dropTracked('status_export_batch', LEDGER.statusBatches, exportIds)
        await dropTracked('import_batch', LEDGER.importBatches, batchIds)
      }
    })
  })
})

// ===========================================================================
describe(`${AUDIT} operational tables: scrape_token, app_settings, auth_login_attempt, api_request_log`, () => {
  it('are readable by admin-or-above only, never writable by a signed-in role, and invisible to anon', async () => {
    await withFixture({}, async (fx) => {
      const tokenIds: number[] = []
      const attemptIds: number[] = []
      const logIds: number[] = []
      try {
        const tokenId = await insertTracked(
          'scrape_token',
          {
            token_hash: `${TAG}-${fx.suffix}-hash`,
            token_prefix: 'rlstest0',
            label: `${TAG} fixture`,
            source_system: 'departmental',
            created_by: fx.adminUser.id,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          LEDGER.scrapeTokens
        )
        tokenIds.push(tokenId)
        const attemptId = await insertTracked(
          'auth_login_attempt',
          { its_number: `${TAG}-${fx.suffix}`, success: false },
          LEDGER.authAttempts
        )
        attemptIds.push(attemptId)
        const logId = await insertTracked(
          'api_request_log',
          { route: `/${TAG}/${fx.suffix}`, method: 'GET', status_code: 200, latency_ms: 1 },
          LEDGER.apiLogs
        )
        logIds.push(logId)

        const tables: Array<[string, number]> = [
          ['scrape_token', tokenId],
          ['auth_login_attempt', attemptId],
          ['api_request_log', logId],
        ]
        for (const [table, id] of tables) {
          const asDept = await fx.deptUser.client.from(table).select('id').eq('id', id)
          expect(asDept.data ?? [], `dept must not read ${table}`).toEqual([])
          const asAnon = await anonClient().from(table).select('id').eq('id', id)
          expect(asAnon.data ?? [], `anon must not read ${table}`).toEqual([])
          for (const [label, user] of [
            ['admin', fx.adminUser],
            ['superadmin', fx.superadminUser],
          ] as const) {
            const r = await user.client.from(table).select('id').eq('id', id)
            expect(r.error, `${label} ${table}`).toBeNull()
            expect(ids(r.data), `${label} reads ${table}`).toEqual([id])
          }
        }

        // auth_login_attempt / api_request_log are append-only from the service role: no signed-in
        // role may insert, update or delete (grants are select-only).
        for (const table of ['auth_login_attempt', 'api_request_log']) {
          const row: Record<string, unknown> =
            table === 'auth_login_attempt'
              ? { its_number: `${TAG}-forged`, success: true }
              : { route: `/${TAG}/forged`, method: 'GET', status_code: 200, latency_ms: 1 }
          const id = table === 'auth_login_attempt' ? attemptId : logId
          for (const [label, user] of [
            ['dept', fx.deptUser],
            ['admin', fx.adminUser],
            ['superadmin', fx.superadminUser],
          ] as const) {
            const ins = await user.client.from(table).insert(row).select('id')
            if (ins.data?.[0]) {
              const list = table === 'auth_login_attempt' ? LEDGER.authAttempts : LEDGER.apiLogs
              list.push(ins.data[0].id as number)
              if (table === 'auth_login_attempt') attemptIds.push(ins.data[0].id as number)
              else logIds.push(ins.data[0].id as number)
            }
            expect(refused(ins), `${label} insert into ${table}`).toBe(true)
            const upd = await user.client.from(table).update({ id }).eq('id', id).select('id')
            expect(refused(upd), `${label} update ${table}`).toBe(true)
            const del1 = await user.client.from(table).delete().eq('id', id).select('id')
            expect(refused(del1), `${label} delete ${table}`).toBe(true)
          }
          const { data: kept } = await svc.from(table).select('id').eq('id', id)
          expect(kept, `${table} fixture row must survive every attempt`).toHaveLength(1)
        }

        // scrape_token: admin-or-above may revoke (update); dept may not; nobody inserts or deletes.
        const deptRevoke = await fx.deptUser.client
          .from('scrape_token')
          .update({ revoked_at: new Date().toISOString() })
          .eq('id', tokenId)
          .select('id')
        expect(deptRevoke.error).toBeNull()
        expect(deptRevoke.data).toEqual([])
        for (const [label, user] of [
          ['dept', fx.deptUser],
          ['admin', fx.adminUser],
          ['superadmin', fx.superadminUser],
        ] as const) {
          const ins = await user.client
            .from('scrape_token')
            .insert({
              token_hash: `${TAG}-${fx.suffix}-forged-${label}`,
              token_prefix: 'forged00',
              source_system: 'departmental',
              created_by: user.id,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            })
            .select('id')
          if (ins.data?.[0]) {
            tokenIds.push(ins.data[0].id as number)
            LEDGER.scrapeTokens.push(ins.data[0].id as number)
          }
          expect(refused(ins), `${label} must not mint a scrape token directly`).toBe(true)
          const del1 = await user.client.from('scrape_token').delete().eq('id', tokenId).select('id')
          expect(refused(del1), `${label} must not delete a scrape token`).toBe(true)
        }
        const { data: tokenKept } = await svc.from('scrape_token').select('id').eq('id', tokenId)
        expect(tokenKept, 'token row survives').toHaveLength(1)
        const adminRevoke = await fx.adminUser.client
          .from('scrape_token')
          .update({ revoked_at: new Date().toISOString(), revoked_by: fx.adminUser.id })
          .eq('id', tokenId)
          .select('id')
        expect(adminRevoke.error).toBeNull()
        expect(ids(adminRevoke.data), 'admin can revoke (that is the intended capability)').toEqual([tokenId])

        // app_settings is a PRE-EXISTING singleton, so it is only ever poked with writes that
        // cannot succeed even if a policy were wrong (a CHECK-violating value, or a filter that
        // can never match). Staff read it; only admin-or-above passes the update policy.
        for (const [label, user] of [
          ['dept', fx.deptUser],
          ['admin', fx.adminUser],
          ['superadmin', fx.superadminUser],
        ] as const) {
          const r = await user.client.from('app_settings').select('id').eq('id', 1)
          expect(r.error).toBeNull()
          expect(ids(r.data), `${label} reads app_settings`).toEqual([1])
        }
        const deptUpd = await fx.deptUser.client.from('app_settings').update({ max_upload_pages: -1 }).eq('id', 1).select('id')
        expect(deptUpd.error, 'dept update is filtered out by RLS before any CHECK could run').toBeNull()
        expect(deptUpd.data).toEqual([])
        const adminUpd = await fx.adminUser.client.from('app_settings').update({ max_upload_pages: -1 }).eq('id', 1).select('id')
        expect(adminUpd.error?.code, 'admin passes the policy and is then stopped by the CHECK (23514) -- nothing written').toBe('23514')
        const insSettings = await fx.adminUser.client.from('app_settings').insert({ id: 2 }).select('id')
        expect(refused(insSettings), 'no signed-in role may add a second settings row').toBe(true)
        const { data: stray } = await svc.from('app_settings').select('id').neq('id', 1)
        expect(stray, 'no second settings row').toEqual([])
        const delSettings = await fx.adminUser.client
          .from('app_settings')
          .delete()
          .eq('id', 1)
          .eq('max_upload_pages', -1) // can never match, so nothing is deleted even if DELETE were granted
          .select('id')
        expect(refused(delSettings), 'app_settings delete').toBe(true)
        const { data: settingsTruth } = await svc.from('app_settings').select('id,max_upload_pages').eq('id', 1).single()
        expect(settingsTruth?.max_upload_pages).toBeGreaterThan(0)
      } finally {
        await dropTracked('scrape_token', LEDGER.scrapeTokens, tokenIds)
        await dropTracked('auth_login_attempt', LEDGER.authAttempts, attemptIds)
        await dropTracked('api_request_log', LEDGER.apiLogs, logIds)
      }
    })
  })

  it('service-role-only tables (pending_upload, auth_hook_failed_attempt) cannot be read or written by any signed-in role or anon', async () => {
    await withFixture({}, async (fx) => {
      const forgedPath = `${TAG}/${fx.suffix}/forged-pending.pdf`
      try {
        const callers: Array<[string, SupabaseClient]> = [
          ['dept', fx.deptUser.client],
          ['admin', fx.adminUser.client],
          ['superadmin', fx.superadminUser.client],
          ['anon', anonClient()],
        ]
        for (const [label, client] of callers) {
          for (const table of ['pending_upload', 'auth_hook_failed_attempt']) {
            const r = await client.from(table).select('*').limit(1)
            expect(r.error, `${label} select ${table}`).not.toBeNull()
            expect(r.data ?? null).toBeNull()
          }
          const ins = await client.from('pending_upload').insert({ path: forgedPath, user_id: fx.deptUser.id })
          expect(ins.error, `${label} insert pending_upload`).not.toBeNull()
          const insHook = await client.from('auth_hook_failed_attempt').insert({ user_id: fx.deptUser.id })
          expect(insHook.error, `${label} insert auth_hook_failed_attempt`).not.toBeNull()
        }
      } finally {
        // Only runs a delete if a forged insert unexpectedly landed -- exact primary key.
        await svc.from('pending_upload').delete().eq('path', forgedPath)
        await svc.from('auth_hook_failed_attempt').delete().eq('user_id', fx.deptUser.id)
      }
    })
  })
})

// ===========================================================================
describe(`${AUDIT} L17: a user cannot rewrite their own login identity`, () => {
  it('blocks its_number / contact_email self-edits (dept and admin), still allows a rename and a superadmin edit', async () => {
    await withFixture({}, async (fx) => {
      const forged = `${TAG}-${fx.suffix}-forged@rls-test.example.com`
      for (const [label, user] of [
        ['dept', fx.deptUser],
        ['admin', fx.adminUser],
      ] as const) {
        for (const patch of [{ its_number: '00000000' }, { contact_email: forged }]) {
          const res = await user.client.from('staff_profile').update(patch).eq('id', user.id).select('id')
          expect(res.error, `${label} self-update ${JSON.stringify(patch)}`).not.toBeNull()
          expect(res.error?.code).toBe('42501')
        }
        const { data: stored } = await svc.from('staff_profile').select('its_number,contact_email').eq('id', user.id).single()
        expect(stored, `${label}: stored identity untouched`).toEqual({ its_number: null, contact_email: null })

        const rename = await user.client
          .from('staff_profile')
          .update({ display_name: `${TAG}-${label}-renamed` })
          .eq('id', user.id)
          .select('id')
        expect(rename.error).toBeNull()
        expect((rename.data ?? []).length).toBe(1)
      }

      // superadmin keeps the right (it is how contact details get corrected).
      const superEdit = await fx.superadminUser.client
        .from('staff_profile')
        .update({ contact_email: forged })
        .eq('id', fx.deptUser.id)
        .select('id')
      expect(superEdit.error).toBeNull()
      expect(ids(superEdit.data)).toEqual([fx.deptUser.id])
    })
  })
})

// ===========================================================================
describe(`${AUDIT} M9 / D8 + L11: hook function and wrapper privileges`, () => {
  it('hook_password_verification_attempt cannot be called through the API by anon or any signed-in role', async () => {
    await withFixture({}, async (fx) => {
      for (const [label, client] of [
        ['anon', anonClient()],
        ['dept', fx.deptUser.client],
        ['admin', fx.adminUser.client],
        ['superadmin', fx.superadminUser.client],
      ] as const) {
        // An empty event is harmless even if it somehow ran (no user_id -> 'continue', no writes).
        const res = await client.rpc('hook_password_verification_attempt', { event: {} })
        expect(res.error, `${label} must not execute the hook`).not.toBeNull()
        expect(res.data ?? null).toBeNull()
      }
    })
  })

  itPg('EXECUTE grants: only supabase_auth_admin runs the hook; anon has none of the four wrappers; authenticated keeps them', async () => {
    await withPg(async (c) => {
      const can = async (role: string, sig: string) =>
        (await c.query('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).rows[0].ok as boolean
      const hook = 'public.hook_password_verification_attempt(jsonb)'
      expect(await can('supabase_auth_admin', hook)).toBe(true)
      for (const role of ['anon', 'authenticated']) expect(await can(role, hook), `${role} on hook`).toBe(false)

      const wrappers = [
        'public.delete_source_document(bigint)',
        'public.cancel_source_document_jobs(bigint)',
        'public.set_source_document_assignees(bigint[], uuid[])',
        'public.next_manual_ubbl_number()',
      ]
      for (const sig of wrappers) {
        expect(await can('anon', sig), `anon on ${sig}`).toBe(false)
        expect(await can('authenticated', sig), `authenticated on ${sig}`).toBe(true)
      }
    })
  })

  itPg('the lockout hook rejects the 11th attempt (even with the right password), never extends the lock, and recovers after 15 minutes', async () => {
    await withFixture({}, async (fx) => {
      await withPg(async (c) => {
        // EVERYTHING here happens inside a transaction that is rolled back: no row survives.
        await c.query('begin')
        try {
          const uid = fx.deptUser.id
          const call = async (valid: boolean, userId: string = uid) =>
            (
              await c.query('select public.hook_password_verification_attempt($1::jsonb) as r', [
                JSON.stringify({ user_id: userId, valid }),
              ])
            ).rows[0].r as { decision: string; message?: string; should_logout_user?: boolean }
          const failures = async () =>
            (
              await c.query('select count(*)::int as n from public.auth_hook_failed_attempt where user_id = $1', [uid])
            ).rows[0].n as number

          for (let i = 0; i < 10; i++) expect((await call(false)).decision, `attempt ${i + 1}`).toBe('continue')
          const lockedRight = await call(true)
          expect(lockedRight.decision, 'right password while locked').toBe('reject')
          expect(lockedRight.message).toMatch(/too many attempts/i)
          expect((await call(false)).decision).toBe('reject')
          expect(await failures(), 'rejected-while-locked attempts are not recorded').toBe(10)

          // after the window the account works again, and a success clears the counter
          await c.query(
            `update public.auth_hook_failed_attempt set created_at = now() - interval '16 minutes' where user_id = $1`,
            [uid]
          )
          expect((await call(true)).decision).toBe('continue')
          expect(await failures()).toBe(0)

          for (let i = 0; i < 3; i++) await call(false)
          expect(await failures()).toBe(3)
          expect((await call(true)).decision).toBe('continue')
          expect(await failures(), 'a successful login clears the counter').toBe(0)

          // fail-open: an id with no auth.users row makes the insert fail inside the hook; sign-in continues
          expect((await call(false, '00000000-0000-4000-8000-00000000dead')).decision).toBe('continue')
        } finally {
          await c.query('rollback')
        }
      })
    })
  })

  // Opt-in because it needs the hook switched on in the Supabase dashboard (Team plan) and it
  // makes 11 real failed sign-ins: run with RLS_TEST_LOCKOUT_HOOK=1 after docs/login-lockout-hook-setup.md.
  const itHookLive = process.env.RLS_TEST_LOCKOUT_HOOK === '1' ? it : it.skip
  itHookLive('LIVE: 11 wrong passwords straight against /auth/v1/token lock a fixture account, even for the right password', async () => {
    const suffix = `${RUN_ID}${Math.random().toString(36).slice(2, 6)}`
    const email = `${TAG}-lockout-${suffix}@rls-test.example.com`
    const password = `Rls!${RUN_ID}${Math.random().toString(36).slice(2, 10)}`
    const { data, error } = await withAuthRetry('createUser(lockout)', () =>
      svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${TAG} lockout` } })
    )
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
    const userId = data.user.id
    LEDGER.users.push(userId)
    try {
      const anon = anonClient()
      for (let i = 0; i < 10; i++) {
        const bad = await anon.auth.signInWithPassword({ email, password: 'definitely-wrong' })
        expect(bad.error, `wrong password #${i + 1}`).not.toBeNull()
      }
      const locked = await anon.auth.signInWithPassword({ email, password })
      expect(locked.error?.message ?? '', 'right password while locked').toMatch(/too many attempts/i)
      expect(locked.data.session).toBeNull()
    } finally {
      await svc.from('staff_profile').delete().eq('id', userId)
      await withAuthRetry(`deleteUser(${userId})`, () => svc.auth.admin.deleteUser(userId))
      forget(LEDGER.users, [userId])
    }
  }, 300_000)
})

// ===========================================================================
describe(`${AUDIT} anonymous sweeps over everything in the public schema`, () => {
  itPg('anon has no EXECUTE on any callable public function', async () => {
    const offenders = await withPg(async (c) => {
      const res = await c.query(`
        select p.oid::regprocedure::text as sig
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
           and has_function_privilege('anon', p.oid, 'EXECUTE')
         order by 1`)
      return res.rows.map((r) => r.sig as string)
    })
    // within_tally_tolerance(a, b) is pure arithmetic (no table access, no data), so anon being
    // able to call it exposes nothing; the reporting views need it executable.
    const harmless = new Set(['within_tally_tolerance(numeric,numeric)'])
    expect(
      offenders.filter((sig) => !harmless.has(sig)),
      'public functions callable by the anonymous role'
    ).toEqual([])
  })

  itPg('every public table has RLS enabled, and no policy in public/storage applies to anon or PUBLIC', async () => {
    const { noRls, loosePolicies } = await withPg(async (c) => {
      const a = await c.query(`
        select c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
         order by 1`)
      const b = await c.query(`
        select schemaname || '.' || tablename || ' :: ' || policyname as p
          from pg_policies
         where schemaname in ('public', 'storage')
           and ('anon' = any (roles) or 'public' = any (roles))
         order by 1`)
      return { noRls: a.rows.map((r) => r.relname as string), loosePolicies: b.rows.map((r) => r.p as string) }
    })
    expect(noRls, 'public tables without row level security').toEqual([])
    expect(loosePolicies, 'policies that apply to anon / PUBLIC').toEqual([])
  })

  itPg('anon reads zero rows from every public table and view it holds SELECT on', async () => {
    const names = await withPg(async (c) => {
      const res = await c.query(`
        select c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and has_table_privilege('anon', c.oid, 'SELECT')
         order by 1`)
      return res.rows.map((r) => r.relname as string)
    })
    const anon = anonClient()
    const leaks: string[] = []
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names.slice(i, i + 8).map(async (name) => {
          const r = await anon.from(name).select('*').limit(1)
          // An error (permission denied / not exposed) is fine; a returned row is a leak.
          if ((r.data ?? []).length > 0) leaks.push(name)
        })
      )
    }
    expect(leaks, `anon-readable tables/views (checked ${names.length})`).toEqual([])
  }, 300_000)

  it('the private schema is not exposed through the API', async () => {
    for (const [label, client] of [
      ['anon', anonClient()],
      ['service role', svc],
    ] as const) {
      const res = await (client as unknown as { schema: (s: string) => SupabaseClient }).schema('private').rpc('is_staff')
      expect(res.error, `${label}: private.is_staff via the API`).not.toBeNull()
      expect(res.data ?? null).toBeNull()
    }
  })
})

// ===========================================================================
// Final safety net: prove nothing this suite created is still in the database.
// ===========================================================================
afterAll(async () => {
  const leftovers: string[] = []

  const sweep = async (table: string, idList: Array<number | string>) => {
    if (idList.length === 0) return
    const { data, error } = await svc.from(table).select('id').in('id', idList)
    if (error) {
      leftovers.push(`${table}: verification query failed — ${error.message}`)
      return
    }
    if ((data ?? []).length > 0) {
      const stillThere = data!.map((r) => r.id)
      // Second attempt, still strictly by primary key.
      await del(table, stillThere)
      const { data: after } = await svc.from(table).select('id').in('id', idList)
      if ((after ?? []).length > 0) leftovers.push(`${table}: ${after!.map((r) => r.id).join(',')}`)
    }
  }

  // [security-audit 2026-10-15] rows that point at entries / users go first.
  await sweep('flags', LEDGER.flags)
  await sweep('reconciliation_exception', LEDGER.exceptions)
  await sweep('status_export_batch', LEDGER.statusBatches)
  await sweep('import_batch', LEDGER.importBatches)
  await sweep('board_pack', LEDGER.boardPacks)
  await sweep('scrape_token', LEDGER.scrapeTokens)
  await sweep('auth_login_attempt', LEDGER.authAttempts)
  await sweep('api_request_log', LEDGER.apiLogs)
  await sweep('source_document', LEDGER.sourceDocuments)
  await sweep('entries', LEDGER.entries)
  await sweep('zone', LEDGER.zones)
  await sweep('admin_head', LEDGER.heads)
  await sweep('vendor', LEDGER.vendors)
  await sweep('job_queue', LEDGER.jobs)
  await sweep('staff_profile', LEDGER.users)
  // staff_department rows cascade-delete with their staff_profile row (on delete
  // cascade, role_rbac_v2 §1), so once staff_profile sweep above confirms every fixture
  // user is gone, their staff_department rows are provably gone too — no separate
  // ledger/sweep entry needed for that table.
  for (const id of LEDGER.users) {
    const { data } = await withAuthRetry(`getUserById(${id})`, () =>
      svc.auth.admin.getUserById(id)
    )
    if (data?.user) {
      await withAuthRetry(`deleteUser(${id})`, () => svc.auth.admin.deleteUser(id))
      const { data: again } = await svc.auth.admin.getUserById(id)
      if (again?.user) leftovers.push(`auth.users: ${id}`)
    }
  }
  await sweep('event', LEDGER.events)
  await sweep('department', LEDGER.departments)

  if (LEDGER.objects.length > 0) {
    for (const path of LEDGER.objects) {
      const { error } = await svc.storage.from(BUCKET).download(path)
      if (!error) {
        await svc.storage.from(BUCKET).remove([path])
        const { error: after } = await svc.storage.from(BUCKET).download(path)
        if (!after) leftovers.push(`storage: ${path}`)
      }
    }
  }

  for (const path of LEDGER.boardPackObjects) {
    const { error } = await svc.storage.from('board-packs').download(path)
    if (!error) {
      await svc.storage.from('board-packs').remove([path])
      const { error: after } = await svc.storage.from('board-packs').download(path)
      if (!after) leftovers.push(`storage(board-packs): ${path}`)
    }
  }

  // Tag sweep — READ ONLY. Catches anything created outside the ledger by a future
  // edit to this file. It reports; it never deletes on a `like` match.
  const tagged = await svc.from('department').select('id,name').like('name', `${TAG}-%`)
  const taggedEntries = await svc.from('entries').select('id,ubbl_number').like('ubbl_number', `${TAG}-%`)
  const taggedEvents = await svc.from('event').select('id,name').like('name', `${TAG}-%`)

  // eslint-disable-next-line no-console
  console.log(
    '\n[rls cleanup] run=%s | ledger: %d entries, %d departments, %d users, %d zones, %d heads, %d vendors, %d jobs, %d objects, %d source_documents',
    RUN_ID,
    LEDGER.entries.length,
    LEDGER.departments.length,
    LEDGER.users.length,
    LEDGER.zones.length,
    LEDGER.heads.length,
    LEDGER.vendors.length,
    LEDGER.jobs.length,
    LEDGER.objects.length,
    LEDGER.sourceDocuments.length
  )
  // eslint-disable-next-line no-console
  console.log(
    '[rls cleanup] residual by id: %s | residual by tag: %d departments, %d entries',
    leftovers.length === 0 ? 'NONE' : leftovers.join(' ; '),
    (tagged.data ?? []).length,
    (taggedEntries.data ?? []).length
  )

  expect(leftovers, 'fixture rows left behind in the live database').toEqual([])
  expect(tagged.data ?? [], 'rls-test departments left behind').toEqual([])
  expect(taggedEntries.data ?? [], 'rls-test entries left behind').toEqual([])
  expect(taggedEvents.data ?? [], 'rls-test events left behind').toEqual([])
}, 120_000)
