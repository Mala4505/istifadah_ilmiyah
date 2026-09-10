/**
 * The section id/label list for every Reports surface, in one place
 * (redesign plan Phase 3.1a). Before this module each page carried its own
 * inline `SECTIONS`-style array; now `<ReportIndex>` (the left rail) and the
 * surface pages themselves both read from here, so the rail and the pane can
 * never drift out of sync.
 *
 * `id` is the DOM id of the section's card AND the `?report=` value that
 * pins the pane to that one section (Phase 3.3). `label` is the rail text.
 * Order here is the render order on the surface and the rail order.
 *
 * The Executive Brief is deliberately absent: its index lists only
 * `Overview` + pins + a link to Explore (plan Phase 3.3), so it needs no
 * section array.
 */

export type ReportSurface = 'budget' | 'vendors' | 'integrity' | 'explore'

export interface ReportSectionRef {
  /** Section card DOM id; also the `?report=` value that pins the pane. */
  id: string
  /** Left-rail label. */
  label: string
}

/**
 * The pseudo-section every surface rests on when `?report=` is unset — the
 * per-surface overview composition (Phase 3.2). Listed first in every rail.
 */
export const OVERVIEW_SECTION: ReportSectionRef = { id: 'overview', label: 'Overview' }

const BUDGET_SECTIONS: ReportSectionRef[] = [
  { id: 'budget-vs-actual', label: 'Budget vs Actual' },
  { id: 'department-budget-vs-actual', label: 'Department Budget vs Actual' },
  { id: 'sub-department-budget-vs-actual', label: 'Sub-department Budget vs Actual' },
  { id: 'budget-revision-history', label: 'Budget Revision History' },
  { id: 'admin-head-accountability', label: 'Admin-head Accountability' },
  { id: 'zone-spend', label: 'Spend by Zone' },
  { id: 'zone-category-matrix', label: 'Zone × Category Matrix' },
  { id: 'budget-category-mix', label: 'Budget Category Mix' },
  { id: 'entry-type-split', label: 'Entry-type Split by Department' },
  { id: 'outstanding-advance-ageing', label: 'Outstanding Advance Ageing' },
  { id: 'reimbursement-profile', label: 'Reimbursement Profile' },
  { id: 'spend-curve', label: 'Spend Curve & Peak Weeks' },
  { id: 'event-comparison', label: 'Event-over-event Comparison' },
]

const VENDORS_SECTIONS: ReportSectionRef[] = [
  { id: 'vendor-spend', label: 'Vendor Spend' },
  { id: 'vendor-concentration', label: 'Concentration Curve' },
  { id: 'above-median-overpayment', label: 'Above-median Overpayment' },
  { id: 'instrument-type-mix', label: 'Instrument-type Mix' },
  { id: 'spend-by-family', label: 'Spend by Item Family' },
  { id: 'rate-benchmark', label: 'Rate Benchmark' },
  { id: 'purchase-tree', label: 'Purchase Tree' },
  { id: 'vendor-scorecard', label: 'Vendor Scorecard' },
  { id: 'vendor-activity-span', label: 'Vendor Activity Span & Dormancy' },
  { id: 'department-dependency', label: 'Department Dependency' },
  { id: 'vendor-exclusivity', label: 'Vendor Exclusivity' },
  { id: 'new-vendor-first-bill', label: 'New Vendor, First Bill' },
  { id: 'vendor-price-ranking', label: 'Price Ranking per Family' },
  { id: 'related-party-clusters', label: 'Related-party Clusters' },
  { id: 'gstin-tax-exposure', label: 'GSTIN Validity & Tax Exposure' },
  { id: 'rate-drift', label: 'Rate Drift Across the Event' },
  { id: 'discount-consistency', label: 'Discount Consistency' },
  { id: 'quantity-by-unit', label: 'Quantity by Unit' },
  { id: 'zone-unit-economics', label: 'Unit Economics by Zone' },
  { id: 'hsn-gst-anomaly', label: 'HSN Coverage & GST Anomaly' },
  { id: 'vendor-risk-board', label: 'Vendor Risk Board' },
]

