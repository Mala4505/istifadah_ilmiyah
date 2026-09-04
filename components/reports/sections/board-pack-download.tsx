'use client'

import { useTransition } from 'react'
import { Download, FileSpreadsheet, FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getBoardPackDownloadUrl, enqueueBoardPack } from '@/app/(app)/reports/board-pack-actions'

// Client controls for the board-pack list. Kept free of any value import from a
// server module -- they take plain props and call the server actions directly.

export function BoardPackDownloadButton({
  boardPackId,
  kind,
}: {
  boardPackId: number
  kind: 'xlsx' | 'pdf'
}) {
  const [isPending, startTransition] = useTransition()
  const Icon = kind === 'xlsx' ? FileSpreadsheet : FileText

  function handleClick() {
    startTransition(async () => {
      const result = await getBoardPackDownloadUrl(boardPackId, kind)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if ('url' in result) window.open(result.url, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {kind === 'xlsx' ? 'Workbook' : 'PDF'}
    </Button>
  )
}

export function BoardPackGenerateButton() {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      const result = await enqueueBoardPack()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Board pack queued — it will appear here once the next job tick runs.')
    })
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      {isPending ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Generate now
    </Button>
  )
}
