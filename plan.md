# OCR System — Full Review, Issue List, and Remediation Plan

**Date:** 2026-08-18
**Scope:** the whole extraction workflow — ingest → Claude call → schema → pipeline → persist → job queue → review UI.
**Merges:** this review's findings with the existing multi-bill plan (`~/.claude/plans/resilient-rolling-clover.md`), which is folded in wholesale as Phase 2.

**Operator decision driving Phase 1:** run **Haiku only** for now. Sonnet is consuming too many tokens. Once Haiku output has been reviewed on real documents, we decide whether Sonnet earns its cost.

---

## 1. Issue list, by workflow stage

Severity: **P0** = actively producing wrong output or wrong cost today · **P1** = real defect, not the current failure · **P2** = correctness/hygiene debt.

### Stage 1 — Ingest (`app/api/documents/ingest/route.ts`)

| # | Sev | Issue |
|---|---|---|
| I1 | P2 | `pageCount` falls back to a client-declared value when server-side PDF parse fails, and to `null` after that. When null, no `document_page` rows are created at ingest and the table is populated only later by the extraction upsert — page classification for a document that never extracts is silently absent. |
| I2 | P0 | A multi-bill batch scan is ingested as one `source_document` with no split. Correct as an ingest decision; the defect is that nothing downstream can represent what's inside it (see I8/I12). |

### Stage 2 — Claude call (`lib/claude-client.ts`)

| # | Sev | Issue |
|---|---|---|
| I3 | **P0** | `max_tokens: 2000` with **no `thinking` parameter set**. On `claude-sonnet-5`, omitting `thinking` means adaptive thinking runs **by default**, and `max_tokens` caps thinking *plus* output together. Every Sonnet escalation spends part of a 2,000-token budget thinking, then truncates the tool call → `ExtractionTruncatedError` → retry at 8,000 → thinks again. The escalation path meant to *rescue* hard documents is the one most likely to return partial output, at double cost. Sonnet 5's newer tokenizer (~30% more tokens for the same content) tightens this further. |
| I4 | **P0** | `@anthropic-ai/sdk` pinned at `^0.32.1` — predates GA PDF document blocks, typed `cache_control`, and `thinking`. Compensated with three `as unknown as` casts (`buildPdfBlock`, `buildCachedSystemPrompt` casting a block array to `string`, and the tool). **TypeScript no longer type-checks the request body at all**; a malformed request compiles cleanly and fails at runtime or silently drops a field. |
| I5 | **P0** | System prompt instructs *"Read every page as part of one document: a line-item table may continue across a page break."* On a batch scan this actively tells Claude to **merge** several vendors' bills into one invoice. |
| I6 | P1 | No `thinking` configuration on any call, so behaviour is whatever the model defaults to — and that default changed between the Haiku and Sonnet generations. |

### Stage 3 — Extraction schema (`lib/extraction-schema.ts`)

| # | Sev | Issue |
|---|---|---|
| I8 | **P0** | One document = one invoice. `vendor_name`, `invoice_number`, `invoice_date`, `subtotal`, `total_amount` are flat scalars at the response root; there is no `bills[]`. `pages[]` carries only a classification verdict, no per-bill data. Confirmed empirically on `source_document` 6: Claude read all 8 bills correctly and wrote them into `notes_ocr` free text because the schema had nowhere to put them. **This is a data-model bug, not a model-capability bug.** |
| I9 | P1 | `sanitizeExtractionResponse` blanks fields containing leaked tag syntax (`</parameter>`). That is a band-aid over an abnormal model output whose root cause is undiagnosed (most likely the I4 casts). Blanking discards real extracted data and raises an exception a human must clear. |

### Stage 4 — Pipeline (`lib/extraction.ts`)

| # | Sev | Issue |
|---|---|---|
| I10 | **P0** | Auto-escalation to Sonnet fires when `contains_non_latin_script` is true **or** `extraction_confidence < 0.7`. On an Indian invoice corpus the script flag is true for most documents, so **nearly every document runs twice** — roughly 4× the intended cost. This is the operator's reported symptom. |
| I11 | P1 | The truncation retry re-sends the entire PDF at `max_tokens: 8000` — full re-billing of input tokens on exactly the densest, most expensive documents. |