const INTEGRITY_SECTIONS: ReportSectionRef[] = [
  { id: 'hub-status-ageing', label: 'Hub-status Ageing' },
  { id: 'open-issues', label: 'Open Issues' },
  { id: 'open-item-ageing', label: 'Open-item Ageing' },
  { id: 'compliance', label: 'Compliance & Leakage' },
  { id: 'exception-heatmap', label: 'Exception Heat Map' },
  { id: 'amount-at-risk-waterfall', label: 'Amount-at-risk Waterfall' },
  { id: 'duplicate-payment-register', label: 'Duplicate Payment Register' },
  { id: 'ledger-bill-reconciliation', label: 'Ledger vs Bill Reconciliation' },
  { id: 'entries-without-bill', label: 'Entries with No Supporting Bill' },
  { id: 'benford-digit-test', label: "Benford's Law Digit Test" },
  { id: 'round-number-bias', label: 'Round-number Bias' },
  { id: 'threshold-splitting', label: 'Threshold Splitting' },
]

/**
 * Explore carries every section in one scroll — the full flat catalogue,
 * kept in exactly the order the pre-Phase-3 inline `SECTIONS` array used so
 * the in-page anchor nav and grid placement are unchanged. Overview is
 * prepended by the page itself (via `OVERVIEW_SECTION`), not stored here.
 */
const EXPLORE_SECTIONS: ReportSectionRef[] = [
  { id: 'budget-vs-actual', label: 'Budget vs Actual' },
  { id: 'department-budget-vs-actual', label: 'Department Budget vs Actual' },
  { id: 'sub-department-budget-vs-actual', label: 'Sub-department Budget vs Actual' },
  { id: 'vendor-spend', label: 'Vendor Spend' },
  { id: 'zone-spend', label: 'Spend by Zone' },
  { id: 'hub-status-ageing', label: 'Hub-status Ageing' },
  { id: 'open-issues', label: 'Open Issues' },
  { id: 'compliance', label: 'Compliance & Leakage' },
  { id: 'spend-by-family', label: 'Spend by Item Family' },
  { id: 'rate-benchmark', label: 'Rate Benchmark' },
  { id: 'vendor-concentration', label: 'Concentration Curve' },
  { id: 'above-median-overpayment', label: 'Above-median Overpayment' },
  { id: 'instrument-type-mix', label: 'Instrument-type Mix' },
  { id: 'exception-heatmap', label: 'Exception Heat Map' },
  { id: 'amount-at-risk-waterfall', label: 'Amount-at-risk Waterfall' },
  { id: 'purchase-tree', label: 'Purchase Tree' },
  { id: 'vendor-scorecard', label: 'Vendor Scorecard' },
  { id: 'vendor-activity-span', label: 'Vendor Activity Span & Dormancy' },
  { id: 'department-dependency', label: 'Department Dependency' },
  { id: 'vendor-exclusivity', label: 'Vendor Exclusivity' },
  { id: 'new-vendor-first-bill', label: 'New Vendor, First Bill' },
  { id: 'vendor-price-ranking', label: 'Price Ranking per Family' },
  { id: 'related-party-clusters', label: 'Related-party Clusters' },
  { id: 'gstin-tax-exposure', label: 'GSTIN Validity & Tax Exposure' },
  { id: 'rate-drift', label: 'Rate Drift Across the Event' },
  { id: 'discount-consistency', label: 'Discount Consistency' },
  { id: 'quantity-by-unit', label: 'Quantity by Unit' },
  { id: 'zone-unit-economics', label: 'Unit Economics by Zone' },
  { id: 'admin-head-accountability', label: 'Admin-head Accountability' },
  { id: 'budget-revision-history', label: 'Budget Revision History' },
  { id: 'zone-category-matrix', label: 'Zone × Category Matrix' },
  { id: 'budget-category-mix', label: 'Budget Category Mix' },
  { id: 'entry-type-split', label: 'Entry-type Split by Department' },
  { id: 'outstanding-advance-ageing', label: 'Outstanding Advance Ageing' },
  { id: 'reimbursement-profile', label: 'Reimbursement Profile' },
  { id: 'spend-curve', label: 'Spend Curve & Peak Weeks' },
  { id: 'event-comparison', label: 'Event-over-event Comparison' },
  { id: 'open-item-ageing', label: 'Open-item Ageing' },
  { id: 'duplicate-payment-register', label: 'Duplicate Payment Register' },
  { id: 'ledger-bill-reconciliation', label: 'Ledger vs Bill Reconciliation' },
  { id: 'entries-without-bill', label: 'Entries with No Supporting Bill' },
  { id: 'benford-digit-test', label: "Benford's Law Digit Test" },
  { id: 'round-number-bias', label: 'Round-number Bias' },
  { id: 'threshold-splitting', label: 'Threshold Splitting' },
  { id: 'hsn-gst-anomaly', label: 'HSN Coverage & GST Anomaly' },
  { id: 'vendor-risk-board', label: 'Vendor Risk Board' },
  { id: 'weekly-digest', label: 'Weekly Digest' },
  { id: 'rupee-provenance', label: 'Rupee Provenance Trace' },
  { id: 'board-packs', label: 'Board Packs' },
]

