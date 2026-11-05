import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatINR } from '@/lib/reports/format'
import {
  buildCostSegments,
  formatCostSummary,
  groupByKey,
  groupScopeByDepartment,
  tagPeriodLabel,
  type DepartmentRef,
  type SubDepartmentRef,
  type TagCostRow,
  type TagRow,
  type TagScopeRow,
} from '@/lib/tags/shared'
import type { Event } from '@/lib/events/types'

/**
 * The tag list: one row per tag active in the selected event. A Server Component -- no
 * interactivity here, the row links to the tag page where super-admins edit.
 */
export function TagListTable({
  tags,
  scope,
  costs,
  notesByTag,
  events,
  departments,
  subDepartments,
  selectedEvent,
}: {
  tags: TagRow[]
  scope: TagScopeRow[]
  costs: TagCostRow[]
  notesByTag: Map<number, string>
  events: Event[]
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  selectedEvent: Event
}) {
  const eventById = new Map(events.map((e) => [e.id, e]))
  const departmentName = (id: number) => departments.find((d) => d.id === id)?.name ?? 'Unknown department'
  const subName = (id: number) => subDepartments.find((s) => s.id === id)?.name ?? 'Unknown'

  const scopeByTag = groupByKey(scope, (row) => row.tag_id)
  const costsByTag = groupByKey(costs, (row) => row.tag_id)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tag</TableHead>
          <TableHead>Period</TableHead>
          <TableHead>Departments</TableHead>
          <TableHead>Cost per event</TableHead>
          <TableHead>Note for {selectedEvent.hijriYear}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tags.map((tag) => {
          const groups = groupScopeByDepartment(scopeByTag.get(tag.id) ?? [], departmentName, subName)
          const summary = formatCostSummary(
            buildCostSegments(tag.start_event_id, costsByTag.get(tag.id) ?? [], events),
            formatINR
          )
          const note = notesByTag.get(tag.id)
          return (
            <TableRow key={tag.id} className="align-top">
              <TableCell className="max-w-64 whitespace-normal py-3">
                <Link href={`/tags/${tag.id}`} className="font-medium text-primary hover:underline">
                  {tag.name}
                </Link>
                {tag.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tag.description}</p>
                )}
              </TableCell>
              <TableCell className="py-3 tabular-nums">
                {tagPeriodLabel(eventById.get(tag.start_event_id), tag.end_event_id ? eventById.get(tag.end_event_id) : null)}
              </TableCell>
              <TableCell className="max-w-72 whitespace-normal py-3">
                {groups.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  groups.map((group) => (
                    <div key={group.departmentId}>
                      {group.departmentName}
                      {group.subDepartmentNames.length > 0 && (
                        <span className="text-muted-foreground"> › {group.subDepartmentNames.join(', ')}</span>
                      )}
                    </div>
                  ))
                )}
              </TableCell>
              <TableCell className="max-w-80 whitespace-normal py-3 tabular-nums">
                {summary || <span className="text-muted-foreground">No spend linked</span>}
              </TableCell>
              <TableCell className="max-w-72 whitespace-normal py-3">
                {note ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
