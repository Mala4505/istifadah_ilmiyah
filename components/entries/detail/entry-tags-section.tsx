import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AddToTagControl } from '@/components/entries/detail/add-to-tag-control'
import { EarlierTagsNotice } from '@/components/tags/earlier-tags-notice'
import type { EntryTagSection } from '@/lib/tags/entries-queries'

/**
 * The tags this entry belongs to (a table, each tag linking to /tags/[id]), the "tags from
 * earlier years" notice for the entry's department, and -- for a super-admin -- the Add to
 * tag button. What is listed is whatever RLS lets the viewer see.
 */
export function EntryTagsSection({
  entryId,
  section,
  canTag,
}: {
  entryId: number
  section: EntryTagSection
  canTag: boolean
}) {
  const { tags, notices, error } = section
  // A viewer who cannot tag and has nothing to see gets no empty card.
  if (!canTag && !error && tags.length === 0 && notices.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      <EarlierTagsNotice groups={notices} />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">Tags</CardTitle>
          {canTag && <AddToTagControl entryId={entryId} />}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <FriendlyError message={error} />}
          {tags.length === 0 ? (
            !error && <p className="text-sm text-muted-foreground">This entry is not part of any tag.</p>
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tag</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Departments</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tags.map((tag) => (
                    <TableRow key={tag.id}>
                      <TableCell>
                        <Link href={`/tags/${tag.id}`} className="font-medium hover:underline">
                          {tag.name}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{tag.periodLabel}</TableCell>
                      <TableCell>{tag.departmentNames.join(', ') || '—'}</TableCell>
                      <TableCell className="max-w-md truncate text-muted-foreground">{tag.description ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