export const SURFACE_SECTIONS: Record<ReportSurface, ReportSectionRef[]> = {
  budget: BUDGET_SECTIONS,
  vendors: VENDORS_SECTIONS,
  integrity: INTEGRITY_SECTIONS,
  explore: EXPLORE_SECTIONS,
}

/** Every distinct section id across all surfaces — the valid `?report=` set. */
export const ALL_SECTION_IDS: ReadonlySet<string> = new Set(
  Object.values(SURFACE_SECTIONS).flatMap((list) => list.map((s) => s.id)),
)

/** Map a pathname to its surface key, or null for the Brief / non-report routes. */
export function surfaceForPathname(pathname: string): ReportSurface | null {
  if (pathname === '/reports' || pathname === '/reports/') return 'explore'
  if (pathname.startsWith('/reports/budget')) return 'budget'
  if (pathname.startsWith('/reports/vendors')) return 'vendors'
  if (pathname.startsWith('/reports/integrity')) return 'integrity'
  return null
}

/** Resolve `?report=` against a surface's list; unknown / unset ids fall back to Overview. */
export function resolveSection(surface: ReportSurface, reportId: string | null | undefined): ReportSectionRef {
  if (!reportId) return OVERVIEW_SECTION
  return SURFACE_SECTIONS[surface].find((s) => s.id === reportId) ?? OVERVIEW_SECTION
}

/** Look up the label for any section id, across every surface. */
export function labelForSectionId(id: string): string | null {
  for (const list of Object.values(SURFACE_SECTIONS)) {
    const hit = list.find((s) => s.id === id)
    if (hit) return hit.label
  }
  return null
}

/** The route a surface's pane lives at. */
export const SURFACE_BASE_PATH: Record<ReportSurface, string> = {
  budget: '/reports/budget',
  vendors: '/reports/vendors',
  integrity: '/reports/integrity',
  explore: '/reports',
}

/**
 * The "home" surface for a section id — the focused surface that owns it,
 * preferred over Explore (which carries every section). Used to route a pin
 * click to the right pane regardless of which surface the viewer is on.
 */
export function homeSurfaceForSection(id: string): ReportSurface | null {
  for (const surface of ['budget', 'vendors', 'integrity'] as const) {
    if (SURFACE_SECTIONS[surface].some((s) => s.id === id)) return surface
  }
  if (SURFACE_SECTIONS.explore.some((s) => s.id === id)) return 'explore'
  return null
}

/** `?report=` href for a section on a given surface (Overview → the bare surface path). */
export function sectionHref(surface: ReportSurface, id: string | null): string {
  const base = SURFACE_BASE_PATH[surface]
  return id && id !== OVERVIEW_SECTION.id ? `${base}?report=${id}` : base
}

/**
 * Pane-routing gate for a surface page (Phase 3.3). When `?report=` is unset
 * the page renders its `<…Overview />`; when set, every section group is
 * still mounted but each asks this whether it is the selected one. A group
 * whose sections all fail this returns `null` before awaiting its loader, so
 * only the selected section's query runs.
 */
export function isSectionInPane(activeReport: string | null | undefined, id: string): boolean {
  return !activeReport || activeReport === id
}

/** True when a group owning `ids` has nothing to show under the active `?report=`. */
export function groupHiddenInPane(activeReport: string | null | undefined, ids: string[]): boolean {
  return !!activeReport && !ids.includes(activeReport)
}
