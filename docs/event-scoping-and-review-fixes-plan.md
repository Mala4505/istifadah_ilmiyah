# Event Scoping + `/review` Fixes — Plan

**Status:** Decisions locked from a 2026-08-22 walkthrough. Phase 0 (schema drift) and Phase 1 (§2.2/§2.3/§2.4/§2.10/§2.11) are done. Everything else is spec'd, not built.

Companion to [`review-page-layout-redesign-plan.md`](./review-page-layout-redesign-plan.md), which this supersedes for the items it touches (that doc's §4 status line, §10 vendor alias).

---

## 0. Schema drift — found and fixed (2026-08-22)

The repo carried four migrations that had never been applied to the live database. Max applied version was `20260821000005`; the repo had four newer files.

| Migration | Was missing |
|---|---|
| `20260821000006_review_queue_all_view` | `v_review_queue_all` |
| `20260821000007_gst_recipient_compliance` | `buyer_gstin_ocr/_verified`, `buyer_name_ocr/_verified`, `gst_recipient_compliance_missing` exception type |
| `20260822000001_department_budget_allocation` | `department_budget_allocation` table |
| `20260822000002_department_budget_vs_actual_view` | `v_department_budget_vs_actual` |

**Blast radius, before the fix.** `loadDocumentDetail` (`app/(app)/review/page.tsx`) selects `buyer_gstin_ocr` and its three siblings. Those columns did not exist, so the query errored, `extraction` came back null, and the function returned null — dropping the page into its `redirect()` fallback. `/review` did not work at all. `lib/jobs/handlers/extract.ts` also writes `buyer_gstin_ocr` in its unconditional upsert payload, so every new extraction would have failed on write.

**Why nothing caught it.** `tsc --noEmit` passes because Supabase column names are untyped string literals inside `.select()`/`.upsert()`. ESLint passes. All 22 `gst-recipient-compliance` unit tests pass, because the compliance decision function is pure and never touches the database. Static checks and pure-function tests validate code against a schema they never consult.

**Fixed:** `supabase db push --include-all`, all four applied cleanly, verified by re-running the exact query that had been failing.

**Standing rule going forward:** before triaging any bug on a schema-touching screen, diff `supabase_migrations.schema_migrations` against the migration filenames in the repo. One query. An unapplied migration is a single upstream cause that fans out into many unrelated-looking symptoms.

---

## 1. Event scoping — the multi-year architecture

**The requirement.** The system runs one event per Hijri year. This year is **Istifadah Ilmiyah 1448 H**; next is 1449 H. Every piece of data must belong to its event year. Switching to a new year presents a clean slate; previous years stay in the same database, browsable read-only, and comparable in reports.

**Current state:** nothing. No event table, no year column, no such concept anywhere across 35 tables.

### 1.1 The central decision: master identity is shared, membership is per-event

Departments, admin heads and zones partly recur year to year and partly do not. Two ways to model that, and only one survives contact with reporting:

- **Copy rows per event** — `DIESEL` in 1448 H and `DIESEL` in 1449 H become two unrelated ids. Every year-over-year comparison then needs name matching to discover they are the same thing. This is the fuzzy-matching trap `vendor`/`vendor_alias` already exists to avoid. Rejected.
- **Shared master + per-event membership** — one row per real department/head/zone, forever, plus a join table saying which are active in a given event. Adopted.

Under the adopted model the dropdowns in 1449 H show only 1449 H's heads and zones (the clean slate), while `group by admin_head_id` across events is a plain aggregate with no matching logic.

### 1.2 Table treatment

**New: `event`**

```sql
create table public.event (
  id           bigserial primary key,
  name         text not null,                    -- 'Istifadah Ilmiyah 1448 H'
  hijri_year   text not null unique,             -- '1448'
  starts_on    date,
  ends_on      date,
  is_current   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index event_one_current on public.event (is_current) where is_current;
```

**Gets `event_id not null references event(id)`** — the transactional core:

`entries` · `source_document` · `import_batch` · `status_export_batch` · `budget_allocation` · `department_budget_allocation`

**Inherits event via its parent, no column of its own:**

`document_extraction` · `document_extraction_line_item` · `document_page` · `ocr_extraction_run` · `reconciliation_exception` · `entry_change_log` · `import_row_log` · `status_export_row`

Each is reachable through `source_document_id` / `entry_id` / `import_batch_id`. One exception worth weighing: denormalising `event_id` onto `document_extraction` would let `v_review_queue` filter without an extra join. Decide that when the view is rewritten; do not denormalise speculatively.

**New membership join tables** — master rows stay global:

```sql
create table public.event_department (
  event_id      bigint not null references public.event(id) on delete cascade,
  department_id bigint not null references public.department(id),
  primary key (event_id, department_id)
);
-- same shape for event_admin_head, event_zone, event_budget_head
```

**Shared across all events, never scoped:**

`vendor` · `vendor_alias` · `item_catalog` · `item_family` · `item_alias` · `rate_reference` · `staff_profile` · `hub_status` · `entry_status` · `flags` · `budget_head_master` · `budget_head_category`

`rate_reference` is deliberately shared and load-bearing: last year's observed rates are exactly the benchmark this year's bills need. Same argument for `vendor_alias` — a spelling learned in 1448 H should still resolve in 1449 H.

### 1.3 Selecting the active event

A cookie, following the precedent already set by `review_queue_scope` (`app/(app)/review/page.tsx`) — read server-side, defaulting to `event.is_current`. A switcher in the app-shell header.

**Event scoping is a visibility concern, not a security concern.** RLS already answers "who may see this row" by role and department, and that stays exactly as it is. Event filtering happens in application queries and views. Pushing event scope into RLS would mean threading a per-request setting through PostgREST for no security benefit.

### 1.4 Backfill

Insert `1448 H` as event 1, set `event_id = 1` on every existing row in the scoped tables, populate the membership tables from the current `department`/`admin_head`/`zone` contents, then add `not null`. At current volumes (14 entries, 11 extractions, 5 documents) this is instant and reversible.

### 1.5 Creating the next event

An admin screen: name the event, set its dates, then a carry-forward step with every department, admin head and zone from the previous event pre-ticked. Untick what is gone, add what is new. Budgets are never carried forward — they are imported fresh per event.

### 1.6 Cross-year access

Previous events stay browsable read-only: switching to a past event puts the app in a view-only state — no new uploads, no verification, no export. Reports gain a year-over-year comparison mode built on the shared master ids from §1.1.

---

## 2. `/review` punch list

Twelve items raised 2026-08-22. Every diagnosis below comes from reading the code and querying the database, not from assumption.

### 2.1 — Configurable keyboard shortcuts

**Confirmed, and broader than reported.** `review-workspace.tsx`'s global handler binds bare `E`, `S`, `Z`, `H`, `/`, `\`, `1`–`9`, plus `Shift+R`. Its guard only skips when focus sits inside an `input`/`textarea`/`select`/combobox — so clicking a label, a button, or empty space leaves focus on `<body>`, and the next letter typed fires a command. This is the reported "I try to edit a field and it re-extracts."

**Build:** a Settings screen (none exists anywhere in the app), a per-user keymap persisted to `staff_profile`, modifier-combination capture (`Alt+S`, `Alt+Shift+V`), and a master enable/disable. Defaults move off bare letters onto modifier combinations. The focus guard is inverted — bail out unless focus is on a known-safe target, rather than bailing only on known-editable ones.

**Built 2026-08-22 (Phase 3), via two parallel subagents against a shared contract.** New: migration `20260822000003_staff_keymap_preferences` (adds `staff_profile.keymap_overrides`/`shortcuts_enabled`, self-writable under the existing RLS update policy — no new policy needed); `lib/shortcuts/config.ts` (the 14-action definition table, `resolveKeymap`, `matchesBinding`/`matchLineDigit`, `formatBinding`, and the new allowlist `isSafeShortcutTarget`); `lib/shortcuts/load.ts`; `/settings` page + `components/settings/keymap-settings.tsx` (capture UI, master toggle, per-row and reset-all, batched save) + `lib/actions/settings.ts` (`saveKeymapPreferences`, server-side re-validated); a `Settings` nav-rail entry. `review-workspace.tsx`'s handler now looks up bindings from a per-user keymap instead of hardcoded letters, and its focus guard is inverted per the plan. Defaults moved to `Alt+`-prefixed combinations; both client and server reject any rebinding with no modifier, so the original bare-letter bug can't be reintroduced through the settings screen itself. `typecheck`/`lint`/`test` (370/370) clean. Migration pushed to the live database and confirmed applied via `supabase migration list`. **Not yet done:** live-browser verification — pending, same caveat as §2.7-§2.9.

### 2.2 — Navigation cluster spacing

**Confirmed.** One `flex flex-wrap gap-2` row, so every group packs left. Three groups distributed with `justify-between`.

### 2.3 — Bills vs pages

**The reported reading is correct, and the labels are wrong.** `v_review_queue` yields one row per `document_extraction` — one row per **bill**. "Document 12 of 47" already means "Bill 12 of 47". Pages are PDF pages of the uploaded file, skipped ones included. One PDF holds one or more bills; one bill spans one or more pages. Both counts are real and both belong.

**Build:** relabel Document → Bill throughout, and reorder the cluster to actions · **Bill** (centre) · **Pages** (right), per §2.2.

### 2.4 — The three steps, and the vendor/OCR collision

**The vendor problem is a behaviour bug, not a display one.** `handleVendorSelect` (`review-workspace.tsx`) overwrites `header.vendorName` with the master vendor's spelling. Selecting a vendor silently rewrites what OCR read — the reported "the vendor changes the OCR engine."

The learning half of the fix already exists and works: `learnVendorAliasesFromAttach` (`lib/actions/review.ts`) records OCR spellings as `vendor_alias` rows on attach, and `lib/matching.ts` scores against them.

**Build:** stop the overwrite — OCR text stays as read. Selecting a vendor sets the link (`vendorId`) only, and surfaces a confirm-merge prompt: *"Record 'ASHAPURA AIRCON & DECOR' as another spelling of Ashapura Aircon and Decor?"* Accepting writes the alias; the OCR field is left untouched either way.

**Steps redesign:** collapse to a compact three-segment progress line. Step 2 currently carries the whole `MatchStrip` — matched summary, candidate list, search, variance, and "No entry expected" — inline. Move everything past the top suggestion behind the existing expand control.

### 2.5 — Manual page skip / unskip

**Confirmed gap.** `document_page.skip_reason` is written only by the extraction pass. The PDF pane renders it; nothing can change it, and no page can be sent back for OCR individually.

**Build:** per-page controls in the thumbnail rail — skip a page the model kept, or OCR a page the model skipped. The second half depends on §2.6's page-scoped re-extraction.

**Built 2026-08-22 (Phase 4), via two parallel subagents against a shared contract built first.** New: migration `20260822000004_page_scoped_reextraction.sql` (adds `document_page.skip_source`/`manually_set_by`/`manually_set_at`, and widens `skip_reason`'s check constraint with a `'manual'` value — built from the *live* constraint, not the original `CREATE TABLE`, after a `db push` dry-run caught that a naive rebuild would have silently dropped three values a later migration had already added); `setPageSkipOverride` (`lib/actions/review.ts`) for the toggle, RLS-gated by the existing `document_page_update` policy. UI: skip/unskip + "OCR this page" icon buttons in the PDF pane's thumbnail rail (`components/review/pdf-viewer.tsx`), refreshing on success. Pushed to the live database and typechecked/linted/tested clean (370/370).

### 2.6 — Field- and page-scoped re-OCR

**Confirmed gap.** The only re-OCR path is "Re-extract with Sonnet," which rebuilds the whole document and discards unsaved corrections.

**Build:** re-extract one flagged field, or one page, writing back only that scope. Stays on Haiku — the scoping is what makes it cheap, not the model. Unsaved corrections to other fields survive, because nothing outside the requested scope is written.

**Built 2026-08-22 (Phase 4).** `lib/jobs/handlers/rescope-extract.ts`: `reExtractPageScoped` (re-OCRs exactly one page — discovers a new bill on a previously-skipped page, or fully re-reads an existing single-page bill; rejects a page belonging to an existing multi-page bill, directing the reviewer to the whole-document re-extract instead, since a partial re-read would lose the header context the original multi-page merge restored) and `reExtractFieldScoped` (re-reads a bill's own page range but writes back only ONE named header field's `_ocr` column — applying the same vendor-GSTIN own-org/checksum guards `persistExtractionPipelineResult` applies — and deliberately never touches `current_extraction_run_id`, so it can't trigger the workspace's run-id-keyed remount and discard unsaved edits elsewhere on the form). Both always run Haiku with escalation off. Server actions `reExtractPage`/`reExtractField` (`lib/actions/review.ts`) gate on `isAdminOrAbove`, same as the existing whole-document re-escalation route. UI: the thumbnail rail's "OCR this page" button (§2.5) calls the page-scoped path and refreshes; a new "Re-extract a flagged field" button strip in `review-workspace.tsx`, one button per flagged header field, calls the field-scoped path and patches only that field's local state — no refresh, by design. Line-item uncertain fields are explicitly out of scope for v1 (a re-read has no guaranteed stable `line_order` to match an existing row against — see `ReExtractableHeaderField`'s doc comment). Built via two parallel subagents against a contract (migration, types, and fully-implemented server actions) written first; typechecked/linted/tested clean (370/370), full production build clean. No live-browser verification — same standing limitation as §2.1/§2.7-§2.9 (no dev/staging environment, no test credentials).

### Steps redesign + vendor consolidation UI (§2.4, second half)

**Already built, undated in this doc until now.** `components/review/review-status-line.tsx` is the compact three-segment (Verify/Connect/Classify) card the plan called for, and `components/review/match-strip.tsx` already collapses every candidate past the top suggestion, plus the manual search box, behind an "expanded" toggle ("Search or pick another"). The vendor confirm-merge dialog (`confirmVendorAlias`, `handleVendorSelect` in `review-workspace.tsx`) is also already wired. Found already complete while scoping Phase 5 for this session's work — the sequencing table below was stale, not the code.

### 2.7 / 2.8 — Page ↔ OCR synchronisation

**Confirmed by design.** `PdfViewer` owns page state independently; `ExtractionForm` renders every field of the bill regardless of the page on screen. The only link built is one-way — click a flagged field, the PDF jumps. Viewer page → form fields does not exist, and there is no loading state for it.

**Build:** selecting a page filters or highlights the fields sourced from it, with a skeleton while the switch resolves.

**Built 2026-08-22 (Phase 2, commit `9d67da0`).** Uncertain fields (the only fields with a known source page — regular fields have none) now ring orange when their page matches the one on screen and dim to a muted ring otherwise, across header fields, the vendor picker, and line items. No skeleton: the highlight is a synchronous re-filter of `uncertainFields` already held client-side, not a fetch. `typecheck`/`lint`/`test` clean; live-browser verification pending (production is the only environment — user to verify). Re-verify against the now-working page before building, since §0 may have contributed to the reported symptoms.

### 2.9 — Step 3 not appearing without a refresh

**Deferred pending re-test.** The attach path does call `revalidatePath('/review')` and `router.refresh()`. Plausibly a §0 symptom.

**Re-checked 2026-08-22 (Phase 2).** Code reading found nothing wrong with the existing `revalidatePath`/`router.refresh()` wiring — consistent with this having been a §0 schema-drift symptom, but not independently confirmed live (no dev/staging environment to test against; production requires real reviewer credentials). User to confirm on next `/review` session.

### 2.10 — Classification search matches numbers only

**Confirmed, precisely.** Admin head and Zone are plain Radix `Select`s with no search field, rendering items as `{head_number}. {name}` — "3. WATERPROOF MANDAP". Radix type-ahead matches from the start of the label, which is the number. Typing `3` jumps; typing `W` does nothing.

**Build:** replace both with searchable comboboxes (`cmdk` is already a dependency), matching on name and number.

### 2.11 — Sibling-bill navigation bounces

**Confirmed logic bug, independent of §0.** The sibling-bill buttons navigate to `/review?id=<siblingId>`. If that sibling is not in the current queue — because it is already verified and the default scope is unverified-only — `currentIndex` comes back `-1` and the page redirects to the top of the queue. Clicking bill 2 returns you to bill 1.

**Build:** when a requested id is absent from the scoped queue, load it anyway rather than redirecting, or widen scope to `all` for that navigation.

### 2.12 — GST recipient-compliance check

**It has never run.** The code is complete and its 22 unit tests pass, but the columns did not exist in the database until §0, so zero `gst_recipient_compliance_missing` exceptions have ever been raised and `buyer_gstin`/`buyer_name` have never been extracted from a single bill. Confirmed by query: `buyer_gstin_ocr` is null across all 11 existing extractions.

`COMMUNITY_GSTIN` and `COMMUNITY_NAME` are both set in `.env`. The check should now fire on the next extraction.

**Verification step, not a build:** re-extract one known-GST bill and confirm `buyer_gstin_ocr`/`buyer_name_ocr` populate and the exception raises correctly. Until that has run against a real bill, this item is unproven, not done.

**Verified 2026-08-22 (Phase 2).** Re-extracted `Invoices/002 venue Setup Al Nafees Tech.pdf` (source_document 1) for real: `buyer_gstin_ocr`/`buyer_name_ocr` populated correctly, buyer GSTIN matched `COMMUNITY_GSTIN`, no exception raised — the compliant path. Separately extracted a page showing a mismatched buyer GSTIN and no invoice number: one `gst_recipient_compliance_missing` exception raised, severity `high`, correctly flagging only the two actually-missing items (not the buyer name, which matched) — the non-compliant path. Wiring in `lib/jobs/handlers/extract.ts` was already correct end to end; no code fix needed. `npm run typecheck` clean, `npm test` 370/370 passing.

---

## 3. Sequencing

| Phase | Contents | Notes |
|---|---|---|
| **0** | Schema drift fixed | **Done** |
| **1** | §2.2 nav spacing · §2.3 relabel · §2.10 searchable classification · §2.11 sibling nav · §2.4 stop the vendor overwrite | **Done** (2026-08-22) |
| **2** | §2.12 verify compliance on a real bill · re-test §2.7 / §2.8 / §2.9, then build the page↔OCR sync | **Done** (2026-08-22), pending user's live-browser confirmation |
| **3** | §2.1 Settings screen + per-user keymap | **Built 2026-08-22**, migration pushed; pending user's live-browser confirmation |
| **4** | §2.5 manual skip/unskip · §2.6 scoped re-OCR | **Built 2026-08-22**, migration pushed; typecheck/lint/test/build all clean; pending user's live-browser confirmation |
| **5** | §2.4 steps redesign + vendor consolidation UI | **Already done** — found built while scoping this phase, doc was stale |
| **6** | §1 event scoping | Schema, every query, imports, exports, reporting |

Phase 6 is larger than phases 1–5 combined. It is sequenced last deliberately: every fix above is confined to `/review` and stays valid under event scoping, whereas doing §1 first would mean rewriting each of those screens twice.
