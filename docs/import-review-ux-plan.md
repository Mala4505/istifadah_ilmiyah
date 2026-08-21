# Import & Review UX — Plan

**Status:** Nothing in this document is built yet — this is the plan, not a change log. Findings verified against the **working tree** on 2026-08-21 (dirty: the uncertain-fields pass is in progress and uncommitted, see §0a). Companion artifact (stakeholder-facing walkthrough of the same ground): ["Why the review screen feels stuck"](https://claude.ai/code/artifact/a5344ffa-3ca9-41b4-8599-ceee96dc3c76).

Distinct from [`review-inbox-redesign-plan.md`](./review-inbox-redesign-plan.md), which is the **completed** record of the 2026-08-14 seven-item pass. This document covers ground that pass did not.

---

## Context

A UX review of `/documents`, `/import` and `/review`, prompted by the report that *"the user feels stuck instead of knowing that the process is going on."*

Reading the data path before the interface turned much of that complaint into correctness work. Four findings are actions that **succeed in the UI and change nothing a reader can observe** — a success toast over a no-op. No amount of skeleton and spacing work fixes those, and they have to land first, because an interface cannot be made to feel trustworthy on top of a silent write.

The rest is genuine interface work: a hard-coded 50/50 split that starves the form, uniform confidence colour that carries no signal, and progress reporting that is not merely absent but actively wrong in two places.

---

## 0. Status snapshot

| # | Item | Kind | Status | Size |
|---|---|---|---|---|
| D1 | Bill→entry attach writes to a column nothing reads | **Bug** | To build | Small |
| D2 | Uncertainty highlighting covers line items only; no stepper | Gap | To build | Small |
| D3 | Bare `R` re-extracts and discards all unsaved edits | **Bug** | To build | Small |
| D4 | Multi-bill PDF collapses to one arbitrary bill in the inbox | **Bug** | To build | Small–Medium |
| D5 | Upload blocks on unrelated backlog; timeout reported as failure | **Bug** | To build | Medium |
| D6 | Inbox re-runs its heaviest query every 4s with no loading state | Perf/UX | To build | Medium |
| D7 | Import commit has no progress and no `maxDuration` | Gap | To build | Small |
| D8 | No visible signal when the job queue stops draining | Gap | To build | Small |
| C1 | Always-present three-state entry match strip | Redesign | To build | Medium |
| Z1 | Zone + admin head as stage 3 of a visible review flow | Feature | To build | Medium |
| Z2 | Zone + admin head at the moment of attach in the inbox | Feature | To build | Small |
| L1 | Retractable PDF pane — three modes, draggable, persisted | Redesign | To build | Medium |
| L2 | Collapse secondary line-item columns | UX | To build | Small |
| L3 | Confidence tint applied uniformly to every field | UX | To build | Small |
| V1 | Validation, dirty state, save-conflict detection | Gap | To build | Medium |

---

## 0a. Correction: what the in-progress work already covers

An uncommitted pass in the working tree (`supabase/migrations/20260821000001_uncertain_fields.sql` plus changes to `pdf-viewer.tsx`, `extraction-form.tsx`, `review-workspace.tsx`, `extract.ts`, `extraction-schema.ts`) **already implements most of the uncertain-field feature.** An earlier draft of this plan reported it as entirely dark; that was read from a stale view of the tree and is wrong.

What is now in place:
- `PdfViewerHandle.goToPage` is implemented in `useImperativeHandle` (it was previously declared and missing).
- `uncertainFields` is passed to both `PdfViewer` and `ExtractionForm`.
- Line-item fields carry `UNCERTAIN_RING_CLASS` when flagged.

What is **not** yet in place — this is what D2 below now means:
- Header fields (GSTIN, phone, email, invoice number, subtotal, tax, total) receive `tintClass` only. Uncertainty highlighting stops at the line-items table.
- There is no toolbar affordance — no "3 fields to check" count, no next/previous stepping between flagged fields.

This also raises the priority of **L3**: the uncertainty ring is now layered *on top of* the uniform confidence tint. On a 0.68-confidence document, a genuine "check this" ring has to compete with a background that is already red everywhere. The signal and the noise are now rendered in the same place, which is worse than either alone.

---

## 1. D1 — The bill→entry connection writes to a column nothing reads

**Current state:**

| | |
|---|---|
| `attachExtractionToEntry` writes | `document_extraction.entry_id` (`lib/actions/review.ts:284`) |
| `review/page.tsx` reads | `sourceDoc.entry_id` (line 213) |
| `v_review_queue` joins entries on | `sd.entry_id` (`20260817000004`) |

The review page's `document_extraction` select (line 191) does not request `entry_id` at all. `document_extraction.entry_id` exists (`20260817000002`) and is written by `extract.ts` as a single-bill mirror, but **nothing anywhere reads it.**

**Symptom:** attach succeeds → toast reads "Attached to UBBL-1042" → `router.refresh()` runs → the combobox still shows "Not attached", `TallyFooter`'s entry column stays blank, and the Hub status button stays disabled (`canSetHubStatus` derives from the same `entryId`).

This is the whole of *"I want the connecting of each bill with the entry in a better way."* The connection is not weak; it is not wired.

**Build:**
- Migration: redefine `v_review_queue` to join `entries` on `coalesce(de.entry_id, sd.entry_id)`.
- `app/(app)/review/page.tsx` — add `entry_id` to the extraction select; set `const entryId = extraction.entry_id ?? sourceDoc.entry_id`.
- Treat `document_extraction.entry_id` as the source of truth for a bill's match; `source_document.entry_id` remains the single-bill convenience mirror.
- Check `/export` and the reporting views for the same source-level join before shipping.

---

## 2. D3 — One unmodified keypress destroys unsaved corrections

**Current state:** `review-workspace.tsx:329` — `r` outside a text field calls `handleReExtract()` with no confirmation and no dirty check. That runs **Sonnet** (deliberately, per the button label), creating a new `ocr_extraction_run`. `review/page.tsx:130` keys the workspace on `documentExtractionId + ':' + currentExtractionRunId`, so a new run id remounts the component and rebuilds form state from the database.

`grep -c "dirty\|beforeunload" components/review/review-workspace.tsx` → **0**.

Net effect: a reviewer who has typed twenty corrections and brushes <kbd>R</kbd> loses all twenty, silently, and is billed for a Sonnet call. `e` and `s` share the bare-letter shape but are non-destructive.

**Build:**
- Track `dirty` (compare live state against the initial `buildHeaderState`/`buildLineItemState` snapshot).
- Move re-extract to <kbd>Shift+R</kbd>; confirm when dirty.
- `beforeunload` guard, plus an in-app guard on Prev/Next doc so PgUp/PgDn cannot discard edits either.

---

## 3. D4 — A four-bill PDF shows one arbitrary bill in the inbox

**Current state:** `app/(app)/documents/page.tsx:93` —

```ts
const extractionByDocId = new Map((extractionsData ?? []).map((e) => [e.source_document_id, e]))
```

`document_extraction` became 1:many per `source_document` in `20260817000002`. This Map keeps the **last row per document**. So a multi-bill PDF displays one arbitrary bill's vendor and total, ranks candidate entries against that one bill only, and its "Correct the extracted fields in Review" link (`document-card.tsx:417`) opens whichever bill sorted last. The others are invisible until reached through the review queue.

**Build:**
- Group into `Map<number, Extraction[]>`.
- Render a multi-bill document as one row that expands to a per-bill list, each with its own vendor/total, its own ranked candidates, and its own attach control — the same control C1 introduces.

---

## 4. D5 — Upload blocks on other people's backlog, and a timeout is reported as failure

**Current state:** `/api/documents/ingest` awaits `runJobById` for this document, then spends the remainder of a 45s budget (`POST_UPLOAD_DRAIN_BUDGET_MS`) in `drainJobQueue` on **unrelated** queued jobs, before responding. `maxDuration` is 60.

`upload-dropzone.tsx` wires its progress bar to `xhr.upload.onprogress` — that measures **bytes leaving the browser**, which finishes in seconds. The row then sits at a frozen "100%" with a spinner for the rest.

Two failure modes:
1. **False progress.** "100%" for up to 45 seconds while nothing on screen changes. This is the literal shape of "feels stuck".
2. **False failure.** On platform timeout the XHR error handler fires and the row flips to `error` — even though the `source_document` row exists and extraction likely succeeded. The user is told the upload failed when it did not.

**Build:**
- Respond as soon as the row and job exist. Never drain unrelated backlog on a user's request.
- If the inline drain must stay until a worker runs reliably (`INGEST_INLINE_EXTRACTION`), cap it to this document's own job.
- Replace the single bar with the honest two-phase model the stage tracker already models: **Sending** (has a real %) → **Queued** → **Extracting** → **Extracted**, the latter three as named states with elapsed time.
- On timeout, show "Still extracting" — not an error. The `documentId` is already in the response body; reconcile against it.

---

## 5. D6 — The inbox re-runs its heaviest query every four seconds, invisibly

**Current state:** `document-inbox.tsx:57-64` calls `router.refresh()` on a 4s interval while any document is `uploaded` or `processing`. That re-executes the whole server component: six queries including `entries` capped at **5,000 rows** (`documents/page.tsx:133`), plus `rankCandidates` once per document against that full pool.

There is **no `app/(app)/documents/loading.tsx`** — only `/review` and `/entries/[id]` have one.

So: heavy work every four seconds, and a screen that never acknowledges any of it.

**Build:**
- Narrow status endpoint returning `id, upload_status, has_extraction` for pending documents only; patch rows in place instead of refreshing the page.
- Back off: 4s → 8s → 15s. Stop entirely when the tab is hidden (`visibilitychange`).
- Add `app/(app)/documents/loading.tsx` for first load.
- Move candidate ranking off the render path — rank on extraction completion and persist, or compute lazily on row expand.

---

## 6. D7 — Import commit has no progress and no timeout ceiling

**Current state:** `import-workspace.tsx:215` gates the skeleton on `running === 'dry_run'`. A **commit** — the longer, irreversible operation — shows only a button label while the previous dry-run result stays on screen looking current.

`app/api/import/route.ts` declares `runtime = 'nodejs'` but sets **no `maxDuration`** (the ingest route sets 60). A large workbook commit can be killed by the platform default mid-transaction; the user sees only "Could not reach the server."

**Build:**
- Set an explicit `maxDuration`.
- Show the commit skeleton; dim the stale dry-run result so it cannot be misread as fresh.
- Report real counts as known ("412 of 1,180 rows") rather than an indeterminate spinner.
- On network failure: *"The import may still be running. Check batch history before retrying"* — blind re-commit is the worst available action here.

---

## 7. C1 — Always-present, three-state entry match strip

**Current state:** three problems at once.
1. The write goes nowhere (D1).
2. `EntryAttachCombobox` renders **only when `billCount > 1`** (`review-workspace.tsx:427`). A single-bill document that arrived unmatched has no way to be matched from the review screen — the reviewer must return to the inbox.
3. Matching is blind: the combobox needs two typed characters before showing anything, though `rankCandidates` already computes ranked candidates from this exact extraction shape in the inbox.

**Build:** replace the conditional row with a strip directly under the toolbar, always present, in one of three states:

- **Matched** — UBBL number, vendor, ledger amount, live variance against the total being typed. One *Change* link.
- **Suggested** — top-ranked candidate inline with its score, an *Attach* button, and *See 4 more*. The common case should be one click, not a search.
- **Unmatched** — search field plus *No entry expected*, so it can be resolved without leaving.

For multi-bill PDFs add a **bill rail** — `Bill 1 · 2 · 3` chips showing each bill's match state, so an unmatched bill 2 is visible without stepping through the queue.

Reuse `lib/matching.ts`'s `rankCandidates`; do not reimplement.

---

## 8. Z1 + Z2 — Where zone and admin head get assigned

**Current state: nowhere in the document flow.** The only writers are `EnrichmentForm` (`/entries/[id]`) and `BulkEnrichmentDialog` (entries list). Neither is reachable from `/documents` or `/review`.

A reviewer holding the open bill, who has just matched it and knows the zone, must leave the queue, find the entry, scroll to Enrichment, set two dropdowns, save, and navigate back — losing queue position, and (until D3 is fixed) any unsaved corrections on the way out.

### Z1 — Primary: the third stage of the review flow

**Decided 2026-08-21: zone and admin head are a sequenced step, not an optional field pair.** The review screen carries a three-stage flow, and this is stage 3:

| Stage | What happens | Gate |
|---|---|---|
| **1 — Verify** | Correct the OCR-extracted fields | always available |
| **2 — Connect** | Match this bill to its ledger entry | always available |
| **3 — Classify** | Assign admin head + zone | **requires stage 2** |

The gate is not a UI preference — it is a data dependency. `admin_head` and `zone` filter on the entry's `department_id` (`entries/[id]/page.tsx:84-98`), so until a bill is matched to an entry there is no department to scope the options by, and the dropdowns have nothing to show.

**Build:**
- Render the three stages as a visible progression in the review screen, each showing done / current / blocked. This does double duty: it places zone/head correctly *and* answers the original "the user feels stuck instead of knowing the process is going on" complaint at the level of the whole task, not just the network calls. A reviewer should always be able to see which of the three they are on and what remains.
- Stage 3 sits directly below the stage-2 match strip (C1). Disabled with *"Match this bill to an entry first"* until stage 2 completes; options populate the moment a match lands.
- All three stages commit on the same <kbd>Ctrl/Cmd+Enter</kbd> — one keystroke per document, unchanged.
- Shortcuts <kbd>Z</kbd> and <kbd>H</kbd> jump to stage 3's fields.

**Still open:** whether stage 3 *blocks* save, or is merely presented as the expected next step and can be skipped. Sequencing is now decided; enforcement is not. Recommend shipping it non-blocking first, with the progression making an incomplete stage 3 obvious, and adding enforcement only if entries keep arriving unclassified — a hard block interacts badly with the queue's throughput goal (§7's one-keystroke-per-document arithmetic) and is easy to add later, hard to walk back.

