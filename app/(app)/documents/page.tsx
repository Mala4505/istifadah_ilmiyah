import { ScreenStub } from '@/components/screen-stub'

export default function DocumentsPage() {
  return (
    <ScreenStub
      title="Document inbox"
      badge="Phase 1B · Day 3"
      purpose="Unmatched documents with suggested entry matches; attach, mark 'no entry expected', or bulk-attach."
      notes="Highest-volume flow — roughly 18 of the 21 sample documents land here. Waits on lib/storage.ts and the source_document / document_page tables."
    />
  )
}
