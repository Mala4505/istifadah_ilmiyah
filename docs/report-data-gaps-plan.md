# Report data gaps — fill blank reports from existing data

**Status:** Phase 1 done 2026-10-05 (migration 20261005075123, applied) · Phase 2 done 2026-10-05 (migration 20261005084229, applied; 89.4% of rate_reference rows have a family) · Phase 4 done 2026-10-05 (migration 20261005090948, applied; 89 vendors got a GSTIN with "clean only" approved: single 15-char value, conflicts and junk skipped; 158 got a phone; 6 shared-identity edges) · Phase 3 done 2026-10-05 (migration 20261005090407, applied; first sweep wrote 752 flags, next run self-queued) · Phase 5 skipped 2026-10-05 (sub_department_budget_allocation keeps per-import history, but only 1 import exists — batch 101, as_of 2026-09-11, 235 rows — so there are no revisions to show; revisit after a second sub-dept budget import) · Phase 6 done 2026-10-05: cost centers dropped entirely by user decision (budget_head.short_label already is the cross-department category) — migration 20261005095327 removes `cost_center` + `entries.cost_center_id`, adds `v_budget_head_category` (normalised short_label, spelling variants merged), and repoints `v_budget_category_mix` (0 → 55 rows) and `v_zone_category_matrix` (0 → 194); approval thresholds skipped (no real limits given; amounts show no bunching under ₹50k/₹1L/₹5L) · Phase 7 done 2026-10-05: 14 of 16 baseline views now return rows; still empty by design: `v_budget_revision_history` (one budget import) and `approval_threshold` (no limits given)

Fourteen report views return zero rows. The cause isn't the report code: upstream tables were never populated. Each phase below fills one gap **from data already in the database** (bills, line items, entries, vendors), then re-counts the views it feeds.

## Ground rules (every phase)

- **DB access:** use `npx supabase` only (bare `supabase` isn't on PATH).
  - Read: `npx supabase db query --linked "select …"`, or `--file path.sql` for anything longer.
  - Schema and function changes: write the SQL to a new file (`npx supabase migration new <name>`), then apply it with `npx supabase db push --include-all`.
  - Don't run ad-hoc `insert`/`update` through `db query`. All writes, back-fills included, go in migrations so they're reproducible.
- **Look before writing.** Each phase starts with a read-only analysis query and shows the user the result as a **table**, not a list. Write nothing until the user approves the grouping or mapping.
- **Never fuzzy-auto-merge.** The design rule from `20260814000001_item_catalog.sql` applies: exact or normalised match only. Anything new is created **unconfirmed** (`is_confirmed = false`) for a human to confirm.
- **No git commit or push.** Subagents get the same restriction, stated in their prompt. Don't use Agent `isolation: "worktree"` (it's broken in this repo); give parallel agents disjoint file lists instead.
- Before saying a phase is done, re-run that phase's **Verify** query and report the before/after counts.
- After code changes: `npx tsc --noEmit -p .`, then `npx vitest run`.

## Baseline (2026-10-05)

| Table / view | Rows | Feeds |
|---|---|---|
| `item_family` | 0 | all family reports |
| `rate_reference` (2,728 rows) | 0 with `item_family_id`, 0 with `quantity` | rate, family and quantity reports |
| `document_extraction_line_item` | 4,587 (2,305 with `quantity_verified`, 4,206 with `quantity_ocr`, 1,748 with `unit_normalized`) | source data |
| `flags` | 0 (no `flags_run` job ever queued) | compliance, duplicate, vendor-risk reports |
| `approval_threshold` | 0 | threshold splitting |
| `cost_center` | 0 | budget category mix, zone × category |
| `vendor.gstin` / `vendor.phone` | 0 of 484 | related-party clusters |
| `document_extraction` vendor GSTIN | 520 bills have one | source data |
| `budget_allocation` | 0 (`sub_department_budget_allocation` has 235) | budget revision history |
| `event` | 1 | event comparison: nothing to fix, needs a second event |

Empty views: `v_spend_by_family`, `v_rate_benchmark`, `v_rate_observation`, `v_purchase_tree`, `v_vendor_price_by_family`, `v_rate_drift`, `v_discount_consistency`, `v_quantity_by_unit`, `v_zone_unit_economics`, `v_compliance_summary`, `v_duplicate_payment_register`, `v_vendor_shared_identity_edges`, `v_budget_revision_history`, plus `approval_threshold`.

---

## Phase 1 — Quantity, GST rate and discount on `rate_reference`

**Problem:** the live `verify_document_extraction` function (latest definition in `supabase/migrations/20261004000001_bill_discount.sql`) inserts `rate_reference` rows without `quantity`, `gst_rate` or `discount_pct`. Every row therefore has a null quantity, so Quantity by Unit is empty and the family reports value spend at `net_rate × 1`.

