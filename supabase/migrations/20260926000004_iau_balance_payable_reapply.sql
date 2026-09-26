-- Re-applies 20260925000001's entries.amount correction for
-- invoice_against_uplaq rows.
--
-- WHY THIS IS NEEDED AGAIN: 20260925000001 flipped entries.amount from
-- Invoice Amount to Balance Payable (avoiding double-counting the earlier
-- Advance Payment leg — see that migration's header for the full reasoning)
-- and backfilled every row that existed at the time. But the matching code
-- change in lib/import/run-portal-import.ts was never committed/deployed
-- until now (2026-09-26) — the live site kept running the old code, so the
-- next real Invoice-Against-Uplaq scrape through it (import_batch_id 185,
-- 2026-09-25 ~14:12-14:18) silently overwrote entries.amount back to Invoice
-- Amount for every row it touched. Confirmed directly: 15 of the 16 current
-- invoice_against_uplaq entries had regressed. The code is now committed and
-- deploying, so this should not need a third re-application.
--
-- Identical guard to the original migration: only touches rows whose detail
-- row actually has a balance_payable value, so a row that never had one is
-- left alone rather than nulled out.
update public.entries e
   set amount = iad.balance_payable
  from public.invoice_against_uplaq_detail iad
 where e.id = iad.entry_id
   and e.type = 'invoice_against_uplaq'
   and e.is_void = false
   and iad.balance_payable is not null
   and e.amount is distinct from iad.balance_payable;
