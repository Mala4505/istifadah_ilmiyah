import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'
import { getAllEvents, getSelectedEventId } from '@/lib/events/current'
import { getMaxUploadPages } from '@/lib/upload-limits'
import { getSettingsSummary } from '@/lib/settings/summary'
import { Card, CardContent } from '@/components/ui/card'
import { EventSwitcher } from '@/components/app-shell/event-switcher'
import { UploadLimitSettings } from '@/components/settings/upload-limit-settings'
import { SettingsList, type SettingsGroup } from '@/components/settings/settings-list'

/**
 * /settings -- Phase 2 redesign, Direction A. One plain fixed-order list
 * of rows, no tabs, no status strip, no charts. Each structural area
 * (Users, Budget heads, Sub-department budgets, Vendors, Master data,
 * Past events) is a focused sub-route under /settings/<x>; the two
 * genuinely in-place controls (active event, upload page limit) render
 * inline here. Counts are plain sublabel text -- never badges, never
 * alerts.
 *
 * This landing page pulls COUNT-ONLY figures (getSettingsSummary); the
 * full per-area row data loads only once you open that area's sub-route,
 * each of which re-runs its own server-side gate (a hidden row is not a
 * permission check).
 *
 * Gate sequence mirrors /export's getStaffContext() pattern: signed-in,
 * then active, then admin-or-above. A plain admin sees only the
 * "Event -- rarely changed" group; every superadmin-only structural row
 * is filtered out here and re-checked at its sub-route regardless.
 */
export const dynamic = 'force-dynamic'

function PageHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
    </div>
  )
}

function GatedState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  )
}

export default async function SettingsPage() {
  const staff = await getStaffContext()
  if (!staff) {
    return <GatedState title="Sign in required" body="You need to sign in to change your settings." />
  }
  if (!staff.isActive) {
    return (
      <GatedState
        title="Your account is pending activation"
        body="An admin needs to activate your account before you can change settings."
      />
    )
  }
  if (!isAdminOrAbove(staff.role)) {
    return (
      <GatedState
        title="Admins only"
        body="Settings, event management, and admin tools are restricted to active admins -- your account does not currently have that role."
      />
    )
  }

  const superadmin = isSuperadmin(staff.role)
  const supabase = await createClient()

  const [events, selectedEventId, maxUploadPages, summary] = await Promise.all([
    getAllEvents(),
    getSelectedEventId(),
    getMaxUploadPages(supabase),
    superadmin ? getSettingsSummary(supabase) : Promise.resolve(null),
  ])

  const pastEventCount = summary?.pastEventCount ?? events.filter((event) => !event.isCurrent).length

  const groups: SettingsGroup[] = []

  if (superadmin && summary) {
    groups.push({
      heading: 'People',
      rows: [
        {
          label: 'Users & roles',
          sublabel: `${summary.activeStaff} active · ${summary.pendingStaff} pending`,
          description:
            'Staff accounts, their role (superadmin / admin / dept) and department assignment. Nobody self-serves into access -- an account only exists once a superadmin creates it here.',
          href: '/settings/users',
        },
      ],
    })
    groups.push({
      heading: 'Money',
      rows: [
        {
          label: 'Budget heads & mapping',
          sublabel: `${summary.budgetHeadCount} · ${summary.unmappedBudgetHeads} unmapped`,
          description:
            'Budget heads are auto-created on import from the source system’s own labels. Mapping one onto an admin head is optional and reversible -- an unmapped head still imports and reconciles fine.',
          href: '/settings/budget-heads',
        },
        {
          label: 'Sub-department budgets',
          sublabel: `${summary.subDeptBudgetSet} set · ${summary.subDeptBudgetMissing} missing`,
          description:
            'Sets a sub-department budget for the current event directly, without waiting for the next budget import. Saving writes a fresh dated snapshot -- append-only, nothing already imported is overwritten. Current event only.',
          href: '/settings/budgets',
        },
      ],
    })
    groups.push({
      heading: 'Directory',
      rows: [
        {
          label: 'Vendors',
          sublabel: `${summary.vendorCount} · ${summary.unconfirmedVendors} unconfirmed`,
          description:
            'Rename vendors (the old spelling is kept as a matching alias) and merge / unmerge vendor identities. Merges affect payment routing, so they are always a human decision here -- never an automatic fuzzy match.',
          href: '/settings/vendors',
        },
        {
          label: 'Master data',
          sublabel: 'read-only reference',
          description:
            'Departments, sub-departments, zones, admin heads and the Hub status lifecycle. Shown read-only by design -- editing these is a migration, not an admin action.',
          href: '/settings/master-data',
        },
      ],
    })
  }

  groups.push({
    heading: 'Event · rarely changed',
    rows: [
      {
        label: 'Active event',
        description:
          'Which event the whole app is scoped to. Switching to a past event puts the app in a view-only state: no new uploads, no verification, no export.',
        control: <EventSwitcher events={events} selectedEventId={selectedEventId} />,
      },
      {
        label: 'Upload page limit',
        description:
          'PDFs with more pages than this are rejected at upload, before any storage or OCR spend.',
        control: <UploadLimitSettings initialMaxUploadPages={maxUploadPages} />,
      },
      {
        label: 'Past events',
        sublabel: `${pastEventCount} past`,
        description:
          'Read-only history of every event, plus the "create the next event" form -- carry forward whichever departments, heads, zones and budget heads still apply.',
        href: '/settings/events',
      },
    ],
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <SettingsList groups={groups} />
    </div>
  )
}
