import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate, formatMoney } from './format'
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
 * Import fields, read-only (task point 1). Everything here comes from
 * Departmental/Audit via `import-excel` (§3.6) and is never editable on this
 * screen — the section-level "From import" badge marks that once, rather
 * than repeating a badge on every one of ~18 fields.
 */
export function ImportFieldsPanel({
  entry,
  vendorConfirmed,
  budgetHeadRaw,
}: {
  entry: EntryEnriched
  vendorConfirmed: boolean | null
  budgetHeadRaw: string | null
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Import data</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">From import · read-only</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="UBBL number">{entry.ubbl_number}</Field>
        <Field label="Main number">{entry.main_number ?? '—'}</Field>
        <Field label="Type">{entry.type.replace('_', ' ')}</Field>

        <Field label="Department">{entry.department_name ?? '—'}</Field>
        <Field label="Budget head (raw)">
          {budgetHeadRaw ?? entry.budget_head_raw_label ?? '—'}
        </Field>
        <Field label="Budget head (short)">{entry.budget_head_short_label ?? '—'}</Field>

        <Field label="Invoice number">{entry.invoice_number ?? '—'}</Field>
        <Field label="Vendor">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{entry.vendor_display_name ?? entry.vendor_raw ?? '—'}</span>
            {entry.vendor_id && vendorConfirmed === false && (
              <Badge variant="warning">Unconfirmed identity</Badge>
            )}
            {!entry.vendor_id && entry.vendor_raw && (
              <Badge variant="outline">No matched vendor record</Badge>
            )}
          </div>
        </Field>
        <Field label="Date">{formatDate(entry.date)}</Field>

        <Field label="Amount">{formatMoney(entry.amount)}</Field>
        <Field label="Variance reason">{entry.variance_reason ?? '—'}</Field>
        <Field label="Status">
          {entry.status_label ?? '—'}
          {entry.status_raw && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (raw: {entry.status_raw})
            </span>
          )}
        </Field>
        <Field label="Audit status">
          {entry.audit_status_label ?? '—'}
          {entry.audit_status_raw && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (raw: {entry.audit_status_raw})
            </span>
          )}
        </Field>
      </CardContent>
    </Card>
  )
}
