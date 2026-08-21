# Import & Review UX — Implementation Checklist

Working checklist for [`import-review-ux-plan.md`](./import-review-ux-plan.md). That document holds the reasoning and the evidence; this one is the ordered task list to tick off. Section references like *(plan §4)* point back to it.

**Phases are independently shippable.** Each ends in a state you can deploy and stop at. Do not start a phase before the one above it — Phase 1 removes bugs that would otherwise survive every later change, and Phase 3 must precede Phase 4 or the new signal lands on a red background.

**Verification convention:** every task has a "done when" that is observable, not "the code compiles."

---

## Phase 0 — Land what is already in flight

The working tree is dirty. Resolve it before starting, so later diffs are readable.

- [x] **0.1** Review and commit the in-progress uncertain-fields pass — `pdf-viewer.tsx`, `extraction-form.tsx`, `review-workspace.tsx`, `review/page.tsx`, `lib/review/types.ts`, `lib/extraction-schema.ts`, `lib/jobs/handlers/extract.ts`, `lib/claude-client.ts`, `lib/pdf.ts`, plus `supabase/migrations/20260821000001_uncertain_fields.sql` and the test fixtures. Committed `776204d`.
- [x] **0.2** Commit the `cron-tick.yml` assertions (already written, uncommitted) on their own branch — unrelated to the rest, keep it separate. Committed `0ccdc14` on branch `cron-tick-drain-assertions`.
- [x] **0.3** Run the queue-health query and record the answer in the plan. Tells you whether GitHub Actions is a real retry net or just returning OK. **Result: inconclusive from this DB** — every completed job in 24h was `local-dev-tick`/`local-dev-upload`, no production worker id observed. See plan §15.
  ```sql
  select date_trunc('hour', completed_at) as hour,
         locked_by,
         count(*) filter (where job_type = 'flags_run')        as flags,
         count(*) filter (where job_type = 'extract_document') as extracts
  from job_queue
  where completed_at > now() - interval '24 hours'
  group by 1, 2 order by 1 desc;
  ```
  `locked_by` ending `-tick` = GitHub Actions. Ending `-upload` = the inline drain.

**Done when:** `git status` is clean and you know which caller is draining the queue.

---

## Phase 1 — Correctness

Three defects where the UI reports success and nothing observable changes. Small, contained, independently verifiable. **Highest value per line changed in the whole plan.**

### D1 — Bill→entry attach writes to a column nothing reads *(plan §1)*

- [x] **1.1** New migration: redefine `v_review_queue` to join entries on `coalesce(de.entry_id, sd.entry_id)` instead of `sd.entry_id`. Base it on `20260817000004_review_queue_multi_bill.sql`, the last migration-tracked definition.
- [x] **1.2** `app/(app)/review/page.tsx:191` — add `entry_id` to the `document_extraction` select string.
- [x] **1.3** `app/(app)/review/page.tsx:213` — change to `const entryId = extraction.entry_id ?? sourceDoc.entry_id`.
- [x] **1.4** Audit other readers of `source_document.entry_id` for the same bug — `/export`, the reporting views, `lib/actions/documents.ts`. Anywhere a per-bill match should win, apply the same coalesce. Fixed `v_entry_enriched` and `v_vendor_spend` (also fixed an unrelated fan-out bug in the latter). `/export` and `lib/actions/documents.ts` audited — no change needed (neither reads `source_document.entry_id` as a matching signal). **Found but out of scope:** `app/(app)/entries/[id]/page.tsx`'s linked-documents list still queries only `source_document.entry_id`, so it won't show a document whose match lives solely on `document_extraction.entry_id`. Needs a follow-up, not a drop-in coalesce (different query shape).

Committed `8675fa7`.

**Done when:** on a multi-bill PDF, attaching bill 2 to an entry makes the combobox show that UBBL number after refresh, `TallyFooter` shows the entry amount, and the Hub status button becomes enabled. Today all three stay unchanged.

### D3 — Bare `R` destroys unsaved corrections *(plan §2)*

- [x] **1.5** `components/review/review-workspace.tsx` — add a `dirty` flag comparing live `header`/`lineItems` against the initial `buildHeaderState`/`buildLineItemState` snapshot.
- [x] **1.6** Move re-extract from `r` to `Shift+R` (line 329). Confirm before running when `dirty` is true.
- [x] **1.7** Add a `beforeunload` guard when dirty.
- [x] **1.8** Guard in-app navigation too — `goToDocument` (Prev/Next, PgUp/PgDn) must confirm when dirty. Currently it discards silently.
- [x] **1.9** Update `components/review/shortcuts-overlay.tsx` for the new binding.

