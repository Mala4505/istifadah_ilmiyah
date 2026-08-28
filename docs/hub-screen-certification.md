# Hub Screen Certification — Audit & Remediation Plan

**Compiled:** 2026-08-28, from a four-screen parallel audit in one session.
**Codebase state at audit:** `master` @ `ae698f4`. Two pre-existing uncommitted items not touched by this audit (`lib/import/portal-mapping.ts` modified, `supabase/migrations/20260828000002_invoice_against_uplaq.sql` untracked).
**Scope:** `/entries`, `/documents`, `/review`, `/exceptions` — every page file and every component under `components/{entries,documents,review,exceptions}/` read in full, plus the shared primitives beneath them.
**Method:** four parallel per-screen audits against one 7-dimension rubric, plus a separate shared-layer pass. Every correctness finding below was re-verified against source before being written down.
**This was a read-only audit.** No files were modified and no git state was changed.

Companion artifact (same content, presentation form): "Hub Screen Certification".

---

## 0. How this document is organised

Findings are grouped into **waves in implementation order**. The ordering rule is the same one `pre-deploy-findings-and-plan.md` established: fix things that make the app *lie* first, then things that block the workflow, then things that are missing, then polish. Each wave is independently shippable.

Correctness items carry: **What** (the defect) · **Evidence** (how it was proven) · **Fix** (what to change) · **Files** · **Done when** (an observable check, not "it compiles").

Effort tags: **[S]** under an hour · **[M]** half a day · **[L]** more than a day.

### The rubric

Seven dimensions, applied identically to all four screens: statuses · pagination · items-per-page · filtering · sorting · selection · interaction quality (loading, empty, error, keyboard, a11y, responsive).

### Standing rule carried forward from the pre-deploy audit

**Static checks cannot see this class of bug.** Everything below was found by reading source and tracing data flow. Missing pagination is an *absence*; a wrong sort key is valid SQL; a `data-*` attribute that is never applied still typechecks. `tsc` and lint are green through every finding in this document.

---

## 1. Verdict

**Not certified yet — but the gap is narrower than it looks.**

Of 26 scored cells (excluding two that are correctly "absent by design"), **9 are outright missing**. No screen has a page-size selector. Two of four screens have no sorting at all.

Nothing here is structurally wrong. Entries is close to a reference implementation of filtering and pagination; the Review PDF viewer and its unsaved-work protection are the strongest code in the module. The problem is that **each screen solved these problems separately**, so what Entries got right, the other three never received.

### The pattern behind most of the gaps

There is no shared pagination component, no shared status badge, and no shared table. `components/reports/data-table.tsx:14-16` explains why in its own docstring — it says the `components/ui/table` primitive "doesn't exist in this worktree yet and another agent may be adding one in parallel."

**It does exist now.** That stale comment is the root cause of roughly half of this document: every screen re-derives pagination, sorting and empty states from scratch, and each one stops at a different point.

---

## 2. Certification matrix

`Done` = meets the bar · `Partial` = present but incomplete · `Missing` = not implemented · `By design` = correctly omitted.

| Dimension | Entries | Documents | Review | Exceptions |
|---|---|---|---|---|
| **Statuses** | Partial | Partial | Partial | **Done** |
| **Pagination** | Partial | Partial | Partial | **Missing** |
| **Items per page** | **Missing** | **Missing** | By design | **Missing** |
| **Filtering** | **Done** | Partial | Partial | Partial |
| **Sorting** | Partial | **Missing** | **Missing** | **Missing** |
| **Selection** | Partial | Partial | By design | **Missing** |
| **Interaction quality** | Partial | Partial | Partial | Partial |

Cell notes:

| Dimension | Screen | Note |
|---|---|---|
| Statuses | Entries | Badges present, but no legend; `is_void` never rendered; colours disagree with the Dashboard |
| Statuses | Documents | 4 live-polled stages, shape + colour; `matchStatus` loaded, never shown |
| Statuses | Review | Rich field-level state; severity is text-only; 3 loaded fields never displayed |
| Statuses | Exceptions | 3 statuses, ranked severity, distinct variants — no legend |
| Pagination | Entries | Correct keyset/offset split, no off-by-one; but no total count, not in URL |
| Pagination | Documents | Server query unbounded; the 20-row slice is client-side only |
| Pagination | Review | Prev/next + "Bill N of M"; the 500-row cap is silent |
| Pagination | Exceptions | No limit, no order, no controls at all |
| Filtering | Entries | All 13 filters, grouped into 4 sections, URL-synced, clear-all |
| Filtering | Documents | 5 filters + clear-all, but no URL sync and no chips |
| Filtering | Review | Only two scope controls; no severity or confidence filter |
| Filtering | Exceptions | URL-synced, but no severity filter — the primary sort axis |
| Sorting | Entries | 7 columns, `aria-sort`, stable tiebreaker, URL-synced |
| Sorting | Review | Fixed 3-key sort with **no tiebreaker** — order is nondeterministic |
| Selection | Entries | Row + page select, survives paging, 2 bulk actions; no select-all-matching |
| Selection | Documents | Per-row only — the header checkbox cell is empty |
| Selection | Review | Bulk-approve would defeat the screen's only guarantee — correctly absent |
| Selection | Exceptions | 40 same-cause exceptions = 40 dialogs |