**Build:**
- Fetch department-scoped options in `loadDocumentDetail`, alongside `hubStatusOptions` which already follows this pattern.
- Extend `saveVerification` to write `admin_head_id` / `zone_id` in the same transaction, or call the existing `saveEntryEnrichment` after it.
- Shortcuts <kbd>Z</kbd> and <kbd>H</kbd>.

### Z2 — Secondary: at the moment of attach in the inbox

When a document is attached to an entry that has no zone or head set, show the two dropdowns inline in the confirmation, pre-filled from the most recent entry for the same vendor and department. Skipping is free.

For bulk attach, reuse `BulkEnrichmentDialog` as a follow-up step — it already handles the three-state *Don't change / Clear / Set* semantics and partial-success reporting under RLS.

**Build:** purely additive. Call the existing `saveEntryEnrichment` / `bulkSaveEntryEnrichment`; no new server action.

---

## 9. L1 — Retractable PDF pane

**Current state:** `review-workspace.tsx:438` — `grid grid-cols-2`, a fixed 50/50 that cannot be moved. The line-items table declares `min-w-[900px]` and gets roughly 480px, so it is **permanently horizontally scrolling** inside a pane half the screen wide — while the PDF, which a reviewer glances at, holds the other half at all times. On multi-page documents the 80px thumbnail rail takes more, leaving ~400px for nine columns.

