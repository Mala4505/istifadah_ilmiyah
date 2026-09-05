import { Suspense } from 'react'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedStaffProfile } from '@/lib/export/auth'
import { getSelectedEventId } from '@/lib/events/current'
import {
  getCachedDepartments,
  getCachedCostCenters,
  getCachedEntryStatuses,
  getCachedHubStatuses,
  getCachedAdminHeads,
  getCachedZones,
  getCachedBudgetHeads,
  getCachedEntryTypes,
} from '@/lib/cache/reference-data'
import { EntriesExplorer } from '@/components/entries/entries-explorer'
import { Skeleton } from '@/components/ui/skeleton'
import type { FilterOptions } from '@/components/entries/types'
import type { EntryStatusCount } from '@/components/entries/status-count-chips'
import type { StaffRole } from '@/lib/auth/roles'

type EntryStatusCountRow = {
  dimension: 'status' | 'hub_status' | 'type'
  status_id: number | null
  status_code: string
  status_label: string
  sort_order: number
  entry_count: number
}

// Screen 3 — Entries list (MASTER-PLAN §5 row 3, §11.1 Day 3). Reads from
// `v_entry_enriched` (§10.2) rather than assembling joins here. Filter state
// lives in the URL via useSearchParams, which is why the interactive part is
// a Client Component wrapped in Suspense — useSearchParams opts a subtree
// out of static rendering and Next requires a Suspense boundary around it.
//
// Phase 5 §8.1 (docs/pre-deploy-findings-and-plan.md): Entries used to be the
// slowest screen in the app (3.7s to settle at 14 entries) because
// entries-explorer.tsx fired its filter-dropdown lookups (departments,
// budget heads, admin heads, zones, cost centers, statuses, hub statuses,
// event-membership tables, own role/department) as a client-side useEffect
// chain *after* mount — several sequential/parallel round trips gating first
// paint. Those lookups now happen here, server-side, in one Promise.all
// alongside the page's own render, and land as props on first paint instead
// of a post-mount fetch waterfall. This mirrors the server-fetch-then-props
// pattern app/(app)/reports/page.tsx already uses for its own event-scoped
// queries.
export const dynamic = 'force-dynamic'