---

## 3. Wave 1 — Stop the screens misreporting

**Why first:** every item here can show a user something untrue. Six of the eight are single-line changes.

### 1.1 — The review queue has no tiebreaker, so its order is nondeterministic [S]

**What.** The queue sorts on severity rank, then confidence, then amount — and stops. The common case (no open exceptions → rank 0, no extraction run → null confidence, no amount → null) puts every such bill into a single tie group that Postgres may return in any order.

**Evidence.** `app/(app)/review/page.tsx:104-107` chains exactly three `.order()` calls and then `.limit(QUEUE_ROW_CAP)`. Both view definitions in `supabase/migrations/20260822000006_review_queue_event_scoping.sql` (lines 87-90 and 145-148) carry the same three keys with no final tiebreaker. Confirmed as the latest definition of both views.

**Consequences, three at once.** "Bill 3 of 47" changes between navigations; `prevId`/`nextId` point at different bills on each round trip; and because `LIMIT 500` is applied to an unstable order, a *different* 500 rows can come back each request — so a bill can become effectively unreachable.

**Fix.** Append `.order('document_extraction_id', { ascending: true })` at `page.tsx:107`, and add `, de.id` to the `order by` in both views.

**Files.** `app/(app)/review/page.tsx`; a new migration redefining both queue views.

**Done when.** Loading `/review`, navigating forward three bills and back three, returns to the identical bill; and repeated reloads of `/review` with unchanged data always land on the same `queue[0]`.

### 1.2 — The Exceptions queue fetches with no limit and no order, then sorts in the browser [M]

**What.** `loadQueueData` applies only `.eq()` filters — no `.limit()`, no `.order()`. Ordering by severity happens client-side *after* the rows arrive.

**Evidence.** `app/(app)/exceptions/page.tsx:117-131` builds the query; the sort is at `page.tsx:345-353`. (The `.limit(1000)` at `page.tsx:221` belongs to a *different* query — the reconciliation report tab — and is not this one.)

**Why the sequence matters.** When PostgREST's default cap truncates the result, it truncates an **unordered** set. The rows that vanish are arbitrary: a high-severity exception is exactly as likely to be dropped as a low one, and nothing on screen indicates anything was dropped. On an audit tool this is the worst available failure mode.

**Fix.** Move the sort server-side with `.order()`, add an explicit `.range()`, and run a `{ count: 'exact', head: true }` query alongside so the page can render "showing 100 of 812". Apply the same count treatment to the report tab's existing `.limit(1000)`.

**Files.** `app/(app)/exceptions/page.tsx`.

**Done when.** With more open exceptions than the page size, the highest-severity item is always on page 1, and the header states the true total.

### 1.3 — The Documents query is unbounded, and two dependent queries fan out from it [M]

**What.** Every unmatched/suggested document in the selected event is fetched on every page load, with no `.limit()` or `.range()`. Two further queries then fan out over the full id list.

**Evidence.** `app/(app)/documents/page.tsx:70-77` — `.order('uploaded_at', …)` with no limit. Dependent queries at `page.tsx:117-123` (`document_extraction` `.in(...)` over all ids) and `page.tsx:144-149` (`ocr_extraction_run` per failed doc). The `.limit(1)` at `page.tsx:263` is an unrelated `job_queue` lookup.

The `PAGE_SIZE = 20` in `components/documents/document-table.tsx:17` only slices an array that is already fully in memory — it bounds rendering cost, not query cost or payload size.

**Currently masked** by the `match_status` filter keeping the inbox to unresolved documents only. Nothing puts a floor under that number in a busy event.

**Fix.** Add `.range()` to the `source_document` query (or a hard cap with a "showing latest N" notice), and page the dependent queries with it.

**Files.** `app/(app)/documents/page.tsx`.

**Done when.** The document count in the network payload stays constant as the inbox grows.

### 1.4 — Vendor search returns a 400 on any name containing parentheses [S]

**What.** The vendor search term strips only `%` and `,`. PostgREST reserves `(` and `)` as its `or()` group delimiters, so the filter group closes early and the request fails.

