import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { friendlyDataError } from '@/lib/friendly-error'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { formatDateTime } from '@/lib/reports/format'
import {
  BoardPackDownloadButton,
  BoardPackGenerateButton,
} from '@/components/reports/sections/board-pack-download'

// Board pack list -- reporting-blueprint.md §5. Recent generated packs for the
// selected event, each with signed-URL download buttons. Server Component: it
// resolves its own event + rows. Parent wires <BoardPackList /> into the
// /reports/brief footer.
//
// A "board pack" row is written only by the scheduled board_pack job
// (lib/jobs/handlers/board-pack.ts); this surface is read + download only,
// plus an admin-only "Generate now" that enqueues an off-schedule run.

const RECENT_LIMIT = 8

type BoardPackRow = {
  id: number
  generated_at: string
  xlsx_path: string | null
  pdf_path: string | null
}

type BoardPackListItem = {
  id: number
  generatedAt: string
  hasPdf: boolean
}

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the parent page and passed in here,
 * rather than this component re-resolving it itself.
 */
export async function BoardPackList({ selectedEvent }: { selectedEvent: Event | null }) {
  const supabase = await createClient()
  const staff = await getStaffContext()
  const eventId = selectedEvent?.id ?? null
  const canGenerate = isAdminOrAbove(staff?.role)

  const { data, error } = await supabase
    .from('board_pack')
    .select('id, generated_at, xlsx_path, pdf_path')
    .eq('event_id', eventId)
    .order('generated_at', { ascending: false })
    .limit(RECENT_LIMIT)
    .returns<BoardPackRow[]>()

  const loadError = friendlyDataError(error, 'reports:boardPackList')
  const rows: BoardPackListItem[] = (data ?? [])
    .filter((r) => r.xlsx_path && r.xlsx_path !== 'pending')
    .map((r) => ({ id: r.id, generatedAt: r.generated_at, hasPdf: Boolean(r.pdf_path) }))

  const columns: DataTableColumn<BoardPackListItem>[] = [
    { key: 'generated', header: 'Generated', render: (r) => formatDateTime(r.generatedAt) },
    {
      key: 'workbook',
      header: 'Workbook',
      render: (r) => <BoardPackDownloadButton boardPackId={r.id} kind="xlsx" />,
    },
    {
      key: 'pdf',
      header: 'PDF',
      render: (r) =>
        r.hasPdf ? <BoardPackDownloadButton boardPackId={r.id} kind="pdf" /> : <span className="text-muted-foreground">—</span>,
    },
  ]

  return (
    <ReportSection
      title="Board pack"
      description="The Executive Brief frozen to a workbook (and a text PDF), generated weekly. Download the latest, or any recent run."
      action={canGenerate ? <BoardPackGenerateButton /> : undefined}
    >
      {loadError ? (
        <EmptyState title="Couldn't load board packs" description={loadError} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No board pack yet"
          description={
            canGenerate
              ? 'The first scheduled run will appear here — or use Generate now.'
              : 'The first scheduled run will appear here.'
          }
        />
      ) : (
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />
      )}
    </ReportSection>
  )
}
