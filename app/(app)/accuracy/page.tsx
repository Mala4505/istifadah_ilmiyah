import { ScreenStub } from '@/components/screen-stub'

export default function AccuracyPage() {
  return (
    <ScreenStub
      title="Accuracy"
      badge="Phase 1B · Day 5"
      purpose="Per-field agreement rate (7/30/all days), trend, top correction patterns grouped by normalised diff; CSV export."
      notes="Admin-only. The export is what gets sent for a tuning pass (§9.2). Reads from v_extraction_correction."
    />
  )
}