**Evidence.** `components/entries/query.ts:36-37`:
```ts
const term = filters.vendor.trim().replace(/[%,]/g, '')
q = q.or(`vendor_display_name.ilike.%${term}%,vendor_raw.ilike.%${term}%`)
```
Searching `Acme (India)` emits `or=(a.ilike.%Acme (India)%,…)` — the parser closes at the inner `)`.

**Why it matters.** `(Pvt) Ltd`, `(India)` and `(Guj)` are ordinary constructions in Indian vendor names. A user hits this by typing a real vendor name.

**Fix.** Double-quote the value in the filter string (escaping any embedded `"`), which makes parentheses legal, then drop them from the strip list.

**Files.** `components/entries/query.ts`; a unit test beside `test/unit/entries-query-pagination.test.ts`.

**Done when.** Searching a vendor whose name contains parentheses returns matching rows instead of an error card.

### 1.5 — The review queue's 500-row cap is silent [S]

**What.** At 501+ pending bills the reviewer is told the queue is exactly 500, and cannot navigate past it.

**Evidence.** `app/(app)/review/page.tsx:37` (`QUEUE_ROW_CAP`), applied at `:107`; `PageHeader` at `:257-261` renders `Bill {position} of {total}` where `total = queue.length`.

**Fix.** Run a `.select('*', { count: 'exact', head: true })` alongside the capped query and render `Bill 3 of 500 (of 812 pending)`.

**Files.** `app/(app)/review/page.tsx`.

**Done when.** With more than 500 pending bills, the header states the true pending total.

### 1.6 — `is_void` is loaded but never rendered on the Entries list [S]

**What.** A void entry is visually identical to a live one in a payments list.

**Evidence.** `components/entries/types.ts:40` carries `is_void`; `ALL_COLUMNS` (`types.ts:141-157`) has no column for it and `renderCell` (`types.ts:159-201`) has no case. The detail page *does* render a destructive "Void" badge at `app/(app)/entries/[id]/page.tsx:360`.

**Fix.** In `renderCell`'s `ubbl_number` case, append a destructive `Void` badge when `row.is_void`.

**Files.** `components/entries/types.ts`.

**Done when.** A void entry is distinguishable from a live one without opening it.

### 1.7 — Matched entry amounts are labelled "RM" on a rupee application [S]

**What.** Two sites render amounts as Malaysian ringgit.

**Evidence.** `components/review/match-strip.tsx:98` and `components/review/entry-attach-combobox.tsx:141` both emit `` · RM ${formatMoney(...)} ``, while the tally footer renders the same class of number through `formatINR` as `₹`.

**Why it matters.** These are the numbers a reviewer uses to decide whether a bill matches an entry.

**Fix.** Replace the local `formatMoney` in both files with `formatINR` from `@/lib/reports/format`.

**Files.** `components/review/match-strip.tsx`, `components/review/entry-attach-combobox.tsx`.

**Done when.** Every amount on the review screen carries `₹`.

### 1.8 — The claim is a race, is never released, never refreshed, and never enforced [M]

**What.** Four compounding problems in the review claim.

**Evidence.**
- **Race:** `lib/actions/review.ts:182-223` reads `claimed_by`, then issues an unconditional `.update()`. Two reviewers arriving together both read `null`, both write, and both are told the bill is theirs with no banner.
- **Never released:** the `.update()` at `lib/actions/review.ts:218` is the *only* write to `claimed_by` in the repository. Leaving a bill blocks colleagues behind a takeover prompt for 15 minutes.
- **Never refreshed:** `claimed_at` is set once on mount, and the effect keys on `detail.sourceDocumentId`, so stepping between bills of one multi-bill PDF never re-claims. Past 15 minutes the claim silently goes stale and a colleague takes over with no prompt.
- **Never enforced:** `saveVerification` (`lib/actions/review.ts:80-137`) checks the event and `expectedExtractionRunId` but never reads `claimed_by`. Two reviewers can both save the same bill; last write wins.

**Fix.** Replace the read-then-write with a single conditional update or RPC (`where claimed_by is null or claimed_by = $me or claimed_at < now() - interval '15 minutes'`, returning the row); clear `claimed_by` in the `verify_document_extraction` RPC; add a ~5-minute heartbeat while the claim is held; and check the claim inside `saveVerification`.

**Files.** `lib/actions/review.ts`; a migration for the verify RPC; `components/review/review-workspace.tsx` for the heartbeat.

**Done when.** Two browser sessions opening the same bill together produce exactly one holder and one takeover banner; and a save from a session whose claim was taken over is rejected server-side.