1. Read the current function body and confirm which line-item fields it receives in `v_item`: quantity, discount and GST.
2. New migration:
   - `create or replace` the function so its insert also writes `quantity`, `discount_pct` and `gst_rate` (the bill-level rate if there's no line-level one).
   - Back-fill the existing rows from `document_extraction_line_item` through `rate_reference.line_item_id`: `quantity = coalesce(quantity_verified, quantity_ocr)`, discount from `discount_verified`/`discount_ocr`, and `unit_normalized` where it's null.
   - Rows whose `line_item_id` was nulled by `clear_bill_rate_reference_links` can't be back-filled. Count them and report the count.
3. **Verify:** `select count(*), count(quantity) from rate_reference;` and `select count(*) from v_quantity_by_unit;`. Quantity by Unit stays empty until Phase 2 if it joins to families; say so if that's the case.

## Phase 2 — Item families: group the existing line items (the "no item family" gap)

**Problem:** nothing ever creates `item_family` / `item_catalog` / `item_alias` rows or sets `rate_reference.item_family_id`. Every family-based report is empty.

1. **Analysis (read-only):** pull the distinct normalised descriptions from `rate_reference` / line items, with their count, vendor count, units, and median rate. Normalise as: lower-case, collapse whitespace, strip sizes and quantities.
2. **Propose a grouping:** cluster descriptions into coarse, cross-vendor-comparable families (the level the migration header describes, e.g. `pvc-boring-pipe`, `gypsum-ceiling`) using the head noun plus the unit. Mark lump-sum or service lines as `is_comparable = false`.
   - Show the user a table: family key, label, default unit, example descriptions, line count, vendor count.
   - Wait for approval or edits. This is master data.
3. **Migration:**
   - Insert the approved families (`is_confirmed = false`).
   - Insert their aliases (normalised description → family).
   - Set `rate_reference.item_family_id` and `is_comparable` by exact alias match.
4. **Going forward:** extend the save path (the verify function, or `lib/actions/review.ts` before it calls it) to look up the family by exact alias match on every new line. A new description with no match stays unassigned until someone confirms it. No fuzzy matching.
5. **Verify:** counts for `v_spend_by_family`, `v_rate_benchmark`, `v_rate_observation`, `v_purchase_tree`, `v_vendor_price_by_family`, `v_rate_drift`, `v_discount_consistency`, `v_quantity_by_unit` and `v_zone_unit_economics`, plus the share of `rate_reference` rows that now have a family.

## Phase 3 — Flags: start the detector sweep

**Problem:** `lib/jobs/handlers/flags-run.ts` reschedules itself after each run, but no first job was ever queued, so `flags` is empty.

1. Read `lib/jobs/queue.ts` and `flags-run.ts` for the exact `job_queue` row shape.
2. Migration: insert one `flags_run` job (`status = 'queued'`, `run_after = now()`), but only if no queued or running `flags_run` job exists.
3. Drain it once with `npm run worker` (or wait for the cron tick). Check that `job_queue` shows it succeeded and that the next run was queued.
4. **Verify:** `select flag_type, count(*) from flags group by 1;` plus counts for `v_compliance_summary` and `v_duplicate_payment_register`.

## Phase 4 — Vendor GSTIN and phone from verified bills

**Problem:** all 484 `vendor.gstin` values are blank, although 520 bills carry a vendor GSTIN. Related-party Clusters has nothing to join on.

1. **Analysis:** for each vendor, list the distinct GSTINs on its bills (`coalesce(vendor_gstin_verified, vendor_gstin_ocr)`, verified bills preferred) and how often each appears. Do the same for phone, if bills carry one.
   - Show the user three groups: vendors with exactly one GSTIN (auto-fill candidates), vendors with conflicting GSTINs (needs a human), and GSTINs shared by several vendors (likely duplicates or related parties).
2. Migration, after approval: fill `vendor.gstin` only for the single-GSTIN vendors, and only where it's null. Keep a checksum-failing GSTIN as read; a human fixes the character. Don't touch conflicting vendors.
3. **Verify:** `select count(*) from v_vendor_shared_identity_edges;` and the vendor GSTIN coverage.

## Phase 5 — Budget revision history from the tables actually in use

**Problem:** `v_budget_revision_history` reads `budget_allocation` (0 rows). Budgets now arrive through `department_budget_allocation` / `sub_department_budget_allocation`.

1. Check whether the sub-department table keeps a row per import (`import_batch_id` / `as_of`), i.e. whether it has revision history at all.
2. If it does, migration: redefine the view over that table, keeping the same output columns so `lib/reports/surfaces/budget-structure.ts` needs no change (or update it if it must). If it doesn't, tell the user the report can only show a single snapshot and ask how to proceed.
3. **Verify:** `select count(*) from v_budget_revision_history;`

## Phase 6 — Cost centers and approval thresholds (analysis only, then ask)

These can't be derived honestly without the user's rules, so this phase proposes and asks. It writes nothing.

1. **Cost centers:** analyse entries by budget head and sub-department, and propose a cost-center list (e.g. one per budget-head category) with how many entries each would cover. Show it as a table and ask the user to confirm or edit before any migration.
2. **Approval thresholds:** show the amount distribution (round-number clusters, percentiles per department) and ask the user for the real approval limits. Don't invent them.

## Phase 7 — Final check

Re-run the bulk row count over every report view (the Baseline list) and give the user a before/after table. List anything still blank, with the reason. Update `C:\Users\pc\.claude\projects\d--Idara-Maliyah-Code-Istifadah-Ilmiyah\memory\project_blank_reports_root_causes.md` with what was fixed.