**Build:** <kbd>\\</kbd> cycles three modes, with a draggable divider at any point between:

| Mode | PDF | Form | For |
|---|---|---|---|
| **Split** | ~50% | ~50% | Default |
| **Collapsed** | spine only | full width | Typing — line items stop scrolling sideways |
| **Document** | ~75% | summary strip | Poor scans, disputes |

- Persist the choice in `localStorage`. The mode is a working style, not a per-document decision — a reviewer who works collapsed stays collapsed across the whole queue.
- **Do not tear down pdf.js on collapse.** Keep the document loaded and the page number intact; only the pane width changes.
- Re-render the canvas on resize. It currently renders once at a fixed scale and does not respond to its container at all (`pdf-viewer.tsx` render effect depends on `pageNumber, scale, rotation, numPages` only).
- Three behaviours keep collapse from becoming a trap: clicking an uncertainty marker auto-expands to Split and jumps to that page; the collapsed spine shows page count and flag count so it is never a blank edge; <kbd>\\</kbd> reverses instantly.

---

## 10. L2 — Collapse secondary line-item columns

**Current state:** every row renders nine inputs plus five unit quick-pick buttons. A twelve-line invoice is 108 inputs and 60 buttons on screen at once. But **Qty (raw)**, **HSN/SAC** and **Discount** are rarely touched, and Qty (raw) duplicates Qty as a debugging field.