### 1.9 — The oversized-upload message is discarded and replaced with the generic fallback [S]

**What.** The helpful "that file is too large" message that was already written for this case never fires.

**Evidence.** `app/api/documents/ingest/route.ts:117-120` returns `File is ${file.size} bytes; the limit is ${MAX_UPLOAD_BYTES}.` with HTTP 413. The matching rule at `lib/friendly-error.ts:140` tests for `/payload too large|request entity too large|maximum allowed size|file size limit|\b413\b/i` — and only the response *body* is tested, never the status code. With `MAX_UPLOAD_BYTES = 33554432`, the body contains none of those tokens and no standalone `413`, so the user gets `'Something went wrong. Try again…'` instead.

**Fix.** Either reword the server message to include "exceeds the file size limit", or pass the HTTP status into the matcher alongside the body.

**Files.** `app/api/documents/ingest/route.ts` or `lib/friendly-error.ts`.

**Done when.** Uploading an oversized PDF shows the split-into-smaller-PDFs guidance.

---

## 4. Wave 2 — Make the reviewer fast

**Why second:** Review is the throughput-critical screen and its entire keyboard layer is currently inert. These are cheap and felt immediately.

### 2.1 — Every on-screen shortcut hint shows the wrong key [S]

Defaults are all Alt-gated (`lib/shortcuts/config.ts:62-132`), but the UI advertises bare letters:

| Hint shown | Location | Actual binding |
|---|---|---|
| "Press ? for keyboard shortcuts" | `app/(app)/review/page.tsx:263` | Alt+? |
| "Flag exception (E)" | `review-workspace.tsx:1070` | Alt+E |
| "Hub status (S)" | `review-workspace.tsx:1091` | Alt+S |
| "Shortcuts (?)" | `review-workspace.tsx:1093` | Alt+? |
| "Change vendor (/)" | `review-status-line.tsx:137` | Alt+/ |
| "Sub-department (U)" / "Admin head (H)" / "Zone (Z)" | `review-status-line.tsx:221, 239, 257` | Alt+U / Alt+H / Alt+Z |
| "(press 1-9 to jump to a row)" | `extraction-form.tsx:524` | Alt+1–9 |

Only `"Re-extract with Sonnet (Alt+R)"` (`review-workspace.tsx:1088`) is correct. A new reviewer presses `E` inside a description field and types a letter instead of flagging.

**Fix.** Render `formatBinding(keymap.…)` at each site instead of the literal; thread `keymap` into `ReviewStatusLine` and `ExtractionForm` the way `ShortcutsOverlay` already receives it.

**Done when.** Every hint matches what actually fires.

### 2.2 — Shortcuts are unreachable during actual work [S]

**What.** `isSafeShortcutTarget` (`lib/shortcuts/config.ts:249-252`) allows only `document.body`/null **or** an element carrying `data-shortcut-safe`. **No element anywhere in the app sets that attribute** — verified by repo-wide grep; the only real hits are the comment at `components/review/review-workspace.tsx:884` and the definition itself. (Other hits are stale copies under `.claude/worktrees/`, not the working tree.)

So the moment a reviewer tabs into any field — the normal state for an entire session — every Alt shortcut plus PageUp/PageDown/arrows stops working. They must click empty background first.

**Fix.** Let Alt-modified bindings bypass `isSafeShortcutTarget` entirely (the Alt gate already makes them typing-safe, which is its stated purpose at `config.ts:51-61`), keeping the guard only for the bare PageUp/PageDown/arrow keys.

**Done when.** Alt+E flags an exception while the cursor is inside a description field.

### 2.3 — The help binding can never fire [S]

`toggleHelp` defaults to `{ key: '?', alt: true }` (`config.ts:67`) with `shift` unset. Typing `?` requires Shift on essentially every layout, and `matchesBinding` (`config.ts:211`) rejects on `!!binding.shift !== event.shiftKey`. Only the "More → Shortcuts" menu item works.

**Fix.** Change the default to `{ key: '/', alt: true, shift: true }`, or make `matchesBinding` ignore `shift` for shifted punctuation.

### 2.4 — Nothing is focused after a queue advance [S]

No `autoFocus` and no post-mount focus call exists in `extraction-form.tsx` or `review-workspace.tsx`. Every item begins with a reach for the mouse — the single biggest tax on a throughput screen.

**Fix.** In a mount effect, call `focusUncertainField(0)` when there are uncertain fields, else focus the first line-jump target, else the first input; set `uncertainStepIndex` to 0 so the `—/N` counter starts populated.

### 2.5 — Exception severity is text-only [S]

`review-workspace.tsx:1167-1175` renders every open exception in the same amber pill, with only the uppercased severity word differing. Severity is the queue's primary sort key but carries no visual weight, and there is no legend on either Review or Exceptions.

