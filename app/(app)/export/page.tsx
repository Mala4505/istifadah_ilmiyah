import { ScreenStub } from '@/components/screen-stub'

export default function ExportPage() {
  return (
    <ScreenStub
      title="Export"
      badge="Phase 1A · Day 5"
      purpose="Queue of entries with a Hub status not yet pushed out; review, generate .xlsx, download, mark delivered/acknowledged; batch history with per-row detail."
      notes="Admin-only. The outward path — re-exports are explicit, prior batches immutable. Waits on status_export_batch/status_export_row and app/api/export-status/route.ts."
    />
  )
}