### Stage 5 — Persistence (`lib/jobs/handlers/extract.ts`)

| # | Sev | Issue |
|---|---|---|
| I12 | **P0** | `document_extraction` upserts `onConflict: 'source_document_id'` — exactly one extraction row per uploaded file, enforced by a `unique` constraint. Structural counterpart to I8. |
| I13 | **P0** | `runTallyChecks` compares the merged line-item sum against a single header total. On any multi-bill file this raises a high-severity `line_item_tally_mismatch` **every run, unresolvably**. The review queue prioritises on these rows, so the prioritisation is currently noise. (`source_document` 6 was manually re-escalated to Sonnet 7 times chasing this — ~$0.68 of $2.57 total account spend, on a mismatch no model can fix.) |
| I14 | P1 | `source_document.page_count` from ingest wins over the model's `pages.length`. Pages the model omitted from `pages[]` keep a null classification with no warning. |

### Stage 6 — Job queue and worker (`worker/index.ts`, `app/api/jobs/tick/route.ts`)

| # | Sev | Issue |
|---|---|---|
| I15 | P1 | `generate_export` and `rasterize_retry` are **claimed** and then skipped with no completion bookkeeping, deliberately leaving the row `running`/locked for "the sweeper". `grep` finds the sweeper described in a comment (`20260808000025_flags.sql:64`) but no implementation — **verify**; if absent, those jobs lock forever. |
| I16 | P1 | Batch API never implemented — `batch-poll.ts` throws `not implemented — Phase 1B`. Every extraction runs at the full synchronous rate rather than the 50% batch rate the plan assumed, roughly doubling real per-page cost. |
| I17 | P2 | Two migrations share the timestamp prefix `20260817000001` (`_entry_status_counts_view` and `_ocr_leaked_tag_syntax_exception`) — ordering between them is ambiguous. The Phase 2 migration must sort strictly after both. |

### Stage 7 — Review UI and actions

| # | Sev | Issue |
|---|---|---|
| I18 | **P0** | The review queue's `?id=` param and prev/next navigation are keyed by `sourceDocumentId`, which breaks the moment one document appears more than once in `v_review_queue`. |
| I19 | P1 | `manualExtractNow` ("Extract now" on the Documents inbox) passes `runReason: 'manual_reescalation'` while actually running **Haiku**. Ordinary first extractions are logged as manual re-escalations — cost attribution and extraction history are both wrong. |
| I20 | P2 | Two buttons run different models with no UI indication: **"Extract now"** (Documents card) → Haiku (+ escalation); **Re-extract** (Review workspace) → forced Sonnet. |

---

## 2. Phase 1 — Haiku only, and stop the token bleed

Small, self-contained, independently testable, and reversible. Does not touch the database. **This is what unblocks review today.**

