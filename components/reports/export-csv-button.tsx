'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toCsv, downloadCsv, type CsvColumn } from '@/lib/reports/csv'

/**
 * The one reusable CSV export control (MASTER-PLAN §5 row 10: "CSV export on
 * every one"). Generic over the row shape so every report section wires its
 * own columns without re-deriving the download mechanics.
 */
export function ExportCsvButton<T>({
  data,
  columns,
  filename,
  label = 'Export CSV',
}: {
  data: T[]
  columns: CsvColumn<T>[]
  filename: string
  label?: string
}) {
  function handleClick() {
    const csv = toCsv(data, columns)
    downloadCsv(filename, csv)
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={data.length === 0}>
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}
