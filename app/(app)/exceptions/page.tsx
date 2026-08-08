import { Card, CardContent } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { severityRank } from '@/components/exceptions/labels'
import { ExceptionsFilters } from '@/components/exceptions/exceptions-filters'
import { ExceptionsTable, type ExceptionRow } from '@/components/exceptions/exceptions-table'

/**
 * /exceptions (MASTER-PLAN §3.10, §5 row 8, §11.1 Day 5). Sorted by
 * severity then ₹ at risk descending, filterable by exception_type and by
 * status (open by default — resolved/dismissed stay visible as the audit
 * trail, per §3.10's resolution_note/resolved_by/resolved_at columns).
 *
 * Any active staff can view (reconciliation_exception_select RLS requires
 * only is_staff()); resolving requires reviewer/admin (§4.4c), enforced
 * both by hiding the action here and by RLS in lib/actions/exceptions.ts.
 */
export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>
}) {
  const params = await searchParams
  const status = params.status ?? 'open'
  const type = params.type ?? 'all'

  const staff = await getStaffContext()
  if (!staff) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Sign in required</p>
            <p className="text-sm text-muted-foreground">You need to sign in to view exceptions.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }
  if (!staff.isActive) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Your account is pending activation</p>
            <p className="text-sm text-muted-foreground">An admin needs to activate your account first.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }

  const supabase = await createClient()
  let query = supabase
    .from('reconciliation_exception')
    .select(
      'id, entry_id, exception_type, severity, amount_at_risk, description, status, resolution_note, resolved_at, created_at'
    )

  if (status !== 'all') {
    query = query.eq('status', status)
  }
  if (type !== 'all') {
    query = query.eq('exception_type', type)
  }

  const { data, error } = await query

  const canResolve = staff.role === 'admin' || staff.role === 'reviewer'

  return (
    <PageShell>
      <ExceptionsFilters status={status} type={type} />

      {error ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Could not load exceptions: {error.message}</p>
          </CardContent>
        </Card>
      ) : (
        (() => {
          const exceptions = ((data ?? []) as ExceptionRow[])
            .slice()
            .sort((a, b) => {
              const rankDiff = severityRank(b.severity) - severityRank(a.severity)
              if (rankDiff !== 0) return rankDiff
              const aAmount = a.amount_at_risk ?? -Infinity
              const bAmount = b.amount_at_risk ?? -Infinity
              return bAmount - aAmount
            })

          if (exceptions.length === 0) {
            return <EmptyState isDefaultView={status === 'open' && type === 'all'} />
          }
          return <ExceptionsTable exceptions={exceptions} canResolve={canResolve} />
        })()
      )}
    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Exceptions</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1A · Day 5
        </span>
      </div>
      {children}
    </div>
  )
}

function EmptyState({ isDefaultView }: { isDefaultView: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium">{isDefaultView ? 'No open exceptions' : 'No exceptions match these filters'}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {isDefaultView
          ? "This queue fills in as the importer, OCR pipeline, and reconciliation checks run — line-item tally mismatches, tenant/Main variances, allocation mismatches and the like (§3.10). It's expected to be empty or near-empty until an import has actually committed data and documents have been through review."
          : 'Try a different status or exception type.'}
      </p>
    </div>
  )
}
