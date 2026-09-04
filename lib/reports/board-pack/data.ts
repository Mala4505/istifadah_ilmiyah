/**
 * Board pack -- data assembly. reporting-blueprint.md §5, §8 Phase Six.
 *
 * Composes the pack's `BoardPackData` from the THREE existing Brief loaders --
 * loadHeroMetrics, loadExecutiveBrief, loadWeeklyDigest -- rather than
 * re-querying anything. Server-only (it pulls in the loaders, which pull in
 * @/lib/supabase/server). Called only by lib/jobs/handlers/board-pack.ts.
 *
 * ---------------------------------------------------------------------------
 * The Brief loaders are session-bound -- resolved
 * ---------------------------------------------------------------------------
 * Each of loadHeroMetrics / loadExecutiveBrief / loadWeeklyDigest would, left
 * to itself, call `createClient()` from @/lib/supabase/server -- a client that
 * reads the request's auth cookie and resolves to the Postgres `anon` role
 * when there is no signed-in user. The board_pack job runs from the queue
 * drain (app/api/jobs/tick/route.ts or worker/index.ts) with NO session, so
 * under RLS (every `v_*` view gates on `private.is_staff()`) those loaders
 * would return empty data.
 *
 * Fix (Phase 6, cluster 9): each of the three loaders now takes an optional
 * trailing `client?: SupabaseClient` and does `client ?? await createClient()`.
 * The job handler builds a service-role client (createAdminClient, exactly like
 * flags-run) and this module passes it straight through. Server Components are
 * unaffected -- they still call the loaders with no client and get the
 * cookie-scoped one.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadHeroMetrics } from '@/lib/reports/hero-metrics'
import { loadExecutiveBrief } from '@/lib/reports/executive-brief'
import { loadWeeklyDigest } from '@/lib/reports/weekly-digest'
import type { BoardPackData, BoardPackKpi } from '@/lib/reports/board-pack/types'

export type BoardPackEvent = {
  id: number
  name: string | null
  startsOn: string | null
  endsOn: string | null
}

/** The current event, resolved with a service-role client (no cookie context
 *  in a job). Null when no event is marked current. */
export async function resolveCurrentEvent(admin: SupabaseClient): Promise<BoardPackEvent | null> {
  const { data, error } = await admin
    .from('event')
    .select('id, name, starts_on, ends_on')
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw new Error(`board-pack: could not resolve the current event: ${error.message}`)
  if (!data) return null
  return {
    id: data.id as number,
    name: (data.name as string | null) ?? null,
    startsOn: (data.starts_on as string | null) ?? null,
    endsOn: (data.ends_on as string | null) ?? null,
  }
}

function toKpis(brief: Awaited<ReturnType<typeof loadExecutiveBrief>>): BoardPackKpi[] {
  const k = brief.kpi
  return [
    { label: 'Spend vs budget', value: k.spendVsBudgetValue, delta: k.spendVsBudgetDelta, tone: k.spendVsBudgetTone },
    {
      label: 'Projected landing',
      value: k.projectedLandingValue,
      delta: k.projectedLandingValue !== '—' ? 'of budget, at current pace' : null,
      tone: k.projectedLandingTone,
    },
    { label: k.vendorConcentrationLabel, value: k.vendorConcentrationValue, delta: null, tone: 'neutral' },
    { label: 'Above-median spend', value: k.aboveMedianSpendValue, delta: 'above our own median rate', tone: 'neutral' },
    { label: 'Open ₹ at risk', value: k.openAmountAtRiskValue, delta: null, tone: 'neutral' },
  ]
}

/**
 * Assembles the full pack payload for `event`. `admin` is a service-role
 * client (see the seam note above). Never throws for a loader-level data error
 * -- those become `warnings` on the pack so a partial pack is still produced
 * and labelled.
 */
export async function assembleBoardPackData(
  admin: SupabaseClient,
  event: BoardPackEvent | null
): Promise<BoardPackData> {
  const eventId = event?.id ?? null

  const hero = await loadHeroMetrics(eventId, admin)
  const [brief, digest] = await Promise.all([
    loadExecutiveBrief(eventId, hero.kpi.totalSpend, hero.kpi.openAmountAtRisk, admin),
    loadWeeklyDigest(eventId, admin),
  ])

  const warnings = [
    hero.errors.kpi,
    hero.errors.hubStatus,
    hero.errors.pipeline,
    hero.errors.spendTrend,
    brief.errors.league,
    brief.errors.needsDecision,
    digest.errors.compliance,
    digest.errors.reconciliation,
    digest.errors.budget,
    digest.errors.overpayment,
    digest.errors.rateDrift,
    digest.errors.newVendor,
    digest.errors.owners,
  ].filter((w): w is string => typeof w === 'string' && w.length > 0)

  return {
    eventName: event?.name ?? brief.eventName ?? null,
    generatedAt: new Date().toISOString(),
    eventStartsOn: event?.startsOn ?? brief.eventDates?.starts_on ?? null,
    eventEndsOn: event?.endsOn ?? brief.eventDates?.ends_on ?? null,
    kpis: toKpis(brief),
    narrative: brief.sentences,
    digest: digest.items,
    league: brief.leagueTable,
    needsDecision: brief.needsDecision,
    warnings: Array.from(new Set(warnings)),
  }
}
