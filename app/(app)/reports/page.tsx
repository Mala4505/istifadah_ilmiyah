import { ScreenStub } from '@/components/screen-stub'

export default function ReportsPage() {
  return (
    <ScreenStub
      title="Reports"
      badge="Phase 1A · Day 6"
      purpose="Budget vs actual by head; vendor spend; spend by zone; open-issues digest."
      notes="CSV export on every one. Reads from v_budget_vs_actual, v_vendor_spend, v_zone_spend, and v_open_issues (§10.2)."
    />
  )
}
