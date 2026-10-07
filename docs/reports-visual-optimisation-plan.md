# Reports visual optimisation plan

Source: chart audit of `/reports` (2026-10-07). Goal: right chart form per
question, no colour bugs, charts that fill their cards and stay legible on
phones. No data/loader/migration changes unless a phase says so.

Shared rules for every phase:
- Follow the `dataviz` skill (form → colour → validate → marks → hover → a11y).
  Run its validator on any new palette.
- CSP: no data-driven inline `style` on HTML elements — use SVG attributes or
  `barWidthClass`/`barLeftClass` (lib/reports/bar-scale.ts).
- Never import a runtime value from a `'use client'` module into a Server
  Component, or a server-only module into a client one.
- Money stays INR-grouped (formatINR / formatINRCompact).
- Raw error text never shown — existing EmptyState/error patterns only.

## Direction change (2026-10-07): shadcn charts
User chose shadcn charts (Recharts 3) with animations. Base is in place:
`recharts@^3.10.1`, `components/ui/chart.tsx` (hand-ported shadcn chart:
ChartContainer / ChartTooltip(Content) / ChartLegend(Content) +
`useChartAnimation()` — one 450ms ease-out on mount, off under reduced
motion), and a `motion-safe:animate-chart-in` Tailwind animation for the
charts that stay custom. CSP style-src is 'unsafe-inline' (middleware.ts), so
Recharts inline styles are fine — bar-scale.ts's "no unsafe-inline" comment is
stale.

Split:
- **Move to Recharts:** spend pace (+ forecast, budget line), donuts,
  spend curve, amount histogram, gap distribution, Benford, entry-type /
  instrument mix / tax exposure stacked bars, department dependency, vendor
  exclusivity, quantity by unit, attention map + new-vendor scatters,
  concentration curve, rate drift (slope), funnel, waterfall.
- **Stay custom** (useChartWidth sizing, 11px labels, shadcn-styled tooltip,
  `animate-chart-in`): heatmap + zone matrices, strip plot, discount dumbbell,
  vendor price ranking, activity timeline, related-party network, purchase
  tree, vendor scorecard grid, KPI sparklines.
Phase 2 (sizing) now only applies to the custom set; Recharts'
ResponsiveContainer handles the rest.

## Phase 1 — Categorical palette + donut colour fixes
1. New `components/reports/charts/categorical-palette.ts`: 6 muted categorical
   hues (light + dark), `strokeClass` / `fillClass` / `bgClass` literals,
   validated with the dataviz validator. Plus a neutral "Other" step.
2. `budget-category-mix.tsx`, `department-budget-explorer-client.tsx`: donut
   segments use the categorical palette (no `i % 4` repeat).
3. `reimbursement-profile.tsx`: colour follows the reimbursement type (stable
   key → hue), not its rank.
4. Severity donuts (open-issues, compliance, open-item-ageing via
   `severitySegments`): weight by ₹ at risk where rows carry it, else label the
   centre "by count".

## Phase 2 — Charts fill their card, text stays readable
1. `components/reports/charts/use-chart-width.ts` (done): ResizeObserver hook.
2. Every fixed-viewBox SVG chart lays out at its measured width (scale 1), so
   it fills wide cards and 9px labels don't shrink to ~5px on phones. Axis
   label floor 10–11px.

## Phase 3 — Share questions get a share chart
1. Entry-type split: event-wide donut (4 types, reimbursement amber) above
   the per-department bars.
2. Instrument-type mix: event-wide donut (5 tiers, existing tier colours).
3. Zone spend: donut when ≤ 6 zones (else top 5 + Other).
4. Admin-head accountability: donut of share of event (top 5 + Other).
5. Vendor concentration: lead with a Top 5 / Next 5 / Everyone else donut;
   keep the curve below for analysts.

## Phase 4 — Rate drift: slope chart
Replace the multi-line chart with a slope chart (first week → latest week per
vendor×family), plus a ranked drift-% list. Keep the table twin.

## Phase 5 — Correct encodings
1. Zone unit-economics matrix: diverging scale centred on 1.0× (cool below
   median, neutral grey at 1.0×, warm above).
2. Spend pace: dotted forecast extension to the event end at current pace,
   and the approved-budget ceiling as a reference line when known.

## Phase 6 — Remove duplicate views
One chart per question. Budget category mix: drop the bar list (donut + table
stays). Sections that render a full DataTable directly under a chart that has
its own "View as table" twin: keep one.

## Status (2026-10-07)
- [x] Phase 1  - [x] Phase 2  - [x] Phase 3
- [x] Phase 4  - [x] Phase 5  - [x] Phase 6
typecheck, lint, 595 unit tests and `next build` pass. NOT yet eyeballed in
a browser (needs auth + live data). Open follow-ups:
- Visual pass at desktop + 360px: label collisions (rate-drift end labels,
  bar-end labels, related-party-network on phones), light-mode grey 1.0×
  zone-matrix cell is faint.
- Bundle: /reports routes now 354–424 kB first load (other pages 230–290 kB)
  — Recharts. Lazy-load chart modules per section if this matters.
- Two near-duplicate tooltip helpers: charts/chart-tooltip-panel.tsx (custom
  SVG charts) and recharts-kit.tsx / tooltip-value-row.tsx (Recharts) — merge.
- ~~Spend-pace budget totals differ between pages~~ — resolved: budget heads
  carry no amounts, so hero-metrics now uses the department + sub-department
  total (v_department_budget_vs_actual, itself the sum of sub-department
  allocations) for both the target pace and the budget line, the same figure
  the Brief's % of budget uses.
- Reports nav tab now lands on /reports/budget?report=budget-vs-actual;
  Explore (/reports) stays reachable from the surface tabs.
