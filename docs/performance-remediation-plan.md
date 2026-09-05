# Speed, Efficiency & UX Remediation — Execution Plan

**Source:** companion artifact "Istifadah Ilmiyah Audit Register" (4 Sep 2026), produced by six parallel read-only audits over 363 source files — review screen, reports surface, entries/documents/exceptions, app-wide infrastructure, Postgres schema, and UX/accessibility. No live session was opened and no query was run against the deployed database; every finding is static analysis of the working tree as of 4 Sep 2026 (which includes uncommitted reports-surface work). This doc turns those findings into an ordered, checkable work list.

**Relationship to `perf-ux-audit-checklist.md`:** that earlier pass (31 Aug) is largely landed and its fixes were re-verified as still correct during this audit — `getCachedUser` and `getCachedStaffProfile` are genuinely deduping, and the reference-data cache is a real cross-request cache. This plan does **not** revisit any of it. Phase 2 below is the one helper that pass missed.

**Ordering rule:** same as `pre-deploy-findings-and-plan.md` and `hub-screen-certification.md` — cheapest and highest-leverage first. Two deviations, both deliberate:
- Phase 1 is not the cheapest, but every other phase's gains are invisible behind it. Client-side render work on `/review` cannot be felt while the query feeding it re-executes a lateral join per row.
- Phase 2 is cheap *and* high-leverage, so it jumps ahead of larger work.

**Dependencies are stated per phase.** Phases marked `Depends on: —` are independent and may be run in any order, or in parallel by different sessions.

Effort tags: **[S]** under an hour · **[M]** half a day · **[L]** more than a day.

Check items off as you land them (`- [x]`). Leave a one-line note under an item if the fix ended up different from what's written here — future re-audits read this file, not just the artifact.

**Three root causes** account for nearly every Critical and High item below. Each phase notes which it addresses:
- **(A)** An unindexable `OR` inside a per-row lateral join in `v_review_queue`.
- **(B)** Whole-ledger fuzzy matching executed in the request path.
- **(C)** `getSelectedEventId` never memoized, so every call site re-issues two round trips.

---

## Phase 1 — Rewrite the review-queue views and add the missing indexes

**Addresses:** root cause (A). **Depends on:** — **Effort:** [M]

**Why first.** `v_review_queue` correlates a subquery per outer row rather than joining a set, and Postgres cannot flatten a correlated `OR` across two columns. It re-plans and re-executes the exception scan once per `document_extraction` row, against indexes not scoped to `status = 'open'`. This is the dominant cost on every `/review` load, it is paid twice per load, and it degrades fastest as `reconciliation_exception` grows — which it does on every extraction run, including re-runs. No application code changes here.

**Before starting:** this phase writes a migration. Follow the project's normal migration flow (`npx supabase`, not bare `supabase`). Do not apply anything without review — the SQL below is drafted, not verified against a live plan.

- [x] **1.1 — Add the two status-scoped partial indexes on `reconciliation_exception` [S]**
  Landed in `supabase/migrations/20260904000001_review_queue_perf_rewrite.sql`. Not yet applied to the live DB — needs `npx supabase db push` (or equivalent) after review, and the migration's own header note about `CREATE INDEX CONCURRENTLY` vs. a transaction-wrapped runner.
  The existing `recon_exception_extraction_idx` / `recon_exception_entry_idx` are not scoped to open status, so every lookup returns all historical rows for that key (open, resolved and dismissed alike) before filtering status in a separate Filter node.
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS recon_exception_open_extraction_idx
    ON public.reconciliation_exception (document_extraction_id)
    WHERE status = 'open' AND document_extraction_id IS NOT NULL;

  CREATE INDEX CONCURRENTLY IF NOT EXISTS recon_exception_open_entry_idx
    ON public.reconciliation_exception (entry_id)
    WHERE status = 'open' AND entry_id IS NOT NULL;
  ```
  **Files:** new migration.
  **Also serves (independently of the view rewrite):** `lib/jobs/handlers/extract.ts:596-604` (runs on every extraction and re-run) and `app/(app)/entries/[id]/page.tsx:314-320` (runs on every entry detail view). Both currently fall back to the unscoped indexes.
  **Done when:** both indexes exist and `EXPLAIN` on the two call sites above shows an index scan on the new partial index rather than the old one plus a Filter.

- [x] **1.2 — Replace the correlated lateral in `v_review_queue` with two pre-aggregated CTEs [M]**
  Landed, but not as a plain sum of two independently-grouped CTEs as drafted below — the "watch for a semantic change" note turned out to be a real, reachable bug: `lib/actions/review.ts`'s `flagReviewException` inserts a row with **both** `entry_id` and `document_extraction_id` set whenever a flagged bill is already attached to an entry, so a plain sum would double-count it. Implemented instead as a `UNION`'d (not `UNION ALL`) set of `(exception_id, document_extraction_id)` pairs, grouped once — see the migration's own comment for the exact shape. Not yet applied to the live DB or verified against a real query plan.
  Turn N correlated subplans into two hash-joined, index-backed group-bys. The `OR` disappears because the two sides are aggregated separately and joined on their own keys.
  **Current shape** (`supabase/migrations/20260828000003_review_queue_tiebreaker.sql:56-69`):
  ```sql
  left join lateral (
    select count(*) as open_count, max(case ex.severity ...) as max_severity_rank
    from public.reconciliation_exception ex
    where ex.status = 'open'
      and ( ex.document_extraction_id = de.id
            or (coalesce(de.entry_id, sd.entry_id) is not null
                and ex.entry_id = coalesce(de.entry_id, sd.entry_id)) )
  ) x on true
  ```
  **Replacement shape:**
  ```sql
  with open_by_extraction as (
    select document_extraction_id,
           count(*) as open_count,
           max(case severity when 'high' then 3 when 'medium' then 2
                             when 'low' then 1 else 0 end) as rank
    from public.reconciliation_exception
    where status = 'open' and document_extraction_id is not null
    group by document_extraction_id
  ),
  open_by_entry as (
    select entry_id,
           count(*) as open_count,
           max(case severity when 'high' then 3 when 'medium' then 2
                             when 'low' then 1 else 0 end) as rank
    from public.reconciliation_exception
    where status = 'open' and entry_id is not null
    group by entry_id
  )
  -- ... joined as:
  left join open_by_extraction xe on xe.document_extraction_id = de.id
  left join open_by_entry      xn on xn.entry_id = coalesce(de.entry_id, sd.entry_id)
  -- and the two output columns become:
  greatest(coalesce(xe.rank, 0), coalesce(xn.rank, 0))            as max_open_severity_rank,
  coalesce(xe.open_count, 0) + coalesce(xn.open_count, 0)         as open_issue_count
  ```
  **Files:** new migration recreating `v_review_queue` with `security_invoker = true`.
  **Careful:** preserve every existing output column and the `count(*) over (partition by de.source_document_id) as bill_count` window, plus the `where de.verified_at is null` filter and the tiebreaker ordering added in `20260828000003`. `app/(app)/review/page.tsx:120` selects eleven named columns from this view — all must survive.
  **Watch for a semantic change:** the old lateral counted a row *once* even when it matched both the extraction and the entry condition; the new form counts it in both CTEs and sums them. If a `reconciliation_exception` row can carry both a `document_extraction_id` and a matching `entry_id`, `open_issue_count` will differ. Verify against real data before shipping; if such rows exist, deduplicate with a `union`-based CTE instead of summing.
  **Done when:** `EXPLAIN ANALYZE` shows hash joins rather than per-row subplans, and the queue renders in the same order with the same counts as before.

- [x] **1.3 — Apply the same rewrite to `v_review_queue_all`, and bound it [M]**
  Landed with the same CTE rewrite. Bound: user confirmed a rolling 2-year window on `de.created_at` (matches the option this checklist proposed). Also flagged (comment only, not fixed — out of this rewrite's scope): `v_review_queue_all`'s entry resolution was already inconsistent with `v_review_queue` before this pass (`sd.entry_id` only, not `coalesce(de.entry_id, sd.entry_id)`) — a per-bill match on `document_extraction.entry_id` goes unrecognised by the "All documents" toggle. Preserved as-is; worth a follow-up.
  This sibling view (`supabase/migrations/20260821000006_review_queue_all_view.sql:12-64`) has **no `verified_at` filter at all** — it is every extraction ever written, carrying the same lateral. Its cost scales with total history rather than with pending work, and any reviewer reaches it by flipping the Unverified/All toggle. No index fixes an intentionally unbounded view.
  **Files:** same migration.
  **Done when:** the rewrite is applied and the view carries a bound — a rolling window (e.g. `created_at > now() - interval '2 years'`) or event scoping. Confirm with the user which bound is acceptable before choosing; "All" changing meaning is a product decision, not a perf one.

- [x] **1.4 — Stop counting through the view [S]**
  `app/(app)/review/page.tsx:126-131` runs `select('*', { count: 'exact', head: true })` against the view. Postgres cannot prove a correlated lateral is row-count-preserving, so it cannot drop it just because `count(*)` ignores its output columns — the "how many are pending" query re-runs the most expensive half of the list query.
  Count `document_extraction` directly with the same filters:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS document_extraction_unverified_idx
    ON public.document_extraction (source_document_id)
    WHERE verified_at IS NULL;
  ```
  **Files:** new migration; `app/(app)/review/page.tsx` (`queueCountQuery`).
  **Done when:** the count no longer touches `reconciliation_exception` in its plan, and `truePendingTotal` still matches the view's row count.
  Landed. `queueCountQuery` now selects from `document_extraction`, embedding `source_document!inner(event_id)` (PostgREST embedded-filter join) only for the event scope — `reconciliation_exception` never enters this query's plan at all. The 'all' scope's count mirrors `v_review_queue_all`'s new 2-year bound via a small helper (`queueAllBoundIso()`) so the header total and the list agree on what's reachable; kept as a code comment cross-reference rather than a shared constant since one side is SQL and the other TypeScript.

