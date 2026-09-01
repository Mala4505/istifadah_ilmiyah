# Speed & Interface Audit — Execution Checklist

**Source:** companion artifact "Speed & Interface Audit" (code-based, 31 Aug 2026 — no live session was opened, see that artifact's "A note on method"). This doc turns its findings into an ordered, checkable work list.

**Ordering rule:** same as `pre-deploy-findings-and-plan.md` and `hub-screen-certification.md` — fix what's cheapest and highest-leverage first. Phase 1 alone is one function and touches every screen in the app; everything after it is narrower in scope.

Effort tags: **[S]** under an hour · **[M]** half a day · **[L]** more than a day.

Check items off as you land them (`- [x]`). Leave a one-line note under an item if the fix ended up different from what's written here — future re-audits read this file, not just the artifact.

---

## Phase 1 — Stop re-checking identity 3–4 times per page load

**Why first.** One function, `lib/supabase/server.ts`, is read by every layout, page, and helper in the app. Fixing it removes 2–3 redundant round-trips from *every* navigation, not just one screen — the single highest ratio of impact to effort in this whole list.

- [x] **1.1 — Memoize the per-request user lookup [S]**
  Wrap the `auth.getUser()` call in React's `cache()` so every call within one request reuses the first answer. Likely lands as a new cached helper (e.g. `getCachedUser(supabase)`) called from `middleware.ts`, `app/(app)/layout.tsx`, every page's own `auth.getUser()`, and `lib/export/auth.ts`'s `getStaffContext()` — rather than each of them calling `supabase.auth.getUser()` directly.
  **Files:** `lib/supabase/server.ts` (new cached export), `app/(app)/layout.tsx`, `app/(app)/entries/[id]/page.tsx`, `app/(app)/page.tsx`, `app/(app)/review/page.tsx`, `app/(app)/import/page.tsx`, `lib/export/auth.ts`.
  **Note:** `middleware.ts` runs in the Edge runtime, a separate request lifecycle from the Server Components below it — its `getUser()` call cannot share a cache with the rest. This item removes the *page-level* duplication (layout → page → `getStaffContext()`), which is 2–3 of the 3–4 calls traced in the artifact.
  **Done when:** a temporary counter (or server log) around `auth.getUser()` shows exactly one real network call per request on `/entries/[id]`, down from four.
  **Note (landed differently):** `getCachedUser()` takes no arguments — it creates its own client internally rather than taking `supabase` as a param, since `cache()` dedupes by argument identity and each call site was constructing its own client instance (a different reference each time would have defeated the cache). Also touched `app/(app)/entries/page.tsx` (the entries *list*, not `[id]`) — not in the original file list above, but found during implementation making the same direct `auth.getUser()` + `staff_profile` call as everything else here.

- [x] **1.2 — Stop `getStaffContext()` re-fetching `staff_profile` when the caller already has it [S]**
  Once 1.1 lands, `getStaffContext()`'s own `staff_profile` query is still a second, separate query from the one `app/(app)/layout.tsx` already ran for the nav rail. Either thread the already-fetched profile through, or cache this lookup the same way.
  **Files:** `lib/export/auth.ts`, `app/(app)/layout.tsx`.
  **Done when:** `staff_profile` is queried once per request, not once per call site.
  **Note (landed differently):** cached (`getCachedStaffProfile(userId)`, keyed by `userId`) rather than threaded — selects the superset of columns every call site needed (`display_name`, `role`, `is_active`, `its_number`) so one cached query shape serves both the nav rail and the role gates instead of two different `.select()`s.

- [x] **1.3 — Confirm the fix on the two worst offenders**
  Re-trace `app/(app)/entries/[id]/page.tsx` and `app/(app)/review/page.tsx` (both had 5+ `await supabase` calls) after 1.1/1.2 land — these were the deepest waterfalls found.
  **Verified statically** (`tsc --noEmit` passes; no live session opened, consistent with this doc's own "note on method"): on `/entries/[id]`, the page's own `getCachedUser()` call and `getStaffContext()`'s internal `getCachedUser()` + `getCachedStaffProfile()` calls now share one cache entry each — one real `auth.getUser()` round trip and one `staff_profile` query per request, down from two of each. Same on `/review`: `getStaffContext()` at the top and `loadDocumentDetail()`'s own `getCachedUser()` call resolve to the same cached values. A remaining `staff_profile` query on `entries/[id]/page.tsx` (resolving `changed_by` display names for the change log) and on `settings/page.tsx` (the full staff list for the admin table) are correctly left alone — different data, not the current user's own row.
  **Follow-up if an empirical trace is wanted:** add a temporary counter around `getCachedUser()`'s body and hit `/entries/[id]` and `/review` in a real browser session to confirm the network-tab call count directly.

---

## Phase 2 — Cache the reference data that barely changes

**Why second.** Every route is correctly forced dynamic for the CSP nonce (don't touch that) — but the lookup tables underneath (departments, budget heads, zones, cost centers, statuses) don't need to be re-queried from Postgres on every navigation just because the page around them does.

- [x] **2.1 — Wrap the reference-data fetchers in `unstable_cache` [M]**
  Target: `department`, `budget_head`, `admin_head`, `zone`, `cost_center`, `entry_status`, `hub_status`. Short revalidate window (a few minutes is plenty — these change a handful of times a term).
  **Files:** `app/(app)/entries/page.tsx` (`loadEntriesPageData`), `app/(app)/entries/[id]/page.tsx`, `app/(app)/page.tsx` (dashboard tiles), `app/(app)/review/page.tsx`.
  **Note (landed differently):** `app/(app)/page.tsx` (the dashboard) doesn't actually query any of these seven tables directly — it reads only the `v_*` reporting views — so there was nothing to wire there; that file in the original list was stale. Two consumers *not* in the original list turned out to hit the same tables on every navigation and got wired in the same pass: `app/(app)/documents/page.tsx` (admin_head/zone/cost_center for the attach-time and bulk-enrichment dropdowns) and `app/(app)/settings/page.tsx` (department/admin_head/zone/budget_head for the Events tab's option lists — NOT `loadSuperadminData`, the admin management table, which deliberately shows inactive rows too and needed its own richer query shape left alone). `exceptions/page.tsx` also reads `department`/`budget_head` but was left uncached on purpose (see note below).

  A single shared module, `lib/cache/reference-data.ts`, holds all seven cached fetchers. Two things came up during implementation that weren't visible from the checklist text alone:
  1. **RLS is not uniform across these seven tables.** `department`, `cost_center`, `entry_status`, and `hub_status` gate on `private.is_staff()` only — every authenticated user reads the same rows, safe for one global cache entry. `admin_head`, `zone`, and `budget_head` additionally gate through `private.can_see_department()`, which returns different row sets for a department-scoped account vs. admin-or-above. A single global cache key on those three would have let one role's request silently populate the cache for every other role for the rest of the revalidate window (truncating an admin's list, or leaking another department's names to a dept account). Fixed by keying those three fetchers on `userId` — same principle as `getCachedStaffProfile`.
  2. **The cached fetchers return the full, unfiltered table** (every row RLS allows, active and inactive, every department) rather than pre-applying `is_active`/event-membership/department_id filters inside the cache. Every call site re-applies its own existing filter as a JS `.filter()`/`.sort()` over the cached array instead of a Postgres predicate — this is what let `exceptions/page.tsx`-style "resolve a name even for a retired row" consumers share the same cache as "active-only dropdown" consumers without either changing behavior.

- [x] **2.2 — Wire cache invalidation to admin writes [S]**
  Tag the cached reads; call `revalidateTag(...)` from the relevant mutations in `lib/actions/admin.ts` and `lib/actions/settings.ts` (creating/editing a department, budget head, zone, cost center, or status) so an admin edit shows up immediately instead of waiting out the revalidate window.
  **Note (landed differently):** as of this pass, `lib/actions/admin.ts` and `lib/actions/settings.ts` together have exactly one mutation that touches any of these seven tables — `updateBudgetHeadMapping` (budget_head) — now wired with `revalidateTag(REFERENCE_DATA_TAGS.budgetHead)`. There is no admin-writable path yet for department, admin_head, zone, cost_center, entry_status, or hub_status (RLS denies authenticated writes on most of them; per 20260808000026's own comments, rows grow only via the service-role importer or a future admin screen). `REFERENCE_DATA_TAGS` exists for all seven so wiring the remaining `revalidateTag` calls is a one-line addition whenever such a mutation gets built — don't let it get missed then.

- [x] **2.3 — Re-verify event-membership filtering still holds**
  Several of these queries are filtered through `event_department` / `event_admin_head` / `event_zone` membership tables tied to the *selected* event (a cookie). Make sure the cache key includes the selected event id — otherwise switching events could serve another event's cached options for a moment.
  **Note (landed differently):** the cache key does not need the event id after all, because the cache holds the *unfiltered* master table (see 2.1) and event-membership filtering runs fresh, uncached, on every request (the `event_department`/`event_admin_head`/`event_zone` membership queries were left exactly as they were). Switching events can never see a stale cross-event option list, because the thing that's cached never varied by event in the first place — only the always-live membership filter did.
  **Verified statically** (`npm run typecheck` and `npx eslint` both pass across every touched file; no live session opened, consistent with this doc's own "note on method"), by re-reading each page's post-cache filtering logic against its pre-cache query predicates line by line to confirm identical semantics (is_active, department_id, and event-membership-set filters all reproduced in JS over the cached array).
  **Follow-up if an empirical trace is wanted:** open `/entries`, `/entries/[id]`, `/review`, `/documents`, and `/settings` in a real browser, switch the active event, and confirm the department/admin-head/zone lists update immediately with no stale cross-event options.

---

## Phase 3 — Defer the heaviest client bundle

- [x] **3.1 — Lazy-load the PDF viewer on Review [S]**
  Load `PdfViewer` via `next/dynamic(() => import('@/components/review/pdf-viewer'), { ssr: false })` with a lightweight loading placeholder, instead of the current eager import. pdf.js then only downloads and parses once a bill is actually open.
  **Files:** wherever `PdfViewer` is imported in `components/review/review-workspace.tsx`.
  **Done when:** the Network tab shows pdf.js's worker/wasm assets loading only after a document is opened, not on `/review`'s first paint.
  **Note (landed differently):** implemented as `dynamic(() => import('./pdf-viewer').then(mod => mod.PdfViewer), { ssr: false, loading: () => <Skeleton .../> })` — the module-resolving `.then()` form (not the default-export shorthand), which is what let the `forwardRef` ref (`pdfViewerRef`, used by keyboard nav) forward through cleanly. `PdfViewerHandle` stays a type-only import (zero bundle cost). Loading placeholder reuses `pdf-viewer.tsx`'s own internal `Skeleton` sizing so there's no layout jank when the real component mounts.
  **Verified statically** (`tsc --noEmit`, `npm run lint`, and `npx next build` all pass; build output confirms pdf.js now lands in its own chunk, not `/review`'s route bundle — no live session opened, consistent with this doc's own "note on method").
  **Follow-up if an empirical trace is wanted:** open `/review` in a real browser, confirm pdf.js's worker/wasm assets load only after a bill is opened (not on first paint), and confirm no "Function components cannot be given refs" console warning when using arrow-key page navigation.

---

## Phase 4 — Small consistency fixes

- [x] **4.1 — Route the login form's error through the app's own error pattern [S]**
  `app/login/page.tsx` renders its error as a bare `role="alert"` paragraph instead of the `FriendlyError` / toast pattern used everywhere else. Bring it in line — it's the one screen every person sees first.
  **Note (landed differently):** `FriendlyError` itself carries no `role`, so `role="alert"` moved onto a wrapping `<div>` around `<FriendlyError message={error} />` rather than editing the shared component. Confirmed `loginWithIts`'s `result.error` (in `lib/actions/auth.ts`) is always already a short, plain-English string, so `friendlyErrorMessage()` passes it through unchanged — no "Technical detail" toggle appears on login failures.
  **Verified statically** (`tsc --noEmit` and `npx eslint app/login/page.tsx` both pass; no live session opened, consistent with this doc's own "note on method").

- [x] **4.2 — Decide on "forgot password" [S — decision, not code]**
  No reset-password path is reachable from the login form. Confirm whether one exists elsewhere (an admin resets it manually?) and either surface it here or document the intended process.
  **Finding: this is a real, undocumented gap, not a settled process.** `lib/actions/admin.ts`'s only password-touching function is `createStaffUser`, which sets a password at account creation only and explicitly rejects an already-registered ITS number as a duplicate — so "recreate the account" is not a workaround either. No `updateUserById`, `resetPasswordForEmail`, or any other Supabase Auth admin password call exists anywhere in app code (repo-wide grep confirms), and `components/admin/users-table.tsx` has no password-related action. Today, if a staff member forgets their password, an admin has **no in-app lever** to help them — only direct Supabase dashboard/API access outside this codebase.
  **Deliberately not done:** no "intentionally admin-managed/out-of-band" comment was added to `app/login/page.tsx` — unlike account creation (which `create-user-dialog.tsx` documents explicitly as an out-of-band handoff), nothing here suggested this gap was a deliberate design choice, so asserting that in a comment would misstate the situation.
  **Open decision for the user:** build a small admin-side "set new password for existing user" action (`admin.auth.admin.updateUserById` from `lib/actions/admin.ts`), add a true self-serve reset flow, or explicitly document today's out-of-band process once one actually exists.
  **Resolved 2026-09-01:** built the admin-side reset. `resetStaffPassword({ id, password })` in `lib/actions/admin.ts` — same posture as `createStaffUser` (superadmin gate checked with the session-bound client first, then the write goes through `createAdminClient().auth.admin.updateUserById`, since that call bypasses RLS entirely). UI: a "Reset password" dialog (`components/admin/reset-password-dialog.tsx`) next to each row's Save button in `components/admin/users-table.tsx` (Users & roles tab, superadmin-only), reusing the same generate/enter-password pattern as account creation — the `generatePassword()` helper that used to live only in `create-user-dialog.tsx` moved to a shared `lib/generate-password.ts` so both dialogs use it. Still no self-serve "forgot password" link on the login form itself — out-of-band admin reset remains the intended process, and it now actually has an in-app lever.
  **Verified statically** (`tsc --noEmit` and `npm run lint` both pass; no live session opened, consistent with this doc's own "note on method").
  **Follow-up if an empirical trace is wanted:** open Settings → Users & roles as a superadmin, reset a test account's password, and confirm the account can log in with the new password and not the old one.

---

## Phase 5 — Screen-specific follow-ups (not urgent, worth a decision)

- [ ] **5.1 — Reports: plan the split before it's needed [M, deferred]**
  ~10 sections on one route, settling under 800ms today. No action needed now — just don't let it grow past a comfortable single page without revisiting tabs/sub-nav.

- [x] **5.2 — Settings: check tab-switch cost [S — verify only]**
  Five data-heavy admin tables share one route (`/settings`). Confirm switching tabs doesn't force a full page re-render of tables the user isn't looking at.
  **Verified, no issue.** `app/(app)/settings/page.tsx` is a Server Component — every tab's data is fetched once per request and passed down as props for the whole tabbed tree in one render. `components/ui/tabs.tsx` re-exports Radix's `Tabs.Content` with no `forceMount` passed anywhere in `settings/page.tsx` (confirmed by reading `node_modules/@radix-ui/react-tabs/dist/index.js:205`: `Presence({ present: forceMount || isSelected })`), so an inactive tab's subtree unmounts entirely rather than staying hidden-but-mounted. Switching tabs is a client-only mount/unmount of already-fetched data — zero network calls, no server re-render.

- [x] **5.3 — Accuracy: decide if line-item correction tracking matters [decision]**
  Currently header-field accuracy only, by design per the page's own doc comment — not a bug, but confirm that's still the intended scope.
  **Confirmed, still the intended scope.** `app/(app)/accuracy/page.tsx:26-29`'s doc comment already states line-item accuracy "is a gap, not an omission" — no migration exists yet for `document_extraction_line_item`-level correction tracking (MASTER-PLAN §9.2 envisions it, but it was never built). Nothing to change.

---

## Phase 6 — Mobile and small screens

- [x] **6.1 — Manual pass on a real phone (~390px)**
  Check `/entries`, `/exceptions`, `/settings`, and the document-upload flow specifically — the CSP's `camera=(self)` permission implies phone-based bill photography is an assumed workflow, so this isn't a nice-to-have.
  **Done when:** each of those screens is usable (not just technically scrollable) at 390px width — filters, tables, and dialogs included.
  **Note (landed differently — method):** no browser/device tool was available in this session, so this was done as a code-based static audit (same "no live session" method this whole doc already uses) rather than an actual phone test — four screens read in parallel against a 390px-viewport checklist (fixed widths, missing `overflow-x-auto`, tab/filter-bar overflow, dialog sizing, touch-target size). Findings below; a real-device pass is still the honest way to close this out and is called out per screen.
  - **App-wide (not screen-specific):** `components/app-shell/nav-rail.tsx` had zero responsive treatment — the expanded rail (`w-56` = 224px) renders unconditionally regardless of viewport, crushing available content width on every screen at 390px. This is the single highest-impact finding, since it's in the shared layout (`app/(app)/layout.tsx`), not any one screen.
  - **`/entries`:** table/filter-bar/most dialogs already responsive-safe (`overflow-x-auto` table wrapper, `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` filter grid). Real breakage: the nav rail (above), and `components/entries/new-entry-dialog.tsx`'s rigid `grid-cols-2`/`grid-cols-3` field layout (too narrow for a date input at 3-up inside a ~342px dialog). Row-select checkboxes also under the ~40px touch-target guideline.
  - **`/exceptions`:** no page-level overflow or fixed-width breakage — queue table, filters, and dialogs are all structurally responsive-safe. Real problem is touch-target size on shared primitives: `components/ui/sortable-table-head.tsx`'s sort button, `components/ui/checkbox.tsx`'s row/bulk-select checkbox, and `components/ui/dialog.tsx`'s close (X) button all sit around 16–18px hit areas.
  - **`/settings`:** the one genuine page-wide breakage found. `components/ui/tabs.tsx`'s `TabsList` (7 tabs, `inline-flex`, no wrap, no scroll) has no width cap or overflow handling, so at 390px it forces the *entire page* to scroll sideways to reach the last 4 of 7 tabs — compounded by the nav rail eating ~224px first. Same dialog-close touch-target issue as above (`create-user-dialog.tsx`, `vendor-merge-panel.tsx`'s merge dialog). Secondary, non-blocking: several `size="sm"` (32px) row-action buttons across the admin tables sit under the touch-target guideline — left as a documented note, not fixed (see 6.2).
  - **Document-upload flow (`/import`):** already responsive-safe — no fixed widths, tables scroll via the shared `Table` wrapper, the grid stacks under `lg`. Two non-blocking findings: (a) minor buttons (Revoke, Choose file, drag-to-install link) sit at 28–32px touch targets; (b) genuine scope gap, not a layout bug — nothing in the app actually uses `capture`/`accept="image/*"` anywhere, so despite the CSP's `camera=(self)` grant, phone bill-photography isn't wired to any upload path today (every upload — `/import`'s spreadsheets, `/documents`' PDF dropzone — expects a file, not a camera capture). Flagging for a product decision, not fixing as part of this pass — out of scope for "responsive treatment."

- [x] **6.2 — Add responsive treatment where 6.1 finds real breakage [size TBD]**
  Scope this once 6.1 has an actual list of what breaks, rather than guessing from the code alone — the artifact flagged this as a "go look" item, not a confirmed bug.
  **Landed as six small, mostly shared-component fixes** (chosen over per-screen patches since three of 6.1's findings were the same shared primitive breaking on every screen that uses it):
  1. `components/app-shell/nav-rail.tsx` — added an `isNarrowViewport` flag (`useSyncExternalStore` + `window.matchMedia('(max-width: 639px)')`, not `useEffect`+`useState`, to avoid the hydration-flicker pattern) that ORs into a new `effectiveCollapsed` used for every *rendering* decision (width, padding, label visibility, tooltip wrapping), while the real `collapsed` state/cookie/`/review` auto-collapse logic is untouched — so a phone always gets the icon-only 56px rail regardless of the user's saved desktop preference, and widening the window restores exactly what they last chose. The now-redundant collapse/expand handle is hidden below `sm` (`max-sm:hidden`).
  2. `app/(app)/layout.tsx` — `main`'s padding is `p-3 sm:p-6` instead of a flat `p-6`, clawing back a bit more width on top of the rail fix.
  3. `components/ui/tabs.tsx` — `TabsList` gets `max-w-full overflow-x-auto` and `TabsTrigger` gets `shrink-0`, so an overflowing tab strip (like `/settings`' 7 tabs) scrolls *within itself* instead of forcing the whole page sideways.
  4. `components/ui/checkbox.tsx` — added an invisible `before:absolute before:-inset-2.5` hit-slop around the root, so the tap target grows to roughly 36×36px without changing the checkbox's visual 16×16px size.
  5. `components/ui/dialog.tsx` — `DialogClose` gets explicit `h-8 w-8` flex centering (was an unpadded 16px icon); `DialogContent` changed from `w-full` to `w-[calc(100%-2rem)]` so it keeps a consistent margin from the device edge instead of touching it.
  6. `components/ui/sortable-table-head.tsx` — sort button gets `-m-2 p-2` (negative-margin-offset padding), growing the tap area without shifting its visual position or the column's layout.
  Plus one screen-specific fix: `components/entries/new-entry-dialog.tsx`'s two rigid grids (`grid-cols-2`, `grid-cols-3`) became `grid-cols-1 sm:grid-cols-2` / `grid-cols-1 sm:grid-cols-3`.
  **Deliberately not done (documented, not fixed):** the `size="sm"` row-action buttons across `/settings`' admin tables and the minor `/import` buttons (6.1's secondary findings) — bumping a shared `size="sm"` button variant affects desktop too and is a bigger design call than this pass's scope; and the missing camera/image upload path — a product decision (wire it up, or treat the CSP grant as forward-looking), not a responsive-treatment bug.
  **Verified statically** (`tsc --noEmit` and `npx eslint` both pass across every touched file; no live session opened, consistent with this doc's own "note on method").
  **Follow-up if an empirical trace is wanted:** open `/entries`, `/exceptions`, `/settings`, and `/import` on a real ~390px phone (or DevTools device emulation) and confirm: the nav rail is icon-only and the settings tab strip scrolls locally rather than the whole page; the New Entry dialog's date field isn't clipped; checkboxes, sort headers, and dialog close buttons are comfortably tappable.

---

## Order of work

1. **Phase 1** — do this first, always. Every other phase benefits from it being done.
2. **Phase 2** — same screens Phase 1 touches; natural to do in the same pass.
3. **Phase 3** and **Phase 4** — small, independent, can slot in anywhere.
4. **Phase 5** — decisions more than code; resolve when convenient.
5. **Phase 6** — do last, since 6.2's scope depends on what 6.1 finds.
