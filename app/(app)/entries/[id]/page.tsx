import { ScreenStub } from '@/components/screen-stub'

export default async function EntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <ScreenStub
      title={`Entry ${id}`}
      badge="Phase 1A · Day 4"
      purpose="Import fields read-only with a source badge; enrichment fields editable; Hub status control with its own history timeline; linked documents; change history tab."
      notes="The advance-settlement picker lives here. Status control shows 'exported <date>' or 'pending export' once the entries and entry_change_log tables exist."
    />
  )
}