Committed `8a2173a`.

**Done when:** typing a correction then pressing `r` does nothing; `Shift+R` asks first; PgDn asks first; closing the tab warns.

### D4 — Multi-bill PDF collapses to one bill in the inbox *(plan §3)*

- [x] **1.10** `app/(app)/documents/page.tsx:93` — change `Map<number, Extraction>` to `Map<number, Extraction[]>`; stop letting last-row-wins silently drop bills.
- [x] **1.11** `components/documents/types.ts` — `InboxDocumentView.extraction` becomes an array.
- [x] **1.12** `components/documents/document-card.tsx` / `document-table.tsx` — render a multi-bill document as one row expanding to a per-bill list, each bill with its own vendor/total and its own "Correct in Review" link (currently line 417 links to whichever bill sorted last).
- [x] **1.13** Rank candidates per bill, not per document.

Also required a ripple fix in `document-inbox.tsx` (default-candidate seeding read the removed top-level `candidates` field). Committed `cdc6c99`.

**Done when:** a 4-bill PDF shows 4 bills in the inbox, each linking to its own review record.

---

## Phase 2 — Honesty

Where the screen goes quiet, or actively lies. Biggest single change to "feels stuck"; touches almost no UI structure.

### D5 — Upload blocks on other users' backlog; timeout reported as failure *(plan §4)*

- [ ] **2.1** `app/api/documents/ingest/route.ts:292-299` — **remove the backlog drain.** Cap the inline work to this document's own job (`runJobById`) and nothing else. A user's upload must never spend its budget on other people's queued documents. *(Single highest-impact change in this phase.)*
- [ ] **2.2** Respond as soon as the `source_document` row and job exist, with the extraction outcome as a field rather than a precondition.
- [ ] **2.3** `components/documents/upload-dropzone.tsx` — replace the single `xhr.upload.onprogress` bar with the staged model. Only **Sending** carries a percentage; **Queued / Extracting / Extracted** are named states with elapsed time. Reuse `stagesFor()` from `document-card.tsx` — do not duplicate the mapping.
- [ ] **2.4** On timeout or network error where a `documentId` was returned, show **"Still extracting"**, never `error`. Reconcile against the id.

**Done when:** an upload returns in seconds, the row shows a named stage rather than a frozen 100%, and a slow extraction never displays as a failure.

### D6 — Inbox re-runs its heaviest query every 4s, invisibly *(plan §5)*

- [ ] **2.5** New narrow status endpoint returning only `id, upload_status, has_extraction` for pending documents.
- [ ] **2.6** `components/documents/document-inbox.tsx:57-64` — poll that endpoint and patch rows in place. Remove the `router.refresh()` interval, which re-runs six queries including a 5,000-row `entries` fetch.
- [ ] **2.7** Back off: 4s → 8s → 15s. Stop polling entirely on `visibilitychange` when the tab is hidden.
- [ ] **2.8** Add `app/(app)/documents/loading.tsx` — mirror the dropzone and table shape, like the existing `review/loading.tsx`.
- [ ] **2.9** Move `rankCandidates` off the render path (`documents/page.tsx:162`) — compute on extraction completion and persist, or lazily on row expand.

**Done when:** the inbox stops re-fetching 5,000 entries every 4 seconds, first load shows a skeleton, and a background tab stops polling.

### D7 — Import commit has no progress and no timeout ceiling *(plan §6)*

- [ ] **2.10** `app/api/import/route.ts` — set an explicit `maxDuration` (it declares `runtime = 'nodejs'` but no duration; the ingest route sets 60).
- [ ] **2.11** `components/import/import-workspace.tsx:215` — show the skeleton for `commit`, not only `dry_run`.
- [ ] **2.12** Dim the stale dry-run result during commit so it cannot be misread as current.
- [ ] **2.13** Report real counts as known ("412 of 1,180 rows") instead of an indeterminate spinner.
- [ ] **2.14** On network failure, replace "Could not reach the server" with *"The import may still be running. Check batch history before retrying"* — blind re-commit is the worst available action.

**Done when:** a commit shows progress, and a failed commit tells the user not to retry blindly.

### D8 — No visible signal when the queue stops draining *(plan §15)*

- [ ] **2.15** Surface a banner in the document inbox when the oldest `queued` job is older than ~10 minutes: *"Extraction is running behind. Uploads may take longer than usual."* Cheap query against `job_queue`.

**Done when:** a stalled pipeline is a named, visible state instead of silence.

---

## Phase 3 — Room

The form finally gets its width, and colour starts carrying information. **L3 before L2** — it is smaller and makes the result readable.

