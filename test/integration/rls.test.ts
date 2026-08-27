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
  vendors: [] as number[],
  jobs: [] as number[],
  users: [] as string[],
  objects: [] as string[],
}

/** Delete by exact primary key only. An empty id list is a no-op, never a bare DELETE. */
async function del(table: string, ids: Array<number | string>) {
  if (ids.length === 0) return
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
  cleanup: () => Promise<void>
}

type FixtureUser = { id: string; email: string; client: SupabaseClient }

async function makeUser(
  suffix: string,
  label: string,
  role: 'superadmin' | 'admin' | 'dept',
  departmentIds: number[],
  isActive: boolean
): Promise<FixtureUser> {
  const email = `${TAG}-${label}-${suffix}@rls-test.example.com`
  const password = `Rls!${RUN_ID}${Math.random().toString(36).slice(2, 10)}`

  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `${TAG} ${label} ${suffix}` },
  })
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
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
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
      () => del('entries', created.entries),
      async () => {
        if (created.users.length === 0) return
        const { error } = await svc.from('staff_profile').delete().in('id', created.users)
        if (error) throw new Error(`staff_profile: ${error.message}`)
      },
      async () => {
        for (const id of created.users) {
          const { error } = await svc.auth.admin.deleteUser(id)
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
  // 4. Storage bucket policies — §4.3, delete widened to admin-or-above by role_rbac_v2
  // -------------------------------------------------------------------------
  it('applies invoice-documents bucket policies: staff read/upload/replace, admin-or-above delete', async () => {
    await withFixture({ inactive: true }, async (fx) => {
      const path = `${TAG}/${fx.suffix}/invoice.txt`
      fx.objects.push(path)
      LEDGER.objects.push(path)

      const store = (c: SupabaseClient) => c.storage.from(BUCKET)

      // dept (active staff, lowest role) can upload — is_staff(), not a role check.
      const up = await store(fx.deptUser.client).upload(path, new Blob([`${TAG} v1`]), {
        contentType: 'text/plain',
      })
      expect(up.error, `dept upload: ${up.error?.message}`).toBeNull()

      // ...and read it back.
      const down = await store(fx.deptUser.client).download(path)
      expect(down.error).toBeNull()
      expect(await down.data?.text()).toBe(`${TAG} v1`)

      // ...and replace it (upsert needs INSERT + SELECT + UPDATE together, §4.3).
      const replace = await store(fx.deptUser.client).upload(path, new Blob([`${TAG} v2`]), {
        contentType: 'text/plain',
        upsert: true,
      })
      expect(replace.error, `staff replace: ${replace.error?.message}`).toBeNull()
      const down2 = await store(fx.adminUser.client).download(path)
      expect(await down2.data?.text()).toBe(`${TAG} v2`)

      // An unauthenticated caller gets nothing — the bucket is private and every
      // policy is `to authenticated`.
      const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      expect((await anon.storage.from(BUCKET).download(path)).error).not.toBeNull()
      const anonUp = await anon.storage
        .from(BUCKET)
        .upload(`${TAG}/${fx.suffix}/anon.txt`, new Blob(['nope']))
      expect(anonUp.error).not.toBeNull()

      // Deactivated staff: authenticated, but is_staff() is false.
      const dead = fx.inactive!.client
      expect((await dead.storage.from(BUCKET).download(path)).error).not.toBeNull()
      const deadUp = await dead.storage
        .from(BUCKET)
        .upload(`${TAG}/${fx.suffix}/inactive.txt`, new Blob(['nope']))
      expect(deadUp.error).not.toBeNull()

      // Delete is admin-or-above (the "admins delete documents" policy calls the now-
      // widened is_admin() alias). The storage API answers a blocked remove with an
      // empty result rather than an error, so the real assertion is that the object
      // survives.
      await store(fx.deptUser.client).remove([path])
      expect(
        (await svc.storage.from(BUCKET).download(path)).error,
        'dept user must not be able to delete a document'
      ).toBeNull()

      // admin (not just superadmin) CAN delete — a widened capability vs. the old model,
      // where only the single top role could.
      const adminRemove = await store(fx.adminUser.client).remove([path])
      expect(adminRemove.error).toBeNull()
      expect((await svc.storage.from(BUCKET).download(path)).error).not.toBeNull()

      // Second document: confirm dept is blocked here too (not a one-off on the first
      // path) and that superadmin also retains delete.
      const path2 = `${TAG}/${fx.suffix}/invoice-2.txt`
      fx.objects.push(path2)
      LEDGER.objects.push(path2)
      const up2 = await store(fx.deptUser.client).upload(path2, new Blob([`${TAG} v1`]), {
        contentType: 'text/plain',
      })
      expect(up2.error).toBeNull()

      await store(fx.deptUser.client).remove([path2])
      expect(
        (await svc.storage.from(BUCKET).download(path2)).error,
        'dept user must not be able to delete a document (second check)'
      ).toBeNull()

      const superadminRemove = await store(fx.superadminUser.client).remove([path2])
      expect(superadminRemove.error).toBeNull()
      expect((await svc.storage.from(BUCKET).download(path2)).error).not.toBeNull()

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

  it('scopes zone by department but keeps the department list readable to all staff', async () => {
    await withFixture({}, async (fx) => {
      const rows = [
        { department_id: fx.deptA, zone_number: 1, name: `${TAG}-zone-a-${fx.suffix}` },
        { department_id: fx.deptB, zone_number: 1, name: `${TAG}-zone-b-${fx.suffix}` },
      ]
      const { data: zones, error: zErr } = await svc.from('zone').insert(rows).select('id,department_id')
      if (zErr || !zones) throw new Error(`fixture zone: ${zErr?.message}`)
      LEDGER.zones.push(...zones.map((z) => z.id))
      const zoneA = zones.find((z) => z.department_id === fx.deptA)!.id

      try {
        const seen = await fx.deptUser.client
          .from('zone')
          .select('id,department_id')
          .in('department_id', [fx.deptA, fx.deptB])
        expect(seen.error).toBeNull()
        expect(ids(seen.data)).toEqual([zoneA])

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

  await sweep('entries', LEDGER.entries)
  await sweep('zone', LEDGER.zones)
  await sweep('vendor', LEDGER.vendors)
  await sweep('job_queue', LEDGER.jobs)
  await sweep('staff_profile', LEDGER.users)
  // staff_department rows cascade-delete with their staff_profile row (on delete
  // cascade, role_rbac_v2 §1), so once staff_profile sweep above confirms every fixture
  // user is gone, their staff_department rows are provably gone too — no separate
  // ledger/sweep entry needed for that table.
  for (const id of LEDGER.users) {
    const { data } = await svc.auth.admin.getUserById(id)
    if (data?.user) {
      await svc.auth.admin.deleteUser(id)
      const { data: again } = await svc.auth.admin.getUserById(id)
      if (again?.user) leftovers.push(`auth.users: ${id}`)
    }
  }
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

  // Tag sweep — READ ONLY. Catches anything created outside the ledger by a future
  // edit to this file. It reports; it never deletes on a `like` match.
  const tagged = await svc.from('department').select('id,name').like('name', `${TAG}-%`)
  const taggedEntries = await svc.from('entries').select('id,ubbl_number').like('ubbl_number', `${TAG}-%`)

  // eslint-disable-next-line no-console
  console.log(
    '\n[rls cleanup] run=%s | ledger: %d entries, %d departments, %d users, %d zones, %d vendors, %d jobs, %d objects',
    RUN_ID,
    LEDGER.entries.length,
    LEDGER.departments.length,
    LEDGER.users.length,
    LEDGER.zones.length,
    LEDGER.vendors.length,
    LEDGER.jobs.length,
    LEDGER.objects.length
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
}, 120_000)
