# Hub Refinements — Plan

**Status:** Decisions locked from a 2026-08-17 review of the live app. **Nothing in this document is built yet** — this is the plan, not a change log. Two items are not implementation-ready (flagged in Outstanding). Companion artifact (stakeholder-facing walkthrough of the same ground): "Hub Walkthrough."

---

## Context

A walkthrough of the whole Hub — login to export — surfaced nine areas worth changing or clarifying, cross-checked against the live codebase rather than `MASTER-PLAN.md` alone (which has drifted on some points, e.g. Hub status: the live code keeps it as a genuinely separate `hub_status` field, not folded into `entries.status_id` as one point in the plan's history suggested). Two real bugs were also diagnosed from live evidence during this review (a mis-linked document, and a leaked-syntax OCR artifact) — see §3 and §6.

---

## 0. Status snapshot

| # | Item | Status | Size |
|---|---|---|---|
| 1 | Group Entries filters into 4 labelled sections | To build | Small |
| 2 | Add click-to-sort on Entries table columns | To build | Small |
| 3 | Status-count summary as Dashboard tiles | To build | Small |
| 4 | Auto-retry unmatched Audit-portal rows on later imports | To build | Small–Medium |
| 5 | Sanitize leaked tool-call syntax from OCR text fields | To build | Small |
| 6 | Bulk zone/admin-head assignment (in addition to single) | To build | Small–Medium |
| 7 | Batch manifest: parse, auto-split, tally, near-exact linking | **Not implementation-ready** — needs more design | Large |
| 8 | Own-GST-ID exclusion in OCR | **Already built** (2026-08-14) — needs re-test | — |
| 9 | OCR keyboard shortcuts | Staying as-is, no change | — |
| 10 | OCR correction/tuning cadence | User-driven, no fixed schedule — no build item | — |
| 11 | Reports special formatting | **Still open — no spec** | Unknown |

---

## 1. Entries filters — reorganize, not remove

**Current state:** `components/entries/filter-bar.tsx` renders 13 filter controls (Department, Budget head, Admin head, Zone, Cost center, Status, Audit status, Hub status, Vendor, Date from/to, Export-pending, Missing Main #, Has document) in one flat grid. `components/entries/entries-table.tsx` has no sort affordance at all — `query.ts:75` hard-codes `.order('id', { ascending: false })`, unconditionally.

**Decision:** asked which filter groups get used regularly; the answer was all four. So the fix is not removing filters, it's organizing them.

**Build:**
- Split the filter bar into four visually distinct, labelled groups:
  - **Status** — Status, Audit status, Hub status
  - **Classification** — Department, Budget head, Admin head, Zone, Cost center
  - **Search** — Vendor, Date from/to
  - **Flags** — Export-pending, Missing Main #, Has document
- Add click-to-sort on table column headers (amount, date, vendor, status at minimum), replacing the hard-coded `id desc` order (or making it the default rather than the only option).

---

## 2. Hub status — clarified, no build item

An entry carries three independent status fields, not one:
- **Status** / **Audit status** — read-only facts copied in from Departmental/Audit on import.
- **Hub status** — the only status field this app writes. Holds only `Awaiting Verification` or `Awaiting Validation`, set by a reviewer, and is the *only* thing ever exported back out (§export screen). Without it the Hub has no way to record a review decision at all.

No code change from this — documented for the filter-grouping work above and for onboarding.

---

## 3. OCR review

### 3a. Own-GST-ID exclusion — already built

Shipped 2026-08-14. `COMMUNITY_GSTIN` env var (`lib/env.server.ts`) feeds two layers: a system-prompt instruction (`lib/claude-client.ts`, `buildSystemPrompt`) telling the model to extract the vendor's GSTIN only, and a deterministic backstop (`isSameGstin`, `lib/analytics/gstin.ts`) that nulls `vendor_gstin_ocr` and raises a low-severity `vendor_gstin_is_own_org` exception when a match is found, rather than showing the wrong ID.

**Limit:** excludes exactly one GST ID. If more than one of the org's own entities could appear as a buyer, this needs to become a list.

**Action, not build:** re-test on a bill with no visible GST ID; report back what the field shows.

### 3b. Leaked tool-call syntax in OCR fields — diagnosed, fix scoped

**Real example observed:** a GSTIN field showed `</antml.parameter><parameter name="vendor_phone">+91 9925755` — Claude's own internal tool-call formatting, leaked into the field's text content. Not HTML, nothing renders as markup (no `dangerouslySetInnerHTML` anywhere in review — confirmed by full-repo search).

**Mechanism:** `lib/extraction-schema.ts` defines `vendor_phone` immediately after `vendor_gstin` in the tool schema. `strict: true` tool calling (`lib/claude-client.ts`) guarantees the JSON *structure* is valid but does not constrain what text the model puts *inside* a string field — so a momentary hallucination of the model's own formatting can end up as literal field content.

**Build (two layers, same pattern as 3a):**
1. Prompt instruction: tell the model to never emit tag-like syntax (`<...>`, `</...>`) in any field value.
2. Code-level backstop: after parsing the tool response, scan every extracted text field for tag-shaped content (e.g. `/<\/?[\w:.]+[^>]*>/`); if found, blank the field and raise a low-severity exception flagging it for manual entry — mirroring the `vendor_gstin_is_own_org` pattern in `lib/jobs/handlers/extract.ts`.

### 3c. OCR correction / "does it learn" — no build item, documented honestly

No automatic learning exists or is planned. The loop is: corrections accumulate (`_ocr`/`_verified` twin columns, never overwritten) → `/accuracy` surfaces per-field agreement rate and correction patterns → a human manually edits the AI's instructions → re-tested against the 21-invoice gold set (`npm run score`) → deployed. User will drive this personally, reactively, with no fixed cadence.

### 3d. Keyboard shortcuts — staying as-is

Current set (Review screen only: Enter, Ctrl/Cmd-Enter, PageUp/PageDown, arrow keys, E, R, 1–9, /, S, ?) is not changing. Revisit later if it becomes worth the churn.

### 3e. OCR classification token cost — documented, no build item

Classification and extraction happen in **one call**, not two. Every page's image is sent as input (Claude must look at a page to know it's not a bill), and every page gets a small amount of output tokens for its classification fields (`is_financial_document`, `skip_reason`, `classification_confidence`); full line-item extraction only happens — and is hard-filtered in code regardless — for pages classified financial. No separate "should I OCR this" call exists or is needed.

---

## 4. Import matching — Departmental + Audit portal

**Current state, confirmed against `lib/import/run-import.ts`, `lib/import/run-portal-import.ts`, `test/unit/portal-linkage.test.ts`:** there is only ever one `entries` row per UBBL number. The Departmental `.xlsx` import creates it and writes `main_number`. The Audit-portal scrape (bookmarklet) never creates a second row — it looks up the existing row by `main_number` (the Audit portal's own "Entry Number," verbatim) and updates only the audit-side fields on that same row. No "year" is involved in matching. Order matters: Departmental import must run before the Audit scrape, every time, or Audit rows have nothing to match yet.

**Current gap:** an Audit row that finds no match today is parked as a permanent "unmatched" exception (`audit_row_unmatched`), requiring manual resolution.

**Decision:** change this — an unmatched Audit row should keep retrying automatically on every later Departmental import, until it finds its `main_number` and links up on its own, instead of sitting as a one-time exception.

**Build:** on each Departmental import, re-attempt matching for any Audit-sourced rows still marked unmatched, before (or instead of) raising a fresh exception.

---

## 5. Bulk zone/admin-head assignment

**Current state:** `components/entries/detail/enrichment-form.tsx` sets zone/admin head/cost center one entry at a time, on the entry detail page. No bulk tool exists anywhere in the codebase (confirmed — no `bulkEnrich`/"bulk zone"/"bulk head" hits).

**Decision:** build bulk assignment **in addition to** single-entry assignment — both need to remain available, not a replacement.

**Build:** a bulk-assign action on the Entries list (select multiple rows → set zone/admin head for all of them in one action), following the same UI pattern as the existing `bulk-status-dialog.tsx`.

---

## 6. Bill → entry linking

**Current state:** `lib/matching.ts` scores every unattached entry against a document's OCR'd vendor name (50% weight, bigram-Dice fuzzy match), amount (30%, degrades past 25% difference), and date (20%, degrades past 21 days) — searched across the *entire* ledger, not scoped to department. A human always confirms; nothing auto-attaches.

**Live evidence this needs improvement:** a bill from vendor "Jay Prakash Sahani" was found attached to an entry whose amount (₹7,42,118) exactly matches a *different* vendor's (Al Nafees Tech) invoice from the same sample batch — a real mis-match produced by the current fuzzy search.

**Decisions:**
- Narrow candidate search to the bill's department before scoring (once a batch/department context is known — see §7).
- Once §7 (batch manifest) exists, prefer **exact invoice-number matching** off the manifest as the primary signal, falling back to today's fuzzy vendor+amount+date scoring only when the manifest has no usable invoice number (a real case in the sample file: the AVS Decor row's invoice number is "NA").

---

## 7. Batch manifest — auto-split, tally, near-exact linking

**Not implementation-ready.** This is a real, larger feature, grounded in an actual file (`Invoices/1448_Invoice_1_05.08.2026.pdf`), not yet fully specced.

**What's confirmed:** a daily invoice batch's first page is a "Batch Print Summary" — a manifest table (Sr No, Budget Head, Vendor, Description, Invoice No, Date, Amount) for every bill in the batch, with a grand TOTAL and an HOD signature. The bills follow as scans; a vendor's supporting ID/cheque documents appear once per vendor (after their first bill in the batch), not once per bill. A separate per-department summary page is not guaranteed even when a batch spans multiple departments.

**What's designed but needs more detail before building:**
1. **Parse the manifest** as a structured row list + stated total — a new extraction shape, distinct from single-bill extraction (needs its own tool schema / prompt).
2. **Auto-split the rest of the PDF** into per-bill groups, using the manifest's row count plus the existing financial/non-financial page classification to find bill boundaries and fold in trailing support-doc pages. *Open question: exact algorithm for grouping — how does the system know a PAN card page belongs to the bill before it rather than after, especially across a vendor's multiple consecutive bills?*
3. **Tally:** sum of OCR'd bill totals vs. the manifest's stated TOTAL — same pattern as the existing line-items-vs-document-total check, one level up. *Open question: what happens when the split-out bill count doesn't match the manifest's row count — new exception type needed?*
4. **Linking:** match each split-out bill to its ledger entry by exact invoice number, scoped to the manifest's department (see §6), falling back to fuzzy matching when the manifest's invoice number is blank.

**Before this can be scoped for implementation:** needs a design pass on the splitting algorithm specifically, and confirmation of exception-handling behavior for manifest/bill-count mismatches.

---

## Outstanding

1. **Reports special formatting** — flagged in an earlier session, no spec defined yet. Raise with specifics when ready.
2. **Batch manifest (§7)** — needs a further design pass before it's buildable; not just a queued task like the others.
3. **`COMMUNITY_GSTIN` as a list** — raised as a limitation (§3a) but not decided; only relevant if more than one of the org's own GST IDs could appear on a bill as the buyer.