async function loadEntriesPageData(): Promise<{
  options: FilterOptions
  role: StaffRole | null
  ownDepartmentIds: number[]
  typeCounts: EntryStatusCount[]
  statusCounts: EntryStatusCount[]
  hubStatusCounts: EntryStatusCount[]
}> {
  const supabase = await createClient()
  const selectedEventId = await getSelectedEventId()

  // Membership ids fetched first (department_id/admin_head_id/zone_id
  // arrays), then used to filter the master-row queries below — mirrors the
  // client-side version this replaced (entries-explorer.tsx, Phase 6 Step 2
  // of docs/event-scoping-and-review-fixes-plan.md §1): a switch to a new
  // event presents its own "clean slate" (§1.1) rather than every master row
  // that has ever existed.
  //
  // Perf audit Phase 2: getCachedAdminHeads/getCachedZones/getCachedBudgetHeads
  // need the current user's id *synchronously* (it's part of their cache
  // key — see lib/cache/reference-data.ts), so getCachedUser() is resolved
  // here alongside the membership queries rather than inside the big
  // Promise.all below. That big Promise.all already waited on this
  // membership step when an event is selected, so folding the user lookup in
  // here doesn't add a new serial wait in that case; only the no-event-
  // selected branch (which previously fired zero queries at this point)
  // gains one extra parallelized round trip.
  const [membership, user] = await Promise.all([
    selectedEventId === null
      ? Promise.resolve([
          { data: [] as { department_id: number }[] },
          { data: [] as { admin_head_id: number }[] },
          { data: [] as { zone_id: number }[] },
        ] as const)
      : Promise.all([
          supabase.from('event_department').select('department_id').eq('event_id', selectedEventId),
          supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId),
          supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId),
        ]),
    getCachedUser(),
  ])
  const [deptMembership, headMembership, zoneMembership] = membership
  const departmentMemberIds = (deptMembership.data ?? []).map((r) => r.department_id)
  const adminHeadMemberIds = (headMembership.data ?? []).map((r) => r.admin_head_id)
  const zoneMemberIds = (zoneMembership.data ?? []).map((r) => r.zone_id)
  const userId = user?.id ?? null

  const [departmentRows, bhRows, adminHeadRows, zoneRows, costCenterRows, statusRows, hubRows, typeRows, statusCountsRes] = await Promise.all([
    getCachedDepartments(supabase),
    getCachedBudgetHeads(supabase, userId),
    getCachedAdminHeads(supabase, userId),
    getCachedZones(supabase, userId),
    getCachedCostCenters(supabase),
    getCachedEntryStatuses(supabase),
    getCachedHubStatuses(supabase),
    getCachedEntryTypes(supabase),
    // Status-count chips (docs/hub-screen-certification.md §3.7). Event-scoped
    // the same way app/(app)/page.tsx scopes this view — a plain
    // `.eq('event_id', ...)`, since v_entry_status_counts.event_id resolves
    // through entries.event_id which is `not null` on the base table.
    supabase
      .from('v_entry_status_counts')
      .select('dimension, status_id, status_code, status_label, sort_order, entry_count')
      .eq('event_id', selectedEventId)
      .returns<EntryStatusCountRow[]>(),
  ])

  // The cached fetchers return the FULL table (active + inactive, every
  // department) — is_active / event-membership filtering that used to be a
  // Postgres predicate now happens here in JS instead, see
  // lib/cache/reference-data.ts's file header for why.
  const dept = departmentRows
    .filter((d) => d.is_active)
    .filter((d) => selectedEventId === null || departmentMemberIds.includes(d.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const adminHead = adminHeadRows
    .filter((h) => h.is_active)
    .filter((h) => selectedEventId === null || adminHeadMemberIds.includes(h.id))
    .sort((a, b) => a.head_number - b.head_number)
  const zone = zoneRows
    .filter((z) => z.is_active)
    .filter((z) => selectedEventId === null || zoneMemberIds.includes(z.id))
    .sort((a, b) => a.zone_number - b.zone_number)

  const options: FilterOptions = {
    departments: dept.map((d) => ({ id: d.id, label: d.name })),
    budgetHeads: bhRows.map((b) => ({
      id: b.id,
      label: b.short_label ?? b.raw_label,
      department_id: b.department_id,
    })),
    adminHeads: adminHead.map((h) => ({ id: h.id, label: `${h.head_number}. ${h.name}`, department_id: h.department_id })),
    zones: zone.map((z) => ({ id: z.id, label: `${z.zone_number}. ${z.name}`, department_id: z.department_id })),
    costCenters: costCenterRows.map((c) => ({ id: c.id, label: c.name })),
    statuses: statusRows.map((s) => ({ id: s.id, label: s.label, code: s.code })),
    hubStatuses: hubRows.map((h) => ({ id: h.id, label: h.label, code: h.code })),
    entryTypes: typeRows.map((t) => ({ id: t.code, label: t.label, code: t.code })),
  }

  let role: StaffRole | null = null
  let ownDepartmentIds: number[] = []
  if (user) {
    const profile = await getCachedStaffProfile(user.id)
    // department_id no longer lives on staff_profile (20260819000003) — a
    // dept account may now hold several departments via staff_department.
    const { data: deptRows } =
      profile?.role === 'dept'
        ? await supabase.from('staff_department').select('department_id').eq('staff_id', user.id)
        : { data: [] as { department_id: number }[] }
    role = (profile?.role as StaffRole | undefined) ?? null
    ownDepartmentIds = (deptRows ?? []).map((d) => d.department_id as number)
  }

  const statusCountRows = statusCountsRes.data ?? []
  // `type` has no numeric id (entries.type is a CHECK-constrained text
  // column, not an FK) -- its code is what `/entries` filters on, so its
  // chips carry `status_code` as `id` instead of the (always-null) status_id.
  const toStatusCounts = (
    dimension: EntryStatusCountRow['dimension'],
    idField: 'status_id' | 'status_code' = 'status_id'
  ): EntryStatusCount[] =>
    statusCountRows
      .filter((r) => r.dimension === dimension)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => ({ id: r[idField], code: r.status_code, label: r.status_label, count: r.entry_count }))

  return {
    options,
    role,
    ownDepartmentIds,
    typeCounts: toStatusCounts('type', 'status_code'),
    statusCounts: toStatusCounts('status'),
    hubStatusCounts: toStatusCounts('hub_status'),
  }
}

export default async function EntriesPage() {
  const { options, role, ownDepartmentIds, typeCounts, statusCounts, hubStatusCounts } = await loadEntriesPageData()

  return (
    <Suspense fallback={<EntriesPageSkeleton />}>
      <EntriesExplorer
        initialOptions={options}
        initialRole={role}
        initialOwnDepartmentIds={ownDepartmentIds}
        typeCounts={typeCounts}
        statusCounts={statusCounts}
        hubStatusCounts={hubStatusCounts}
      />
    </Suspense>
  )
}

function EntriesPageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>
      {/* §4.5: the filter bar is collapsed by default (~40px) — don't paint a
          tall block that collapses on hydration and shoves the table up. */}
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  )
}
