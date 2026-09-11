import { buildBudgetUtilizationPdf } from '@/lib/reports/budget-utilization-pdf'
import { DepartmentBudgetExplorerClient } from '@/components/reports/sections/department-budget-explorer-client'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import type { DepartmentBudgetVsActualRow, SubDepartmentBudgetVsActualRow } from '@/lib/reports/sections/shared'

// Server wrapper: builds the Budget Utilization Report PDF once (it's
// department-grained and doesn't depend on the client's drill state) and
// hands the bytes down to the interactive component -- same
// server-builds/client-downloads split department-budget.tsx already uses
// for the same PDF.
export async function DepartmentBudgetExplorerSection({
  deptRows,
  subDeptRows,
  deptError,
  subDeptError,
  compareBasis,
  previousDeptActualTotal,
  eventName = null,
}: {
  deptRows: DepartmentBudgetVsActualRow[]
  subDeptRows: SubDepartmentBudgetVsActualRow[]
  deptError: string | null
  subDeptError: string | null
  compareBasis: CompareBasis
  previousDeptActualTotal: number | null
  eventName?: string | null
}) {
  const generatedAt = new Date()
  const budgetUtilizationBase64 = Buffer.from(
    await buildBudgetUtilizationPdf(deptRows, { eventName, generatedAt })
  ).toString('base64')
  const filenameDate = generatedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')

  return (
    <DepartmentBudgetExplorerClient
      deptRows={deptRows}
      subDeptRows={subDeptRows}
      deptError={deptError}
      subDeptError={subDeptError}
      compareBasis={compareBasis}
      previousDeptActualTotal={previousDeptActualTotal}
      budgetUtilizationBase64={budgetUtilizationBase64}
      budgetUtilizationFilename={`budget-utilization-report-${filenameDate}.pdf`}
    />
  )
}