**Build:** keep *Description · Qty · Unit · Rate · Amount* visible. Move the rest behind a per-row expander that opens automatically when the field differs from OCR or carries an uncertainty flag. Show unit quick-picks only on the focused row.

---

## 11. L3 — Confidence tint carries no signal

**Current state:** confidence is stored per `ocr_extraction_run`, not per field, so `extraction-form.tsx:130` paints one `tintClass` across all eleven header inputs and every line-item cell. A document at 0.68 renders as a wall of red.

Colour that is always on carries no information — it raises anxiety and trains reviewers to ignore red exactly where red matters. **The in-progress uncertainty ring now sits on top of this**, so the real signal competes with a uniformly red ground (see §0a).

**Build:**
- Move document confidence to a **single badge in the toolbar**, beside model name and legibility.
- Reserve field-level colour for genuinely per-field conditions: an uncertainty flag, a value edited away from OCR, or a validation failure.
- Then red on a field means *look here*.

---

## 12. D2 — Finish the uncertainty surface

Given §0a, what remains:
- Extend `UNCERTAIN_RING_CLASS` to header fields — `uncertain_fields_ocr` entries with `line_order: null` are header-level and are currently not rendered anywhere in the form.
- Add a toolbar chip: **"3 fields to check"**, with next/previous stepping that focuses the field and calls `goToPage`.
- Verify the bbox overlay renders correctly under rotation — bbox values are fractions of page width/height and the canvas applies `rotation` independently.

