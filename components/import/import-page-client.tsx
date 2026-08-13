'use client'

import { useCallback, useState } from 'react'
import { ImportWorkspace } from '@/components/import/import-workspace'
import { PortalReaderWorkspace } from '@/components/import/portal-reader-workspace'
import { BatchHistory } from '@/components/import/batch-history'

/**
 * File upload and the Portal Reader side by side, committed-batch history
 * below spanning both — the two ways rows get into the Hub, one screen.
 * A client wrapper because the batch history needs to refresh after a
 * commit from the upload card, which the page's server component can't do.
 */
export function ImportPageClient({
  isAdmin,
  portalReaderSource,
  hubUrl,
}: {
  isAdmin: boolean
  portalReaderSource: string
  hubUrl: string
}) {
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0)
  const bumpHistory = useCallback(() => setHistoryRefreshSignal((k) => k + 1), [])

  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ImportWorkspace isAdmin={isAdmin} onCommitted={bumpHistory} />
        <PortalReaderWorkspace isAdmin={isAdmin} source={portalReaderSource} hubUrl={hubUrl} />
      </div>
      <BatchHistory isAdmin={isAdmin} refreshSignal={historyRefreshSignal} />
    </div>
  )
}
