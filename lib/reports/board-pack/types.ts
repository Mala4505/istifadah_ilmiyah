/**
 * Board pack -- the plain data contract shared by the workbook builder
 * (workbook.ts), the PDF builder (pdf.ts) and the job handler that assembles
 * it (lib/jobs/handlers/board-pack.ts). reporting-blueprint.md §5.
 *
 * LEAF MODULE -- zero framework imports (no next/headers, no supabase client,
 * no React). Both builders are pure functions of a `BoardPackData`; the handler
 * is the only place that touches I/O. Type-only imports from the report loaders
 * are erased at build time, so pulling `DepartmentLeagueRow` / `NeedsDecisionRow`
 * / `WeeklyDigestItem` in here does not create a runtime dependency on those
 * (server-only) modules.
 */

import type { DepartmentLeagueRow, NeedsDecisionRow } from '@/lib/reports/executive-brief'
import type { WeeklyDigestItem } from '@/lib/reports/weekly-digest'

export type { DepartmentLeagueRow, NeedsDecisionRow, WeeklyDigestItem }

/** One headline KPI tile, exactly as the Executive Brief renders it. */
export type BoardPackKpi = {
  label: string
  value: string
  /** The small caption under the value (Brief's `delta`); null when the tile has none. */
  delta: string | null
  tone: 'good' | 'bad' | 'neutral'
}

/**
 * Everything the two renderers need, already resolved to display-ready values.
 * Built once by the handler from loadHeroMetrics + loadExecutiveBrief +
 * loadWeeklyDigest so neither builder re-queries or re-derives anything.
 */
export type BoardPackData = {
  /** Event name, or null when no event is selected/current. */
  eventName: string | null
  /** ISO timestamp the pack was generated (also the workbook/PDF cover date). */
  generatedAt: string
  /** Event window, for the cover line. Either side may be null. */
  eventStartsOn: string | null
  eventEndsOn: string | null

  /** Summary sheet -- the 5 Brief KPI tiles. */
  kpis: BoardPackKpi[]

  /** "What changed this week" -- the Brief's plain sentences (band 2). */
  narrative: string[]

  /** "What changed" sheet -- the weekly digest's ten ranked items. */
  digest: WeeklyDigestItem[]

  /** "Department league" sheet -- E-01, the full table. */
  league: DepartmentLeagueRow[]

  /** "Needs decision" sheet -- E-04, ten rows. */
  needsDecision: NeedsDecisionRow[]

  /** Any non-fatal loader errors, surfaced on the Summary sheet so a pack that
   *  generated against partial data says so rather than looking complete. */
  warnings: string[]
}
