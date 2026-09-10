# Reports / Settings / Workload — redesign execution plan

**Execute with:** `exe-now docs/reports-settings-workload-redesign-plan.md phase <N>`
(the root `plan.md` is an unrelated, stale historical OCR doc — ignore it; this is the live plan.)

Design proposal & mockups: https://claude.ai/code/artifact/1f795841-fd37-4cca-a192-961708f2f235 (rev 4)
Rationale for the Reports direction: `docs/reporting-blueprint.md` §5–§6.

## Decisions (user, 2026-09-09)

| Surface | Decision |
|---|---|
| **Settings** | **Direction A** — one plain fixed-order list of rows, edited in place. No tabs, no status strip, no charts. Structural areas become focused sub-routes. |
| **Workload** | Fold `/documents/workload` into `/documents` as a superadmin **Inbox / Workload** toggle. Drop the nav item. |
| **Reports** | One workspace: left index + right pane. Pane rests on a per-surface **overview** (hero tiles → 2 flagship charts → disclosure); selecting a report swaps the pane to that one section at full fidelity. Insight sentence under every chart. `★ My reports` pins. Executive Brief keeps its body. |

No new report, query pattern, or schema object anywhere in this plan. Presentation and routing only.

## Rules for every phase

- **Branch per phase.** No `git add` / `commit` / `push` at any point unless the user explicitly says so — this applies to the orchestrator **and every subagent** (state it verbatim in each subagent prompt).
- **Foundation first, then fan out.** Do the shared/loader refactor in the orchestrator, land it, *then* dispatch parallel subagents onto disjoint file sets. Never two agents guessing the same seam.
- **Gate on:** `npx tsc --noEmit` + `npm run lint` + `npx vitest run` + `npx next build`, after the foundation step and again after integrating all subagents (not just each agent's own green report).
- **Browser check gap:** no test credentials / no dev-staging project in this environment. Deliver each phase static-green and list what still needs a human to click. Do not claim visual verification.
- Recommended order: **Phase 1 → 2 → 3** (smallest blast radius first).

---

## Phase 1 — Workload into Documents  ·  effort S  ·  no parallelism needed

### 1.1 Remove the nav item
`components/app-shell/nav-rail.tsx` — delete the `{ label: 'Workload', href: '/documents/workload', … superadminOnly: true }` entry from `NAV_ITEMS`; drop the now-unused `Scale` import.

### 1.2 Add the toggle to Documents
`app/(app)/documents/page.tsx` — read `?view=` from `searchParams`. For a superadmin only, render an `Inbox | Workload` segmented link control (pattern: `components/app-shell/report-surface-nav.tsx`) above `BillKpiBar`.
- `view=workload` → `await getAssignmentWorkload(supabase)` + `<WorkloadBoard pool={…} perStaff={…} />` in its own `<Suspense>`; skip the inbox queries.
- default / `view=inbox` / non-superadmin → existing inbox untouched.

### 1.3 Redirect the old route
`app/(app)/documents/workload/page.tsx` — replace the body with `redirect('/documents?view=workload')`. Keep the folder. Simplify `app/(app)/documents/workload/loading.tsx` to a bare skeleton or delete it.

### 1.4 Verify
Static gate (above). Manual checklist for the user: superadmin toggle flips inbox↔board; `?view=workload` deep-links; `/documents/workload` redirects; non-superadmin sees no toggle and the redirect lands on their normal inbox.

**Out of scope:** drag-to-reassign. Board stays read-only.

---

## Phase 2 — Settings as one plain list (Direction A)  ·  effort S–M

### 2.1 Foundation (orchestrator, serial — do first, land before 2.2)

**2.1a** `lib/settings/summary.ts` — `getSettingsSummary(supabase)` returning count-only figures:
`{ activeStaff, pendingStaff, budgetHeadCount, unmappedBudgetHeads, vendorCount, unconfirmedVendors, subDeptBudgetSet, subDeptBudgetMissing, pastEventCount }`. Use `head:true, count:'exact'` queries — no row payloads.

**2.1b** Split `loadSuperadminData` (the 13-query `Promise.all` in `app/(app)/settings/page.tsx`) into per-area loaders in `lib/settings/`:
`loadUsers`, `loadBudgetHeads`, `loadSubDeptBudgets`, `loadVendors`, `loadMasterData`, each taking `(supabase, eventId?)`. Keep behaviour identical; just narrow each to its own queries. Leave `loadSuperadminData` in place until 2.3 removes its last caller.

**2.1c** `components/settings/settings-list.tsx` — the row-list primitive: grouped rows, each `{ label, sublabel, control?, href?, superadminOnly? }`, with a `?` `Popover` (see `nav-rail.tsx`) carrying the long description. No badges, no counts-as-alerts — counts are plain sublabel text.

### 2.2 Sub-routes (parallel — one subagent per route, disjoint files)

Each subagent: new `app/(app)/settings/<x>/page.tsx` + `loading.tsx`, same `getStaffContext` gate sequence as today's page, its own 2.1b loader, the **exact card body moved from the matching old `TabsContent`**, plus a `← Settings` back link. **Forbid git operations in the prompt.**

| Agent | Route | Body moved from tab | Owns |
|---|---|---|---|
| A | `settings/users/` | `UsersTable` + `CreateUserDialog` | `app/(app)/settings/users/**` |
| B | `settings/budget-heads/` | `BudgetHeadTable` | `app/(app)/settings/budget-heads/**` |
| C | `settings/budgets/` | `SubDepartmentBudgetTable` | `app/(app)/settings/budgets/**` |
| D | `settings/vendors/` | `VendorMergePanel` | `app/(app)/settings/vendors/**` |
| E | `settings/events/` | past-events table + `CreateEventForm` | `app/(app)/settings/events/**` |
| F | `settings/master-data/` | **compacted** (2.2F below) | `app/(app)/settings/master-data/**` |

**2.2F — master-data compaction:** one row per department (`name · N sub-departments · N zones · N admin heads`), each expandable (`<details>` or a small client disclosure) to the current three per-department tables. Keep the Hub-status lifecycle table below, unchanged. Still read-only.

### 2.3 Landing page (orchestrator, serial — after 2.2 integrates)

`app/(app)/settings/page.tsx` — delete the `<Tabs>` tree. Render `<SettingsList>` from `getSettingsSummary`, fixed order:

| Group | Row | Control | Target |
|---|---|---|---|
| People | Users & roles | `{activeStaff} active · {pendingStaff} pending` | `/settings/users` |
| Money | Budget heads & mapping | `{budgetHeadCount} · {unmappedBudgetHeads} unmapped` | `/settings/budget-heads` |
| Money | Sub-department budgets | `{subDeptBudgetSet} set · {subDeptBudgetMissing} missing` | `/settings/budgets` |
| Directory | Vendors | `{vendorCount} · {unconfirmedVendors} unconfirmed` | `/settings/vendors` |
| Directory | Master data | `read-only reference` | `/settings/master-data` |
| Event · rarely changed | Active event | `<EventSwitcher>` inline | — |
| Event · rarely changed | Upload page limit | `<UploadLimitSettings>` stepper inline | — |
| Event · rarely changed | Past events | `{pastEventCount}` | `/settings/events` |

- Role gating: reuse the `TAB_DEFS` superadmin flags as a per-row visibility filter. Plain admin sees only `Event · rarely changed` + Past events + Upload limit. Every sub-route keeps its own server-side gate regardless.
- Delete `loadSuperadminData` and the `Tabs` imports once unused.
- Optional "Weekly board pack" status-only row → decide at build time; drop if it reads as noise.

### 2.4 Verify
Static gate. Manual checklist: plain-admin vs superadmin row sets; every `→` route gates server-side; inline event switch + upload-limit persist and revalidate; master-data one-row-per-department expands.

**Out of scope:** making master data writable; new settings; search (Direction B, later).

---

## Phase 3 — The Reports workspace  ·  effort M–L

### 3.1 Foundation (orchestrator, serial — land before 3.3/3.4 fan-out)

**3.1a** `lib/reports/surface-sections.ts` — lift every surface's section id/label list (currently inline `SECTIONS`-style arrays in each page) into one module keyed by surface. Pages and the new index both import it.

**3.1b** `components/reports/report-index.tsx` (client) — left rail: `★ My reports` pins (top), `Overview`, then the current surface's section list from 3.1a. Search box only when surface is Explore. Active state from `usePathname` + `?report=`. `data-hide-in-present`.

**3.1c** `app/(app)/reports/layout.tsx` — wrap `{children}` in a two-column grid: `<ReportIndex />` (~13.5rem) + pane (`{children}`). Read `reports_pins` cookie server-side (pattern: `nav_rail_collapsed` in `nav-rail.tsx`), pass to the index.

**3.1d** Pin/unpin server action writing the `reports_pins=<ids>` cookie. Per-browser, no table, no revalidation.

### 3.2 Overview compositions (parallel — one subagent per surface, disjoint files)

Each subagent builds `components/reports/overviews/<surface>-overview.tsx`: a hero tile row (3–4 figures from that surface's existing loader data) + a 2-col grid of its 2 flagship charts + a "Show all N breakdowns" `disclosure`. **Forbid git operations.**

| Agent | Surface | Flagship charts | Owns |
|---|---|---|---|
| A | Budget | dept budget-vs-actual · spend pace | `components/reports/overviews/budget-overview.tsx` |
| B | Vendors | concentration curve · above-median overpayment | `components/reports/overviews/vendors-overview.tsx` |
| C | Integrity | exception heat map · amount-at-risk waterfall | `components/reports/overviews/integrity-overview.tsx` |

### 3.3 Pane routing (orchestrator, serial — after 3.2)

`budget/page.tsx`, `vendors/page.tsx`, `integrity/page.tsx`, `reports/page.tsx` (Explore):
- `?report=<id>` unset → render `<…Overview />`.
- `?report=<id>` set → render only that one section presenter (already independent) with its CSV + pin + drill links.
- Explore = full section list + search box, no audience pre-filter.
- Anchor back-compat: on mount, if `location.hash` is a known section id, `history.replace` it to `?report=<id>`.
- `loadHeroMetrics` stays the top-level un-suspended await (perf plan 6.1).
- Executive Brief (`brief/page.tsx`): body unchanged; its index lists `Overview` + pins + a link to Explore.

### 3.4 Insight sentences (parallel — batch by report family, after 3.3)

Each section loader returns `insight: string | null` computed from its own rows; the section component renders it in the Brief's existing `insight` slot pattern. ~45 sections — dispatch one subagent per family (Budget / Vendors / What-we-bought / Integrity / Executive). A missing `insight` renders nothing, so the shell ships without waiting for all of them. **Forbid git operations.**

### 3.5 Verify
Static gate after foundation and after full integration. Manual checklist: each surface lands on Overview; index swaps the pane to a single report; CSV exports; Present mode clean; pins survive reload and are per-browser.

**Out of scope:** new charts; the known `/entries` drill-param gap (track separately); board-pack changes.

---

## After all three land

Update `docs/reporting-blueprint.md`'s status notes for the parts now built. Leave the design artifact link in this file as the visual reference.