**Fix.** Map severity to variant (destructive / warning / muted) and add an `aria-label` such as `"High severity: amount mismatch"`. Applies to both screens together.

### 2.6 — Three loaded status fields are never displayed [S]

`matchStatus` (`review/page.tsx:682`), `verifiedAt` (`:706`), `hubStatusCode` (`:728`) and the claim snapshot (`:698-701`) are all computed server-side and then never read by any review component (`hubStatusCode` reaches only a dialog default).

Consequences: in "All" scope a verified bill is indistinguishable from a pending one; the Hub status is invisible without opening a dialog; and because the claim snapshot goes unused, `ClaimBanner` flashes "Checking claim…" with the whole form disabled on **every** queue navigation.

**Fix.** Seed `claimState` from `detail.claimedBy*`; add a "Verified {date}" chip; add the Hub status to `toolbarInfoParts`.

### 2.7 — Internal plan citations leak into user-facing copy [S]

`app/(app)/review/page.tsx:139-140` renders "New documents enter this queue as soon as extraction finishes (§8)" in both empty-state branches; `review-workspace.tsx:874` says "see the document inbox, Day 3". The project's own `looksTechnical` heuristic (`lib/friendly-error.ts:184`) explicitly classifies `MASTER-PLAN §` as plumbing.

**Fix.** Drop the citations; link to `/documents` instead.

---

## 5. Wave 3 — The missing table affordances

**Why third:** these are the features the rubric says are missing. Build them **once** in shared components, then adopt — building them per-screen is exactly what produced today's inconsistency.

### 3.1 — Extract a shared pagination bar [M]

Total count, page-size selector (25/50/100/200), prev/next, and "showing X–Y of Z". Lift it from the Entries cursor logic in `components/entries/query.ts:117-190`, which is already correct — the keyset-for-`id` / offset-for-everything-else split is deliberate, documented, and has no off-by-one at any boundary. Add `{ count: 'exact' }` to the select so the total comes back in `Content-Range` at no extra round trip.

Adopt on Entries, Documents and Exceptions. **This closes the "items per page" row of the matrix on all three screens at once.**

### 3.2 — Extract a sortable table header [M]

Click-to-sort with a direction indicator and `aria-sort`, defaulting `date` / `amount` / `document_count` to **descending first**. Today `aria-sort` appears exactly once in the codebase (`components/entries/entries-table.tsx:78`).

Adopt on Documents and Exceptions (no sorting at all today), and extend Entries' sortable set to include `hub_status_label` and `document_count` — both are plain columns on `v_entry_enriched`, so it is a union-plus-array change. Hub status is the field this app owns and exports; "show me everything Awaiting Verification together" is the most likely sort and it is currently unavailable.

### 3.3 — Unify the two status colour maps [M]

`components/entries/format.ts:55` maps any label containing `pending` to `outline` (grey). `components/dashboard/status-count-card.tsx:66` maps `/pending|sent|awaiting|progress/` to `warning` (amber). **"Pending" is grey on Entries and amber on the Dashboard**, and the Dashboard card's own comment (`:36-40`) acknowledges the divergence.

**Fix.** Promote the Dashboard's `semanticStatusState` / `dashboardStatusBadgeVariant` into a shared `lib/status-badge.ts` and have `entries/format.ts` delegate. The Dashboard's map is code-first with a label fallback, which is strictly better than the Entries label-sniffing.

### 3.4 — Add a severity filter to Exceptions [M]

`components/exceptions/exceptions-filters.tsx` has exactly two controls (status, exception type). Severity — the dimension the whole table is grouped and sorted by — cannot be filtered. Source it from `SEVERITY_GROUP_LABELS` in `labels.ts:51-59`, using the same URL-param pattern as the existing two.

### 3.5 — Selection: select-all on Documents, and bulk resolve on Exceptions [L]

- **Documents:** the header checkbox cell is an empty `<TableHead className="w-10" />` (`document-table.tsx:233`). Add a tri-state select-all for the current page.
- **Exceptions:** no selection exists at all, and `resolveException` (`lib/actions/exceptions.ts:21-25`) accepts a single id. One bad import batch raising 40 identical exceptions means 40 dialogs, each with a typed note. Add a checkbox column, a "Resolve N selected" bar, and a batch action taking `exceptionId: number[]`. Since the audit trail requires a note, the same note applies to the batch — warn when the selection spans mixed types or severities.

### 3.6 — Add "select all N matching these filters" to Entries [M]

