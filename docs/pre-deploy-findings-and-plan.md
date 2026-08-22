# Pre-Deployment Findings & Implementation Plan

**Compiled:** 2026-08-22, from two audit passes in one session.
**Codebase state at audit:** `master` @ `2352822`, plus two uncommitted files (`lib/actions/review.ts`, `lib/claude-client.ts`) and one untracked migration (`20260822000009_document_extraction_delete_policy.sql`).
**Checks at audit time:** `typecheck` clean · `lint` clean (1 pre-existing warning) · `test` 370/370 · production build clean · all 60 migrations applied (max `20260822000009`).

Companion artifacts (same content, presentation form):
- [Hub Deployment Readiness](https://claude.ai/code/artifact/8b3a8442-91f8-4b87-8e5e-b1b1904482bf) — pass 1, code/schema/data audit
- [Hub Live UI Audit](https://claude.ai/code/artifact/72ac5043-ae1c-4b22-be6a-ba0344e5c2bb) — pass 2, signed-in walkthrough with screenshots

---

## 0. How this document is organised

Findings are grouped into phases in **implementation order**. The ordering rule is: fix things that make the app *lie* first, then things that block the workflow, then things that are missing, then polish. Each phase is independently shippable.

Every item carries: **What** (the defect) · **Evidence** (how it was proven) · **Fix** (what to change) · **Files** · **Done when** (an observable check, not "it compiles").

**Two standing rules established this session:**

1. **Never trust a plan document's own status field.** Two docs in `docs/` carried status headers that were wrong in the conservative direction — `hub-refinements-plan.md` says "Nothing in this document is built yet" while 6 of its 7 items shipped. Always verify against code, schema, or live data.
2. **Static checks cannot see this class of bug.** `tsc`, ESLint and 370 unit tests were green through every single finding below. Column names live in untyped string literals; a missing filter clause is an *absence*; layout bugs need a viewport; and counters only go wrong against real data.

### Roles (confirmed with the user 2026-08-22)

There are **three** roles: `superadmin`, `admin`, `department`. There is **no reviewer role** — anywhere this document or the code says "reviewer", read it as "whoever is doing the review", which in practice is a department-role user.

Import (`/import` and the dashboard import tile) is **admin-and-above only, and that is correct** — department users do not import. No change needed there.

---

## Phase 0 — Stop the app from lying

**Why first:** these three make the UI report something false. Everything else is a missing feature or a rough edge; these actively mislead. All three were introduced or made visible by today's commits.

### 0.1 — The Exceptions queue hides 33 of its 34 open items

**What.** Scoping `/exceptions` to the active event resolves each exception's event through its `entry_id`, then drops every row where that is null. Only **one** open exception in the database has an `entry_id`. Everything document-level (tally mismatches, failed pages, duplicate hashes, GST compliance) and everything batch-level (unmatched audit rows, ID collisions) vanishes.

**Evidence.**
```
app/(app)/exceptions/page.tsx
  exceptions = rawExceptions.filter(r => r.entry_id !== null && eventEntryIds.has(r.entry_id))

select count(*) filter (where status='open')                             -> 34
select count(*) filter (where status='open' and entry_id is not null)    -> 1
select count(*) filter (where status='open' and entry_id is null)        -> 33
```
Breakdown of the 33 dropped: `other` ×11, `line_item_tally_mismatch` ×7, `id_namespace_collision` ×3, `page_extraction_failed` ×3, `duplicate_document_hash` ×3, `page_count_mismatch` ×3, `audit_row_unmatched` ×1, `vendor_gstin_is_own_org` ×1, `page_count_unresolved` ×1.

**Fix.** Resolve the event the way `v_open_issues` already does — `entries.event_id` via `entry_id`, else `source_document.event_id` via `document_extraction_id`, else `import_batch.event_id` via `import_batch_id` — and **keep** rows that still resolve to nothing rather than discarding them. Do not write a shorter chain than the view already uses.

**Files.** `app/(app)/exceptions/page.tsx`.

**Done when.** `/exceptions` with status=open shows 34 rows (or 33 + whatever the event filter legitimately excludes), and the count matches the Dashboard tile.

### 0.2 — Three screens disagree about the same data by 30×

**What.** The Dashboard tile says "38 open exceptions, ₹6.99 L at risk". The Reports Open-issues digest lists ~30 rows. The Exceptions queue shows 1. A department user who trusts the queue believes the backlog is clear.

**Evidence.** All three observed on screen in the same session. The Dashboard reads `v_open_issues` **unfiltered by event**; Reports reads `v_open_issues` **filtered by event**; Exceptions reads the base table with the broken filter from 0.1.

**Fix.** Once 0.1 lands, make all three read the same resolution. Decide one rule and apply it everywhere: either every screen is event-scoped (then the Dashboard needs scoping — see 6.1) or none is. Do not leave two screens on different rules.

**Files.** `app/(app)/page.tsx`, `app/(app)/reports/page.tsx`, `app/(app)/exceptions/page.tsx`.

**Done when.** The open-exception count is identical on all three screens.

### 0.3 — `reconciliation_exception` has no `source_document_id`

**What.** Ten open exceptions are raised during ingest/extraction and reference their document **only inside the description text** (`"...source_document 16 has 8 page(s) at ingest..."`). The table has `entry_id`, `document_extraction_id`, `import_batch_id` — no source-document column. Consequences: they can never be attributed to an event, they are dropped from the event-filtered Reports digest, and they can never be surfaced on a document's or an entry's page because nothing links them.

**Evidence.**
```
select ... from reconciliation_exception
 where status='open' and entry_id is null
   and document_extraction_id is null and import_batch_id is null
-> 10 rows: duplicate_document_hash ×3, page_extraction_failed ×3,
            page_count_mismatch ×3, page_count_unresolved ×1

v_open_issues -> 37 rows total, 24 with a resolvable event_id
```

**Fix.** New migration: add `source_document_id bigint references source_document(id)` to `reconciliation_exception`. Populate it at every raise site that already knows the document. Backfill existing rows by parsing the id out of the description (one-off, in the migration). Add it to `v_open_issues`'s event-resolution `coalesce` chain.

**Files.** new `supabase/migrations/2026________`, `lib/jobs/handlers/extract.ts`, `app/api/documents/ingest/route.ts`, `v_open_issues` definition.

**Done when.** `select count(*) from v_open_issues where event_id is null` returns only the deliberate vendor-level flags (currently 3), not 13.

---

## Phase 1 — Operational prerequisites

**Why here:** no code. These are conditions that are true right now and would make the first real day go badly. Do them in parallel with Phase 0.

### 1.1 — Nothing drains the job queue in production

**What.** A `flags_run` job has been queued since 10:54 and never picked up. Across the entire history of `job_queue`, the only workers that have ever claimed a job are `local-dev-tick` (87), `local-dev-upload` (8) and `e2e-drain` (4). The GitHub Actions cron in `.github/workflows/cron-tick.yml` has never run against the deployed site — its two one-time setup steps were never completed.

**Why it matters.** Extraction runs inline on upload (`INGEST_INLINE_EXTRACTION=true`), so uploads work. But nothing retries a failed extraction, and `flags_run` never runs — so the `flags` table stays stale and the Open Issues digest is permanently incomplete.

**Fix.** Repository secret `CRON_SECRET` + repository variable `SITE_URL` in GitHub; same `CRON_SECRET` on the host; redeploy; then trigger "Run workflow" manually once.

**Done when.** `select locked_by, max(completed_at) from job_queue group by 1` shows a non-`local-dev` worker id.

### 1.2 — `staff_department` is empty

**What.** RLS is department-based (`private.can_see_department` → `staff_department` join). That table has **zero rows**, and all five existing accounts are `admin` or `superadmin`, which bypass the check. So the department-role path has never been exercised. Add a department user and they get a working login and no data anywhere.

**Evidence.** `select * from staff_department` → 0 rows. `staff_profile` → 3 admin, 2 superadmin, 0 department.

**Fix.** Create one real department account on `/settings` → Users & Roles, assign its departments, sign in as it.

**Done when.** A department-role user signs in and sees populated Entries, Documents and Review. **This is the single highest-value pre-deploy test.**

### 1.3 — Commit the uncommitted work

**What.** `20260822000009_document_extraction_delete_policy.sql` is **applied to the live database** (the policy exists; it is the newest recorded version) but the file is untracked, alongside the two modified files it belongs with. Repo and database have drifted apart — the exact condition that caused the §0 incident earlier this month.

**Fix.** `git add` the migration + `lib/actions/review.ts` + `lib/claude-client.ts` and commit together.

### 1.4 — Department budget data has never been imported

**What.** `department_budget_allocation` is empty. `components/import/department-budget-import-workspace.tsx` carries its own note: *"No real department-budget spreadsheet has been provided yet."* Its column parsing is written against an assumed sheet shape. The report the user described first — "the total budget of these departments is so-and-so" — therefore renders one row saying "no budget set".

**Fix.** Send one real department-budget `.xlsx` through the dry run on `/import`. The dry run shows a per-row diff before anything is written, so a wrong column guess is visible and free.

**Done when.** `select count(*) from department_budget_allocation` > 0 and the Reports "Department budget vs actual" section shows real figures.

### 1.5 — `approved_amount` is ₹0 on every budget head

**What.** The Reports "Budget vs actual by head" table shows 10 rows, every one reading "no approved budget", because `approved_amount` is 0 across the board. `utilised_amount` is populated. So the Departmental import brings utilised figures but not approved ones.

**Fix.** Determine whether approved amounts exist in the Departmental export at all. If they do, the importer is dropping a column. If they don't, they must come from the department-budget sheet (1.4) and the head-level report needs re-basing on that.

**Done when.** At least one budget head shows a real "% of Approved" figure instead of the fallback note.

---

## Phase 2 — Review screen correctness

**Why here:** this is the core workflow. Three defects, all cheap, all visible on screen today.

### 2.1 — The PDF opens on page 1, never on the bill's own page

**What.** The highest-value fix in this document. The viewer hard-codes `useState(1)`. The bill observed during the audit lives on **page 8**; the viewer showed **page 1**, which is the batch summary sheet and is marked "Skipped — not extracted as a bill". So the form on the right and the page on the left are unrelated, on every bill, every time. This breaks the stated promise of the screen.

**Evidence.**
```
components/review/pdf-viewer.tsx:119   const [pageNumber, setPageNumber] = useState(1)
grep pageNumberStart components/review/pdf-viewer.tsx  -> no matches

document_extraction where source_document_id=16:
  bill_index 0 -> pages 2-2
  bill_index 1 -> pages 5-5
  bill_index 2 -> pages 6-6
  bill_index 3 -> pages 8-8   <- the bill on screen; viewer showed page 1
```
`detail.pageNumberStart` **is** passed down — but to `extraction-form.tsx` (for the "Read from pages X–Y" label), never to `pdf-viewer.tsx`.

**Fix.** Pass `pageNumberStart` into `PdfViewer`; seed `useState(pageNumberStart ?? 1)`; re-seed when the bill changes (key off `documentExtractionId`, not just the prop, so navigating between bills of the same PDF re-jumps).

**Files.** `components/review/pdf-viewer.tsx`, `components/review/review-workspace.tsx`.

**Done when.** Opening any bill of a multi-bill PDF shows that bill's first page, and stepping Prev/Next bill moves the PDF with it.

### 2.2 — "Bill 4 of 3 in this PDF"

**What.** An impossible counter, rendering right now. `bill_index` is the bill's **absolute** position in the document; `bill_count` comes from `v_review_queue`, which contains **only unverified** bills. Verify one bill of a four-bill PDF and the denominator drops to 3 while the numerators stay 1, 3, 4.

**Evidence.**
```
components/review/review-workspace.tsx:976
  Bill ${detail.billIndex + 1} of ${detail.billCount}

v_review_queue_all  -> bill_count 4 (correct)
v_review_queue      -> bill_count 3 (excludes verified bills)

doc 14 (bill 1 verified): displays "Bill 1 of 3", "Bill 3 of 3", "Bill 4 of 3"
doc 16 (bill 2 verified): displays "Bill 1 of 3", "Bill 2 of 3", "Bill 4 of 3"
```

**Fix.** Take the denominator from `v_review_queue_all`, or from a direct count on `document_extraction` for that `source_document_id`. Never from the filtered queue. Audit any other place that pairs an absolute index with a filtered count.

**Files.** `app/(app)/review/page.tsx` (the `billCount` it passes into `loadDocumentDetail`), `components/review/review-workspace.tsx`.

**Done when.** Both multi-bill documents display "Bill N of 4".

### 2.3 — Save advances to the queue's next bill, not the next bill in this PDF

**What.** The user's described workflow is: work a PDF through to the end, then see it marked complete. The queue is ordered by severity → confidence → amount (deliberately, so the riskiest bill is next), so after saving bill 1 of PDF-A, Save can land you in PDF-B. Today's redesign made this more visible by adding separate Prev/Next **bill** and Prev/Next **document** controls.

**Fix.** Make Save prefer the next *unverified sibling bill* in the same document; fall back to the queue only when the document is finished — and show a "Document complete" confirmation at that moment. This is the single change that makes Review feel like the described workflow.

**Files.** `components/review/review-workspace.tsx` (`handleSave`, `nextId` computation), `app/(app)/review/page.tsx` (sibling-bill query already exists).

**Done when.** Saving bill 1 of a 4-bill PDF lands on bill 2 of the same PDF; saving the last one says the document is complete and returns to the queue.

---

## Phase 3 — Progress and tally (the missing half of the workflow)

**Why here:** two things the user explicitly described that are not built at all.

### 3.1 — The Documents inbox tracks extraction, not review

**What.** Each row shows Uploaded → Queued → Extracting → Extracted. Once a document reaches "Extracted" the row **stops changing forever**, however many of its bills are still unreviewed. On screen, `Binder2.pdf` (8 pages, 4 bills, none reviewed) looks identical to a fully-reviewed document. The page never even asks the database for review state.

**Evidence.**
```
app/(app)/documents/page.tsx:118
  .select('id, source_document_id, bill_index, vendor_name_ocr,
           invoice_date_ocr, invoice_number_ocr, total_amount_ocr')
grep verified_at app/(app)/documents/page.tsx -> 0 matches
```
Note also: `stagesFor()` returns 4 stages but 5 checkmarks render — worth checking while in there.

**Fix.** Add `verified_at` to that select. Render "3 of 5 bills reviewed" with a distinct completed state at 5 of 5. The column already exists and is already written on every save.

**Files.** `app/(app)/documents/page.tsx`, `components/documents/types.ts`, `components/documents/document-card.tsx`, `components/documents/document-table.tsx`.

**Done when.** A partly-reviewed PDF is visually distinguishable from an untouched one and from a finished one.

### 3.2 — The entry page lists its bills but never adds them up

**What.** The Documents card on an entry shows each attached PDF with its own OCR'd total. It never sums them and never compares that sum to the entry's imported amount — so the tally the user described has to be done by eye.

**Evidence.** `components/entries/detail/linked-documents.tsx` renders per-document `formatINR(doc.totalAmountOcr)` and nothing else. No sum, no comparison.

**Fix.** Add a footer row to that card: bills attached · sum of bill totals · entry amount · difference, with the difference coloured when non-zero. Every number is already on the page; only the arithmetic is missing.

**Files.** `components/entries/detail/linked-documents.tsx`, `app/(app)/entries/[id]/page.tsx`.

**Done when.** An entry with two attached bills shows their sum and whether it matches.

### 3.3 — Mismatches are never shown on the entry page

**What.** The user asked to see a flag on the entry itself and work it there. The entry detail page has **zero** references to `reconciliation_exception` or `flags` — not a count, not a banner. All open exceptions live only on the separate `/exceptions` list.

**Evidence.** `grep -c "reconciliation_exception\|from('flags')" app/(app)/entries/[id]/page.tsx` → 0.

**Fix.** Add an "Issues" card to the entry page listing that entry's open exceptions and flags, with resolve in place. Depends on Phase 0.3 for document-level exceptions to be reachable at all. The data and the resolve action both already exist.

**Files.** `app/(app)/entries/[id]/page.tsx`, new `components/entries/detail/entry-issues.tsx`, `lib/actions/exceptions.ts` (reuse).

**Done when.** Opening an entry that has an open exception shows it without leaving the page.

### 3.4 — Nothing anywhere says a PDF is finished

**What.** There is no "complete" state in Review or in the Documents inbox — no phrase, no badge, no count. Grepping `components/review/*.tsx` and `components/documents/*.tsx` for `all bills` / `fully reviewed` / `document complete` / `allVerified` returns nothing.

The user's description ends each PDF with "after the full PDF is done reviewing, it will show that this PDF has completed." Today the only signal that anything was reviewed is the per-page "Done" checkmark added in today's redesign.

**Fix.** Two halves, both already scoped above: the Review side is 2.3 (Save recognises the last bill and says so); the inbox side is 3.1 (`verified_at` in the query, "5 of 5 bills reviewed" → a completed state). Track them together so the two agree on what "complete" means — all bills verified, ignoring skipped pages.

**Done when.** Finishing the last bill of a PDF produces a visible completion state in both places.

---

## Phase 4 — Make Exceptions a real work queue

### 4.1 — A flag tells you it is wrong, not what to do

**What.** Resolving an exception opens a dialog with one field: a free-text note, and a choice of Resolved or Dismissed. It is a bookkeeping record. Nothing routes to the thing that needs changing, and nothing suggests a fix — which is exactly the distinction the user drew ("just don't flag it — give us a solution for how we can resolve that as well").

**Fix.** Give each exception type a one-line "what to do" and a destination button:

| Type | What to do | Goes to |
|---|---|---|
| `line_item_tally_mismatch` | Re-check the line items against the bill total | that bill in `/review` |
| `ocr_total_vs_amount` | Confirm which figure is right — bill or ledger | that bill in `/review` |
| `audit_row_unmatched` | The Departmental row hasn't arrived yet; re-run the import | `/import` |
| `duplicate_document_hash` | Compare against the earlier upload | the earlier document |
| `page_extraction_failed` | Re-OCR that page | that page in `/review` |
| `page_count_mismatch` / `page_count_unresolved` | Check for pages the model didn't classify | that document in `/review` |
| `gst_recipient_compliance_missing` | Buyer GSTIN/name missing or wrong on the bill | that bill in `/review` |
| `vendor_gstin_is_own_org` | OCR read our own GSTIN as the vendor's; correct it | that bill in `/review` |
| `id_namespace_collision` | Two source systems reused an identifier | the entry |
| `new_vendor` / `new_budget_head` | Confirm the auto-created master row | `/settings` → Vendors / Budget Heads |

Roughly ten short strings and a link map.

**Files.** `components/exceptions/labels.ts`, `components/exceptions/resolve-exception-dialog.tsx`, `components/exceptions/exceptions-table.tsx`.

### 4.2 — Nine exception types have no plain-English label

**What.** The database allows 20 types; `EXCEPTION_TYPE_LABELS` covers 14 (three were added today, none of them these nine). The rest render as raw snake_case codes on screen — a direct violation of the project's plain-English-errors rule — **and** are missing from the type filter entirely, because `EXCEPTION_TYPES = Object.keys(EXCEPTION_TYPE_LABELS)`. So you cannot filter to the types that dominate the backlog.

**Still missing:** `audit_ambiguous_match`, `audit_row_unmatched`, `gst_recipient_compliance_missing`, `ocr_leaked_tag_syntax`, `page_count_mismatch`, `page_count_unresolved`, `page_extraction_failed`, `vendor_gstin_invalid_checksum`, `vendor_gstin_is_own_org`.

**Fix.** Nine lines in `components/exceptions/labels.ts`. Smallest fix in this document.

**Done when.** No raw code appears on `/exceptions` and all 20 types are selectable in the filter.

### 4.3 — Description column overlaps two other columns

**What.** The description cell has no truncation or wrapping constraint, so long text runs underneath the Status badge **and** the Raised date. Observed on screen: `"...does not match entry 20[open]unt 742418.00[26, 11:48 am]"` — three columns rendering on top of each other.

The Reports Open-issues digest has the mirror problem: descriptions cut mid-word with no ellipsis and no way to read the rest.

**Fix.** Max width on the description cell with `text-overflow: ellipsis` and a `title` tooltip, or let it wrap to two lines.

**Files.** `components/exceptions/exceptions-table.tsx`, `app/(app)/reports/page.tsx` (issue columns).

---

## Phase 5 — Reports

### 5.1 — The department → budget head → expense path doesn't connect

**What.** The user described drilling from a department into its budget heads and then into the expenses under each. Budget heads are rendered as **one flat list across all departments**, with no department column and no link out. Department rows, vendor rows and zone rows all link through to a filtered Entries list; budget-head rows are the one exception.

**Evidence.** `grep -c "budget_head_id=" app/(app)/reports/page.tsx` → 0. The `BudgetVsActualRow` type carries `department_id` but never renders it.

**Fix.** Add a Department column to the budget-head table and link each row to `/entries?budget_head_id=…`, matching what the other three tables already do. Consider grouping the table by department.

**Files.** `app/(app)/reports/page.tsx` (`budgetColumns`).

### 5.2 — The two vendor sections overlap

**What.** Merging Analytics into Reports put "Vendor spend" and "Vendor concentration" on the same 5,946 px page. Both rank the same vendors by the same spend with the same bar chart; only the trailing columns differ (first/last entry + doc coverage vs. % of total + open flags + ₹ at risk).

**Fix.** Fold into one vendor table with all the columns, one bar chart.

**Files.** `app/(app)/reports/page.tsx`.

### 5.3 — The page is 5,946 px of continuously scrolling sections

**What.** Ten sections on one page after the merge. The anchor nav at the top helps, but this grows with data.

**Fix (optional).** Consider tabs or a section picker if it gets worse. Not urgent — the anchor nav is a reasonable choice today.

### 5.4 — Cost centres appear nowhere in Reports, and no entry has one

**What.** The user's description of the reporting hierarchy was: *"each department has this many cost centers, like the budget heads that we have talked about, and each budget head has this many expenses."* Cost centre is the middle rung of that hierarchy and it is missing entirely — there is no cost-centre section on `/reports`, and no cost-centre column on any existing section.

**Evidence.**
```
grep -n "cost_center" app/(app)/reports/page.tsx   -> no matches
select count(*), count(cost_center_id) from entries -> 14 rows, 0 with a cost centre
```
The plumbing exists everywhere else: a `cost_center` table, a cost-centre filter on `/entries`, `entries.cost_center_id`, and a cost-centre picker on the entry enrichment form. Nothing has ever been assigned, and nothing reports on it.

**Fix.** Two parts, in order:
1. **Confirm the intended hierarchy first.** "Budget head" and "cost centre" may be the same rung under two names — §5.1's budget-head table may already be the report meant here. If they are genuinely different levels, the drilldown is department → cost centre → budget head → entries and §5.1's fix needs to account for the extra level.
2. Once settled, add the section (or the column) and decide how cost centres get populated — they are not set by either import today, so they would have to be assigned during review or in bulk from `/entries`.

**Done when.** The user confirms whether cost centre is a distinct level from budget head, and the reports reflect the answer.

### 5.5 — Sections that render correctly and say nothing

Not defects — but your team will open these and conclude the app is broken. Worth knowing, and worth a line of copy on each.

| Section | Shows today | Why |
|---|---|---|
| Budget vs actual by head | 10 rows, all "no approved budget" | see 1.5 |
| Department budget vs actual | 1 row, "no budget set" | see 1.4 |
| Spend by zone | 13 of 14 entries unassigned | classification hasn't happened yet |
| Hub-status ageing | empty | no entry has a Hub status set |
| Spend by item family | empty | no item catalogue yet |
| Rate benchmark | empty | not enough observations yet |

The empty states themselves are **good** — "Nothing awaiting verification or validation", "No item families yet", "Not enough data yet" all explain themselves. No change needed to those.

---

## Phase 6 — Finish event scoping

### 6.1 — Four surfaces were missed

**What.** Ten of the app's query sites filter by the selected event. These do not:

| Surface | Reads | Risk |
|---|---|---|
| `app/(app)/page.tsx` (Dashboard) | `v_review_queue`, `v_open_issues`, `v_budget_vs_actual`, `import_batch`, `source_document`, `v_entry_status_counts` | silently sums across years once 1449 H exists |
| `v_entry_status_counts` | — | has no `event_id` column at all |
| Analytics views (now inside Reports) | `v_compliance_summary`, `v_vendor_concentration`, `v_spend_by_family`, `v_rate_benchmark` | none has `event_id`; Phase 6 never touched them |
| `/import` batch history | `import_batch` | shows every year's batches |

Invisible today because only one event exists. **The day 1449 H is created, the Dashboard starts lying.**

**Fix.** Add `event_id` to `v_entry_status_counts` and the four analytics views (same pattern as `20260822000007`), then filter at each query site.

**Related asymmetry worth closing.** `/entries` and `/export` *are* correctly event-scoped, but not through their views — `v_entry_enriched` has no `event_id` column at all, and the filtering happens in `components/entries/entries-explorer.tsx` (which re-implements the cookie-reading logic client-side because `lib/events/current.ts` is server-only) and in `lib/export/queries.ts`. So the codebase has two different scoping mechanisms, and the view-based one can't be reused by the client-side one. Not broken, but it means a future reader has to know which surface uses which. Worth adding `event_id` to `v_entry_enriched` so every surface can use the same pattern.

### 6.2 — There is now no way to switch events at all

**What.** Today's commit deleted `components/app-shell/event-switcher.tsx` and `setActiveEvent`. The `active_event_id` cookie is now written by nothing. So the whole read-only past-event browsing that Phase 6 built is **unreachable**, and creating a 1449 H event will flip `is_current` and move every screen to the empty new year with no way back.

**Fix.** Either restore a minimal switcher (a dropdown on the Settings → Events "Past events" table would be enough) or accept the limitation — but do not create a second event until one exists.

### 6.3 — Settings tells the user to use the control that was just deleted

**What.** The Past-events card reads: *"Switching to a past event **(via the rail's event switcher)** puts the app in a view-only state — no new uploads, no verification, no export."* That switcher no longer exists. Anyone reading this hunts for a control that isn't there.

**Fix.** Rewrite the copy, or restore the control per 6.2. **Do not ship the current wording.**

**Files.** `app/(app)/settings/page.tsx`.

---

## Phase 7 — UI and responsive

### 7.1 — Stage 3 "Classify" is clipped off-screen at tablet width

**What.** At 820 px the Verify / Connect / Classify stepper runs past the right edge with no horizontal scroll, so the third step of the core workflow is **unreachable**. The line-items table is cut off the same way — "No line items were extracte" and half a "Re-extract" button. Clean at 1440 px, so this only bites whoever reviews on an iPad.

**Fix.** `overflow-x: auto` on the stepper row and the right column, or wrap the stepper below a breakpoint.

**Files.** `components/review/review-status-line.tsx`, `components/review/review-workspace.tsx`, `components/review/extraction-form.tsx`.

### 7.2 — The Entries filter panel eats the first half of the screen

**What.** Thirteen filters in four labelled groups — the grouping itself is well done and matches what was agreed (keep all 13, fix overload via grouping and sorting) — but the panel is permanently expanded and takes roughly 450 px before the first row of data appears. On the app's most-used screen, you scroll to see anything.

**Fix.** Collapse by default with a one-line summary of what's active ("3 filters · Labour, Pending, Aug 2026") and a click to expand. Keeps all thirteen without paying for them on every page load.

**Files.** `components/entries/filter-bar.tsx`.

### 7.3 — Sorting is inconsistent and half the columns aren't sortable

**What.** Date, Vendor, Amount and Status carry sort arrows; UBBL #, Main # and Budget Head don't, with nothing explaining why. Amount puts its arrows to the **left** of the label while every other column puts them on the right.

**Files.** `components/entries/entries-table.tsx`.

### 7.4 — The same label is two different colours on the same screen

**What.** On the Dashboard status breakdown: "Not set" is amber under Audit status and plain outline under Hub status. "Approved" is light green while "Paid" — also a terminal positive state — is solid dark olive. Numerals are set in two different typefaces across one row of tiles: `6`, `0`, `2` render serif while `₹2.32 Cr` and `₹6.99 L` render monospace.

**Fix.** One badge-variant map keyed by semantic state, shared by both status fields. Pick one numeral face for all stat tiles.

**Files.** `components/entries/format.ts`, `components/dashboard/stat-tile.tsx`, `components/dashboard/status-count-card.tsx`.

### 7.5 — "Budget burn" shows a big number when there is no budget

**What.** The tile reads **₹2.32 Cr** with the subtitle "10 of 10 heads have no approved budget". If nothing has a budget, nothing can be burning — that figure is just spend to date.

**Fix.** Rename the tile when the denominator is missing, or show the warning state instead of the number.

**Files.** `app/(app)/page.tsx`.

### 7.6 — Documents inbox has no filter or search

**What.** No status filter, no date filter, no filename search. Fine at 2 documents; a problem at 200. Also, a multi-bill row shows "4 bills" as a collapsed expander with no total for the PDF — you can't see what the document is worth without expanding.

### 7.7 — Horizontal scroll at phone width

**What.** Entries, Documents and the Dashboard overflow at 430 px (body scroll width 552, 478, 505 against a 430 viewport). Tablet is clean apart from 7.1.

**Fix.** Only worth doing if anyone actually opens this on a phone.

### 7.8 — Smaller items

- **Nav rail hydration flash.** The collapse state is applied in a `useEffect` after mount, so the rail renders expanded then snaps. Read the preference before paint or render from a cookie.
- **Settings carry-forward has no select-all/none.** Unticking a few of 42 admin heads means scrolling inside a small fixed-height box.
- **Budget head labels are redundant.** They read "Venue setup (Dome Tents) (Dom…" — department prefix plus label twice, then truncated.
- **Only the Budget Heads tab has a count badge.** Users and Vendors don't. Either all or none.
- **CSP warning.** `upgrade-insecure-requests` is ignored in a report-only policy — drop it from the report-only variant or move to enforcing.
- **The Documents upload dropzone is permanently 230 px tall**, even when you came to the page to find a document rather than add one. Fine at 2 rows; it pushes the list below the fold as the inbox grows.
- **The Dashboard's "Getting data in — two steps" pair is visually lopsided** — step 1 is a tall dropzone, step 2 is a short card with a single button, so the row reads as unfinished.

---

## Phase 8 — Performance and perceived speed

### 8.1 — Entries is the slowest screen in the app

**What.** 3.7 s to settle, at **14 entries**. Every other screen is under 2 s. It is also the heaviest bundle: 337 kB first-load JS against 199 kB shared. The cost is the client-side fetches in `entries-explorer.tsx` firing after mount (event membership tables, department/admin-head/zone lists).

Measured (production build, local, warm):

| Screen | TTFB | Settled |
|---|---|---|
| Dashboard | 226 ms | 789 ms |
| **Entries** | 150 ms | **3736 ms** |
| Documents | 574 ms | 1382 ms |
| Review | 233 ms | 1944 ms |
| Exceptions | 260 ms | 835 ms |
| Reports | 227 ms | 799 ms |
| Settings | 301 ms | 878 ms |

**Fix.** Move the membership/lookup fetches server-side into the page, or fetch them in one round trip instead of several.

### 8.2 — Ten of thirteen pages have no loading state

**What.** Only Documents, Review and the entry detail page have a `loading.tsx`. Every route is `force-dynamic` (required for the CSP nonce), so a click leaves the previous page on screen until the server answers.

**Mitigating factor found live:** Next's route prefetching is working (`_rsc` requests fire for every visible nav link), which hides most of this today. Entries is the exception and is the one that matters.

**Missing:** `/`, `/accuracy`, `/entries`, `/exceptions`, `/export`, `/import`, `/import/bookmarklet`, `/reports`, `/settings`, `/shortcuts`.

**Fix.** A `loading.tsx` per route mirroring the shape of the page beneath. Prioritise `/entries` and `/reports`.

---

## Phase 9 — Housekeeping and security

| Item | Raised | State | Action |
|---|---|---|---|
| Leaked-password protection disabled | 10 Aug | Open | One toggle in the Supabase dashboard (Auth → Policies). Do before real accounts exist. |
| Orphan tables `budget_head_master`, `budget_head_category` | 10 Aug | Open | Empty, outside version control, RLS on with no policies. `drop table` migration. |
| Missing index `entries.audit_status_changed_by` | 10 Aug | Open | Every sibling `_by` column has one. One line. |
| `pg_trgm` in public schema | 10 Aug | **Resolved** | Moved since that report. |
| `rls_auto_enable` executable by `anon`/`authenticated` | 10 Aug | Open | Platform-injected function; `revoke execute` to close the lint. |

---

## Phase 10 — OCR quality

### 10.1 — The model's commentary is landing in a data field

**What.** One bill's Notes field contains: *"Document is partially rotated and heavily skewed; significant text is illegible or obscured. Bank of Baroda receipt/document with reference number 11100100253… This appears to be a bank receipt."* Its vendor was read as **"Bank of Baroda"** — the bank on a cheque, not a supplier. The page should have been classified `is_financial_document: false` with `skip_reason: bank_cheque`.

Same class of problem as the leaked-tag-syntax guard already built: prose *about* the document is landing in a field meant for content *from* it.

**Fix.** Extend the `sanitizeExtractionResponse` backstop to catch meta-commentary patterns, and/or strengthen the classification prompt for bank receipts. Note the existing prompt (uncommitted) already added a worked example covering cheques and passbooks — verify it fixes this case on re-extraction before building more.

### 10.2 — The prompt-cache fix is correct, but sits 57 tokens from a silent cliff

**What.** The uncommitted `lib/claude-client.ts` change is **right**, and the numbers were verified against Anthropic's published documentation, not assumed:

- Claude Haiku 4.5 minimum cacheable prefix: **4,096 tokens** ✓ (as the comment claims)
- Claude Sonnet 5 minimum: **1,024 tokens** ✓
- Cache write: **1.25×** base input rate ✓ · Cache read: **0.1×** ✓
- Prompts under the floor are processed **without caching and without an error** ✓

So the diagnosis (measured ~4,039 tokens → Haiku silently never cached, 57 tokens short) and the cost maths are both sound.

**The risk.** The margin is thin and the failure mode is silent. Any future trim to the system prompt or the tool schema drops the prefix back under 4,096 and caching stops again with nothing to notice.

**Fix.** After the next production run, read `cache_creation_input_tokens` out of `ocr_extraction_run.raw_response_jsonb` (as the comment already says to). Then add a test asserting the rendered prefix stays above 4,096, so the cliff becomes a failing test rather than a silent cost increase.

### 10.3 — There is no skip reason for an ID document

**What.** The user named PAN cards first when describing skippable pages: *"The skipable ones are the PAN card, checkbox, etc."* The `skip_reason` check constraint has no value for them.

**Evidence.**
```
skip_reason allowed values:
  bank_cheque, passbook, unrelated_document, blank,
  other, permission_letter, agreement, photo, manual
```
No `pan_card`, no `id_document`, no `id_card`. Live data shows 4 pages classified `other` — the bucket a PAN card necessarily falls into today.

**Why it matters.** The reviewer's thumbnail rail shows the skip reason as the page's label, so an ID page reads "Other" — indistinguishable from a genuinely unclassifiable page. It also gives the model no dedicated label to reach for, which makes the classification less reliable than it needs to be for the single most common supporting document.

**Fix.** Widen the check constraint with `id_document` (covering PAN, Aadhaar, and similar), add it to the classification prompt's skip-reason list with a one-line description, and add a label for it in the UI. Build the new constraint from the **live** constraint definition, not from the original `CREATE TABLE` — a naive rebuild silently drops values added by later migrations, which is a trap this codebase has already hit once (see `20260822000004`'s notes).

**Files.** new migration, `lib/extraction-schema.ts`, `lib/claude-client.ts` (prompt), `components/review/pdf-viewer.tsx` (label map).

**Done when.** Re-extracting a PDF containing a PAN card labels that page as an ID document rather than "Other".

---

## Phase 11 — Deferred, needs a decision or a spec

| Item | Blocker |
|---|---|
| **Reviewers cannot add a vendor** | No create-vendor action exists anywhere in the app — vendors are only auto-created by the Departmental import. Decide: add one to the Review picker, or confirm the rule is "every bill maps to an imported entry so the vendor always exists" and make the picker say so when a search finds nothing. |
| **Page ceiling** | Measured: 8 pages ≈ 15 s, 20 ≈ 39 s, 28 ≈ 54 s against a 60 s limit. The 20-page cap keeps every upload safe with margin — but there's no room to raise it without either a longer request budget or resumable extraction. Needs one number: the largest bundle your team will realistically upload in a week. |
| **Batch manifest — auto-split, tally, exact invoice linking** | `hub-refinements-plan.md` §7. Needs a design pass on the splitting algorithm before it can be scoped. |
| **Reports special formatting** | Flagged twice across sessions, never specified. |
| **`COMMUNITY_GSTIN` as a list** | Only relevant if more than one of your own GST IDs can appear as the buyer. |

---

## Appendix A — What is confirmed working

Recorded so it isn't re-litigated or re-audited.

- **All 8 phases of the event-scoping punch list plus Phase 6 are built.** Nav spacing, Bill relabel, searchable classification comboboxes, sibling-nav fix, vendor-overwrite fix, GST compliance verified on a real bill, page↔OCR sync, Settings + per-user keymap, manual page skip/unskip, page- and field-scoped re-OCR, steps redesign, and the full event-scoping foundation.
- **The entire `import-review-ux-checklist.md` is complete** — all of Phases 0 through 5.
- **6 of 7 `hub-refinements-plan.md` items are built** despite that document's header. Only §7 (batch manifest) remains.
- **No schema drift.** All 60 repo migrations recorded as applied.
- **Both import ports have really run** — 5 Departmental batches, 7 Audit-portal batches, one shared `entries` table, with automatic retry of previously-unmatched audit rows.
- **The 20-page upload cap is wired end to end** — `app_settings.max_upload_pages`, editable from Settings, enforced at ingest before storage or OCR spend.
- **Auth gate verified on all 12 protected routes** against a production build.
- **Error handling is in good shape** — route/global/not-found boundaries, plain-English mapping, PDF retry, pinned save-conflict toast with Reload, explicit "don't retry blindly" on import failure.
- **Today's nav simplification works** — 12 items to 9; a department user sees seven.
- **Auto-collapsing the rail on `/review`** with a per-visit override that resets on leaving is a genuinely good detail.
- **Moving page skip/unskip into a per-page action bar with a consequence-naming confirmation** fixes a real click-target hazard.
- **The new "Done" checkmark on reviewed page thumbnails** is the first review-progress signal anywhere in the app.
- **Empty states are consistently excellent.**

## Appendix B — Method, and what was not tested

**Pass 1 (code, schema, data).** Read every plan document in `docs/`, then checked each claim against code and the live database rather than the documents' own status fields. Ran typecheck, lint, unit suite, production build. Queried the live database for migration state, data volumes, queue history and view output. Confirmed the auth gate on all protected routes.

**Pass 2 (live UI).** Production build served locally against the live database, signed in with a test account, driven with headless Chromium. Every screen visited and photographed at 1440 px, 820 px and 430 px, with console errors, failed requests and navigation timings captured. Each finding traced back to its source line and confirmed against the database.

**Not tested.**
- **No write actions were performed.** Navigation was by URL only — no Save, Resolve, Attach, Skip or Detach was clicked, because this is the production database. The read-only surface is verified; the write paths are not.
- **The account used was superadmin.** The department-role view is inferred from the nav filter and RLS definitions, not observed. See 1.2 — this is the test to run.
- **"Bill 4 of 3" is itself proof that verifying a bill changes what the queue reports.** One deliberate end-to-end save, on a document you don't mind touching, would exercise the write path that this audit could not.
