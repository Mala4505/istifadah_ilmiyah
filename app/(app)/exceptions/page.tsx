import { ScreenStub } from '@/components/screen-stub'

export default function ExceptionsPage() {
  return (
    <ScreenStub
      title="Exceptions"
      badge="Phase 1A · Day 5"
      purpose="Sorted by severity then ₹ at risk; resolve with a note; filter by type."
      notes="Resolution note is required — 'resolved' with no reason is not an audit trail. Waits on the reconciliation_exception table and v_open_issues."
    />
  )
}
