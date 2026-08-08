import { ScreenStub } from '@/components/screen-stub'

export default function ReconciliationPage() {
  return (
    <ScreenStub
      title="Reconciliation"
      badge="Phase 1A · Day 6"
      purpose="Tenant vs Main variance, unmatched-on-either-side, allocation-sum mismatches."
      notes="The report the org currently produces by hand. Reads from v_tenant_main_variance once §10.2's reporting views exist."
    />
  )
}
