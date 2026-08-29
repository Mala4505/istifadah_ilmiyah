import { Card, CardContent } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isSuperadmin } from '@/lib/auth/roles'
import { getAssignmentWorkload } from '@/lib/assignment/workload'
import { WorkloadBoard } from '@/components/documents/workload-board'

/**
 * /documents/workload — the superadmin workload board (document assignment,
 * design §06 "Direction C"). Answers "is the review work spread sensibly, and
 * is anyone's stack going stale?" for the selected event.
 *
 * Superadmin-only. RLS is the real gate (source_document_assignee_select,
 * can_see_source_document — 20260829000002); this page just avoids rendering
 * an empty board to anyone who could not populate it. Gate sequence mirrors
 * /settings' getStaffContext() pattern.
 */
export const dynamic = 'force-dynamic'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Assignment workload</h1>
        <span className="text-sm text-muted-foreground">Superadmin view</span>
      </div>
      {children}
    </div>
  )
}

export default async function DocumentsWorkloadPage() {
  const staff = await getStaffContext()

  if (!staff || !staff.isActive || !isSuperadmin(staff.role)) {
    return (
      <Shell>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-sm font-medium">Superadmins only</p>
            <p className="text-sm text-muted-foreground">
              The workload board is restricted to active superadmins — your account does not currently have that
              role.
            </p>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  const supabase = await createClient()
  const workload = await getAssignmentWorkload(supabase)

  return (
    <Shell>
      <WorkloadBoard pool={workload.pool} perStaff={workload.perStaff} />
    </Shell>
  )
}
