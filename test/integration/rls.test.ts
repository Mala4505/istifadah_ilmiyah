/**
 * Live RLS suite — MASTER-PLAN §11.1 Day 7 exit ("RLS suite as three users"), §4.1–§4.4c.
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
 *   4. Fixture departments are brand new, so a "reviewer scoped to department A" in this
 *      suite can see no production data at all, whatever the policies say.
 *
 * The three users of the day-7 exit criterion are `admin`, `reviewer` (scoped to
 * department A) and `viewer` (scoped to department A). A fourth, deactivated staff user
 * is created only by the storage test that needs it (§4.3 "inactive-staff request is
 * rejected").
 *
 * Source of truth for expected behaviour is the migrations, not the plan's snippets:
 *   supabase/migrations/20260808000026_rls_policies.sql   (table policies + grants)
 *   supabase/migrations/20260808000027_storage_policies.sql
 *   supabase/migrations/20260811000003_entries_restructure.sql (current `entries` shape)
 *   supabase/migrations/20260811000004_reporting_views_update.sql (security_invoker views)
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
  adminUser: FixtureUser
  reviewerA: FixtureUser
  viewerA: FixtureUser
  inactive?: FixtureUser
  /** Storage paths created during the test, removed on cleanup. */
  objects: string[]
  cleanup: () => Promise<void>
}

type FixtureUser = { id: string; email: string; client: SupabaseClient }

async function makeUser(
  suffix: string,
  label: string,
  role: 'admin' | 'reviewer' | 'viewer',
  departmentId: number | null,
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

  // `private.handle_new_user()` lands the profile as viewer/inactive by default
  // (20260810000001_its_login.sql). Set the role/department/active state explicitly by
  // exact id rather than relying on user_metadata plumbing, so the test's premise is
  // never in doubt. its_number is deliberately left NULL — the 8-digit ITS namespace is
  // real identity data and this suite must not squat on a value in it.
  const { error: upErr } = await svc
    .from('staff_profile')
    .update({ role, department_id: departmentId, is_active: isActive })
    .eq('id', id)
  if (upErr) throw new Error(`staff_profile setup(${label}): ${upErr.message}`)

  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${label}): ${signInErr.message}`)

  return { id, email, client }
}

async function insertDepartment(suffix: string, letter: 'a' | 'b'): Promise<number> {
  const { data, error } = await svc
    .from('department')
    .insert({ name: `${TAG}-dept-${letter}-${suffix}`, external_code: `${TAG}-${letter}-${suffix}` })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert department ${letter}: ${error?.message}`)
  LEDGER.departments.push(data.id)
  return data.id
}

