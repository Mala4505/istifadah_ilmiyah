import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMoney } from './format'
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
 * Advance Payment tab fields, read-only. Backed by `advance_payment_detail`
 * (supabase/migrations/20260827000001_entries_type_detail_tables.sql), a 1:1
 * extension of `entries` joined onto `v_entry_enriched`. `entries.amount` is
 * this tab's "Uplaq Amount" — `advance_invoice_amount` is a separate figure,
 * not a duplicate — same import-only, never-editable convention as
 * ImportFieldsPanel.
 */
export function AdvancePaymentDetailSection({ entry }: { entry: EntryEnriched }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Advance payment details</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">From import · read-only</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Uplaq amount">{formatMoney(entry.amount)}</Field>
        <Field label="Invoice amount">{formatMoney(entry.advance_invoice_amount)}</Field>
      </CardContent>
    </Card>
  )
}