- [x] **1.5 — Add the four remaining supporting indexes [S]**
  ```sql
  -- Removes a sort step from a query issued on every review-page load.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_line_item_parent_order_idx
    ON public.document_extraction_line_item (document_extraction_id, line_order);

  -- entries_date_idx has no is_void predicate, so the scan increasingly
  -- walks past voided rows as they accumulate.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS entries_active_date_idx
    ON public.entries (date DESC)
    WHERE is_void = false;

  -- source_document_inbox_idx covers only 'unmatched'/'suggested'.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS source_document_matched_idx
    ON public.source_document (match_status)
    WHERE match_status = 'matched';

  -- v_vendor_shared_identity_edges' case-insensitive address self-join
  -- recomputes lower(trim(...)) per row with no functional index.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS vendor_address_normalized_idx
    ON public.vendor (lower(trim(address)))
    WHERE address IS NOT NULL;
  ```
  **Done when:** all four exist. The last two are cheap insurance at current volumes rather than fixes for present pain — bank them now, not after the tables are 10× larger.

- [ ] **1.6 — Verify the whole phase on `/review` [S]**
  **Done when:** opening a bill and stepping J/K through several is measurably faster, and `EXPLAIN ANALYZE` on the queue query shows no per-row subplan. Record the before/after timings as a note under this item — the next re-audit will want them.
  **Not done.** No live Supabase connection available in this session (MCP Supabase servers are unauthenticated here) — `EXPLAIN ANALYZE` and before/after timings need a human with `pbi`/`supabase` access, after 1.1–1.5's migration is reviewed and applied. `npx tsc --noEmit`, `next lint`, and `vitest run` all pass against the application-code changes (1.4's `queueCountQuery`), but the SQL itself is unverified against a real plan, per this phase's own header note.

---

## Phase 2 — Memoize event resolution and thread the id through the reports loaders

**Addresses:** root cause (C). **Depends on:** — **Effort:** [S] for 2.1, [M] for 2.2

**Why here.** One function, read by nearly every page. `getCachedUser` and `getCachedStaffProfile` were both wrapped in React `cache()` by the earlier perf pass and that fix is verified working; `getSelectedEventId` was missed and still costs two sequential round trips per call — validate the cookie's id against `event`, then fetch the row. Nine call sites on `/reports` alone.

- [x] **2.1 — Wrap `getSelectedEventId` in React `cache()` [S]**
  **Files:** `lib/events/current.ts:49`.
  **Careful:** `cache()` dedupes by argument identity. `getSelectedEventId` currently takes a `supabase` param and each call site constructs its own client, so a naive wrap would never hit. Follow exactly what `getCachedUser()` did when this same trap was hit in the earlier pass — drop the parameter and create the client internally.
  **Immediate effect:** `/exceptions` drops from three identical event-resolution queries to one (`app/(app)/exceptions/page.tsx:150`, `:244`, `:338`, all invoked together via `Promise.all` at `:497`).
  **Done when:** a temporary counter shows one real event query per request on `/exceptions` and on `/reports`.
  Landed, and extended beyond the literal ask: `getSelectedEvent` and `getAllEvents` (same file) took the identical trap and were wrapped the same way — verified safe first (not assumed): every call site was grepped, and the two that pass a non-default client (`lib/export/queries.ts`'s admin client, `app/api/documents/ingest/route.ts`'s admin client) both run in requests that already carry the `active_event_id` cookie, and `event_select` (`20260822000005_event_scoping.sql`) grants `select` to every authenticated user with no per-department scoping — so the cookie-bound client this function now builds internally returns identical rows to whichever client used to be passed in. `getCurrentEvent` (the internal fallback helper) still takes an explicit client on purpose — no external caller, always invoked here with the client this function just built. All ~30 call sites across the app were updated to drop the now-removed `supabase` argument; `npx tsc --noEmit` and `next lint` both pass clean.

- [x] **2.2 — Thread `eventId` into the reports surface loaders as a parameter [M]**
  Even memoized, each loader re-reading the cookie is indirection with no purpose — the page already resolved the id. `loadHeroMetrics(eventId)` already takes it as a parameter; make the rest match.
  **Files:** `lib/reports/surfaces/{budget,vendors,integrity,purchase-tree,rate-drift-discount,quantity-zone-price,vendor-scorecard,vendor-dependency,related-party-gstin}.ts`, `app/(app)/reports/page.tsx:119`, `components/reports/sections/board-pack-list.tsx:41`.
  **Do this before the blueprint's Phases 5–6 land.** Seven more loaders (`reconciliation-gap`, `budget-structure`, `duplicate-vendor-risk`, `spend-curve-open-ageing`, `amount-forensics`, `rupee-provenance`, `entry-type-flow`) are written but unimported, and each already replicates this pattern. Fixing it now costs nine edits; fixing it after they are wired costs sixteen.
  **Done when:** `getSelectedEvent` appears once per request in the reports tree.
  Landed for exactly the files named above, plus their other callers discovered along the way: `app/(app)/reports/budget/page.tsx`, `app/(app)/reports/vendors/page.tsx`, `app/(app)/reports/integrity/page.tsx`. Threaded the full `Event | null` object (not just `eventId`) — `vendor-scorecard.ts` also needed `.name`/`.startsOn`/`.endsOn` from it, and every one of the nine needed `.name`. **Scope note for the next re-audit:** by the time this ran, the "seven more loaders... unimported" premise was already stale — `reporting page redesign` (commit `34cb949`) had wired all seven into `/reports` since the plan was drafted, so the actual surface is 19 loaders calling `getSelectedEvent`, not 9. The 2.1 cache fix above already removes the real round-trip cost for all 19; threading was still done only for the 9 explicitly named here (bounded, reviewable scope) — the other 10 (`admin-head`, `amount-forensics`, `budget-structure`, `duplicate-vendor-risk`, `entry-type-flow`, `hsn-gst-anomaly`, `reconciliation-gap`, `rupee-provenance`, `spend-curve-open-ageing`, `threshold-splitting`) still call `getSelectedEvent()` internally — cheap now (cached), but not yet threaded. Follow-up if full uniformity is wanted.

