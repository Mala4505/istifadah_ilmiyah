# Bill-exempt vendors (Burhani Hospital Surat)

**Date:** 2026-09-29
**Why:** Burhani Hospital Surat is reimbursed through the Sehhat batch (see the
"Batch Print Summary" PDF, 12 entries / ₹68,660, 16–20 Sep 2026). The hospital
issues no bills, so these entries will never have a PDF uploaded or an invoice
linked. Today every such entry counts as "Awaiting bill" and as undocumented
spend.

**Decision (operator, 2026-09-29):** the exemption is **vendor-wide**, not
limited to one department. An entry is bill-exempt when its vendor, or the
vendor it is merged into (`cluster_group_id`), is marked "No bill needed".

**Not in scope:** bill matching (`match_candidate_entries`) is left alone, so
a bill that does turn up for an exempt vendor can still be linked.

## Phase 1 — Exemption end to end

1. **Migration** `supabase/migrations/20260929000001_vendor_bill_not_required.sql`
   - `vendor.bill_not_required boolean not null default false`
   - Set it for `normalized_name = 'burhani hospital surat'`
   - `v_entry_enriched`: append `bill_exempt` (own vendor or merge root flagged)
   - `v_entries_without_bill` / `_rollup`: exclude exempt entries
2. **Entries list** — "Awaiting bill" filter + KPI tile skip exempt entries;
   the Docs cell shows "Not needed" instead of "Awaiting".
3. **Entry detail** — the Documents card says no bill is needed for this vendor.
4. **Settings → Vendors** — admin-only "No bill needed" checkbox per vendor.
