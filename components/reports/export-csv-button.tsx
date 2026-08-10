'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadCsv } from '@/lib/reports/csv'

/**
 * The one reusable CSV export control (MASTER-PLAN §5 row 10: "CSV export on
 * every one"). Takes an already-built CSV string rather than row data plus
 * column accessor functions — this is a Client Component, and the pages that
 * use it are Server Components, so `value: (row) => ...` closures (and the
 * Maps some of them capture) can't cross that boundary. Callers build the
 * string server-side with `toCsv()` and hand over just the string.
 */
export function ExportCsvButton({
  csv,
  rowCount,
  filename,
  label = 'Export CSV',
}: {
  csv: string
  rowCount: number
  filename: string
  label?: string
}) {
  function handleClick() {
    downloadCsv(filename, csv)
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={rowCount === 0}>
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}