---

## 13. V1 — Validation, dirty state, save conflicts

| Moment | Today | Should be |
|---|---|---|
| Amount parse | `parseNum("12,500")` → `NaN` → **saved as null, silently** | Accept separators and `₹`; block save on unparseable |
| Date | Native input, no range check | Warn on future dates and dates outside the event window |
| Unsaved edits | No tracking anywhere | Per-field changed marker, count in toolbar, navigation guard |
| Save conflict | Not detected — last write wins | Version check against `current_extraction_run_id` |
| Claim check | Form editable while "Checking claim…" runs | Resolve server-side, or disable inputs until settled |
| PDF load failure | Raw `err.message` printed on screen (`pdf-viewer.tsx`) | Route through `FriendlyError` like everywhere else, plus Retry |
| Empty extraction | "No line items were extracted." | Offer the next action: add a row, re-extract, or flag |

The amount case is the sharpest: `Number("12,500")` is `NaN`, so `parseNum` returns `null` and the value is written as null with no warning and no inline error. The PDF-load case violates the project's own plain-English error rule — every other site routes through `toastError` / `FriendlyError`.

---

## 14. Order of work

Sequenced so each stage ships independently, earliest stages removing the most confusion per line changed.

| Stage | Theme | Items | Why here |
|---|---|---|---|
| **1** | Correctness | D1, D3, D4 | Small, contained, independently verifiable. The bill→entry connection works before it looks better. |
| **2** | Honesty | D5, D6, D7, D8 | Biggest single change to "feels stuck"; touches almost no UI structure. D8 makes a stalled queue visible rather than silent. |
| **3** | Room | L1, L3, L2 | The form finally gets its width, and colour starts meaning something. L3 before L2 — it is smaller and unblocks reading the result. |
| **4** | Signal | D2 | Small now that §0a has landed. Lights up retroactively for the whole backlog. |
| **5** | Flow | C1, Z1, Z2, V1 | Closes the loop: one screen, one keystroke, document verified and entry enriched. |

