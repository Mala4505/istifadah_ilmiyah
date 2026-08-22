import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { ResolveExceptionDialog } from '@/components/exceptions/resolve-exception-dialog'
import { exceptionTypeLabel, severityBadgeVariant } from '@/components/exceptions/labels'
import { ResolveFlagDialog } from '@/components/entries/detail/resolve-flag-dialog'
import { formatINR } from '@/lib/reports/format'

// Plain-English labels for flags.flag_type (20260808000025, widened by
// 20260814000003). No shared labels.ts exists for this table (only
// components/exceptions/labels.ts, which is exception-type specific and out
// of scope for this task to edit) — kept local since this is currently the
// only place flags render on a non-queue screen.
const FLAG_TYPE_LABELS: Record<string, string> = {
  vendor_cluster: 'Vendor cluster',
  duplicate_payment: 'Duplicate payment',
  rate_drift: 'Rate drift',
  discount_inconsistency: 'Discount inconsistency',
  missing_documentation: 'Missing documentation',
  vendor_splitting: 'Vendor splitting',
  rate_above_benchmark: 'Rate above benchmark',
  gst_not_charged: 'GST not charged',
  gstin_invalid: 'GSTIN invalid',
  gstin_missing: 'GSTIN missing',
  gst_type_mismatch: 'GST type mismatch',
  gst_rate_anomaly: 'GST rate anomaly',
  tax_math_mismatch: 'Tax math mismatch',
  tds_threshold: 'TDS threshold',
}

function flagTypeLabel(type: string): string {
  return FLAG_TYPE_LABELS[type] ?? type
}

export interface EntryExceptionIssueRow {
  id: number
  exceptionType: string
  severity: string
  description: string | null
  amountAtRisk: number | null
  entryId: number | null
  documentExtractionId: number | null
  sourceDocumentId: number | null
  // Set when this exception was reached only through an attached document
  // (source_document_id, Phase 0 §0.3) rather than entry_id directly — shown
  // so it's clear which document the issue is actually about.
  sourceDocumentFilename: string | null
}

export interface EntryFlagIssueRow {
  id: number
  flagType: string
  severity: string
  description: string | null
  amountAtRisk: number | null
}

/**
 * §3.3 (docs/pre-deploy-findings-and-plan.md) — the entry page had zero
 * references to reconciliation_exception or flags; every open issue only
 * ever surfaced on the separate /exceptions queue. This card lists both
 * categories for this entry — rows tied to it directly (entry_id) and,
 * since Phase 0 §0.3 gave reconciliation_exception a source_document_id,
 * document-level exceptions raised at ingest/extraction against one of this
 * entry's attached PDFs (duplicate_document_hash, page_extraction_failed,
 * page_count_mismatch, page_count_unresolved) — with resolve in place so
 * the workflow doesn't have to leave this screen.
 *
 * Resolve is gated the same way the /exceptions queue gates it
 * (isAdminOrAbove) — the real enforcement is RLS
 * (reconciliation_exception_update / flags_update, both
 * private.is_reviewer_or_admin()), this is just matching the queue's UX.
 */
export function EntryIssues({
  entryId,
  exceptions,
  flags,
  canResolve,
}: {
  entryId: number
  exceptions: EntryExceptionIssueRow[]
  flags: EntryFlagIssueRow[]
  canResolve: boolean
}) {
  const total = exceptions.length + flags.length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Issues</CardTitle>
        <CardDescription>
          {total === 0
            ? 'No open exceptions or flags for this entry or its attached documents.'
            : `${total} open issue${total === 1 ? '' : 's'} — resolve here, or from the Exceptions queue.`}
        </CardDescription>
      </CardHeader>
      {total > 0 && (
        <CardContent className="flex flex-col gap-2">
          {exceptions.map((e) => (
            <div
              key={`exception-${e.id}`}
              className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={severityBadgeVariant(e.severity)}>{e.severity}</Badge>
                  <span className="text-sm font-medium">{exceptionTypeLabel(e.exceptionType)}</span>
                  {e.sourceDocumentFilename && (
                    <span className="text-xs text-muted-foreground">on {e.sourceDocumentFilename}</span>
                  )}
                </div>
                {e.description && <p className="mt-1 text-sm text-muted-foreground">{e.description}</p>}
                {e.amountAtRisk !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">{formatINR(e.amountAtRisk)} at risk</p>
                )}
              </div>
              {canResolve && (
                <div className="flex-shrink-0 self-end sm:self-auto">
                  <ResolveExceptionDialog
                    exceptionId={e.id}
                    amountAtRisk={e.amountAtRisk}
                    description={e.description}
                    exceptionType={e.exceptionType}
                    entryId={e.entryId}
                    documentExtractionId={e.documentExtractionId}
                    sourceDocumentId={e.sourceDocumentId}
                  />
                </div>
              )}
            </div>
          ))}

          {flags.map((f) => (
            <div
              key={`flag-${f.id}`}
              className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={severityBadgeVariant(f.severity)}>{f.severity}</Badge>
                  <span className="text-sm font-medium">{flagTypeLabel(f.flagType)}</span>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                    flag
                  </Badge>
                </div>
                {f.description && <p className="mt-1 text-sm text-muted-foreground">{f.description}</p>}
                {f.amountAtRisk !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">{formatINR(f.amountAtRisk)} at risk</p>
                )}
              </div>
              {canResolve && (
                <div className="flex-shrink-0 self-end sm:self-auto">
                  <ResolveFlagDialog
                    flagId={f.id}
                    entryId={entryId}
                    amountAtRisk={f.amountAtRisk}
                    description={f.description}
                  />
                </div>
              )}
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  )
}
