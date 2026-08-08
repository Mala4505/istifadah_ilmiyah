import { ScreenStub } from '@/components/screen-stub'

export default function EntriesPage() {
  return (
    <ScreenStub
      title="Entries"
      badge="Phase 1A · Day 3"
      purpose="Filter by department / budget head / head / zone / imported status / Hub status / export-pending / date range / vendor / has-variance / has-document; keyset paginated."
      notes="Bulk Hub-status change with a required note is the primary way staff set awaiting verification/validation at volume. Column chooser, CSV export, saved filters in URL — all pending the entries schema and lib/module-mapping.ts."
    />
  )
}
