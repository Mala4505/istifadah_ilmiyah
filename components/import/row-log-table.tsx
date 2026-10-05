'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { InteractiveTable } from '@/components/ui/interactive-table'
import { RowLogBadge, actionDisplay } from '@/components/import/row-log-badge'
import { FriendlyError } from '@/components/ui/friendly-error'

export interface RowLogEntry {
  rowNumber: number
  rawRow: Record<string, unknown>
  action: string
  entryId: number | null
  fieldsChanged: Record<string, { from: unknown; to: unknown }> | null
  note?: string | null
}

/**
 * A .xlsx-sourced row's rawRow is keyed by the export's exact column names
 * ("Budget Head", "Vendor Name", ...). A portal-scraped row's rawRow is keyed
 * by whatever header text that portal happens to render ("Vendor", "Amount",
 * "Entry Number", ...) — see the synonym table in lib/import/portal-mapping.ts.
 * Looking up a single exact key left these columns blank for every
 * portal-sourced row even though the data was right there under a different
 * header. This normalizes both the row's own keys and a list of candidate
 * names, so either source resolves to the same display cell.
 */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function pickCell(row: Record<string, unknown>, candidates: readonly string[]): string {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeKey(key), value)
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate)
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  return '—'
}

const BUDGET_HEAD_KEYS = ['budget head', 'budgethead', 'head', 'budget']
const VENDOR_KEYS = ['vendor name', 'vendor', 'party name', 'party', 'supplier name', 'supplier']
const UBBL_KEYS = ['ubbl number', 'ubbl no', 'ubbl', 'entry number', 'entry no']
const MAIN_KEYS = ['main entry number', 'main number', 'main no', 'main']
const INVOICE_AMOUNT_KEYS = ['invoice amount', 'amount', 'total amount', 'total', 'value']
const STATUS_KEYS = ['status', 'entry status', 'departmental status', 'tenant status']
const MAIN_STATUS_KEYS = ['main status', 'audit status', 'approval status']

/**
 * The per-row diff table (MASTER-PLAN §5: "the preview is the screen, not
 * a modal"). Reused for both the dry-run/commit preview and for inspecting
 * a past batch's import_row_log from history.
 *
 * `unchanged` rows are hidden by default. SummaryBadges (rendered alongside
 * this table by every caller) already carries the full per-action counts, so
 * nothing about "how many" is lost — this only trims which rows are worth a
 * human's eyes. On a large scrape (800+ rows, most of them re-confirming a
 * status the Hub already had) the unfiltered table buried the handful of
 * new/changed/error rows an operator actually needs to look at under
 * hundreds of identical "unchanged" lines. Toggle-able, not removed: history
 * review and spot-checking "did row 412 really not change" both still need
 * the full list on demand.
 */
export function RowLogTable({ rows }: { rows: RowLogEntry[] }) {
  const [showUnchanged, setShowUnchanged] = useState(false)

  const unchangedCount = useMemo(() => rows.filter((r) => r.action === 'unchanged').length, [rows])
  const visibleRows = useMemo(
    () => (showUnchanged ? rows : rows.filter((r) => r.action !== 'unchanged')),
    [rows, showUnchanged]
  )

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No rows to show.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {unchangedCount > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {showUnchanged
              ? `Showing all ${rows.length} rows.`
              : `${unchangedCount} unchanged row${unchangedCount === 1 ? '' : 's'} hidden — already matched, nothing to review.`}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setShowUnchanged((v) => !v)}>
            {showUnchanged ? 'Hide unchanged rows' : 'Show unchanged rows'}
          </Button>
        </div>
      )}

      {visibleRows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Every row was unchanged — nothing new to review.
        </div>
      ) : (
        <InteractiveTable
          noun="row"
          searchPlaceholder="Search budget head, vendor, UBBL…"
          columns={[
            { key: 'row', header: 'Row', filterable: false },
            { key: 'action', header: 'Action' },
            { key: 'head', header: 'Budget head', className: 'max-w-[16rem] truncate' },
            { key: 'vendor', header: 'Vendor', filterable: false, className: 'max-w-[14rem] truncate' },
            { key: 'ubbl', header: 'UBBL / Main #', filterable: false, className: 'font-mono text-xs' },
            { key: 'amount', header: 'Invoice amount', align: 'right', descendingFirst: true },
            { key: 'status', header: 'Status (tenant / main)', className: 'text-muted-foreground' },
            {
              key: 'changes',
              header: 'Changed fields',
              filterable: false,
              wrap: true,
              className: 'max-w-[18rem] text-xs text-muted-foreground',
            },
          ]}
          rows={visibleRows.map((r) => {
            const head = pickCell(r.rawRow, BUDGET_HEAD_KEYS)
            const vendor = pickCell(r.rawRow, VENDOR_KEYS)
            const ubbl = pickCell(r.rawRow, UBBL_KEYS)
            const main = pickCell(r.rawRow, MAIN_KEYS)
            const amount = pickCell(r.rawRow, INVOICE_AMOUNT_KEYS)
            const status = `${pickCell(r.rawRow, STATUS_KEYS)} / ${pickCell(r.rawRow, MAIN_STATUS_KEYS)}`
            const changes =
              r.fieldsChanged && Object.keys(r.fieldsChanged).length > 0
                ? Object.entries(r.fieldsChanged)
                    .map(([field, change]) => `${field}: ${String(change.from ?? '—')} → ${String(change.to ?? '—')}`)
                    .join('; ')
                : ''
            return {
              key: r.rowNumber,
              className: r.action === 'error' ? 'bg-destructive/5' : undefined,
              cells: [
                <span key="n" className="text-muted-foreground">
                  {r.rowNumber}
                </span>,
                <RowLogBadge key="a" action={r.action} />,
                head,
                vendor,
                <span key="u">
                  {r.entryId !== null ? (
                    <Link href={`/entries/${r.entryId}`} className="text-primary underline-offset-2 hover:underline">
                      {ubbl}
                    </Link>
                  ) : (
                    ubbl
                  )}
                  {main !== '—' ? <span className="text-muted-foreground"> / {main}</span> : null}
                </span>,
                amount,
                status,
                r.action === 'error' && r.note ? (
                  <FriendlyError key="c" message={r.note} />
                ) : r.fieldsChanged && Object.keys(r.fieldsChanged).length > 0 ? (
                  <ul key="c" className="space-y-0.5">
                    {Object.entries(r.fieldsChanged).map(([field, change]) => (
                      <li key={field}>
                        <span className="font-medium text-foreground">{field}</span>:{' '}
                        {String(change.from ?? '—')} → {String(change.to ?? '—')}
                      </li>
                    ))}
                  </ul>
                ) : (
                  '—'
                ),
              ],
              texts: [
                String(r.rowNumber),
                actionDisplay(r.action).label,
                head,
                vendor,
                main !== '—' ? `${ubbl} / ${main}` : ubbl,
                amount,
                status,
                r.action === 'error' && r.note ? r.note : changes,
              ],
            }
          })}
        />
      )}
    </div>
  )
}