async function insertEntry(suffix: string, letter: 'a' | 'b', departmentId: number): Promise<number> {
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
    // then the now-unreferenced departments.
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

    const adminUser = await makeUser(suffix, 'admin', 'admin', null, true)
    created.users.push(adminUser.id)
    const reviewerA = await makeUser(suffix, 'reviewer', 'reviewer', deptA, true)
    created.users.push(reviewerA.id)
    const viewerA = await makeUser(suffix, 'viewer', 'viewer', deptA, true)
    created.users.push(viewerA.id)

    let inactive: FixtureUser | undefined
    if (opts.inactive) {
      inactive = await makeUser(suffix, 'inactive', 'reviewer', deptA, false)
      created.users.push(inactive.id)
    }

    fx = {
      suffix,
      deptA,
      deptB,
      entryA,
      entryB,
      adminUser,
      reviewerA,
      viewerA,
      inactive,
      objects,
      cleanup,
    }
    await run(fx)
  } finally {
    // Sign out every session before the accounts disappear.
    for (const u of [fx?.adminUser, fx?.reviewerA, fx?.viewerA, fx?.inactive]) {
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

// ===========================================================================
describe('RLS as three users (admin / reviewer / viewer)', () => {
  // -------------------------------------------------------------------------
  // 1. Department scoping on `entries` — §4.2 entries_select
  // -------------------------------------------------------------------------
  it('scopes entries SELECT to the caller department; admin sees across departments', async () => {
    await withFixture({}, async (fx) => {
      const scope = (c: SupabaseClient) =>
        c.from('entries').select('id,department_id').in('department_id', [fx.deptA, fx.deptB])

      const reviewer = await scope(fx.reviewerA.client)
      expect(reviewer.error).toBeNull()
      expect(ids(reviewer.data)).toEqual([fx.entryA])

      const viewer = await scope(fx.viewerA.client)
      expect(viewer.error).toBeNull()
      expect(ids(viewer.data)).toEqual([fx.entryA])

      // department_id null on the profile = every department (§4.1 can_see_department)
      const admin = await scope(fx.adminUser.client)
      expect(admin.error).toBeNull()
      expect(ids(admin.data)).toEqual([fx.entryA, fx.entryB].sort())

      // Targeting department B's row directly must also return nothing, not an error —
      // a filtered-out row is indistinguishable from a non-existent one.
      const direct = await fx.reviewerA.client.from('entries').select('id').eq('id', fx.entryB)
      expect(direct.error).toBeNull()
      expect(direct.data).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 2. Role enforcement on writes — §4.2 entries_update, §4.4c
  // -------------------------------------------------------------------------
  it('enforces role and department on entries UPDATE', async () => {
    await withFixture({}, async (fx) => {
      // viewer: role not in (admin, reviewer) -> USING fails -> zero rows matched.
      const viewerUpd = await fx.viewerA.client
        .from('entries')
        .update({ remark: 'viewer-should-not-land' })
        .eq('id', fx.entryA)
        .select('id')
      expect(viewerUpd.error).toBeNull()
      expect(viewerUpd.data).toEqual([])
      expect((await readEntry(fx.entryA))?.remark).toBeNull()

      // reviewer, own department: allowed.
      const revOwn = await fx.reviewerA.client
        .from('entries')
        .update({ remark: `${TAG}-reviewer-ok` })
        .eq('id', fx.entryA)
        .select('id')
      expect(revOwn.error).toBeNull()
      expect(ids(revOwn.data)).toEqual([fx.entryA])
      expect((await readEntry(fx.entryA))?.remark).toBe(`${TAG}-reviewer-ok`)

      // reviewer, other department: invisible, so nothing to update.
      const revOther = await fx.reviewerA.client
        .from('entries')
        .update({ remark: 'cross-department-should-not-land' })
        .eq('id', fx.entryB)
        .select('id')
      expect(revOther.error).toBeNull()
      expect(revOther.data).toEqual([])
      expect((await readEntry(fx.entryB))?.remark).toBeNull()

      // admin: across departments.
      const adminA = await fx.adminUser.client
        .from('entries')
        .update({ remark: `${TAG}-admin-a` })
        .eq('id', fx.entryA)
        .select('id')
      expect(adminA.error).toBeNull()
      expect(ids(adminA.data)).toEqual([fx.entryA])

      const adminB = await fx.adminUser.client
        .from('entries')
        .update({ remark: `${TAG}-admin-b` })
        .eq('id', fx.entryB)
        .select('id')
      expect(adminB.error).toBeNull()
      expect(ids(adminB.data)).toEqual([fx.entryB])
      expect((await readEntry(fx.entryB))?.remark).toBe(`${TAG}-admin-b`)
    })
  })

  it("blocks a reviewer from moving a row out of their department (entries_update WITH CHECK)", async () => {
    await withFixture({}, async (fx) => {
      const moved = await fx.reviewerA.client
        .from('entries')
        .update({ department_id: fx.deptB })
        .eq('id', fx.entryA)
        .select('id')
      // USING passes (row is in department A) but WITH CHECK evaluates the NEW row.
      expect(moved.error).not.toBeNull()
      expect(moved.error?.code).toBe('42501')
      expect((await readEntry(fx.entryA))?.department_id).toBe(fx.deptA)
    })
  })

  // -------------------------------------------------------------------------
  // 3. No delete policy anywhere — §4.2, §4.4d
  // -------------------------------------------------------------------------
  it('rejects entries DELETE for every role — loudly, not as a silent no-op', async () => {
    await withFixture({}, async (fx) => {
      for (const [label, user] of [
        ['viewer', fx.viewerA],
        ['reviewer', fx.reviewerA],
        ['admin', fx.adminUser],
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

  it('grants no INSERT on entries to any authenticated role (importers are service_role)', async () => {
    await withFixture({}, async (fx) => {
      for (const [label, user] of [
        ['reviewer', fx.reviewerA],
        ['admin', fx.adminUser],
      ] as const) {
        const res = await user.client
          .from('entries')
          .insert({
            ubbl_number: `${TAG}-${fx.suffix}-insert-${label}`,
            department_id: fx.deptA,
            amount: '1.00',
          })
          .select('id')
        expect(res.error, `${label} insert should error`).not.toBeNull()
        expect(res.error?.code, `${label} insert code`).toBe('42501')
      }
      // Nothing leaked in despite the errors.
      const { data } = await svc
        .from('entries')
        .select('id')
        .like('ubbl_number', `${TAG}-${fx.suffix}-insert-%`)
      expect(data).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 4. Storage bucket policies — §4.3
  // -------------------------------------------------------------------------
  it('applies invoice-documents bucket policies: staff read/upload/replace, admin-only delete', async () => {
    await withFixture({ inactive: true }, async (fx) => {
      const path = `${TAG}/${fx.suffix}/invoice.txt`
      fx.objects.push(path)
      LEDGER.objects.push(path)

      const store = (c: SupabaseClient) => c.storage.from(BUCKET)

      // viewer (active staff, lowest role) can upload — is_staff(), not a role check.
      const up = await store(fx.viewerA.client).upload(path, new Blob([`${TAG} v1`]), {
        contentType: 'text/plain',
      })
      expect(up.error, `viewer upload: ${up.error?.message}`).toBeNull()

      // ...and read it back.
      const down = await store(fx.viewerA.client).download(path)
      expect(down.error).toBeNull()
      expect(await down.data?.text()).toBe(`${TAG} v1`)

      // ...and replace it (upsert needs INSERT + SELECT + UPDATE together, §4.3).
      const replace = await store(fx.reviewerA.client).upload(path, new Blob([`${TAG} v2`]), {
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

      // Delete is admin-only. The storage API answers a blocked remove with an empty
      // result rather than an error, so the real assertion is that the object survives.
      await store(fx.reviewerA.client).remove([path])
      expect(
        (await svc.storage.from(BUCKET).download(path)).error,
        'reviewer must not be able to delete a document'
      ).toBeNull()

      const adminRemove = await store(fx.adminUser.client).remove([path])
      expect(adminRemove.error).toBeNull()
      expect((await svc.storage.from(BUCKET).download(path)).error).not.toBeNull()

      // Nothing left for cleanup to chase, but the path stays registered anyway.
      const stray = await svc.storage.from(BUCKET).list(`${TAG}/${fx.suffix}`)
      expect(stray.data ?? []).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 5. security_invoker reporting views — §4.4
  // -------------------------------------------------------------------------
  it('keeps security_invoker reporting views department-scoped for a reviewer', async () => {
    await withFixture({}, async (fx) => {
      // v_entry_enriched — the join every other view builds on.
      const enriched = await fx.reviewerA.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(enriched.error).toBeNull()
      expect(ids(enriched.data)).toEqual([fx.entryA])

      // v_department_audit_variance — both fixture entries qualify (main_number null,
      // not void), so anything other than [entryA] here is a genuine leak.
      const variance = await fx.reviewerA.client
        .from('v_department_audit_variance')
        .select('entry_id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(variance.error).toBeNull()
      expect((variance.data ?? []).map((r) => r.entry_id).sort()).toEqual([fx.entryA])

      // The viewer role reads reports too (§4.4c) — same scoping.
      const viewerView = await fx.viewerA.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(ids(viewerView.data)).toEqual([fx.entryA])

      // Admin sees both through the same view.
      const adminView = await fx.adminUser.client
        .from('v_entry_enriched')
        .select('id,department_id')
        .in('department_id', [fx.deptA, fx.deptB])
      expect(ids(adminView.data)).toEqual([fx.entryA, fx.entryB].sort())
    })
  })

  // -------------------------------------------------------------------------
  // 6. Everything else in 20260808000026 that the brief did not name
  // -------------------------------------------------------------------------
  it('lets staff read only their own staff_profile and blocks privilege escalation', async () => {
    await withFixture({}, async (fx) => {
      const all = [fx.adminUser.id, fx.reviewerA.id, fx.viewerA.id]

      const own = await fx.viewerA.client.from('staff_profile').select('id,role').in('id', all)
      expect(own.error).toBeNull()
      expect((own.data ?? []).map((r) => r.id)).toEqual([fx.viewerA.id])

      const asAdmin = await fx.adminUser.client.from('staff_profile').select('id').in('id', all)
      expect((asAdmin.data ?? []).map((r) => r.id).sort()).toEqual([...all].sort())

      // A non-admin may edit their own row...
      const rename = await fx.viewerA.client
        .from('staff_profile')
        .update({ display_name: `${TAG}-renamed` })
        .eq('id', fx.viewerA.id)
        .select('id')
      expect(rename.error).toBeNull()
      expect((rename.data ?? []).length).toBe(1)

      // ...but not the locked columns. This is §4.4c ("manage users, roles, department
      // assignment" is admin-only) enforced in the database, not just hidden in the UI.
      for (const patch of [
        { role: 'admin' },
        { department_id: null },
        { is_active: true, role: 'reviewer' },
      ]) {
        const esc = await fx.viewerA.client
          .from('staff_profile')
          .update(patch)
          .eq('id', fx.viewerA.id)
          .select('id')
        expect(esc.error, `escalation via ${JSON.stringify(patch)} must fail`).not.toBeNull()
        expect(esc.error?.code).toBe('42501')
      }

      const { data: stored } = await svc
        .from('staff_profile')
        .select('role,department_id,is_active')
        .eq('id', fx.viewerA.id)
        .single()
      expect(stored).toMatchObject({ role: 'viewer', department_id: fx.deptA, is_active: true })
    })
  })

  it('restricts vendor merges to admin (vendor_update_admin) while all staff can read vendors', async () => {
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
        const read = await fx.reviewerA.client.from('vendor').select('id').eq('id', vendor.id)
        expect(ids(read.data)).toEqual([vendor.id])

        const revUpd = await fx.reviewerA.client
          .from('vendor')
          .update({ is_confirmed: true })
          .eq('id', vendor.id)
          .select('id')
        expect(revUpd.error).toBeNull()
        expect(revUpd.data).toEqual([])

        const adminUpd = await fx.adminUser.client
          .from('vendor')
          .update({ is_confirmed: true })
          .eq('id', vendor.id)
          .select('id')
        expect(adminUpd.error).toBeNull()
        expect(ids(adminUpd.data)).toEqual([vendor.id])
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
        const seen = await fx.reviewerA.client
          .from('zone')
          .select('id,department_id')
          .in('department_id', [fx.deptA, fx.deptB])
        expect(seen.error).toBeNull()
        expect(ids(seen.data)).toEqual([zoneA])

        // department itself is a deliberate exception (documented JUDGEMENT CALL in
        // 20260808000026): all active staff read the full department list, because
        // scoping the dimension table would be circular. Asserted so the exception is
        // recorded behaviour rather than an accident.
        const depts = await fx.reviewerA.client
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

  it('exposes job_queue to admins only (job_queue_select_admin)', async () => {
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
        for (const user of [fx.viewerA, fx.reviewerA]) {
          const res = await user.client.from('job_queue').select('id').eq('id', job.id)
          expect(res.error).toBeNull()
          expect(res.data).toEqual([])
        }
        const asAdmin = await fx.adminUser.client.from('job_queue').select('id').eq('id', job.id)
        expect(asAdmin.error).toBeNull()
        expect(ids(asAdmin.data)).toEqual([job.id])
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
      // is `id = auth.uid() or is_admin()`, deliberately not gated on is_active, so an
      // admin can reactivate them and they can see their own status meanwhile.
      const ownProfile = await dead.from('staff_profile').select('id,is_active').eq('id', fx.inactive!.id)
      expect(ownProfile.error).toBeNull()
      expect(ownProfile.data).toEqual([{ id: fx.inactive!.id, is_active: false }])

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
