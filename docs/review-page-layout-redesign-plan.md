# Review Page Layout Redesign — Plan

**Status:** Design decisions locked from a 2026-08-21 walkthrough of `/review`. **Nothing in this document is built yet** — this is the plan, not a change log. Companion artifact (visual mockups, four iterations from the raw current layout through the agreed final pass): [Review Page Redesign](https://claude.ai/code/artifact/c1ae9afa-e8c4-4232-b0e4-d58d84584098).

---

## Context

`/review` is the core reconciliation screen — the page a reviewer lives in all day, verifying OCR'd bills, connecting them to ledger entries, and classifying them by admin head and zone. A walkthrough surfaced that the page had grown cramped: eleven-plus unrelated pieces of information (actions, navigation, confidence, exception state, edited-field count) stacked in one wrapping toolbar row, three separate cards for the Verify/Connect/Classify stages that mostly just repeated what the reviewer already knows, a suggested-match card that showed a bare score with no reasoning, no link between which PDF page is on screen and which OCR fields it produced, and a footer of financial stats with no visible explanation of what they meant. Four design passes (v0 diagnosis → v1 → v2 → v3) worked through this with the user; this doc is the resulting build spec.

---

## 0. Status snapshot

| # | Item | Status | Size |
|---|---|---|---|
| 1 | Scope bill navigation to pending/unverified, with an explicit Unverified/All toggle | To build — needs a query check first, see §1 | Small–Medium |
| 2 | Merge bill nav, page nav, and sibling-bill nav into one navigation cluster; drop the standing flagged-field stepper | To build | Small |
| 3 | Actions bar: keep Save + Flag exception primary, move Re-extract/Hub status behind "More" | To build | Small |
| 4 | Collapse the Verify/Connect/Classify status cards into one line with inline controls | To build | Medium |
| 5 | Reorder the extraction-form panel: fields first, page/flag clarification demoted below | To build | Small |
| 6 | Page↔field OCR sync indicator (which page produced which field, flagged-field ring) | To build | Medium |
| 7 | Simplify the suggested-match UI to one line; relabel the fallback control | Built | Small |
| 8 | Footer: two labeled cards ("Bill math", "Compared to Entries") with plain-English captions | Built | Small |
| 9 | Add `invoice_number` as a scored matching factor (real gap found — see §9) | Built — weighted factor, not an exact-match short-circuit | Unknown |
| 10 | Vendor alias/correction memory to raise suggestion confidence over time | **Idea only, not spec'd** | Large |
| 11 | Budgeted-vs-actual variance reporting per department | **Explicitly out of scope for this page** — separate initiative | Unknown |
| 12 | GST recipient-compliance check (buyer GSTIN, buyer name, invoice number required when GST is charged) | To build — spec locked, see §12 | Medium |

---

## 1. Bill navigation — scoped to pending, not the whole document set

**Problem:** the original toolbar showed "Document 12 of 47," implying navigation across every document ever uploaded, reviewed or not. The user's actual mental model: `/review` is entered from Entries or Documents by clicking "Verify," and once inside, moving to the next bill should mean the next *unreviewed* one — not walk through already-verified history.

**Decision:** default the position counter and Prev/Next to the pending (unverified/not-yet-assigned) subset, with an explicit **Unverified / All** toggle so a reviewer can still browse everything when they want to.

**Before building:** check whether `v_review_queue` (`app/(app)/review/page.tsx`'s queue source) already filters to unreviewed-only or lists everything — the "All 47" toggle state may require a new query parameter or a second view, not just a UI relabel. Confirm this before scoping the work.

---

## 2. One navigation cluster instead of three separate places

**Problem:** bill/document navigation lived in the header toolbar; PDF page navigation lived at the bottom of the PDF pane; sibling-bill navigation (bills split out of one multi-bill PDF) lived in its own row below the stage progress. Three different physical locations for "which thing am I looking at."

**Decision:** one card, three adjacent groups — **Bill** (pending-scoped, per §1) · **Page** · **This PDF** (sibling bills, shown only when `billCount > 1`, unchanged condition from today's code) — separated by thin dividers, single row.

**Also decided:** the flagged-field prev/next stepper (today's `stepUncertainField` control, `review-workspace.tsx:883-907`) does **not** get a fourth slot here. Bill and page navigation apply to every bill; flagged fields don't (plenty of bills have none), so it shouldn't be permanent chrome. It moves to a small "N to check" indicator on the Verify segment of the status line (§4) instead.

---

## 3. Actions bar — primary vs. occasional, not five equal buttons

**Problem:** Save, Flag exception, Re-extract with Sonnet, and Hub status all rendered as equal-weight outline buttons. Re-extract and Hub status are deliberate, occasional overrides — the existing code comment on Re-extract (`review-workspace.tsx:836-838`) already says it's named the way it is specifically because Sonnet costs materially more than the default Haiku pass, i.e. it's meant to be a considered choice, not a habitual click.

**Decision:** Save stays primary and prominent. Flag exception stays visible (it's a real, regular action). Re-extract with Sonnet and Hub status move behind a **"More"** button. One extra click on the bill that actually needs them; two fewer buttons competing for attention on every ordinary one.

**Unchanged:** keyboard shortcuts (`Ctrl/Cmd+Enter` for Save, `E` for Flag exception, `Shift+R` for Re-extract, `S` for Hub status) keep working from wherever the actions live — moving Re-extract/Hub status into a menu doesn't remove their shortcuts.

---

## 4. One status line for Verify → Connect → Classify

**Problem:** `StageProgress` (`components/review/stage-progress.tsx`) rendered three small chips that only said "done / current / blocked" — the user's point: "the user knows these are the three steps," so a purely-decorative progress indicator wastes space without adding information. Meanwhile the actual controls for each stage (vendor check implicit in the form, entry attach in `MatchStrip`, admin head/zone selects in the Classify bar) lived in three separate places the reviewer had to hunt between.

**Also flagged as confusing:** showing an OCR-confidence percentage next to a "total mismatch" exception badge implied a relationship between the two that doesn't exist — confidence is the OCR model's certainty about what it read; the mismatch flag is an independent ledger-comparison exception (`open_exceptions`, `review-workspace.tsx:815-826`). Pairing them as equal-weight badges was misleading.

**Decision:** one card, one row, three segments separated by dividers — each carrying its step's real control, not just a status label:

- **Verify** — vendor name (from OCR) + a control to confirm it matches an existing vendor or add a new one, plus a small "N to check" chip (only rendered when `uncertainFields.length > 0`) that jumps to the first flagged field. Confidence % is **dropped** from this line entirely — uncertain fields already get a visual ring in the form itself (existing behavior, `pdf-viewer.tsx`/`extraction-form.tsx`), which is more actionable than a summary number.
- **Connect** — the top suggested entry (§7) with Attach / Search-or-pick-another inline.
- **Classify** — admin head + zone selects, inline, **only rendered once Connect is done** (`stage2Done`, `review-workspace.tsx:799`); before that, a single line of placeholder text ("unlocks once this bill is connected, above") instead of two grayed-out selects. Nothing renders that the reviewer can't act on yet.

The document-level exception flag (e.g. "total doesn't match Entries," from `open_exceptions`) moves to the page title row, standing alone — no longer paired with a confidence badge.

---

## 5. Form panel — the reviewer's actual work goes first

**Problem:** in an earlier design pass, a page/flag clarification banner sat above the extraction-form fields, pushing down the thing the reviewer is actually there to do (confirm/correct field values).

**Decision:** fields render first. The clarification — which page produced which field, and whether the page on screen has anything flagged — becomes a single quiet line at the *bottom* of the panel, not a banner blocking the top.

---

## 6. Page ↔ field sync (real behavior gap, not just a display choice)

**Problem, confirmed in code:** `PdfViewer` (`components/review/pdf-viewer.tsx`) owns `pageNumber` state independently of `ExtractionForm`. The form always renders every field for the whole document regardless of which PDF page is on screen — there is no indicator of which page a given field came from, and no signal when the current page has nothing flagged on it. The only existing link is one-directional: focusing a flagged field calls `onJumpToPage` (`review-workspace.tsx:1016-1024`) to move the *viewer* to that field's page; the reverse (viewer page → relevant fields) doesn't exist.

**Decision:** label each field with the page it came from (e.g. "Vendor name · page 1"); visually ring flagged fields as today; add the quiet clarification line from §5 stating whether the page currently on screen has a flagged field and which one. This is a real frontend change to `extraction-form.tsx` / `pdf-viewer.tsx`, not only a restyle — implement alongside the layout work, not as a follow-up.

---

## 7. Suggested match — simplified, and its fallback relabeled

**Problem:** the match-strip evidence card (vendor/amount/date breakdown as three separate lines) duplicated information already visible elsewhere on the page (amount is in the footer, vendor is in the form) and added a card the user didn't find worth the space. Separately, "Not this?" as a label implied dismissal, when what it actually needs to do is open both the other ranked candidates *and* a manual search.

**Decision:** one line — suggested entry's identifying number + a plain **Attach** + **"Search or pick another"** (search icon), which expands into: the other ranked candidates from `rankCandidates` (today's top-3, ≥35% score, `lib/matching.ts`), and the manual search box already wired to `searchEntriesForAttach` (`lib/actions/documents.ts:376-412`), which searches UBBL number, Main number, vendor, and invoice number by substring — unchanged, just clearer labeling on the entry point.

**How the automatic suggestion is actually computed** (for reference, not changing except per §9): every non-void, not-yet-matched entry is scored against this bill's OCR'd vendor name (50% weight, bigram-similarity), total amount (30%, proximity), and invoice date (20%, proximity) — `lib/matching.ts:65-67, 132-145`. The UBBL number shown is the winning entry's own identifier, not something matched against the bill.

---

## 8. Footer — two labeled comparisons, not four unexplained numbers

**Problem:** "Line items," "Document total," and "Entry (tenant)" read as three unrelated stats in a row. The explanation (already written, reasonably, as `ENTRY_TOOLTIP`/`VARIANCE_TOOLTIP`/`TOLERANCE_TOOLTIP`/`LINE_ITEMS_TOOLTIP` in `tally-footer.tsx:21-31`) only existed behind a hover-only info icon most reviewers never click.

**Decision:** two cards, each with a section label and a permanent one-line caption instead of a hover-only tooltip:

- **Bill math** — line-item sum vs. document total, captioned "both numbers come from this bill's own pages — not a summary or cover page" (answers a direct question raised during design: neither number is pulled from a separate cover sheet; on a multi-bill PDF, each bill is its own extraction scoped to its own pages).
- **Compared to Entries** — this bill's confirmed total vs. what the department already typed into Entries before review, captioned in plain language, replacing the ambiguous "Entry (tenant)" wording. Variance and the tolerance verdict (tighter of flat ₹1 or 0.05% of the larger amount, `tallyWithinTolerance`, `lib/normalize.ts:162-167`) unchanged.

---

## 9. Real gap found: `invoice_number` exists on both sides, unused by auto-matching

Not part of the layout work, but surfaced while explaining §7 and worth recording before it's lost:

- `document_extraction.invoice_number` is OCR'd from the bill (`lib/extraction-schema.ts:238, 308, 446`).
- `entries.invoice_number` exists on the ledger side too, and is already searched manually (`lib/actions/documents.ts:391`).
- **Neither is used by the automatic scorer.** `MatchableDocument` and `MatchableEntry` (`lib/matching.ts:27-53`) only carry vendor name, amount, and date — invoice number never enters `scoreEntry`.

An invoice number, when legible, is usually a far sharper signal than fuzzy vendor+amount+date proximity. **Not implementation-ready yet** — before committing a weight (or an exact-match short-circuit), check how often `invoice_number` is actually populated and legible across real extractions; if it's frequently blank or garbled, a naive weight could hurt more than help.

**Data check, done (2026-08-21):** queried production directly (only 11 `document_extraction` rows and 14 `entries` rows exist so far, so this is a small sample, not a mature read). `invoice_number_ocr` populated on 11/11 document extractions; `entries.invoice_number` populated on 11/14. No reliable way to judge legibility/accuracy from population alone (short values like "120" aren't evidence of an OCR misread — invoice numbering conventions vary), so population was the only thing actually checked. Decision (user, given the population numbers): build it now as a weighted factor, not an exact-match short-circuit.

**Built:** `invoiceNumberMatch` in `lib/matching.ts` — binary (1/0) after normalizing case/punctuation/whitespace, since a partial overlap between two invoice numbers isn't a meaningful signal the way partial vendor-name similarity is. Weights rebalanced to sum to 1: vendor 0.4, amount 0.2, date 0.15, invoice number 0.25. Missing on either side scores 0 for that dimension only, same convention as every other field — never penalizes or throws. Wired into both `rankCandidates` call sites (`lib/actions/documents.ts`'s `getInboxMatchCandidates`, and `app/(app)/review/page.tsx`'s per-bill suggested-match query), preferring `_verified` over `_ocr` on the document side. Not surfaced in the UI (`MatchCandidate`/`CandidateEntryView` unchanged) — per §7, the invoice number isn't shown in the simplified match-strip line, only used as a scoring input.

---

## 10. Idea, not spec'd: vendor alias / correction memory

Raised as the bigger lever once the layout itself was judged close to a ceiling: if a vendor's OCR'd name consistently differs slightly from how it's entered in Entries, that same near-miss repeats on every one of that vendor's bills with no memory. A per-vendor alias/correction table (learn the mapping once, reuse it on every future match) would raise suggestion confidence over time and cut how often a reviewer needs to manually search — a bigger win than anything left to trim on the page itself, but unscoped. Follow up separately if the user wants it designed.

---

## 11. Out of scope: budget vs. actuals

The user flagged a future need — extracting or importing department budgets, comparing to actuals, flagging overspend — as a separate initiative to discuss later. No design or build work has been done on it here; noted only so it isn't lost.

---

## 12. GST recipient-compliance check

**Real-world requirement, confirmed with the user:** under GST rules, a valid tax invoice a registered recipient can claim input tax credit against must show the recipient's name, GSTIN, and the invoice number — not just the seller's details. When a bill has GST charged on it, three things must be present on the bill itself:

1. The community's own GSTIN (`COMMUNITY_GSTIN`), printed as the *recipient's* GSTIN.
2. The community's name — written as "Dawat e Hadiyah" or any close variant of it.
3. The invoice number.

If GST is **not** charged on a bill, none of this applies — the check (and its UI) should not appear at all.

**Current state, precisely (checked against the code, not assumed):**

- **GST amount** — captured. `cgst_amount`, `sgst_amount`, `igst_amount`, and combined `tax_amount` are all extracted per bill.
- **GST percentage/rate** — deliberately *not* captured. `buildTaxBreakdown` (`lib/extraction-schema.ts:769-779`) always writes `rate: null`; the code comment explains this was a scope cut to stay under the extraction tool's ~16 field-count limit, since nothing downstream reads rate today. Out of scope for this item; flagged here only so it isn't confused with a bug.
- **The community's GSTIN on the bill** — actively *discarded* today, not stored anywhere. `isOwnOrgGstin` (`lib/jobs/handlers/extract.ts:295-319`) exists for the opposite reason: if the model reads the community's GSTIN into the `vendor_gstin` field (meant for the *seller*), that's treated as an OCR mix-up, the field is blanked, and a low-severity `vendor_gstin_is_own_org` exception is raised. Correct behavior for keeping `vendor_gstin` clean, but it means there is currently no field that would hold "the recipient's GSTIN, as printed."
- **The community's name on the bill** — not captured at all. The schema only extracts the *vendor's* identity block (name, GSTIN, phone, email, address); there is no "billed to" / recipient block.
- **Invoice number** — already captured (`invoice_number_ocr`). No new extraction needed, only a presence check.
- **Tax-invoice vs. not** — `instrument_type_ocr` already distinguishes `tax_invoice` from `bill_of_supply`/`retail_cash_memo`/etc., specifically so a compliance detector can tell "unregistered vendor, no GST, that's fine" from "tax invoice missing something it needs" (`lib/extraction-schema.ts:113-117`). This already exists for exactly this purpose; it has just never been wired to a recipient-details check.

**Build spec, locked:**

- **New extraction fields:** `buyer_gstin_ocr` / `buyer_name_ocr` on `document_extraction` (plus `_verified` twins, matching the existing convention for every other reviewer-correctable field). Wire-schema and system-prompt changes so the model reads the recipient/"billed to" block on the invoice separately from the vendor/seller block it already reads. Check the resulting field count against the tool schema's union-type budget before finalizing (the same constraint that ruled out per-component tax rates, §12 above).
- **New env var:** a community-name counterpart to `COMMUNITY_GSTIN` (e.g. `COMMUNITY_NAME`), holding the canonical name; matching is fuzzy (reuse the existing bigram/normalize approach from `normalizeVendorName` / `vendorSimilarity` in `lib/matching.ts` rather than exact string equality), so "Dawat e Hadiyah," "Dawat-e-Hadiyah Trust," and similar variants all pass. Both `COMMUNITY_GSTIN` and `COMMUNITY_NAME` are fixed constants — the recipient is always the same organization, so neither varies per bill. Only the invoice number is genuinely bill-specific; its check is presence-only, not a match against a known value.
- **Feed the known values to the model, don't just compare after the fact.** `buildSystemPrompt(communityGstin)` (`lib/claude-client.ts`) already passes the real `COMMUNITY_GSTIN` into the prompt today, for the existing exclusion check — extend this so `COMMUNITY_NAME` rides along too, and have the prompt ask the model to specifically check whether *that* GSTIN/name appears in the recipient block, not just free-read whatever's there with no prior. Confirming a known target is more reliable than blind small-print OCR. Still write what was actually read into `buyer_gstin_ocr`/`buyer_name_ocr` (not just a boolean) so a reviewer can see and correct it, consistent with every other OCR'd field — the hint improves the read, it doesn't replace storing it.
- **Trigger condition:** the check only runs when GST is actually charged — any of `cgst_amount`/`sgst_amount`/`igst_amount`/`tax_amount` present and non-zero, **or** `instrument_type_ocr === 'tax_invoice'`. When neither is true, the check does not run and nothing about it appears anywhere in the UI — not shown, not hidden-but-present, genuinely absent.
- **Check logic:** when triggered, all three of (buyer GSTIN present and matches `COMMUNITY_GSTIN`), (buyer name present and fuzzy-matches `COMMUNITY_NAME`), (invoice number present) are required. Any one missing raises an exception — mirroring the existing `vendor_gstin_is_own_org` / `vendor_gstin_invalid_checksum` pattern in `lib/jobs/handlers/extract.ts`, including a new exception type (needs a migration extending `reconciliation_exception_exception_type_check`, same as `20260820000002_gstin_checksum_and_page_failure_exceptions.sql` did for the checksum check) and a dedup key scoped per bill/run.
- **On `/review`:** the compliance check surfaces as a conditionally-rendered section — present only on a bill where the trigger condition is true, entirely absent (not collapsed, not disabled — genuinely not in the DOM) otherwise. Natural fit is alongside the existing exception flag in the page-title row (§4), or as a fourth line item if it needs more room than a single chip; exact placement to be mocked once the field/exception plumbing exists.

**Not yet decided:** exception severity (the existing GSTIN checks use `low`; missing recipient details on what's meant to be an ITC-eligible tax invoice arguably deserves `high`, since it can mean the community can't actually claim the credit) — confirm with the user before implementing. Also open: whether all three missing items raise one combined exception or three separate ones (separate matches the existing one-exception-per-distinct-problem pattern, but three near-identical exceptions on one bill may be noisier than useful).

**Model capability (confirmed):** Haiku can do the reading half of this — extracting `buyer_gstin`/`buyer_name` off a "Bill To"/recipient block is the same category of task it already does for vendor identity and invoice number, no Sonnet needed, consistent with the standing OCR-stays-Haiku-only rule. The compliance *decision* must stay deterministic code, not a model judgment call — mirroring `isOwnOrgGstin`/`validateGstin` exactly: the model only writes what it read (or blank), code compares it against `COMMUNITY_GSTIN` / fuzzy-matches `COMMUNITY_NAME` / checks `invoice_number_ocr` presence, and raises the exception. Two real accuracy caveats to design for: (1) recipient blocks print smaller/less reliably than the vendor letterhead (sometimes stamped, handwritten, or genuinely absent) — run `buyer_gstin_ocr` through the existing `validateGstin()` checksum check before trusting it, same backstop already used for `vendor_gstin`; (2) block-confusion risk is symmetric to the existing `isOwnOrgGstin` case — the prompt must clearly distinguish "Seller/Vendor" vs. "Bill To/Recipient" sections, since Haiku could copy the seller's GSTIN into `buyer_gstin` just as it sometimes copies the recipient's into `vendor_gstin` today. No new API call — rides the same one extraction call per bill, two more output fields, no added per-document cost.