### L3 — Confidence tint carries no signal *(plan §11)*

- [x] **3.1** `components/review/extraction-form.tsx:130` — stop applying `tintClass` to every header field and every line-item cell.
- [x] **3.2** Move document confidence to a single badge in the review toolbar, beside model name and legibility.
- [x] **3.3** Reserve field-level colour for genuinely per-field conditions: uncertainty flag, value edited away from OCR, validation failure. (Uncertainty ring and a new blue "edited from OCR" ring shipped; a validation-failure state is not built — no validation logic exists yet, that's V1 in Phase 5 — so red is deliberately left unused for now.)

**Done when:** a 0.68-confidence document no longer renders as a wall of red, and a coloured field means "look here." Verified against a live 75%-confidence multi-bill document.

### L1 — Retractable PDF pane *(plan §9)*

- [x] **3.4** `components/review/review-workspace.tsx:438` — replace the hard-coded `grid grid-cols-2` with a resizable split.
- [x] **3.5** Three modes cycled by <kbd>\\</kbd>: **Split** (~50/50) → **Collapsed** (PDF as a spine, form full width) → **Document** (PDF ~75%, form as a summary strip). Draggable divider at any point between.
- [x] **3.6** Persist the chosen mode in `localStorage` — it is a working style, not a per-document decision.
- [x] **3.7** **Do not tear down pdf.js on collapse.** Keep the document loaded and the page number intact; only the pane width changes.
- [x] **3.8** Re-render the canvas on container resize. The current render effect depends only on `pageNumber, scale, rotation, numPages` and ignores its container entirely. Now fits the page to `containerWidth` via a `ResizeObserver`.
- [x] **3.9** Collapsed spine shows page count and flag count, so it is never a blank edge.
- [x] **3.10** Clicking an uncertainty marker auto-expands to Split and jumps to that page.

Two pdf.js bugs surfaced only under live, multi-page documents (not the synthetic single-page harness used for the first pass) and were fixed before landing: (1) the fit-width `ResizeObserver` re-renders the main canvas far more often than before, and a second `render()` call on the same canvas before the first settles throws `"Cannot use the same canvas during multiple render() operations"` — fixed by tracking the in-flight render task and awaiting its cancellation before starting the next one. (2) the thumbnail rail's inline `ref` callback (pre-existing pattern, not new) re-fires on every re-render, not just on real mount, so the same higher re-render frequency turned a latent bug into a real one — fixed by only re-rendering a thumbnail when its canvas element actually changed.

**Done when:** the line-items table stops scrolling horizontally in Collapsed mode, and the mode survives moving to the next document. Verified against a live 8-page, 4-bill document — Split/Collapsed/Document cycling, divider drag, and page navigation all confirmed with no console errors.

### L2 — Collapse secondary line-item columns *(plan §10)*

- [x] **3.11** Keep *Description · Qty · Unit · Rate · Amount* visible. Move **HSN/SAC**, **Qty (raw)** and **Discount** behind a per-row expander.
- [x] **3.12** Auto-expand a row when a hidden field differs from OCR or carries an uncertainty flag.
- [x] **3.13** Show the five unit quick-pick buttons only on the focused row (currently every row renders all five).

The per-row expand toggle button initially had a real click-target bug: clicking it also focused the row (via `onFocus` bubbling), which revealed that row's unit quick-picks and grew the row's height — since table cells default to vertical-align: middle, the button shifted under the cursor between mousedown and mouseup, so a real click could land on empty space instead of the button. Fixed with `onMouseDown={(e) => e.preventDefault()}` on the toggle button so it never takes focus. Confirmed fixed with a real (non-forced) click against both a synthetic harness and the live page.

**Done when:** a 12-line invoice renders roughly 60 inputs instead of 108 plus 60 buttons.

---

## Phase 4 — Signal

Small, now that Phase 0 landed most of the uncertainty feature. Sequenced **after Phase 3** on purpose: the ring needs a quiet background to read against.

### D2 — Finish the uncertainty surface *(plan §12)*

- [ ] **4.1** Extend `UNCERTAIN_RING_CLASS` to header fields. Entries with `line_order: null` are header-level and currently render nowhere in the form — only line items are covered.
- [ ] **4.2** Add a toolbar chip — **"3 fields to check"** — with next/previous stepping that focuses the field and calls `goToPage`.
- [ ] **4.3** Verify the bbox overlay under rotation. Bbox values are fractions of page width/height; the canvas applies `rotation` independently, so the two must be reconciled.

**Done when:** a reviewer can step through every flagged field, header and line item alike, without hunting.

---

## Phase 5 — Flow

Closes the loop: one screen, one keystroke, document verified, entry connected and classified.

### C1 — Always-present three-state match strip *(plan §7)*

- [ ] **5.1** `components/review/review-workspace.tsx:427` — remove the `billCount > 1` condition. A single-bill unmatched document currently has **no way** to be matched from the review screen at all.
- [ ] **5.2** Build the strip with three states:
  - **Matched** — UBBL, vendor, ledger amount, live variance against the total being typed, one *Change* link.
  - **Suggested** — top-ranked candidate inline with score, *Attach* button, *See 4 more*.
  - **Unmatched** — search field plus *No entry expected*.
- [ ] **5.3** Reuse `rankCandidates` from `lib/matching.ts` to populate Suggested. Do not reimplement — it already runs on this exact extraction shape in the inbox.
- [ ] **5.4** Multi-bill **bill rail**: `Bill 1 · 2 · 3` chips showing each bill's match state at a glance.

**Done when:** the common case is one click, not a search, and an unmatched bill 2 is visible without stepping through the queue.

### Z1 — Zone + head as stage 3 of a visible flow *(plan §8)*

- [ ] **5.5** Render the review screen's three stages as a visible progression, each showing done / current / blocked:
  **1 Verify** (correct OCR fields) → **2 Connect** (match to entry) → **3 Classify** (admin head + zone).
- [ ] **5.6** Fetch department-scoped `admin_head` and `zone` options in `loadDocumentDetail`, alongside `hubStatusOptions` which already follows this pattern.
- [ ] **5.7** Stage 3 sits directly below the stage-2 match strip. Disabled with *"Match this bill to an entry first"* until stage 2 completes; options populate the moment a match lands.
- [ ] **5.8** Extend `saveVerification` to write `admin_head_id` / `zone_id` in the same transaction, or call the existing `saveEntryEnrichment` after it. All three stages commit on the same <kbd>Ctrl/Cmd+Enter</kbd>.
- [ ] **5.9** Shortcuts <kbd>Z</kbd> and <kbd>H</kbd> jump to stage 3.
- [ ] **5.10** Ship **non-blocking** — see plan §16, still open. The progression makes an unfinished stage 3 obvious without a hard block.

**Done when:** a reviewer can always see which of the three stages they are on, and zone/head are assignable without leaving the queue.

### Z2 — Zone + head at the moment of attach in the inbox *(plan §8)*

- [ ] **5.11** When attaching a document to an entry with no zone or head set, show the two dropdowns inline in the confirmation, pre-filled from the most recent entry for the same vendor and department. Skipping is free.
- [ ] **5.12** For bulk attach, reuse `BulkEnrichmentDialog` as a follow-up step — it already handles *Don't change / Clear / Set* and partial-success reporting under RLS.
- [ ] **5.13** Call the existing `saveEntryEnrichment` / `bulkSaveEntryEnrichment`. **No new server action needed.**

### V1 — Validation, dirty state, save conflicts *(plan §13)*

- [ ] **5.14** `parseNum` — accept thousands separators and `₹`. Today `Number("12,500")` is `NaN`, so the value is **saved as null with no warning**.
- [ ] **5.15** Block save on an unparseable amount, with an inline field error.
- [ ] **5.16** Warn on invoice dates in the future or outside the event window.
- [ ] **5.17** Per-field "changed from OCR" marker, with a count in the toolbar. (Builds on the `dirty` flag from 1.5.)
- [ ] **5.18** Save-conflict detection — version check against `current_extraction_run_id`; today it is last-write-wins.
- [ ] **5.19** Resolve the claim check server-side, or disable inputs until it settles. The form is currently editable while "Checking claim…" is still running.
- [ ] **5.20** `components/review/pdf-viewer.tsx:258` — route the PDF load failure through `FriendlyError` instead of printing raw `err.message`. Add Retry. *(Violates the project's plain-English error rule — every other site uses `toastError`/`FriendlyError`.)*
- [ ] **5.21** Empty-extraction state — offer the next action (add a row, re-extract, flag) instead of only "No line items were extracted."

**Done when:** no silent data loss on save, and no raw error text on screen.

---

## Not in scope

Recorded so they are not re-litigated:

- **Running a worker** — decided against (plan §15). `INGEST_INLINE_EXTRACTION` stays on; every user's own request extracts their own document. A local worker would make one person's laptop a single point of failure for a distributed team.
- **A hosted always-on worker** — only revisit if `dead` rows appear in `job_queue`. As of 2026-08-21: 0 failed, 0 dead, 0 running.
- **Auto-escalation to Sonnet** — OCR stays Haiku-only; humans correct misreads in the review queue.