`toggleAllOnPage` (`entries-explorer.tsx:251-261`) covers the current page only. Selection *does* correctly survive pagination, so the missing piece is just the cross-page action: when the whole page is selected and more pages exist, offer "Select all N matching these filters", fetching ids only — the pattern `components/entries/csv-export.ts:45-66` already uses. Depends on the total count from 3.1.

### 3.7 — Status-count tiles above Entries and Exceptions [M]

`v_entry_status_counts` already exposes `status`, `audit_status` and `hub_status`, and the Dashboard already consumes it (`app/(app)/page.tsx:103`). Nothing on Entries reads it, so this is a **wiring job, not backend work**. Render a compact chip row where each chip applies its own filter.

This closes the outstanding status-count-tiles item from the 2026-08-17 walkthrough, on the screens where it is most useful. See `docs/hub-refinements-plan.md`.

---

## 6. Wave 4 — Accessibility and finish

### 4.1 — Make Entries rows keyboard-reachable [M]

`components/entries/entries-table.tsx:133-138` gives the `<tr>` `cursor-pointer` and an `onClick` — no `tabIndex`, no `onKeyDown`, no anchor. **Opening an entry is the primary action on the page and it is unreachable without a mouse**, and invisible to screen readers as a control.

**Fix.** Render the first visible cell's content as a real `<Link>`. This is strictly better than `tabIndex` + `onKeyDown` because it also restores middle-click and ⌘/Ctrl-click to open in a new tab.

### 4.2 — Associate the Review form's labels with their inputs [M]

`extraction-form.tsx:806-817` renders `<Label>` with no `htmlFor` and `<Input>` with no `id`; Radix's `Label` does not auto-wrap, so there is no association — clicking a label doesn't focus its input and a screen reader announces bare "edit text". The six-column line-item table is worse: those inputs have no `aria-label` at all, only column headers.

**Fix.** `useId()` + `htmlFor` in `Field`; `aria-label={\`Line ${index+1} ${columnName}\`}` on every table input.

### 4.3 — Fix the sticky headers [S]

- **Entries:** `components/ui/table.tsx:15` sets `sticky top-0` on `TableHeader`, but `table.tsx:6` wraps every table in `overflow-auto` and `entries-table.tsx:60` adds a *second* `overflow-x-auto` wrapper. `position: sticky` resolves against the nearest scrolling ancestor, which has no height constraint — so it never scrolls vertically and the header scrolls away. Bound the wrapper's height (e.g. `max-h-[calc(100vh-20rem)] overflow-auto`), add `bg-card` to the `<th>` cells, and drop the redundant nested wrapper.
- **Exceptions:** `exceptions-table.tsx:65` has no sticky positioning at all. On a long severity-grouped list only the group labels repeat while the column names scroll away.

### 4.4 — Split every combined empty state and give each a clear-filters action [S]

- **Entries:** `entries-table.tsx:123-129` always renders "No entries match your filters" — including when there are no entries at all and no filters are set, which reads as a bug on a new event. Pass down the `activeCount` that `filter-bar.tsx:53` already computes and render two states, the filtered one with a "Clear all filters" button.
- **Exceptions:** the two states are correctly distinguished (`page.tsx:550-561`) but the filtered one offers no one-click reset.

### 4.5 — Correct the loading skeletons [S]

- **Entries:** `app/(app)/entries/loading.tsx:26-31` paints a fully expanded four-section filter panel (~450px), but `filter-bar.tsx:44` is collapsed by default (~40px). Every cold navigation paints a tall block that collapses on hydration, shoving the table up several hundred pixels. It also uses `fieldCount={3}` for a two-field section. Replace with a single collapsed-height skeleton; same for `EntriesPageSkeleton` at `page.tsx:130`.
- **Documents:** `loading.tsx` renders three stacked `DocumentCardSkeleton` blocks, mirroring the layout that existed *before* the table view replaced it. `DocumentCard` is now only mounted inside a row-detail dialog. Rewrite to mirror the filter-panel-plus-table shape.

### 4.6 — Persist the Entries column chooser [S]

`entries-explorer.tsx:134-136` re-initialises `visibleColumns` from defaults on every mount, and since the page is `force-dynamic` the explorer fully remounts on each return to `/entries`. A user who enables Department/Zone/Cost centre loses it the moment they open an entry and come back — the most common navigation on the page.

**Fix.** Persist to `localStorage` under a versioned key with a try/catch and a defaults fallback; refuse to hide the last remaining column.

### 4.7 — Restore Back/Forward on Entries [M]

`entries-explorer.tsx:151` uses `router.replace`, so no history entry is pushed; and `filters`/`sort` are seeded by lazy `useState` initialisers (`:118-119`) that read `searchParams` exactly once and never react to later changes. A user who applies four filters and presses Back to undo one is thrown off the Entries page entirely.

