import { ScreenStub } from '@/components/screen-stub'

export default function ImportPage() {
  return (
    <ScreenStub
      title="Import"
      badge="Phase 1A · Day 2"
      purpose="Upload → dry-run preview with per-row diff → commit; batch history."
      notes="The preview is the screen, not a modal. Waits on lib/module-mapping.ts and app/api/import/route.ts."
    />
  )
}
