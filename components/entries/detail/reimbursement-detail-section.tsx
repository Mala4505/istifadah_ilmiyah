import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { EntryEnriched } from './types'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

/**
 * Reimbursement tab fields, read-only. Backed by `reimbursement_detail`
 * (supabase/migrations/20260827000001_entries_type_detail_tables.sql), a 1:1
 * extension of `entries` joined onto `v_entry_enriched` — same import-only,
 * never-editable convention as ImportFieldsPanel.
 */
export function ReimbursementDetailSection({ entry }: { entry: EntryEnriched }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Reimbursement details</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">From import · read-only</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="SR NO">{entry.reimbursement_sr_no ?? '—'}</Field>
        <Field label="Reimbursement type">{entry.reimbursement_type ?? '—'}</Field>
        <Field label="Reimburse to">{entry.reimburse_to_raw ?? '—'}</Field>
      </CardContent>
    </Card>
  )
}