**Fix.** Keep `replace` for debounced intermediate writes (the vendor text field), switch to `push` on committed changes, and add an effect that resyncs state when the serialized params differ.

### 4.8 — Guard the resolve dialog; add a retry to failed uploads [S]

- **Exceptions:** `resolve-exception-dialog.tsx:67-68,92` — `onOpenChange={setOpen}` lets Escape or an outside click discard a typed note with no prompt, and the submit has no confirmation despite there being **no reopen action anywhere**, making a mistaken "Dismiss" permanent. Gate `onOpenChange` when the note is non-empty; consider an `AlertDialog` confirm before dismissal.
- **Documents:** `upload-dropzone.tsx:330-336` deletes the `File` reference before marking the item errored, so the error render (`:464-493`) can only offer Dismiss. The user must re-pick the file from disk. Keep the `File` and add a Retry button for `'error'` items (not for `'connection-lost'`, where the server may already hold the job).

### 4.9 — Surface the Exceptions "what to do" guidance in the row [S]

`components/exceptions/what-to-do.ts` is genuinely strong — per-type guidance with a reasoned, id-aware destination link and the rationale for every fallback documented inline. But it renders only inside `ResolveExceptionDialog`, which `exceptions-table.tsx:137` mounts only when `status === 'open' && canResolve`. Non-admin viewers never see it, and it disappears the moment an item is resolved — exactly when someone reviewing the audit trail wants it.

**Fix.** Render `getExceptionAction(row).whatToDo` inline in the row (or as a tooltip), independent of role and status.

### 4.10 — Smaller Entries items [S]

| Issue | Evidence | Fix |
|---|---|---|
| Raw Postgres text rendered inline on load failure | `entries-explorer.tsx:181, 360` — plain-English headline is present, but `err.message` sits on the line below rather than behind a disclosure | Use `<FriendlyError message={loadError} />`, matching `app/(app)/entries/[id]/page.tsx:80` |
| "No department access" fires for admins on an event with no department mappings | `page.tsx:56-57` returns zero rows for every role; `entries-explorer.tsx:280,310-319` then hides the whole screen behind a wrong diagnosis | Distinguish the two cases; for admin-or-above (or an unmapped event) say "This event has no departments mapped yet" |
| CSV lacks a UTF-8 BOM — Excel on Windows mojibakes non-ASCII vendor names | `csv-export.ts:68` | Prefix `'﻿'` |
| CSV silently truncates at 20,000 rows and still reports success | `csv-export.ts:65` vs `entries-explorer.tsx:270` | Return `truncated` and warn |
| CSV ignores the column chooser | `csv-export.ts:40` | Pass `visibleColumns` through |
| Stale rows shown during refetch with no pending affordance | `entries-explorer.tsx:372` | Dim + `pointer-events-none` while loading |
| 300 ms debounce also delays the *initial* load | `entries-explorer.tsx:145-158` | Track a mount ref; debounce only later changes |
| Focus lost after a bulk action | `bulk-status-dialog.tsx:70-71` → `entries-explorer.tsx:405` unmounts the bulk bar holding the trigger | Restore focus to the first row link in `onDone` |
| Filter-bar docstring claims 14 filters; 13 render | `filter-bar.tsx:26` | Correct the comment, or implement the reserved `ast` filter (see below) |
| `optionsLoaded` is dead | `entries-explorer.tsx:121` | Delete |

### 4.11 — Multi-select filters and removable chips [M]

Every Entries filter is single-select `.eq()` (`query.ts:26-32`). For Status, Hub status and Department, switch to `.in()` with a `Combobox` (already in `components/ui/`) and comma-joined URL values. **This widens the filters; it removes none** — consistent with the standing decision that all 13 stay.

Separately, `buildFilterSummary` (`filter-bar.tsx:264`) already computes label-plus-field for the collapsed summary, but the output is inert text. Return `{label, key}[]` and render each as a `Badge` with an `X` that resets that one filter.

---

## 7. Cross-cutting: the shared layer

These are not page bugs — they are why the same gap keeps reappearing on different screens.