| Step | Change | Fixes |
|---|---|---|
| 1.1 | Add `OCR_AUTO_ESCALATION` to `lib/env.server.ts` (`z.string().optional().default('false').transform(v => v === 'true')`, matching the existing `CSP_REPORT_ONLY` idiom). Default **off**. | I10 |
| 1.2 | Gate auto-escalation in `runExtractionPipeline` on that flag, so a Haiku run never triggers a Sonnet run unless explicitly re-enabled. The manual Sonnet button stays available and unaffected. | I10 |
| ~~1.3~~ | ~~Set `thinking: { type: 'disabled' }` explicitly.~~ **Dropped during execution — see note below.** | — |
| 1.4 | Raise `EXTRACTION_MAX_TOKENS` from 2,000 to 4,000, so Sonnet's adaptive thinking and the tool call both fit in one budget. `max_tokens` is a ceiling, not a reservation — unused headroom is never billed — while each truncation retry re-bills the whole PDF's input tokens. Net cost reduction. | I3, I11 |
| 1.5 | Rewrite the "Read every page as part of one document" sentence in `buildSystemPrompt` to distinguish *a table continuing across a page break* from *a new bill starting on a new page*, and to record per-bill facts in `notes` until `bills[]` exists. | I5 |
| 1.6 | `manualExtractNow` passes `runReason: 'initial'` (it runs Haiku, and it is the document's first extraction). | I19 |
| 1.7 | Surface the model on both buttons: "Extract now (Haiku)" and "Re-extract with Sonnet". | I20 |

**Why 1.3 was dropped.** Expressing `thinking` at all requires a *fourth* `as unknown as` cast on the pinned 0.32.1 SDK — adding to the exact problem I4 describes. And disabling thinking on a Claude 5-generation model carries two documented failure modes: tool calls occasionally emitted as plain assistant text (the call silently never runs) and internal `<thinking>` tags leaking into field values — the second being suspiciously close to the leaked-tag syntax this codebase already has a sanitizer for (I9). Raising `max_tokens` fixes the Sonnet truncation without either risk and without a new cast, so 1.4 alone carries the fix. Haiku 4.5 does not think by default, so the primary path is unaffected either way.

**Verification (done):** `npx tsc --noEmit` clean; `npx vitest run test/unit` 272/272 passing. Still to do on a live system: re-extract 2–3 real documents and confirm exactly one `ocr_extraction_run` row per document, with `model = 'claude-haiku-4-5'` and `run_reason = 'initial'`.

---

## 3. Phase 2 — Multi-bill extraction

Reproduced in full below from `~/.claude/plans/resilient-rolling-clover.md`, which lived outside the repo and was therefore unversioned and invisible to anyone cloning the project. That plan is correct and this review independently reproduced its diagnosis; it is the authoritative Phase 2 spec and is inlined here so the repo carries it.

### Context

The OCR pipeline currently assumes one uploaded PDF (`source_document`) is exactly one bill: `document_extraction.source_document_id` is `unique`, so extraction can only ever write one header/total/line-item-set per document, no matter what's actually in the PDF.

That assumption breaks on real batch scans. Investigated `source_document` id 6 (`1448_Invoice_1_05.08.2026.pdf`, 17 pages, referenced in `docs/hub-refinements-plan.md` §7): it's a "Batch Print Summary" cover page followed by 8 separate vendor bills plus their supporting PAN-card/cheque pages. Claude correctly identified every one of the 8 bills — vendor, invoice number, date, amount, GSTIN, even reading damaged handwriting — and wrote it all out in the `notes_ocr` free-text field, because the schema had nowhere else to put it. The single `total_amount_ocr` field got the batch cover page's grand total, which can never equal the sum of 21 line items drawn from 8 different bills, so `line_item_tally_mismatch` fires every run and can never be resolved. That document alone was manually re-escalated to Sonnet 7 times chasing a mismatch that no model can fix under this schema (~$0.68 of the account's $2.57 total spend). This is a data-model bug, not an OCR/model capability problem — confirmed by Claude's own notes text — so the fix is structural, not a vendor switch.

**Goal:** let one `source_document` produce N `document_extraction` rows (one per bill Claude finds), each independently reviewable, verifiable, tally-checked, and matchable to its own ledger entry — while keeping today's single-bill documents (the overwhelming majority of traffic) behaving exactly as before.

**Explicitly out of scope for this pass** (call these out if they come up, don't build them):
- Auto-attributing non-financial support pages (PAN cards, cheques) to a specific bill. They stay visible in the page strip as document context, unattributed — same as today.
- Parsing the batch manifest/cover page as structured data and tallying it against the sum of bills (`hub-refinements-plan.md` §7 point 3). This pass only fixes per-bill extraction; manifest cross-checking is a natural follow-up once this is live.
- Per-bill escalation (auto-escalating only the one bill that's low-confidence). Escalation stays whole-document, as today — one Claude call still covers the whole PDF.

### Data model changes

New migration — must sort after **both** `20260817000001_*` files (see I17: they share a timestamp prefix):

- `document_extraction`: drop the `unique` constraint on `source_document_id` (it's `document_extraction_source_document_id_key` per Postgres's default naming — verify with `\d document_extraction` before writing the `drop constraint`). Add `bill_index int not null default 0`, `page_number_start int`, `page_number_end int`, `entry_id bigint references public.entries(id)`. Add `unique (source_document_id, bill_index)` (replaces the old single-column unique — this is what `extractAndPersist`'s upsert will conflict on) and a plain `document_extraction_document_idx (source_document_id)` (the old unique constraint provided this implicitly; dropping it removes that index too). Add `document_extraction_entry_idx (entry_id) where entry_id is not null`.
- `public.verify_document_extraction`: supersede via a new migration. Change the lookup from the current ambiguous `select de.id into v_doc_extraction_id from document_extraction de where de.source_document_id = p_source_document_id` (in `20260814000011_verify_document_extraction_vendor_email.sql`) to taking `p_document_extraction_id bigint` directly and looking up `where de.id = p_document_extraction_id`. Read the current full function body first and change only the identifier logic — everything else (the `_verified` writes, `rate_reference` insert) stays the same.
- `v_review_queue` (`create or replace view`, from `20260814000009_review_queue_add_queue_amount.sql`): add `de.bill_index`, `de.page_number_start`, `de.page_number_end`, and a per-document bill count (`count(*) over (partition by de.source_document_id)` or a lateral subquery) to the selected columns. The existing `join public.source_document sd on sd.id = de.source_document_id` already fans out correctly once `document_extraction` is 1:many — no join logic changes needed, just add columns.
- Before writing the migration, re-read `private.can_see_source_document` / `private.can_see_document_extraction` (bodies in `20260808000026_rls_policies.sql`) to confirm neither assumes source→extraction is 1:1 in a way that breaks (direction of the join shouldn't care about cardinality, but confirm before relying on it).

### Claude request/response schema (`lib/extraction-schema.ts`, `lib/claude-client.ts`)

Replace the flat top-level header fields + top-level `line_items[]` with a `bills[]` array. Each bill object carries exactly the fields `extractionResponseSchema` currently has at the top level (`vendor_name` … `notes`, all of it — same `absentTextAsNull`/nullable-number conventions, unchanged) plus `page_number_start`/`page_number_end` (ints) and its own `line_items: extractionLineItemSchema[]`. `pages[]`, `legibility`, `extraction_confidence`, `contains_non_latin_script` stay at the response root — page classification and the escalation signal remain whole-document.

Union-type budget (the `strict: true` 16-union cap documented in the file's own comment): this is checked per JSON-schema *object*, not globally — the reason text fields already use the `""`-for-absent convention instead of `| null` is exactly this constraint. Moving header fields under `bills.items.properties` doesn't add nullable text unions (they stay plain strings), so each bill object's own union count stays roughly what the current top level's is today (~7 nullable numbers). This should be safe, but **verify with one real `extractDocument` call against the new schema before treating it as done** — a `strict: true` schema violation is a 400 at request time, cheap to catch early.

Update the pure functions that currently operate on the flat response to loop over `bills`:
- `filterNonFinancialLineItems` → filter each bill's `line_items` against the financial page set.
- `buildTaxBreakdown` → take one bill, not the whole response.
- `sanitizeLeakedTagSyntax`/`sanitizeExtractionResponse` → sanitize each bill's header + line items; blanked-field names become `bills[i].vendor_phone` etc.

Update `EXTRACTION_TOOL_DESCRIPTION` to say the document may contain several distinct bills, each should become its own entry in `bills[]`, and each should include the page range its header/totals were read from. **Also revert the Phase 1 stopgap wording in `buildSystemPrompt`** (the "schema has room for only one bill, put the rest in `notes`" instruction) — it becomes actively wrong once `bills[]` exists.

`lib/claude-client.ts` needs no structural change beyond what's already shipped (cached system prompt) — `extractDocument` still calls `extractionResponseSchema.parse(...)` and `filterNonFinancialLineItems(...)`, just against the new nested shape.

### Pipeline (`lib/extraction.ts`, `lib/jobs/handlers/extract.ts`)

- `lib/extraction.ts`: `lineItemTotal` becomes per-bill (takes one bill, used inside the per-bill tally loop below). `escalationReason`/the escalation rule stay reading `extraction.extraction_confidence`/`extraction.contains_non_latin_script` off the response root — unchanged (and still gated by `OCR_AUTO_ESCALATION` per Phase 1).
- `lib/jobs/handlers/extract.ts` (`extractAndPersist`) — the real rewrite. After sanitizing, loop `extraction.bills` by index (`bill_index`):
  - Upsert `document_extraction` on `(source_document_id, bill_index)` instead of `source_document_id` alone, writing the same header columns as today plus `page_number_start`/`page_number_end`.
  - `entry_id` on write: if `extraction.bills.length === 1`, mirror `source_document.entry_id` (read-only derivation — preserves today's behavior for the dominant single-bill case, no new write path). If `bills.length > 1`, leave `entry_id` as whatever it already is on that row (null on first insert; set later via the new attach action below) — never overwritten by an extraction run.
  - `vendor_gstin_is_own_org` / `ocr_leaked_tag_syntax` exceptions: same as today, but `dedup_key` includes `bill_index` so sibling bills don't collide.
  - Line items: delete-and-reinsert scoped to that bill's `document_extraction_id` (same pattern as today, just inside the loop).
  - Tally checks (`runTallyChecks`): run once per bill, scoped to that bill's own `document_extraction_id`/`entry_id`/totals — this is the actual fix for the repeating `line_item_tally_mismatch` spam (I13), since each bill's own line items now sum against its own total, not the batch cover page's.
  - Exception supersession (marking prior open exceptions dismissed on re-run): already scoped by `document_extraction_id` today — no change needed there, just make sure it runs per bill.
  - `document_page` upsert and `source_document.page_count` update: unchanged, still whole-document.
- `ExtractAndPersistResult`: change `documentExtractionId: number` → `documentExtractionIds: number[]` (or similar), add `billCount: number`, keep `lineItemCount` as the sum across bills. Update the two callers: `handleExtractDocument`'s log line, and `app/api/documents/reescalate/route.ts`'s JSON response (feeds the toast in `review-workspace.tsx`: `Re-extracted with ${model} — ${lineItemCount} line item(s)` → extend to mention bill count when > 1).

### Review UI (`lib/review/types.ts`, `app/(app)/review/page.tsx`, `components/review/review-workspace.tsx`, `lib/actions/review.ts`)

Smaller than expected: `loadDocumentDetail` in `review/page.tsx` already queries `document_extraction` by `.eq('id', documentExtractionId)` (not by source document), and `flagReviewException`/`getReviewDocumentUrl`/`claimReviewDocument` in `lib/actions/review.ts` are already correctly scoped (claim and PDF URL stay document-level on purpose — you don't want two reviewers independently claiming different bills in the same PDF; exception-flagging already takes `documentExtractionId` explicitly). The actual bug is that **the `?id=` URL param and the prev/next queue navigation are keyed by `sourceDocumentId`** (I18), which breaks the moment one `source_document_id` can appear more than once in `v_review_queue`.

Concrete edits:
- `app/(app)/review/page.tsx`: switch `queue.findIndex`, the redirect fallbacks, and `prevId`/`nextId` from `sourceDocumentId` to `documentExtractionId`. Add `billIndex`/`billCount` to the `QueueEntry` mapping and to `ReviewDocumentDetail` (pulled from the `document_extraction` row already being fetched — free columns, already in the query once the migration adds them). The `queue={queue.map(...)}` prop passed to `ReviewWorkspace` changes from `{sourceDocumentId}` to `{documentExtractionId}`.
- `lib/review/types.ts`: `QueueEntry` gains `billIndex`, `billCount`; `ReviewDocumentDetail` gains `billIndex`, `billCount`, `pageNumberStart`, `pageNumberEnd`.
- `components/review/review-workspace.tsx`: `queue` prop type → `{ documentExtractionId: number }[]`; `buildSavePayload()` adds `documentExtractionId: detail.documentExtractionId`. `handleReExtract` and the claim calls stay on `detail.sourceDocumentId` — unchanged, correct, re-extraction re-runs the whole PDF and regenerates every bill. Add a small "Bill {billIndex + 1} of {billCount} in this PDF" badge near the existing filename/confidence display when `billCount > 1`, so a reviewer understands why they're seeing bill 3 of 8 back to back.
- `lib/actions/review.ts`: `SaveVerificationInput` gains `documentExtractionId: number`; `saveVerification` passes `p_document_extraction_id` to the RPC instead of `p_source_document_id`.

### Matching — link a bill to its ledger entry

Precedent already exists: `reconciliation_exception` independently links `entry_id` and `document_extraction_id`. Reuse that shape.

- `document_extraction.entry_id` (added in the migration above) becomes the per-bill match link.
- New server action in `lib/actions/review.ts`, mirroring `attachDocumentToEntry` (`lib/actions/documents.ts`): `attachExtractionToEntry(documentExtractionId, entryId)` — a plain `update document_extraction set entry_id = … where id = …`, RLS-gated the same way (`is_reviewer_or_admin()`).
- Small UI addition on the review screen: an entry-search-and-attach control, shown only when `detail.billCount > 1` (single-bill documents keep matching exactly as today, via the existing document-inbox flow at `app/(app)/documents/page.tsx` — untouched). Reuse the existing vendor-autocomplete combobox pattern already in `review-workspace.tsx`/`extraction-form.tsx` for the search UX, querying `entries` instead of `vendor`.
- `runTallyChecks`'s `ocr_total_vs_amount` check (bill total vs. matched entry amount) reads `entry_id` off the per-bill row for multi-bill documents once set, same as it reads `source_document.entry_id` today for the single-bill case.

Existing single-bill matching code (`lib/matching.ts` candidate scorer, `components/documents/document-inbox.tsx`, `lib/actions/documents.ts`, `app/(app)/entries/[id]/page.tsx`'s linked-documents display, `lib/analytics/fetch.ts`) is **not touched** — it keeps reading `source_document.entry_id`, which stays authoritative for the single-bill case that's the overwhelming majority of real traffic.

### Phase 2 verification

1. `npx tsc --noEmit` and `npx vitest run test/unit` — must stay clean; extend `test/unit/extraction-schema.test.ts` for the new `bills[]` shape (sanitize/filter/tax-breakdown now operate per-bill).
2. One live `extractDocument` call against the new tool schema on a small existing single-bill document (e.g. `source_document` 3) to confirm the strict-schema union budget holds and single-bill behavior is unchanged (`bills.length === 1`, same field values as before).
3. Re-run extraction on `source_document` 6 (the 17-page batch) via manual re-escalation, and confirm: 8 `document_extraction` rows created, each with its own vendor/total, no `line_item_tally_mismatch` exceptions (or only genuine per-bill ones), review queue shows 8 separate entries with correct "Bill N of 8" badges, PageDown/PageUp move between them correctly.
4. Confirm a normal single-bill document (e.g. `source_document` 1 or 2) still round-trips through review/verify exactly as before — this is the regression check that matters most, since it's 99% of real traffic.

### Phase 2 blocker

The migration must be applied against Supabase. The Supabase connector is unauthorised in this session, so Phase 2 code cannot be verified end-to-end here. The migration file can be written; applying it needs an authorised session (claude.ai connector settings, or the `supabase` CLI directly).

**Ordering note:** Phase 2 supersedes I5's Phase 1 stopgap prompt wording and makes I13 disappear structurally. Phase 1 was deliberately shaped so nothing in it has to be undone — only that one prompt sentence gets rewritten.

---

## 4. Phase 3 — Deferred

- I16 Batch API (halves per-page cost; needs `batch-poll.ts` implemented, keyed by `custom_id`).
- I4 SDK upgrade off `0.32.1` and removal of the three casts — likely also resolves I9.
- I15 job-sweeper verification.
- I1 ingest page-count fallback.
- I14 page-count reconciliation warning.
- Re-evaluate Sonnet: with `bills[]` live and tally noise gone, measure whether Haiku's confidence scores still justify an escalation tier at all.
