import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { TagCarryChart } from '@/components/reports/charts/lazy'
import { toCsv } from '@/lib/reports/csv'
import { loadTagCostReport } from '@/lib/reports/tags'
import { groupHiddenInPane } from '@/lib/reports/surface-sections'
import type { Event } from '@/lib/events/types'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { voidedNote, type TagCostReportRow, type TagEventCostRow, type TagCostReportTotals } from '@/lib/tags/reports-shared'

// docs/entry-tags-plan.md Phase 5 -- "Tags: built vs maintained". For the selected event:
// the tags active in it (decision 10), each tag's cost per event as "built 1448 ₹X ·
// maintained 1449 ₹Y" (decision 15), and the cost carried in from earlier events against
// the cost spent this event. Voided entries never count (decision 11) -- only a small note.
// Every money figure uses full INR grouping (₹2,41,76,880).

// Must match the id registered in lib/reports/surface-sections.ts.
const TAG_COST_SECTION_ID = 'tag-cost-carry'

const RELATION_LABEL: Record<TagEventCostRow['relation'], string> = {
  earlier: 'Earlier',
  this: 'This event',
  later: 'Later',
}

export function TagCostCarrySection({
  rows,
  eventRows,
  totals,
  eventName,
  eventHijriYear,
  insight,
  error,
}: {
  rows: TagCostReportRow[]
  eventRows: TagEventCostRow[]
  totals: TagCostReportTotals
  eventName: string | null
  eventHijriYear: string | null
  insight: string | null
  error: string | null
}) {
  const title = 'Tags: built vs maintained'
  const description =
    'Things paid for once that carry into later events (a washroom block, tent stock) — what each tag active in this event cost in the event it was built and in each event since. Voided entries are left out.'

  if (!eventName || !eventHijriYear) {
    return (
      <ReportSection id={TAG_COST_SECTION_ID} title={title} description={description}>
        <EmptyState title="No event selected" description="Pick an event in the bar above to see its tags." />
      </ReportSection>
    )
  }

  const hasLater = totals.later > 0
  const columns: DataTableColumn<TagCostReportRow>[] = [
    {
      key: 'name',
      header: 'Tag',
      render: (r) => (
        <Link href={`/tags/${r.tagId}`} className="text-primary underline-offset-2 hover:underline">
          {r.name}
        </Link>
      ),
      sortValue: (r) => r.name,
    },
    { key: 'period', header: 'Period', render: (r) => r.periodLabel },
    { key: 'departments', header: 'Departments', render: (r) => r.departmentsLabel || '—' },
    {
      key: 'perEvent',
      header: 'Cost per event',
      render: (r) => r.costSummary || 'No linked spend',
      sortValue: (r) => r.carriedIn + r.thisEvent + r.later,
    },
    {
      key: 'carriedIn',
      header: 'Earlier events ₹',
      align: 'right',
      render: (r) => formatINR(r.carriedIn),
      sortValue: (r) => r.carriedIn,
    },
    {
      key: 'thisEvent',
      header: `${eventHijriYear} ₹`,
      align: 'right',
      render: (r) => formatINR(r.thisEvent),
      sortValue: (r) => r.thisEvent,
    },
    ...(hasLater
      ? [
          {
            key: 'later',
            header: 'Later events ₹',
            align: 'right',
            render: (r) => formatINR(r.later),
            sortValue: (r) => r.later,
          } satisfies DataTableColumn<TagCostReportRow>,
        ]
      : []),
    {
      key: 'voided',
      header: 'Voided',
      align: 'right',
      render: (r) => (r.voidedCount > 0 ? formatNumber(r.voidedCount) : '—'),
      sortValue: (r) => r.voidedCount,
    },
  ]

  const eventColumns: DataTableColumn<TagEventCostRow>[] = [
    { key: 'event', header: 'Event', render: (r) => `${r.name} (${r.hijriYear} H)`, sortValue: (r) => eventRows.indexOf(r) },
    { key: 'relation', header: 'When', render: (r) => RELATION_LABEL[r.relation] },
    { key: 'built', header: 'Built ₹', align: 'right', render: (r) => formatINR(r.built), sortValue: (r) => r.built },
    {
      key: 'maintained',
      header: 'Maintained ₹',
      align: 'right',
      render: (r) => formatINR(r.maintained),
      sortValue: (r) => r.maintained,
    },
    { key: 'total', header: 'Total ₹', align: 'right', render: (r) => formatINR(r.total), sortValue: (r) => r.total },
    { key: 'tags', header: 'Tags with spend', align: 'right', render: (r) => formatNumber(r.tagCount) },
    {
      key: 'voided',
      header: 'Voided',
      align: 'right',
      render: (r) => (r.voidedCount > 0 ? formatNumber(r.voidedCount) : '—'),
      sortValue: (r) => r.voidedCount,
    },
  ]

  const note = voidedNote(totals.voidedCount)
  const combined = totals.carriedIn + totals.thisEvent

  return (
    <ReportSection
      id={TAG_COST_SECTION_ID}
      title={title}
      description={description}
      action={
        rows.length > 0 ? (
          <ExportCsvButton
            filename="tags-built-vs-maintained.csv"
            rowCount={rows.length}
            csv={toCsv(rows, [
              { header: 'Tag', value: (r) => r.name },
              { header: 'Period', value: (r) => r.periodLabel },
              { header: 'Departments', value: (r) => r.departmentsLabel },
              { header: 'Cost per event', value: (r) => r.costSummary },
              { header: 'Earlier events amount', value: (r) => r.carriedIn },
              { header: `${eventHijriYear} amount`, value: (r) => r.thisEvent },
              { header: 'Later events amount', value: (r) => r.later },
              { header: 'Linked entries (not voided)', value: (r) => r.entryCount },
              { header: 'Voided entries', value: (r) => r.voidedCount },
            ])}
          />
        ) : undefined
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the tags" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No tags are active in ${eventHijriYear}`}
          description="Tags record things paid for once that carry into later events. Create one on the Tags page and it shows here for every event in its period."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label={`Tags active in ${eventHijriYear}`}
              value={formatNumber(totals.tagCount)}
              delta={
                totals.newThisEventCount > 0
                  ? `${formatNumber(totals.newThisEventCount)} started this event`
                  : 'All carried in from earlier events'
              }
            />
            <KpiTile
              label="Carried in — spent in earlier events"
              value={formatINR(totals.carriedIn)}
              delta={combined > 0 ? `${Math.round((totals.carriedIn / combined) * 100)}% of their cost so far` : undefined}
            />
            <KpiTile label={`Spent this event (${eventHijriYear})`} value={formatINR(totals.thisEvent)} />
          </div>
          {insight && <p className="text-sm text-muted-foreground">{insight}</p>}
          <TagCarryChart
            bars={rows.map((r) => ({ tagId: r.tagId, name: r.name, carriedIn: r.carriedIn, thisEvent: r.thisEvent }))}
          />
          {totals.withoutCostCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatNumber(totals.withoutCostCount)} {totals.withoutCostCount === 1 ? 'tag has' : 'tags have'} no linked
              spend (for example, something built before this system) and {totals.withoutCostCount === 1 ? 'is' : 'are'}{' '}
              listed in the table only.
            </p>
          )}
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.tagId} />
          {eventRows.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Cost per event, across these tags</h3>
              <p className="text-xs text-muted-foreground">
                Built = spend in the event a tag started; maintained = spend on it in any later event.
              </p>
              <DataTable columns={eventColumns} rows={eventRows} getRowKey={(r) => r.eventId} />
            </div>
          )}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </>
      )}
    </ReportSection>
  )
}

/**
 * The Reports panes' "Tags: built vs maintained" group: loads the report for the selected
 * event and renders the section, or nothing when another report is open in the pane. One
 * copy, used by both app/(app)/reports/page.tsx and app/(app)/reports/budget/page.tsx.
 */
export async function TagCostGroup({ only, selectedEvent }: { only: string | null; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, [TAG_COST_SECTION_ID])) return null
  const tagCost = await loadTagCostReport(selectedEvent)
  return (
    <TagCostCarrySection
      rows={tagCost.rows}
      eventRows={tagCost.eventRows}
      totals={tagCost.totals}
      eventName={tagCost.eventName}
      eventHijriYear={tagCost.eventHijriYear}
      insight={tagCost.insight}
      error={tagCost.error}
    />
  )
}