| Concern | State today | Consequence |
|---|---|---|
| Table implementation | Three: `components/ui/table.tsx`, `components/reports/data-table.tsx`, plus bespoke markup | The reports table has no sorting, selection or pagination and forces `font-mono` on every cell — screens built on it cannot grow those features without replacing it |
| Pagination | No shared component; only `entries/query.ts` has real cursor logic | Well-built and correct, but private to Entries — the other three each stopped somewhere different |
| URL state | Entries full · Review partial (`id`, `page`) · Exceptions partial (`status`, `type`) · Documents none | No consistent expectation about whether a view can be shared, bookmarked, or survive a refresh |
| Status colours | Two independent maps; the Dashboard's is code-first, the Entries one guesses from label text | "Pending" is grey on Entries and amber on the Dashboard |
| `aria-sort` | Appears once in the entire codebase | Every other sortable header is invisible to screen readers |
| Page header | `PageHeader` redefined locally in review, settings, shortcuts | No structural reason for the screens to stay consistent as they change |
| Error boundary | **Solid** — centralised in `lib/friendly-error.ts` with `toastError` / `FriendlyError` / `friendlyDataError` | Working as intended; the inline raw message on Entries (4.10) is the only deviation found across four screens |

**Note on Exceptions using both tables.** `app/(app)/exceptions/page.tsx` imports `ExceptionsTable` (built on `ui/table`) *and* `DataTable` (the reports one), but they are split across two tabs and `page.tsx:27` documents the reasoning. It is a real consistency cost, not an accident.

---

## 8. What is already good

Recorded so it does not get "fixed" by accident, and so the bar is visible:

- **Entries filtering** — all 13 filters retained and grouped into four labelled sections with a live summary and clear-all. This is the 2026-08-17 punch-list item, built. `components/entries/filter-bar.tsx:110-231`.
- **Entries pagination arithmetic** — traced at every boundary (total = 50, 51, exactly page size); no off-by-one. The `id`-desc tiebreaker is a genuine stable sort. `components/entries/query.ts:117-190`.
- **One filter function for list and export**, so a CSV can never disagree with the table. `query.ts:23`.
- **Review PDF viewer** — fit-to-width via `ResizeObserver`, correct pdf.js render-task cancel-then-await sequencing, rotation-aware bbox mapping, skipped-page watermark, retry without remount. The strongest component in the module.
- **Review unsaved-work protection** — dirty-diffing against a mount snapshot, every navigation funnelled through one guard, `beforeunload`, and optimistic-concurrency conflict detection on save. Thorough and uncommon.
- **Review error discipline** — zero raw error strings rendered anywhere on the page.
- **Review bulk actions correctly absent** — bulk-approve would let a reviewer mark bills verified without opening them, destroying the only guarantee the screen provides, and would force the verify RPC to fabricate `_verified` values no human ever saw. **Keep it absent.**
- **Documents upload flow** — staged confirm-before-send, per-file progress, cancel in flight via `xhr.abort()`, and a distinct "connection lost" state that avoids claiming failure when the server may have accepted the job.
- **Documents polling** — 4→8→15s backoff that pauses on tab-hidden and resets on change; stages distinguished by shape as well as colour.
- **Exceptions severity model and `what-to-do.ts`** — clean three-level rank used consistently for both sort and grouping, and per-type guidance with documented fallback reasoning.
- **Exceptions resolve note required on both client and server** — real defence in depth.

---

## 9. Outstanding / not decided

- **Items-per-page values.** 25/50/100/200 is assumed in 3.1. Not confirmed with the user.
- **Whether Review should get a queue drawer.** `maxOpenSeverityRank` and `openIssueCount` are already fetched per row and typed in `lib/review/types.ts:17-27` but never used, so a collapsible list with click-to-jump needs no new query. Deferred because one-item-at-a-time is deliberate — this would add queue *visibility* without changing the workflow. Needs a decision.
- **Whether the queue should skip items claimed by others.** `page.tsx:98` does not even select `claimed_by`, so two reviewers opening `/review` together always collide on `queue[0]`. Depends on 1.8 landing first.
- **The reserved `ast` (audit status) param.** Reserved in `status-count-card.tsx:100` but never read by `searchParamsToFilters` (`entries-explorer.tsx:41-57`), so an `?ast=` link would be silently dropped and then stripped from the URL. **Latent, not live** — the Dashboard renders only `st` and `hs` cards today. Either implement the filter or remove the reservation.
- **macOS shortcut support.** `matchesBinding` compares `event.key`; on macOS Option+letter emits a composed character (`Alt+R` → `®`), so every configurable shortcut would break there. Matching on `event.code` fixes it. Priority depends on whether any reviewer uses a Mac — not established.

---

## 10. Suggested order of work

1. **Wave 1** (§3) — nine items, six of them single-line. Ship as one branch; this is the correctness wave.
2. **Wave 2** (§4) — seven items, all [S], all on Review. High felt value per hour.
3. **Wave 3** (§5) — build 3.1 and 3.2 as shared components *first*, then adopt across screens. Resist doing these per-screen.
4. **Wave 4** (§6) — accessibility and finish.

Waves 1 and 2 together are roughly one focused day and close every correctness finding in this document.
