'use client'

import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadPdfBase64 } from '@/lib/reports/pdf-download'

/**
 * The PDF counterpart to ExportCsvButton -- takes an already-built PDF
 * (base64-encoded, since the bytes are built server-side and this is a
 * Client Component) rather than row data plus column closures.
 */
export function ExportPdfButton({
  base64,
  rowCount,
  filename,
  label = 'Export PDF',
}: {
  base64: string
  rowCount: number
  filename: string
  label?: string
}) {
  function handleClick() {
    downloadPdfBase64(filename, base64)
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={rowCount === 0}>
      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}