---

## 15. Decided — `INGEST_INLINE_EXTRACTION` stays on

**Decision (2026-08-21): keep inline extraction. Do not run a worker. D5 is fixed inside the inline model.** This closes the question left open by `review-inbox-redesign-plan.md`'s Item 3 diagnosis.

**Why.** The Hub is used by staff in multiple locations who upload and review in the same sitting, at unpredictable times. That rules out both worker options:

- **A per-session local worker** (start `npm run worker` when you sit down) fails because the person uploading is often not the person running it. The worker is a puller, not a server — it connects out to the hosted Supabase (`lib/jobs/queue.ts:70`) and claims from the shared queue, so one instance anywhere does serve every user. But that makes one person's laptop a silent single point of failure for everyone else's uploads.
- **The GitHub Actions tick alone** fails because it is best-effort every ~5–10 minutes. With inline off, a user's upload would sit unextracted for that long with no explanation.

Inline extraction has neither problem: every user's own request extracts their own document, on Vercel, wherever they are. No shared machine, no coordination.

**Consequences for the D5 build (§4).** All three fixes stay, and none of them need a worker:
- Cap the post-upload drain to **this document's own job** — never other users' backlog.
- Replace the frozen byte-percentage with the staged model.
- Treat a platform timeout as "still extracting", never as failure.

**Known residual, accepted.** Inline extraction inherits Vercel's `maxDuration = 60`. A PDF needing longer is killed, retried, and after `max_attempts = 3` goes `dead`. As of 2026-08-21 this is not occurring — `job_queue` shows 0 `failed`, 0 `dead`, 0 `running`, 15 succeeded `extract_document` at `max(attempts) = 2`. **Revisit only if `dead` rows appear**; the answer then is a hosted always-on worker (Railway/Render/Fly), never a laptop.

**New build item — worker/queue health banner.** Add to Stage 2 alongside D5: surface in the document inbox when the queue is not draining (oldest `queued` row older than ~10 minutes), so a stalled pipeline is a visible, named state rather than a silent one. Cheap query against `job_queue`; turns the failure mode this section rules out into something diagnosable if it ever arrives by another route.

**Queue-health query result (checklist §0.3, run 2026-08-21 against this environment's `DATABASE_URL`):** every job completed in the last 24h was locked by `local-dev-tick` (34 `flags_run`) or `local-dev-upload` (1 `flags_run` + 1 `extract_document`) — `locked_by` is `${WORKER_ID}-tick` / `${WORKER_ID}-upload` (`lib/env.server.ts`, `app/api/jobs/tick/route.ts`, `app/api/documents/ingest/route.ts`), and `WORKER_ID` defaults to `local-dev`. **Zero rows carry a distinct production worker id in this window**, so this data cannot confirm the GitHub Actions cron is running as a real retry net against this database — everything observed came from local requests (manual `npm run dev` usage / local ingest), not the deployed tick. Overall `job_queue`: 56 `succeeded`, 1 `queued` (`flags_run`, created 2026-08-21T10:06Z, unclaimed at query time), 0 `failed`/`dead`/`running`. Re-run this query against the production database (or check the Vercel/GH Actions logs directly) before relying on the `-tick` suffix to mean "GitHub Actions" — locally it means "someone's dev server."

---

## 16. Outstanding — still needs a decision

- **Whether stage 3 (zone + head) blocks save, or is skippable.** Sequencing is decided (§8, Z1): it is the third stage, gated on the entry connection. Enforcement is not. Recommendation is to ship non-blocking and revisit — see Z1's "Still open".