- [ ] **2.3 — Hoist `resolvePreviousEvent` out of the tail of each loader [S]**
  It depends only on `eventId`/`compareBasis`, never on the main batch's results, yet nine loaders `await` it after their own `Promise.all` resolves. Its internal `getAllEvents()` (`lib/reports/sections/shared.tsx:578`, an uncapped `select('*')`) then re-runs identically in every one of them.
  **Files:** the same nine loaders; `lib/reports/sections/shared.tsx`.
  **Done when:** under `compareBasis='prior_event'` — the expensive basis — Explore no longer adds a sequential stage per loader. Test on that basis specifically; the default `prior_week` short-circuits with no DB call and will hide the regression.
  **Partially addressed as a side effect of 2.1, not done as specified.** `getAllEvents` is now `cache()`'d (see 2.1's note), so `resolvePreviousEvent`'s `getAllEvents()` call is a real round trip only for the first loader to reach it in a given request — every other loader in the same `Promise.all` shares that same in-flight/resolved call, which removes most of this item's actual DB cost. The literal fix (restructuring each loader's internal `await` ordering so `resolvePreviousEvent` runs concurrently with its own batch, not after) was **not** done — left open, lower priority now that the repeated-query cost is gone. Re-test under `compareBasis='prior_event'` before deciding whether the remaining sequential-await latency is worth the nine-loader restructuring. Side note: `resolvePreviousEvent`'s own `supabase` parameter is now unused inside the function (it no longer calls `getAllEvents(supabase)`, just `getAllEvents()`) but all 16 call sites still pass it — harmless, but worth dropping from the signature if this item's own restructuring ever happens.

- [x] **2.4 — Compute total spend once [S]**
  `lib/reports/hero-metrics.ts:261` and `lib/reports/surfaces/integrity.ts:160-165` both fetch all event-scoped non-void entries and reduce in JS for the same number, concurrently, in the same `Promise.all` on `/reports`. `integrity.ts`'s own comment says it mirrors hero's.
  **Fix:** pass hero's total into `loadIntegritySurface`, as `loadExecutiveBrief` already receives it.
  **Done when:** `entries` is fetched once per Explore load for spend totals.
  Landed on `/reports` (Explore): `loadHeroMetrics` now runs sequentially before the big `Promise.all`, and `hero.kpi.totalSpend` feeds `loadIntegritySurface`. `/reports/integrity` (the dedicated surface page) doesn't load hero metrics at all, so it wasn't duplicating anything within its own request — it now runs the one total-spend query itself (same shape `loadIntegritySurface` used to run internally) and passes that in, keeping the "one query, not two" property on both routes without adding hero's other, unrelated computation to a page that never needed it.

---

## Phase 3 — Safety and correctness quick wins

**Depends on:** — **Effort:** all [S]

**Why here.** Every item is under an hour, none blocks or is blocked by other phases, and the first is a genuine lockout risk. Pull this phase forward if you want visible wins before the larger work.

- [x] **3.1 — Guard against superadmin self-lockout [S]**
  A superadmin can uncheck their own "Active" box or drop their own role from Superadmin to Dept and hit Save. There is no client confirmation and no server-side self-protection guard, so if they are the only superadmin this locks them out immediately with no undo path.
  **Files:** `components/admin/users-table.tsx:97,103,175-177,181-183`; `lib/actions/admin.ts:138-198` (`updateStaffProfile`).
  **Fix:** block, or require a typed confirmation, when `id === currentUserId` **and** the change reduces the acting user's own role or active status. Enforce it server-side too — the client guard alone is not sufficient.
  **Done when:** a superadmin cannot demote or deactivate themselves without an explicit confirmation, and the server rejects the mutation if the client is bypassed.
  Landed. Server-side: `updateStaffProfile` rejects the mutation when the target id equals the acting superadmin's own id and the change would drop role away from `superadmin` or set `isActive` false — scoped so demoting/deactivating a *different* superadmin is untouched. Client-side: `users-table.tsx` now opens the app's existing `Dialog` confirmation (matching the house pattern used for document delete, not `window.confirm`) before saving a self-demotion/self-deactivation. `npx tsc --noEmit` clean.

- [x] **3.2 — Exclude `public/` from the middleware matcher [S]**
  The matcher excludes `api`, `_next/static`, `_next/image` and `favicon.ico`, but not files served from `public/`. `components/review/pdf-viewer.tsx:316` sets `workerSrc = '/pdf.worker.min.mjs'`, so opening a bill triggers a browser fetch that runs the entire middleware body — CSP nonce construction plus a real `auth.getUser()` network call — to serve a static worker script. In the review flow's most latency-sensitive moment.
  **Files:** `middleware.ts:113-121`; `next.config.ts` (no `headers()` block exists today).
  **Fix:** add `pdf.worker.min.mjs` and `bookmarklet/*` to the negative lookahead, and add `Cache-Control: public, max-age=31536000, immutable` for `public/`.
  **Done when:** fetching the worker script issues no Supabase auth call, and carries a long-lived cache header.
  Landed as specified. `middleware.ts`'s matcher now excludes `pdf.worker.min.mjs` and `bookmarklet/*` (confirmed `public/bookmarklet/read-portal.js` exists and is reachable directly even though the app itself reads it server-side via `fs`, not over HTTP). `next.config.ts` adds long-lived immutable caching for those same two paths only — deliberately not extended to the logo/image files in `public/`, since their filenames aren't content-hashed and a branding update would then serve stale images for a year.

- [x] **3.3 — Pair `htmlFor`/`id` in the entries filter fields [S]**
  The `Field` helper renders its `<Label>` as a sibling of the input with no association, so all thirteen filters — Type, Status, Hub status, Department, Budget head, Admin head, Zone, Cost center, Vendor, Date from/to — announce as unlabeled controls to a screen reader. Every other form in the app (`create-user-dialog.tsx`, `new-entry-dialog.tsx`, `login/page.tsx`) does this correctly, so this is an isolated regression on the most-used screen in the app.
  **Files:** `components/entries/filter-bar.tsx:396-403`.
  **Done when:** each filter control has an associated label, verified with the accessibility inspector.
  Landed. `Field` now takes a required `htmlFor` prop; all 11 select/input-based filters pass matching `htmlFor`/`id` pairs. Traced (no live a11y inspector available in this session) that `id` lands on the real native `<select>`/`<input>` in `select-native.tsx`/`input.tsx`, not a wrapper div, and that `Label` forwards `htmlFor` through Radix's `Root` correctly. The other 2 of the 13 filters (toggle-style, via `ToggleField`) were already correctly associated via an implicit wrapping `<label>` — left untouched.

- [x] **3.4 — Route board-pack toasts through `toastError` [S]**
  `components/reports/sections/board-pack-download.tsx:26,48` calls raw `toast.error(result.error)`, skipping `logRawError`. Today's strings are hand-written and friendly, so nothing leaks — but this is the one path in the reporting code that would render a Postgres error unfiltered if `board-pack-actions.ts` ever surfaced one.
  **Done when:** both call sites go through `toastError`, consistent with the other ~90 in the app.
  Landed. Both call sites now route through `toastError(result.error, { context: 'board-pack-download' })`, matching the pattern already used in `components/documents/document-card.tsx`.

- [~] **3.5 — Confirm the Vercel plan tier honours `maxDuration` [S]**
  `app/api/documents/ingest/route.ts:56-57` declares `maxDuration = 60` and awaits the full extraction — upload, storage write, and a vision-model call against a PDF of up to 32 MB — before responding. The route's own comment (`:34-45`) explains this is deliberate, because `after()` did not reliably run to completion on this deployment. On a Hobby plan, however, the platform hard-caps execution at 10 s regardless of the declared value, silently truncating well before the documented budget. That would present to a user as data loss, not as a timeout.
  **Fix:** verify the deployed tier is Pro or above (or Fluid compute). If extraction time runs close to the ceiling even on Pro, split it: respond immediately on upload and poll via `app/api/documents/status/route.ts`, which already exists.
  **Also check:** `app/api/import/route.ts:21` declares `maxDuration = 180` and has the same exposure.
  **Done when:** the tier is confirmed in writing under this item, and the largest realistic bill has been timed end-to-end.
  **Tier confirmed: Vercel Hobby (user, 2026-09-05).** User does not want to upgrade. This is a live, already-occurring bug, not a theoretical risk — `docs/ocr-execution-decision.md`'s own measured sample (a real 8-page bundle) is ~15s wall clock, already past the 10s Hobby hard cap. GitHub Actions (`cron-tick.yml`, calling `/api/jobs/tick` every 5 min) is a retry safety net, not the primary extraction path, and does not itself remove the 10s exposure on the upload request.
  **Fix applied:** the "respond immediately and poll" path this item asked for already existed end-to-end and needed no new code — `app/api/documents/status/route.ts` and `document-inbox.tsx`'s polling of it were already built and already handle `'uploaded'`/`'processing'` pending states. The only thing forcing a synchronous wait was `INGEST_INLINE_EXTRACTION` (default `true`), which the project's own prior comment already said to turn off once a cron was driving `/api/jobs/tick` — it has been, since before this default was flipped, and never was. Flipped the code-level default to `false` (`lib/env.server.ts`, `.env.example`); superseded the 2026-08-21 "stays on" decision in `docs/import-review-ux-plan.md` §15 and `docs/ocr-execution-decision.md` with notes rather than deleting the original reasoning.
  **Not done, needs the user:** the live Vercel deployment's `INGEST_INLINE_EXTRACTION` env var is presumably still explicitly set to `true` (per the 2026-08-21 decision) and must be changed to `false` in the Vercel dashboard and redeployed — a code-level default change has no effect there until that happens. Tradeoff to accept: extraction latency goes from a few seconds to up to ~5 minutes (the GitHub Actions cron cadence), which the UI already tolerates. Considered tightening the cron to every 1 minute to shrink that window; declined — repo is private, and 5x'ing a schedule already likely near GitHub's free 2000 min/month Actions quota risks real cost, so left at 5 minutes.
  **Not done, separate finding:** `app/api/import/route.ts` (`maxDuration = 180`, bulk Excel import) has the identical Hobby exposure for a large workbook. Different fix shape (one Postgres transaction, not a job-queue job — would need chunking into resumable batches), and lower priority than the ingest path since it's an admin-only, much less frequent operation. Left as a follow-up, not fixed in this pass.

---

## Phase 4 — Bound everything unbounded

**Addresses:** root cause (B). **Depends on:** Phase 1 for 4.1 to be measurable. **Effort:** [L] for 4.1, [M] for the rest

**Why here.** These are the queries whose cost is not capped by anything the user does. They are survivable today and will not be at 3× the data. 4.1 also fixes a correctness bug, not just a slowdown.

- [x] **4.1 — Move candidate matching to a server-side RPC [L]**
  `app/(app)/review/page.tsx:522-529` fetches up to 5,000 `entries` rows with nine columns and ranks them in JS via `rankCandidates`, every time a bill with no `entryId` is opened — not once per session.
  Three problems, in order of seriousness:
  1. **Silent truncation.** The cap takes the 5,000 most recently dated entries. Once the ledger exceeds that, older entries become permanently unreachable as match suggestions. This is a correctness regression that arrives quietly as data grows, with no error and no warning.
  2. **RLS multiplier.** `entries_select` evaluates `private.can_see_department(department_id)` once per returned row (`supabase/migrations/20260808000026_rls_policies.sql:85-86`) — up to 5,000 SECURITY DEFINER calls per bill opened.
  3. **Payload.** 5,000 rows over the wire, per bill.
  **Fix:** a Postgres function that pre-filters by vendor and amount proximity (and invoice-number exact match) before ranking, returning a small candidate set. `entries_active_date_idx` from 1.5 supports the scan meanwhile.
  **Files:** new migration (the RPC); `app/(app)/review/page.tsx`; `lib/matching.ts` (`rankCandidates` may move server-side wholesale or stay for final scoring on a small set).
  **Careful:** `lib/matching.ts` is shared with the documents inbox (4.2) — change both call sites together or keep the JS path working until both are migrated.
  **Done when:** opening an unmatched bill fetches tens of candidate rows rather than thousands, and a deliberately old entry (beyond the former 5,000 window) is suggestible.
  **Landed.** New migration `supabase/migrations/20260905000001_match_candidate_entries.sql` adds `public.match_candidate_entries(p_vendor_id, p_amount, p_invoice_number, p_vendor_raw)`, `SECURITY INVOKER` so `entries_select`'s RLS still applies per row exactly as before. Pre-filters on four OR'd, index-backed conditions instead of the old `.limit(5000)`: exact `vendor_id` (existing `entries_vendor_idx`); amount within `lib/matching.ts`'s proximity window, padded from its 0.25 cutoff to 0.3 per the plan's own instruction and rewritten from the ratio form (`abs(a-b)/greatest(a,b) <= 0.3`) into an equivalent sargable range (`amount between p*0.7 and p/0.7` — derivation in the migration's own comment) served by a new partial index `entries_active_amount_idx`; normalized invoice-number exact match (strip non-alphanumeric, uppercase — same transform as `lib/matching.ts`'s `invoiceNumberMatch`) served by a new expression index `entries_invoice_number_normalized_idx`; and vendor-name trigram similarity via the schema-qualified `%` operator (`OPERATOR(extensions.%)`, required because the function runs `set search_path = ''`) against a new GIN index `entries_vendor_raw_trgm_idx` on `lower(vendor_raw)`, threshold loosened from pg_trgm's default 0.3 to 0.15 via a function-level `set pg_trgm.similarity_threshold` — a pre-filter is meant to be a superset of what final scoring accepts, not the final gate. No hard cap as the primary bound, per the plan's explicit instruction; a `LIMIT 300` exists only as a last-resort safety valve for a pathological case (e.g. one extremely common vendor name), ordered so exact-vendor/exact-invoice-number matches survive it first if it ever triggers — judgment call, noted in the migration itself, not picked silently.
  **Judgment call beyond the draft's shape:** matched-entry exclusion moved from a caller-supplied excluded-id list into a `NOT EXISTS` against `source_document` inside the function (one of the two shapes the plan itself allowed) — this let both call sites drop their separate "which entries are already matched" query entirely, not just replace the 5,000-row entries fetch.
  Both call sites (`app/(app)/review/page.tsx`, `lib/actions/documents.ts`'s `getInboxMatchCandidates`) call `supabase.rpc('match_candidate_entries', ...)` and still run the unchanged `rankCandidates` on the (now small) result for final scoring/top-N — `lib/matching.ts` itself was not touched, preserving its "stay pure/DB-free" design note. In `review/page.tsx`, the vendor_alias lookup (`vendorAliasRes`) the RPC needs as `p_vendor_id` still resolves inside the same parallel `Promise.all` as before, but the RPC call itself is now a sequential `await` just after that batch (previously `candidateEntriesRes`/`matchedRowsRes` were two more members of that same `Promise.all`, but they can't be — the RPC's own vendor-id parameter is that same batch's own output) — one extra network hop in sequence, traded for two fewer several-thousand-row queries overall.
  **Not verified against a live query plan.** No Supabase connection available in this session (MCP Supabase servers unauthenticated here) — same limitation as every other SQL-writing item in this plan (1.1–1.5, 4.4). `npx tsc --noEmit` and `next lint` both pass clean on every changed file.

- [x] **4.2 — Cap the inbox match-ranking [M]**
  `lib/actions/documents.ts:641-644` fetches **every** `source_document` in `('unmatched','suggested')` with no `.limit()`, ignoring the 200-row `DOCUMENT_QUERY_CAP` the page itself enforces (`app/(app)/documents/page.tsx:28`), then ranks each extraction against the same 5,000-entry pool (`documents.ts:663-671`) — O(bills × 5000). It is invoked from the client on first mount and again on every `initialDocuments` change (`components/documents/document-inbox.tsx:120-160`), which means after every attach, delete and assign, because each calls `router.refresh()`.
  **Fix:** cap the doc-id query to the ids already on screen, and re-rank only extractions that do not already have candidates.
  **Done when:** the inbox no longer re-ranks the whole backlog after a single attach.
  **Landed**, both fixes, plus a reduction in RPC-call count that fell out of doing 4.1 first. `getInboxMatchCandidates` now takes `(docIds: number[], extractionIdsNeedingRank?: number[])`; its `source_document` query is `.in('id', docIds)` narrowed to `unmatched`/`suggested` as defense in depth (the caller already only shows those, but a stale id shouldn't rank a matched document's bills), and it calls `match_candidate_entries` — one RPC per bill, run together via `Promise.all` rather than sequentially — only for the extractions named in `extractionIdsNeedingRank`; omitting it ranks everything found for `docIds`, which is what a first mount with no prior candidates needs. `document-inbox.tsx` passes `initialDocuments.map(d => d.id)` for `docIds`.
  **Judgment call, different from the plan's literal suggestion:** "track which extraction ids already have a computed `candidates` array" doesn't hold up against a real case already in this codebase — `document-card.tsx`'s "Re-run extraction" keeps the same `document_extraction.id` (`extract.ts` upserts onto the existing row rather than inserting a new one) but can change every OCR'd field the ranking reads, and every bill starts with `candidates: []` from the server (`app/(app)/documents/page.tsx`'s own comment: "Candidates are NOT ranked here any more"), so a plain "empty array = never ranked" or "id seen before = skip" check can't tell "never ranked" apart from "ranked and genuinely has zero matches," and can't tell "already ranked" apart from "ranked once, then re-extracted with different fields." Implemented instead as a client-side fingerprint (`extractionFingerprint` in `document-inbox.tsx`: the vendor/date/invoice-number/amount OCR fields, joined) kept in a `useRef<Map<number, string>>` across renders — an extraction is skipped only when its current fingerprint matches what it was last ranked with, so a re-extract's changed fields fall back into `extractionIdsNeedingRank` on the next effect run with no special-casing needed.
  **Freshness trade-off, accepted per the plan's own framing:** an already-ranked, unchanged extraction is never re-scored against the entries table just because something else in the inbox mutated (an attach/delete/assign elsewhere, each triggering `router.refresh()`). A newly-imported entry that would now match an old, already-ranked bill will not surface until that bill's own fingerprint changes (a re-extract) or the page is freshly loaded (a new mount clears the in-memory fingerprint map). Not otherwise mitigated in this pass — left as the plan itself invited ("middle ground... your judgment call").
  Verified with `npx tsc --noEmit` and `next lint`, both clean. **Not verified against a live query plan or an observed trace** — same no-Supabase-connection limitation as 4.1; the "0 or 1 RPC calls after a single attach" property follows from reading the effect's logic, not from a measured run.

- [x] **4.3 — Fetch exceptions once, derive both views [M]**
  `app/(app)/exceptions/page.tsx`: `loadQueueData` (`:198-274`) and `loadOpenSeverityCounts` (`:138-161`) each independently fetch `reconciliation_exception` — up to 3,000 and 5,000 rows respectively — and each independently calls `resolveEventIds` (`:66-112`), which itself issues up to four more round trips against `entries`, `document_extraction`, `import_batch` and `source_document`.
  **Fix:** fetch once, derive both the queue page and the severity counts from that single result, sharing one `resolveEventIds` call.
  **Related:** `loadOpenSeverityCounts` pulls 5,000 rows of six columns to produce three integers. Even after deduplication, prefer a grouped count or a small aggregate view.
  **Done when:** `/exceptions` issues roughly half its current round trips and no longer transfers thousands of rows for the severity summary.
  **Landed, as a single merged `loadQueueAndSeverityCounts` replacing both `loadQueueData` and `loadOpenSeverityCounts`.** The genuine complication called out when this item was assigned was real: the queue's fetch (status/type filtered, per-severity `.range()`-capped at 1,000) and the chips' fetch (always status=open, always every type and severity, capped at 5,000) are not the same query, so "fetch once" is only sound when the queue's own filters happen to be a superset of what the chips need. Implemented as: the queue's own bucketed fetch (`fetchExceptionBuckets`, same three ordered/capped-at-1000 queries as before, byte-for-byte) is reused as the chips' source whenever it is *provably* the full open population — `status='open' && type='all' && severity='all'` **and** none of the three buckets came back exactly at the 1,000 cap (tracked as `anyBucketAtCap`; a capped bucket means that severity may hold more rows than were fetched, so the set can no longer stand in for "every open exception"). That condition covers the page's own default view. Outside it (queue filtered to a non-open status, a specific type, or a specific severity, or a bucket genuinely hit 1,000), the chips fall back to their own fetch — but even then, only one `resolveEventIds` call runs per request: the ids from whichever row set(s) were actually fetched (queue's, and the chips' fallback fetch if it ran) are merged into one id-keyed map before the single call, so the four-round-trip chain inside `resolveEventIds` never doubles up regardless of which branch is taken.
  **Went further than the draft on the "related" ask, not just deprioritized it:** when no event is selected — the common case, since event-scoping is opt-in — the chips need no row payload at all, so they're answered by three `{ count: 'exact', head: true }` queries (one per severity), which transfer zero rows and require no `resolveEventIds` call. The 5,000-row fallback fetch (`fetchOpenSeverityCountRows`, identical shape to the original standalone query) now only runs when *both* an event is selected *and* the queue's fetch can't be reused — i.e. the one case that genuinely needs real row data (to resolve event-scoping) that the queue didn't already provide.
  **Careful, preserved exactly:** the queue's per-severity ordering (`amount_at_risk` desc, `created_at` desc, `id` desc), the 1,000-per-bucket cap and its "truncation confined to the lowest-priority bucket" guarantee, the post-event-scoping sort/paginate sequence, and the "rows with no resolvable event stay visible" rule — none of `loadQueueData`'s row-shaping logic changed, it was only extracted into `fetchExceptionBuckets` and given a cap-detection flag.
  **Remaining second-query case, by design:** whenever the queue is filtered away from the open/all-type/all-severity default *and* an event is selected, `/exceptions` still issues two `reconciliation_exception` fetches (the queue's own, plus the chips' 5,000-row fallback) — this is the case the original assignment explicitly allowed a fallback for, since the two row sets have genuinely different filters and correctness (the chips must count every open exception regardless of the queue's filter) was prioritized over collapsing this particular case to one query. `resolveEventIds` itself still only runs once even here.
  Verified with `npx tsc --noEmit` and `next lint` (both clean on this file — the only outstanding findings from either command are pre-existing and in unrelated files: a TS7006 in `app/(app)/review/page.tsx:681` and an unused-import ESLint warning in `app/api/jobs/tick/route.ts`). **Not verified:** no live Supabase connection was available in this session (MCP Supabase servers unauthenticated here), so the actual round-trip count, row volumes, and query plans were not confirmed against a real database — this needs a human with `supabase`/`pbi` access, same caveat as 1.6.

- [x] **4.4 — Add the missing row caps [S]**
  - `lib/reports/surfaces/related-party-gstin.ts:139` — the only view query in that directory without `ROW_CAP`, and deliberately not event-scoped ("a whole-corpus property"), so it grows with the entire vendor corpus rather than the active event.
  - `lib/export/queries.ts` (`getPendingExportQueue`) — no `.limit()`/`.range()`; the one genuinely unbounded query on `/export`.
  - `supabase/migrations/20260903000008_related_party_gstin_views.sql:129-144` (`v_tax_credit_exposure`) — its `bill_tax` CTE selects from `document_extraction` with no `WHERE` clause at all, running a correlated `EXISTS` for every bill ever extracted. The 1.1 index covers the `EXISTS`; consider bounding by event or date as the other Phase 5 views do.
  **Done when:** no query in the reports or export paths is unbounded.
  Landed, all three, each with a judgment call flagged explicitly rather than picked silently.
  **`related-party-gstin.ts`:** added `.order('vendor_id_a').order('vendor_id_b').limit(ROW_CAP)` to the `v_vendor_shared_identity_edges` read, reusing the existing `ROW_CAP` import rather than a new constant, for consistency with the `v_tax_credit_exposure` query a few lines below in the same `Promise.all`. **Judgment call, documented in-code:** read `buildVendorClusters` first — clusters are connected components derived from the *whole* edge set after the fact, so no per-row ordering can guarantee a cap never severs the one edge bridging two dense subgraphs, which would silently present one real cluster as two smaller ones. There is no column to sort by that reflects "which edges matter to clustering" before clustering has happened. Ordered by `(vendor_id_a, vendor_id_b)` only for determinism across requests, not because it protects cluster integrity — it doesn't. At today's volumes (the view's own header comment: "tens of vendors, not thousands") 1000 edges is far from binding; flagged in-code so a future re-audit at a much larger vendor corpus knows the cap is a size bound, not a correctness guarantee.
  **`lib/export/queries.ts` (`getPendingExportQueue`):** now returns `{ entries, totalPendingCount, truncated }` instead of a bare array. Capped at 1000 (matching `ROW_CAP`'s "how many rows can an admin screen usefully render" judgment, comfortably above the volumes this file's own comments cite), fetching one row past the cap to detect truncation — same pattern `app/(app)/documents/page.tsx`'s `DOCUMENT_QUERY_CAP` already uses. Ordered oldest-`hub_status_changed_at`-first (same order `generateStatusExportBatch` uses), so a truncated view still surfaces the longest-waiting entries rather than an arbitrary slice. `totalPendingCount` comes from a separate uncapped `count: 'exact', head: true` query on the same filter, run in the same `Promise.all` — this is what feeds `GenerateBatchForm`'s pending-count button instead of `entries.length`, because `generateStatusExportBatch` re-queries uncapped and would otherwise export more rows than a capped `queue.length` claimed were pending. `app/(app)/export/page.tsx` updated for the new shape, including a truncation note on the Pending queue card ("Showing the N that have been waiting longest") mirroring the documents page's own notice.
  **`v_tax_credit_exposure`:** new migration `supabase/migrations/20260905000002_tax_credit_exposure_bound.sql` (the `20260903000008` migration left as originally landed, per this repo's "new migration replaces the view" convention — see `20260904000001_review_queue_perf_rewrite.sql`'s `create or replace view` precedent). Two changes: (1) push `document_extraction`'s own tax-amount/entry-join/`is_void` filters *before* the correlated `EXISTS`, which is purely correctness-preserving — `bill_entry` already discarded exactly these rows unconditionally, so pruning first changes the plan, not the result; (2) **judgment call, not correctness-preserving, flagged explicitly:** also bounded `document_extraction` by the same rolling 2-year window on `created_at` that 1.3 used for `v_review_queue_all`, because filter pushdown alone removes the noise (unlinked/void/untaxed bills) but does not bound the *valid* population — a real, taxed, non-void corpus still grows the `EXISTS` count without limit as events accumulate over years, which is the actual unbounded-growth complaint. Unlike 1.3, this bound was **not** separately confirmed with the user in this session (no live DB, no interactive round trip available) — it mirrors 1.3's already-accepted precedent rather than a fresh product decision, and the migration's own header comment says so, with the same risk 1.3 called out: a selected event older than 2 years would make this view read as entirely empty for that event rather than erroring. Confirm before applying to a live corpus that has (or will have) events beyond that window. View's output columns and `security_invoker = true` preserved exactly (same order, same names) via `create or replace view`; no re-grant needed (`CREATE OR REPLACE VIEW` does not revoke existing grants, per `20260814000009`'s note, restated in `20260904000001`).
  **Not applied to the live DB in this session** — same limitation as every other migration in this plan; no Supabase connection was available. `npx tsc --noEmit` passes for all touched files (one unrelated pre-existing error remains in `app/(app)/review/page.tsx:681`, from the concurrent session's Phase 4.1 `match_candidate_entries` work, not touched by this item). `next lint` is clean (one pre-existing unrelated warning in `app/api/jobs/tick/route.ts`).

---

## Phase 5 — Stop the review workspace re-rendering on every keystroke

**Depends on:** Phase 1 (otherwise the gain is masked by query latency). **Effort:** [L]

**Why here.** This is the most-used screen in the app and the work is real, but it is invisible until the server is fast. Do not start it before Phase 1 lands or you will not be able to measure it.

- [x] **5.1 — Split the header form state [M]**
  `components/review/review-workspace.tsx:262-263` holds all twelve header fields in one `useState` object and all line items in one array, so typing a single character replaces the whole object and re-renders everything below.
  **Fix:** split into per-field slices, or move to an uncontrolled model.
  **Done when:** typing in a header field does not change the identity of `lineItems` or of unrelated header fields.
  Landed. Twelve independent `useState` slices replace the one `HeaderFormState` object; `header` itself is still assembled via `useMemo` purely so `ExtractionForm`/the save payload don't need a shape change, but nothing downstream keys a hook dependency on that assembled object any more — `onHeaderChange` (a `[]`-deps `useCallback`, since `useState` setters are referentially stable) is the single per-keystroke entry point, dispatching to the right setter via a `switch`. Verified: typing in one header field never touches `lineItems`' setter or any other field's setter.

- [x] **5.2 — Stabilise the props, then memoize the heavy children [M]**
  **Order matters:** stabilise first. Wrapping children in `memo()` while the parent still passes fresh references does nothing.
  - Stabilise: `review-workspace.tsx:1458` (`onHeaderChange`), `:1460-1462` (`onLineItemChange`), `:1481-1489` (`onJumpToPage`) into `useCallback`; `:1427-1431` (`billPageRanges={detail.siblingBills.map(...)}`, a new array every render) into `useMemo`.
  - Then memoize: `ExtractionForm` (`extraction-form.tsx:177`), `PdfViewer` (`pdf-viewer.tsx:90`), `ReviewStatusLine` (`review-status-line.tsx:63`), `TallyFooter` (`tally-footer.tsx:28`), `MatchStrip` (`match-strip.tsx:30`). All are currently bare — `PdfViewer` and `ExtractionForm` are `forwardRef` without `memo`.
  **Done when:** a React Profiler trace of one keystroke in a header field shows the PDF canvas and line-item rows not re-rendering.
  Landed, in two passes. First pass (parallel subagents) did `onHeaderChange`/`onLineItemChange` as `[]`-deps `useCallback`s and wrapped all five children in `memo()` at their own definitions — `PdfViewer` and `ExtractionForm` as `memo(forwardRef(...))` (memo wrapping the forwardRef result, not the reverse, to keep ref-forwarding intact). A post-hoc correctness review (see 5.7's note on how that review was run) caught that `onJumpToPage` and `billPageRanges` were missed — both were still fresh references on every render, which would have silently defeated `memo(PdfViewer)` since `billPageRanges` is one of its props. Second pass fixed both directly: `billPageRanges` is now `useMemo(..., [detail.siblingBills])`; `onJumpToPage` is now a `[]`-deps `useCallback` (uses a functional `setPaneMode` update instead of reading `paneMode` directly, so it needs no dependency on that state at all). No live React Profiler trace available in this session to confirm the keystroke behavior at runtime — verified by reading the callback/memo chain instead.

- [x] **5.3 — Fix the O(n²) edited-field diff [S]**
  `review-workspace.tsx:328-331` runs `detail.lineItems.find(d => d.id === li.id)` inside a loop over live line items, and the enclosing `useMemo` depends on `[header, lineItems, detail]` — so it recomputes on every keystroke *anywhere*, including header fields.
  **Fix:** `const baselineById = useMemo(() => new Map(detail.lineItems.map(d => [d.id, d])), [detail.lineItems])`, then `.get(li.id)`.
  Landed as `baselineLineItemById`, a `Map` built once per bill. The diff itself was also split into `editedHeaderFields` (deps `[header, detail.header]`) and `editedLineItemFields` (deps `[lineItems, baselineLineItemById]`), matching 5.1's per-slice philosophy — a line-item keystroke no longer recomputes the header half and vice versa, not just the O(n²) fix alone.

- [x] **5.4 — Replace the stringify-based dirty check [S]**
  `review-workspace.tsx:309-314` runs `JSON.stringify` over the whole header and all line items — twice, both sides — on every keystroke, serialising free-text `notes` and `description` just to compare.
  **Fix:** a boolean ref flipped true on the first `setHeader`/`setLineItems`. It never needs to return to false before remount.
  Landed as `hasEditedRef`, flipped in `onHeaderChange`, `onLineItemChange`, and `handleAddLineItem`; `dirty` now just reads `hasEditedRef.current`. No `JSON.stringify` remains in the file.

- [x] **5.5 — Register the keydown listener once [S]**
  `review-workspace.tsx:985-1104` has no dependency array — deliberate, per its comment, to avoid stale closures — so combined with the re-render rate it performs an `addEventListener`/`removeEventListener` pair on `window` per character typed.
  **Fix:** hold the changing values (`header`, `lineItems`, `claimState`) in refs updated by a separate effect, and register once with `[]`.
  Landed via a "latest ref" pattern: `handleKeyDownRef.current` is reassigned unconditionally in the render body every render (closing over that render's current values), and a separate `window.addEventListener` effect registers exactly once with `[]` deps, forwarding each event to `handleKeyDownRef.current(e)`. No stale-closure risk — the ref is always current by the time any real keypress fires.

- [x] **5.6 — Memoize `lineItemSum` [S]**
  `review-workspace.tsx:1119` re-parses every amount string on every render, unlike `editedFields`/`validationErrors` a few lines above which are properly memoized.
  Landed: `useMemo(..., [lineItems])`, matching the sibling memos.

- [x] **5.7 — Key the PDF viewer on the source document, not the bill [M]**
  `app/(app)/review/page.tsx:302,340` passes `key={documentExtractionId}:{runId}`, so stepping between sibling bills **of the same PDF** unmounts `PdfViewer` entirely — discarding the parsed pdf.js document, zoom, rotation, scroll position and the rendered thumbnail rail — then re-fetches the same signed URL and re-parses the identical binary (`pdf-viewer.tsx:290-349`). It also forces the claim heartbeat effects (`review-workspace.tsx:545-579`, `:593-611`) to release and re-acquire the claim even though the reviewer never left the document.
  **Fix:** hoist `PdfViewer` above the remount boundary, or key it on `sourceDocumentId` alone, and pass the page/bill as props.
  **Done when:** J/K between bills of one PDF issues no new signed-URL fetch and no claim round trip.
  **Landed, after a real miss caught by a dedicated verification pass.** The implementing agent wrote all the supporting machinery in `review-workspace.tsx` (a "5.7" reset-on-prop-change block that resets header/line-item state, the dirty latch, the uncertain-field stepper, `vendorId`, and initial focus whenever `documentExtractionId` changes, since the component would no longer remount for free) but never actually changed the two `key={...}` lines in `app/(app)/review/page.tsx` — they still read `` `${detail.documentExtractionId}:${detail.currentExtractionRunId ?? 'none'}` ``, so the component kept remounting on every bill switch exactly as before, and all the new reset-block code was dead. Given this plan's "check items off as you land them" convention is what the next re-audit trusts, a second, independent verification subagent was deliberately run against every Phase 5/6 item's actual behavior (not just compile success) specifically to catch this kind of gap — it did. Fixed directly: both `key={...}` lines in `page.tsx` now read `key={detail.sourceDocumentId}`.
  **Second, related bug the same fix required:** `extract.ts` upserts a whole-document re-extract onto the *same* `document_extraction.id` row and only bumps `current_extraction_run_id` — so the reset-on-prop-change block, which only compared `documentExtractionId`, would have missed a full re-extract entirely once the key stopped forcing a remount on every `currentExtractionRunId` change too. Widened the block's guard to fire on either `documentExtractionId` or `currentExtractionRunId` changing. `handleReExtractField` (the single-field re-extract) is unaffected — it deliberately never calls `router.refresh()`, so `detail` never changes under it. Updated the three comments that described the old "`currentExtractionRunId` is part of the React key" behavior (`review-workspace.tsx`, `lib/actions/review.ts`, `lib/review/types.ts`) to match the new mechanism.
  Verified (by the review subagent, by reading — no live session available): the claim mount/heartbeat effects are already correctly keyed on `sourceDocumentId`, so with the key fix in place they now genuinely stop firing on a same-PDF bill switch. `npx tsc --noEmit`, `npx next lint`, and `npx next build` all pass clean.

- [x] **5.8 — Add race protection to the two search comboboxes [S]**
  `components/review/vendor-autocomplete.tsx:76-86` and `components/review/entry-attach-combobox.tsx:87-102` both debounce correctly at 200 ms with proper cleanup, but once a request is in flight there is no request id or `AbortController` — a slow earlier response can silently overwrite newer, correct results.
  **Fix:** a monotonic request counter per effect run; ignore any resolution that is not the latest.
  Landed identically in both files: a `requestIdRef`, bumped synchronously right before each fetch, with the resolution only applied if `requestIdRef.current` still matches the id captured at fetch time. `entry-attach-combobox.tsx` also bumps the counter on its early-return (query < 2 chars) branch so a still-in-flight fetch from before a clear can't land afterward.

- [x] **5.9 — Lazily render PDF thumbnails [M]**
  `pdf-viewer.tsx:648-661` calls `renderThumbnail(n)` from the ref callback the moment each canvas mounts, so a long source PDF fires N concurrent `page.render()` calls with no viewport awareness. The existing duplicate-render guard is correct and should be preserved.
  **Fix:** render on intersection.
  Landed via a single lazily-created `IntersectionObserver` (`rootMargin: '400px 0px'`, default root — a scoped `root` was deliberately not used since a canvas ref callback can fire before its scrollable-rail parent's own ref is attached, and ancestor overflow-clipping is honored regardless of the named root per spec). `renderedThumbnailPagesRef` preserves the original duplicate-render guard, marked *before* the async render starts. The observer disconnects/recreates on source-document change and on unmount.
  **Regression caught by the same verification pass, fixed directly:** the thumbnail rail unconditionally unmounts on pane-collapse (unlike the main canvas, which stays mounted across that toggle by design), destroying and recreating its `<canvas>` nodes — but `renderedThumbnailPagesRef` was only cleared on a document change, not on that unmount. A Split → Collapsed → Split cycle (the `\` shortcut, a normal workflow) therefore left every thumbnail permanently blank: the fresh canvas got re-observed, but the observer skipped it as "already rendered." Fixed by deleting a page's entry from `renderedThumbnailPagesRef` in the ref callback's own cleanup branch (`!el`), so a genuinely fresh canvas is treated as unrendered again.
  No live browser or long PDF available in this session to observe the fix directly — verified by reading the observer/guard/cleanup interaction, plus `npx tsc --noEmit`/`npx next lint`/`npx next build` all clean.

---

## Phase 6 — Stream the reports surface

**Depends on:** Phase 2 (streaming a page that resolves the event nine times just streams the waste). **Effort:** [M]

- [x] **6.1 — Wrap report sections in `<Suspense>` [M]**
  There is no `<Suspense>` anywhere under `app/(app)/reports/**` — confirmed by grep, zero matches. Every route awaits its full `Promise.all` before returning any JSX, so the single slowest surface gates every section on the page, including ones that resolved instantly. Explore renders 15–20 sections this way.
  **Files:** `app/(app)/reports/page.tsx`, `brief/page.tsx`, `budget/page.tsx`, `vendors/page.tsx`, `integrity/page.tsx`.
  **Fix:** split each `ReportSection` (or logical group) into its own async Server Component behind a boundary, with a skeleton fallback.
  **Done when:** the hero metrics paint before the slowest surface has resolved.
  **Landed on all five pages** — a genuine restructuring, not Suspense bolted onto an unchanged `await`. Each page's sections are now grouped into small async Server Components (e.g. `BudgetGroup1`, `VendorsGroup2`), each doing its own real `await` of its loader and each wrapped in its own `<Suspense fallback={<SectionSkeleton />}>`. Hero/summary content (the Overview band on `/reports`, the executive brief bands on `/reports/brief`, the fast `totalSpend` query on `/reports/integrity`) stays a plain top-level `await` ahead of every Suspense boundary, unchanged from the Phase 2.4 pattern, so it paints independently of the slowest section. Where one loader feeds multiple non-adjacent groups (budget, vendors, integrity, quantity-zone-price, budget-structure, spend-curve-open-ageing, duplicate-vendor-risk), it's wrapped in React's `cache()` so it still fires once per request, not once per group. Each loader's existing try/catch-and-return-`{error}` pattern was left untouched. One disclosed content move on `/reports`: the "couldn't resolve the prior comparison period" banner moved from above the Overview band into the first integrity-fed group, since it reads off the integrity loader (which the hero loader doesn't touch) and showing it before Overview would have forced hero to wait on integrity too — documented in the file's own comment.
  Verified independently (a dedicated review subagent walked all ~50 sections on `/reports` against the pre-change git diff, plus every group on the other four pages) that section order and content survived the restructuring exactly, and that no page still has a page-wide `Promise.all` gating its JSX. `npx tsc --noEmit`, `npx next lint`, and `npx next build` all pass clean; `/reports`' own First Load JS dropped to 517 B in the build output, consistent with section code actually moving into separately-streamed chunks rather than the page's own bundle.

- [x] **6.2 — Add a per-route `error.tsx` for the reports surface [S]**
  Each loader already catches its own query errors and returns `{error}` per section — a good pattern worth keeping. But an unexpected throw outside that try/catch falls through to the root `app/error.tsx` and blanks a page of twenty sections, discarding every other section's already-successful data.
  **Files:** new `app/(app)/reports/error.tsx` (and optionally per surface route).
  **Done when:** one section throwing leaves the rest of the page rendered.
  Landed: new `app/(app)/reports/error.tsx`, a `'use client'` route-segment error boundary matching the root `app/error.tsx`'s pattern (Sentry `captureException` in a `useEffect`, `FriendlyError` messaging, digest reference, a "Try again" `reset()` button and a "Back to Explore" link). Rendered as an inline `Card` rather than a full-screen takeover, since `app/(app)/reports/layout.tsx` keeps the sticky period bar and surface-tab nav mounted around it — a reviewer can still switch surfaces or change the period after a crash. **Judgment call:** skipped the optional per-surface `error.tsx` files under `brief/`, `budget/`, `vendors/`, `integrity/` — Next.js error boundaries already inherit down to nested segments with no boundary of their own, so the one route-level file already covers all five routes for this failure mode; four near-duplicate files would only buy a cosmetic per-surface "back" link. **Known limitation, scoped out on purpose:** this boundary catches a throw outside each surface loader's own try/catch, but within one page's render tree it still replaces every Suspense-streamed group on that page, not just the one that failed — true per-section isolation would need a client `<ErrorBoundary>` wrapped inside each of 6.1's Suspense boundaries, not just a route-level `error.tsx`. Not done in this pass; flagged for a future item if per-section isolation is wanted.

- [x] **6.3 — Memoize the purchase tree [S]**
  `components/reports/charts/purchase-tree-chart.tsx:281-282` runs `buildFamilyNodes(rows)` — a recursive four-level grouping and sorting pass over up to 1,000 rows — on every render with no `useMemo`, so every expand/collapse click and every flat-table toggle re-derives the whole tree. Its siblings (`heatmap-matrix-chart.tsx:84-90`, `related-party-network-chart.tsx:135`) all memoize; this one is the outlier.
  Landed: `useMemo(() => buildFamilyNodes(rows), [rows])`, matching the sibling charts' convention exactly. The memo call had to move above the component's existing `if (rows.length === 0) return null` early return to keep the hook call unconditional — same placement pattern those siblings already use.

- [x] **6.4 — Consider deferring below-the-fold charts [M]**
  Twenty-six of ~29 chart components are `'use client'` and all are imported statically into pages that render everything in one long scroll. The per-chart cost is modest — they are hand-built SVG with no chart library, which is the right call — but nothing defers hydration for sections far below the fold.
  **Fix:** `next/dynamic` for the heaviest and lowest (`related-party-network-chart`, `purchase-tree-chart`, `benford-chart`).
  **Judgement call:** measure before doing this. It may not be worth the complexity.
  Landed for exactly the three named charts. Since a Server Component can't call `next/dynamic({ ssr: false })` directly, each got a tiny `'use client'` wrapper file (`benford-chart-lazy.tsx`, `purchase-tree-chart-lazy.tsx`, `related-party-network-chart-lazy.tsx`) that does the dynamic import with a `Skeleton` loading fallback, mirroring the same pattern already used for `PdfViewer` in `review-workspace.tsx`. The three section components (`benford-digit-test.tsx`, `purchase-tree.tsx`, `related-party-clusters.tsx`) import the `-lazy` version in place of the original; nothing else in the app still imports the original components' runtime export directly. No live session was available to measure the before/after hydration-cost tradeoff the plan's own "measure first" note calls for — verified only that the wiring is correct (`npx tsc --noEmit`/`npx next lint`/`npx next build` clean), not that the change is a net win at current chart weights.

---

## Phase 7 — Remaining efficiency and polish

**Depends on:** — **Effort:** all [S] unless noted

- [x] **7.1 — Parallelise the entry-detail waterfall [S]**
  `app/(app)/entries/[id]/page.tsx:58-74` awaits `getSelectedEventId`, `getCachedUser`, `getStaffContext` and the `v_entry_enriched` select one after another, though the first three are mutually independent and the entry query needs only the id. Separately, `:228-232` awaits `perBillMatches` then `directMatches` back-to-back with no dependency between them.
  **Fix:** `Promise.all` both groups — removes about four hops from the most-visited detail screen.
  Landed. Both waterfalls are now single `Promise.all` groups — `getSelectedEventId`/`getCachedUser`/`getStaffContext`/the `v_entry_enriched` select as one group, `perBillMatches`/`directMatches` as the other. Incidental fix caught by the restructuring: uncommitted in-progress code in this file was calling `getSelectedEventId(supabase)`, a stale argument from before Phase 2.1 dropped that parameter — the rewrite naturally drops it since the call is just one `Promise.all` member now. `npx tsc --noEmit`/`next lint` clean.

- [x] **7.2 — Stop selecting `*` from `v_entry_enriched` [S]**
  `components/entries/query.ts:68` (`ENTRIES_SELECT = '*'`) sends all ~35 view columns on every list fetch (`:182`), every CSV export batch (`components/entries/csv-export.ts:59`) and every detail load, though the column chooser means most renders use a subset.
  **Fix:** select the union of columns `ALL_COLUMNS` can render, plus `id`.
  Landed for all three call sites that were selecting `*` against `v_entry_enriched` (`query.ts`'s `ENTRIES_SELECT`, `csv-export.ts`'s previously-hardcoded `.select('*')`, and `entries/[id]/page.tsx`'s detail select — the last of these was `*` too, not just the two named in the plan). One shared source of truth: `COLUMN_KEY_SELECT_COLUMNS` in `query.ts` maps each `ColumnKey` from `ALL_COLUMNS` to its underlying raw column(s) (`export_pending` needs two, `hub_status_exported_at` + `hub_status_code`, since it's client-derived). The list/CSV select is that map's columns plus `id`. **Judgment call:** the detail page reads more fields than `ALL_COLUMNS` covers (its own `EntryEnriched` type has ~44 fields; three child components — `import-fields-panel.tsx`, `reimbursement-detail-section.tsx`, `advance-payment-detail-section.tsx` — take the whole object) — grepped every field access across the detail tree and built `ENTRY_DETAIL_SELECT` as the shared list base plus 17 extra columns the detail view actually needs. Ten confirmed-unused columns are dropped (`budget_head_id`, `status_id`, `status_code`, `hub_status_id`, `hub_status_changed_at`, `hub_status_changed_by`, `hub_status_note`, `import_batch_id`, `created_at`, `updated_at`); four more that ride along unused (`admin_head_name`, `zone_name`, `cost_center_name`, `document_count`) were kept anyway since they're part of the shared list base and a third near-duplicate column list wasn't worth avoiding four harmless columns — documented in-code. **TS wrinkle:** supabase-js only compile-time-checks select strings that are literals, not `.join()`-built constants, so these trip a `GenericStringError` fallback — resolved with the same `as unknown as EntriesQueryBuilder` escape hatch `fetchAllMatchingIds` already used for the same reason (`EntriesQueryBuilder` exported from `query.ts` for reuse). `npx tsc --noEmit`/`next lint` clean. Not verified against a live query plan — no Supabase connection in this session, same limitation as every SQL/query item elsewhere in this plan.

- [x] **7.3 — Join the stray documents query to the parallel batch [S]**
  `app/(app)/documents/page.tsx:341-349` (`oldestQueuedJob`) has no dependency on anything above it, yet runs after both `Promise.all` blocks (`:202-209`, `:223-227`) instead of inside one.
  Landed. `oldestQueuedJob`'s admin-client job-queue query now runs inside the same `Promise.all` as `getCachedAdminHeads`/`getCachedZones`/`getCachedCostCenters` (the admin client is hoisted once above it); the old sequential block after that `Promise.all` is gone. No behavior change, just concurrency.

- [x] **7.4 — URL-sync the document table filters [M]**
  `components/documents/document-table.tsx:130` holds `DocumentFilters` in plain `useState`, unlike the entries screen where all thirteen filters plus sort are URL-synced. A filtered or sorted view of the inbox is not shareable and the back button does not restore it. The code comment acknowledges this as a scale tradeoff, but the inbox already runs at its 200-row cap.
  Landed, mirroring `entries-explorer.tsx`'s URL-sync pattern: `document-table.tsx` reads its five filters plus sort from the URL on mount and writes back on every change (search debounced 300ms like the vendor field elsewhere in the app; everything else immediate), with a resync effect for browser back/forward. **Judgment call, documented in-code:** since these filters run client-side over an already-fetched array (no new server fetch needed, unlike entries), writes go through the raw History API (`pushState`/`replaceState`) rather than `next/navigation`'s router — a `router.push` would re-run the whole page-level query pipeline (docs, assignees, extractions, admin heads, zones) on every keystroke, exactly the waste this phase exists to remove. `useSearchParams()` still observes History-API writes per Next's documented behavior, so both this and 7.5's param-cloning/back-forward resync work correctly. This is the app's second `useSearchParams()` consumer, so `Suspense` boundaries were added around `DocumentTable` (in `document-inbox.tsx`) and `LoadMoreDocuments` (in `page.tsx`), matching the existing `entries/page.tsx` precedent.

- [x] **7.5 — Give documents past the 200 cap a way to be reached [M]**
  `app/(app)/documents/page.tsx:28,408` hard-caps at 200 with a "showing the latest 200" notice but no pagination, so an older unmatched document stays invisible until the newer backlog clears.
  Landed. `DOCUMENT_QUERY_CAP` (200) is now a default/increment rather than a hard ceiling, gated by a new `docsLimit` URL param the RSC reads (clamped to a `DOCUMENT_QUERY_MAX` of 2000 as a defense-in-depth ceiling). New `components/documents/load-more-documents.tsx` (mirroring `assignment-scope.tsx`'s shape) renders next to the "showing the latest N" notice and pushes `?docsLimit=<current+200>`, preserving other params. **Judgment call:** chose "widen the fetch and refetch" over cursor pagination or infinite scroll — `docs`/`docIds` already flow into every dependent query (assignees, extractions, failure reasons, scope filtering) by construction, so this reuses that whole pipeline unchanged instead of adding a parallel "append" path; it's a real server round trip (like the existing scope/assignee URL params) since RLS-scoped data outside the current window can only be found server-side. Trade-off: repeated clicks re-fetch the whole growing window rather than incrementally appending — capped at 10x default as insurance against a very large `.in()` fan-out.
  Verification for 7.3/7.4/7.5 together: `npx tsc --noEmit` clean, `next lint` clean (one pre-existing unrelated warning in `app/api/jobs/tick/route.ts`), `next build` succeeds, `vitest run` 472/472 relevant tests pass (one unrelated pre-existing failure, `portal-linkage.test.ts`, missing an external `.xlsx` fixture). No live Supabase connection available to observe the widened-limit query or RLS-scoped joins in practice — verified by reading, same limitation as elsewhere in this plan.

- [x] **7.6 — Refresh the session cookie on the polling route [S]**
  Middleware is the only place the Supabase session cookie is refreshed and it never runs for `/api/*` (`middleware.ts:113-121`), while `components/documents/document-inbox.tsx:193` and `upload-dropzone.tsx:284` poll `/api/documents/status` every 4 s. A poll-only session outliving the access token (default 1 hour) starts failing with 401s with no navigation to rescue it.
  **Fix:** let the status route refresh via its own client — a Route Handler *can* write cookies, unlike a Server Component. Verify `setAll`'s try/catch (`lib/supabase/server.ts:28-36`) does not silently swallow it in that context.
  **Investigated, found already correct, documented rather than changed.** Traced Next.js 15's own route-module source: cookie mutation is gated on `requestStore.phase === 'action'`, Route Handlers run with `phase: 'action'` (same as Server Actions), and after the handler resolves Next explicitly merges `requestStore.mutableCookies` onto whatever response was returned — regardless of `NextResponse.json(...)` vs. plain `Response`, and regardless of wrapping layers like `withApiLogging`. So `lib/supabase/server.ts`'s existing `setAll` try/catch was already correct for this context (the catch only fires for Server Components); `app/api/documents/status/route.ts`'s existing `getStaffContext()` call already triggers `auth.getUser()` on the session-bound client, which is exactly the refresh trigger this item asked for. No functional code changed — both files got header comments citing the exact Next.js mechanism and the concrete consumer, converting an implicit, one-refactor-from-breaking correctness property into an explicit, protected one. `npx tsc --noEmit`/`next lint` clean on both files. Not observed live (no Supabase connection/browser in this session) — verified by reading Next's own source rather than a runtime trace.

- [x] **7.7 — Lazy-load the command palette [S]**
  `app/(app)/layout.tsx:6,43` imports `CommandPalette` statically, pulling `cmdk` into every authenticated navigation though it only opens on Alt+K. Small, but the same pattern already proven for `PdfViewer` applies cleanly.
  Landed via a `command-palette-lazy.tsx` wrapper (same shape as the Phase 6.4 chart `-lazy` wrappers and `review-workspace.tsx`'s `PdfViewer`), since `app/(app)/layout.tsx` is a Server Component and can't call `next/dynamic({ ssr: false })` directly. No loading fallback — the palette renders nothing until Alt+K opens it. `npx tsc --noEmit` clean.

- [x] **7.8 — Add progress feedback to the CSV export [S]**
  `components/entries/csv-export.ts:56-84` fetches up to 20 batches of 1,000 rows — necessarily sequential, since each cursor depends on the last — while the UI shows a static "Exporting…" label (`entries-explorer.tsx:477-480`) with no row count.
  Landed. `exportEntriesToCsv` takes an optional `onProgress?: (rowCount: number) => void`, called with the running cumulative count after each batch; `entries-explorer.tsx` shows "Exporting… N,NNN rows" (en-IN formatted, matching the file's existing locale convention) once the first batch lands, falling back to plain "Exporting…" before that. `npx tsc --noEmit`/`next lint` clean.

- [x] **7.9 — Poll or revalidate after enqueuing a board pack [S]**
  `components/reports/sections/board-pack-download.tsx:51` toasts "queued — it will appear here once the next job tick runs", but `BoardPackList` (`board-pack-list.tsx:39-95`) is a plain server component with no polling, so the user must reload `/reports/brief` to discover whether the job produced anything.
  **Note:** `BoardPackList` is not currently imported by any page. Wire this when it lands.
  **That note is now stale — corrected during this pass.** `BoardPackList` is imported and rendered (inside its own `<Suspense>`) on both `/reports` and `/reports/brief` as of Phase 6.1's streaming restructuring; no page-level changes were needed. **Fix landed:** `enqueueBoardPack` (`board-pack-actions.ts`) now returns the inserted `job_queue` row's id; a new `getBoardPackJobStatus(jobId)` action (same staff-gated posture as `getBoardPackDownloadUrl`) lets the client check it. `BoardPackGenerateButton` polls that status after the enqueue toast with backoff `[3000, 5000, 8000, 15000]` ms capped at 16 attempts (~3.5 min); on `succeeded` it toasts and calls `router.refresh()` (re-populating the Suspense-wrapped list), on `failed`/`dead` it shows `toastError`, and past the attempt cap it gives up silently (the original toast already set that expectation). **Judgment call — polling over `revalidatePath`/`revalidateTag`:** the board-pack job handler is dispatched from both a Next Route Handler (`/api/jobs/tick`, a Hobby-plan once-daily Vercel Cron safety net) and a standalone Node `worker/index.ts` loop with no Next request context — the actual primary driver. `revalidatePath`/`revalidateTag` only work inside a Next request context, so firing it from the handler would silently no-op whenever the standalone worker is what ran the job. Client-side polling sidesteps this and mirrors `document-inbox.tsx`'s existing narrow-status-poll-with-backoff precedent. `npx tsc --noEmit`/`next lint` clean on both touched files. Not observed live — verified by reading the job-status union and both dispatch paths.

- [x] **7.10 — Add a confirmation step to vendor merge [S]**
  `components/admin/vendor-merge-panel.tsx:75-95,158-200` merges immediately on target selection with no confirmation, unlike bulk-resolve-exceptions and document delete which both confirm. It is reversible via "Undo merge", which lowers the severity, but spend and document history are re-attributed with no "are you sure" moment.
  Landed. Clicking a candidate target no longer merges immediately — it swaps the `MergeDialog`'s body to a confirmation view ("Merge '{source}' into '{target}'?" plus a description of what re-attribution means, sourced from actually reading `mergeVendor`'s implementation: it only sets `cluster_group_id`, nothing is deleted or copied) with `Back`/`Confirm merge` (destructive-styled) actions; `handleOpenChange` resets the pending target alongside the existing query reset on close. Modeled on `bulk-resolve-exceptions-dialog.tsx`'s own confirm-step state (swap one `Dialog`'s body rather than nest a second dialog), which itself follows the `Dialog`-confirmation convention `users-table.tsx` established in 3.1. `npx tsc --noEmit`/`next lint` clean.

- [x] **7.11 — Drop the redundant index [S]**
  `supabase/migrations/20260817000002_document_extraction_multi_bill.sql:38-43` adds `document_extraction_document_idx on (source_document_id)`, but the unique constraint `(source_document_id, bill_index)` already provides a btree led by that column and fully supports both the equality filter and the ordered fetch. The extra index is maintained on every write for no read benefit.
  Landed as a new migration (`supabase/migrations/20260905000003_drop_redundant_document_extraction_document_idx.sql`), per this repo's "new migration, don't edit an applied one" convention — `DROP INDEX CONCURRENTLY IF EXISTS`, with the same "can't run inside a transaction block" caveat noted in its header as the CONCURRENTLY statements elsewhere in this plan. Not applied to the live DB or verified against a real plan in this session — same no-Supabase-connection limitation as every other migration item in this plan.

- [x] **7.12 — Clean up the dead login validation [S]**
  `app/login/page.tsx:48,57` sets `pattern="[0-9]{8}"` and `required` on a `<form noValidate>`, so neither ever fires; the `onChange` already strips non-digits and caps length. Harmless, but misleading to the next reader.
  Landed. Removed `pattern`/`required` from the ITS-number field and the now-equally-dead `required` from the password field (same `noValidate` form) — the `onChange` handlers and server-side validation in `loginWithIts` were already the real enforcement. `npx tsc --noEmit` clean.

---

## Not doing (decided, with reasons)

Recorded so a future re-audit does not re-raise them.

- **`force-dynamic` on every route.** Correct and unavoidable while the nonce-based CSP stands — a static shell cannot carry a per-request nonce, so Partial Prerendering would not help either. Already documented in `perf-ux-audit-checklist.md` Phase 5.1. Revisit only if the CSP strategy changes.
- **Table virtualization.** Entries caps at 50 rows per page and documents at 200 with client pagination, so there is nothing to virtualize. Becomes relevant only if the page-size options grow.
- **`optimizePackageImports` in `next.config.ts`.** Next 15 auto-optimizes a default list that already includes `lucide-react` and `date-fns`. Verify with a bundle analyzer before adding config that may be redundant.
- **The `can_see_source_document()` → `can_see_document_extraction()` RLS chain.** Correlated by design (the argument varies per row), so it cannot become an InitPlan. Fixing it means denormalizing `department_id` onto three tables — a schema redesign, not an index fix. Noted for awareness only.
- **Asymmetric JWT verification.** The single largest remaining lever — it would remove one to two real network hops from *every* request by letting `getClaims()` verify locally instead of `auth.getUser()` calling the Auth server. But it requires enabling asymmetric signing keys on the Supabase project (a project-level setting, possibly plan-gated) plus changes in `middleware.ts` and `lib/supabase/server.ts`. **Evaluate before committing** — this is a decision, not a task.

---

## Verified correct — do not regress

Confirmed working during this audit. Any phase above that appears to conflict with one of these has a bug in the plan, not in the code.

- **RLS follows the performance rule.** Every `auth.uid()` is wrapped in `(select auth.uid())` and the zero-argument helpers (`is_staff()`, `is_admin()`, `is_reviewer_or_admin()`) are `stable security definer`, so Postgres evaluates them once per query rather than once per row. This is the most common RLS performance mistake and the schema avoids it.
- **Light mode is correctly enforced.** `tailwind.config.ts:4` sets `darkMode: 'class'`; `app/layout.tsx:47-51`'s pre-hydration script reads only `localStorage` and never consults `prefers-color-scheme`.
- **Plain-English errors hold.** All ~90 `toastError`/`toast.error` call sites route through the friendly-error pipeline except the two in 3.4. No bare `catch {}` swallowing anywhere.
- **Unsaved-work protection is thorough.** A dirty-state confirm gates both re-extract and navigate-away (`review-workspace.tsx:670-708`), `beforeunload` covers tab close (`:1109-1117`), focus is restored to the first flagged field after navigation (`:1171-1192`), and save conflicts raise a pinned Reload toast rather than vanishing (`:789-806`).
- **pdf.js is handled correctly.** In-flight render tasks are awaited and cancelled before a new one starts (`pdf-viewer.tsx:404-408`), the thumbnail ref callback guards against duplicate renders (`:649-661`), and the viewer is already `next/dynamic` with `ssr: false` and a dimension-matched skeleton.
- **Entries filter state is fully URL-synced** — all thirteen filters plus sort. Shareable and back-button-safe.
- **Board pack generation is properly async** — `enqueueBoardPack` only inserts a `job_queue` row; generation happens in a job handler. No Vercel timeout risk on that path.
- **`xlsx` is server-only.** Eight importers, all server-side; `board-pack-download.tsx` is `'use client'` but only calls server actions. Re-check this boundary when the uncommitted reports work lands — it is the easiest mistake to introduce in a large reporting build-out.
- **Sentry and fonts are lean.** `tracesSampleRate: 0.1` on all three runtimes with no session replay configured; fonts self-hosted via `next/font/google` with no render-blocking request and no CLS risk.
- **The reference-data cache is real** — `unstable_cache`, 180 s window, per-table `revalidateTag`. Six of its seven tags have no writer yet, which is correct today; do not let a future admin write path for `department`/`admin_head`/`zone` ship without its matching `revalidateTag` call.
