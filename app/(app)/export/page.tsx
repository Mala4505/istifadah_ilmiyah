import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { requireAdmin, type AdminGate } from '@/lib/export/auth'
import { getPendingExportQueue, getExportBatchHistory } from '@/lib/export/queries'
import { GenerateBatchForm } from '@/components/export/generate-batch-form'
import { PendingQueueTable } from '@/components/export/pending-queue-table'
import { BatchHistory } from '@/components/export/batch-history'

/**
 * /export — the outward path (MASTER-PLAN §3.7, §5 row 11, §11.1 Day 5).
 * Admin-only (§4.4c). Gated with the session-bound client via
 * `requireAdmin()` BEFORE any admin-client (RLS-bypassing) query runs —
 * see lib/export/auth.ts for why that ordering matters here specifically.
 */
export default async function ExportPage() {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return <PermissionDeniedState reason={gate.reason} />
  }

  let queue: Awaited<ReturnType<typeof getPendingExportQueue>> = []
  let batches: Awaited<ReturnType<typeof getExportBatchHistory>> = []
  let loadError: string | null = null

  try {
    ;[queue, batches] = await Promise.all([getPendingExportQueue(), getExportBatchHistory()])
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Export</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        The two Hub-owned statuses — Awaiting Verification and Awaiting Validation — are the only fields that flow
        back out to Departmental and Main. Generate a batch to snapshot every pending decision into an .xlsx keyed
        on both UBBL Number and Main Entry Number, then deliver it and mark it received. Once generated, a batch is
        never rewritten.
      </p>

      {loadError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Could not load export data: {loadError}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Generate a batch</CardTitle>
              <CardDescription>
                Includes every entry currently pending export, regardless of the target system chosen below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GenerateBatchForm pendingCount={queue.length} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending queue</CardTitle>
              <CardDescription>Hub status set, not yet pushed out ({queue.length}).</CardDescription>
            </CardHeader>
            <CardContent>
              <PendingQueueTable entries={queue} />
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Batch history</h2>
              <p className="text-sm text-muted-foreground">
                Immutable once generated. Download the file, mark it delivered once sent, and mark it acknowledged
                once the module confirms it applied the change.
              </p>
            </div>
            <BatchHistory batches={batches} />
          </div>
        </>
      )}
    </div>
  )
}

function PermissionDeniedState({ reason }: { reason: Extract<AdminGate, { ok: false }>['reason'] }) {
  const copy: Record<string, { title: string; body: string }> = {
    signed_out: {
      title: 'Sign in required',
      body: 'You need to sign in to view the export screen.',
    },
    inactive: {
      title: 'Your account is pending activation',
      body: 'An admin needs to activate your account before you can use the Hub.',
    },
    not_admin: {
      title: 'Admins only',
      body: 'Generating and delivering status export batches is an admin-only action. Ask an admin to run this, or ask to be granted the admin role if you should have access.',
    },
  }
  const { title, body } = copy[reason] ?? copy.not_admin!

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Export</h1>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  )
}
