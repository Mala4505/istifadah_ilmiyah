-- v_vendor_advance_position: "how much has this vendor been given as an
-- advance, and how much do we still owe them" -- computed live by summing,
-- not by linking individual advance rows to individual settlement rows.
--
-- WHY NO LINK TABLE: an earlier attempt (20260926000002) tried to link each
-- Invoice-Against-Uplaq (IAU) settlement back to the single Advance Payment
-- it closes out via entries.settles_entry_id. Checked against three real
-- ambiguous cases by hand (2026-09-26): in every one, the IAU's balance
-- payable only reconciles to the rupee when ALL of that vendor's candidate
-- advances are summed together, not any single one -- e.g. Apex Infratents'
-- three advances (10,82,500 + 10,53,300 + 10,67,900 = 32,03,700) against its
-- one settlement (invoice 42,71,600, balance payable 10,67,900) only works
-- as 42,71,600 - 32,03,700 = 10,67,900. A single-FK link cannot represent
-- "one settlement closes three advances" -- but the arithmetic below needs
-- no such link at all: summed per vendor, "given" and "still owed" are
-- correct regardless of which specific advance paid for which specific
-- invoice.
--
-- GRAIN: one row per (event, department, vendor). Vendor identity mirrors
-- v_reimbursement_profile's own keying (20260903000014) exactly, for the
-- same reason: a real vendor_id wins when set, otherwise a normalised
-- vendor_raw, so two spellings of an unlinked vendor stay two rows until
-- someone links them -- never fuzzy-merged automatically.
--
--   advance_given          -- sum of this vendor's advance_payment.amount
--                             (entries.amount, the Uplaq Amount -- 20260827000001)
--   advance_count          -- how many advance rows made up that sum
--   settled_invoice_total  -- sum of invoice_against_uplaq_detail.invoice_amount
--                             for this vendor -- the FULL final contract value
--                             of whatever has been finalised into an invoice
--   balance_owed           -- sum of invoice_against_uplaq_detail.balance_payable
--                             -- what's left to pay on those finalised invoices,
--                             already netted against whichever advances covered
--                             it (see header) -- this is the "still left to be
--                             given" figure, no linking required to get it right
--   settlement_count       -- how many IAU rows contributed to the two figures
--                             above; 0 means every advance for this vendor is
--                             still awaiting its final invoice altogether
--
-- A vendor with advances but zero settlements shows balance_owed = 0 and
-- settlement_count = 0 -- read as "nothing finalised yet to owe against",
-- not "fully paid"; the section component is responsible for making that
-- distinction visible (advance_count > 0 and settlement_count = 0).
create view public.v_vendor_advance_position with (security_invoker = true) as
with advance_rows as (
  select e.event_id, e.department_id, e.vendor_id, e.vendor_raw, e.amount
    from public.entries e
   where e.type = 'advance_payment' and e.is_void = false
),
settlement_rows as (
  select e.event_id, e.department_id, e.vendor_id, e.vendor_raw,
         iad.invoice_amount, iad.balance_payable
    from public.entries e
    join public.invoice_against_uplaq_detail iad on iad.entry_id = e.id
   where e.type = 'invoice_against_uplaq' and e.is_void = false
),
advance_keyed as (
  select event_id, department_id,
         coalesce('v:' || vendor_id::text, 'r:' || lower(regexp_replace(coalesce(vendor_raw, ''), '\s+', ' ', 'g'))) as vendor_key,
         vendor_id, vendor_raw, amount
    from advance_rows
),
settlement_keyed as (
  select event_id, department_id,
         coalesce('v:' || vendor_id::text, 'r:' || lower(regexp_replace(coalesce(vendor_raw, ''), '\s+', ' ', 'g'))) as vendor_key,
         vendor_id, vendor_raw, invoice_amount, balance_payable
    from settlement_rows
),
advance_agg as (
  select event_id, department_id, vendor_key,
         max(vendor_id) as vendor_id, max(vendor_raw) as vendor_raw,
         sum(amount) as advance_given, count(*) as advance_count
    from advance_keyed
   group by event_id, department_id, vendor_key
),
settlement_agg as (
  select event_id, department_id, vendor_key,
         max(vendor_id) as vendor_id, max(vendor_raw) as vendor_raw,
         sum(invoice_amount) as settled_invoice_total,
         sum(balance_payable) as balance_owed,
         count(*) as settlement_count
    from settlement_keyed
   group by event_id, department_id, vendor_key
),
-- Every (event, department, vendor) that appears on EITHER side -- a vendor
-- with only a settlement and no tracked advance (or vice versa) still gets a
-- row, coalesced to 0 on whichever side it lacks.
combined as (
  select event_id, department_id, vendor_key from advance_agg
  union
  select event_id, department_id, vendor_key from settlement_agg
)
select
  c.event_id,
  c.department_id,
  d.name as department_name,
  c.vendor_key,
  coalesce(aa.vendor_id, sa.vendor_id) as vendor_id,
  coalesce(v.display_name, aa.vendor_raw, sa.vendor_raw, '(unspecified)') as vendor_display_name,
  coalesce(aa.advance_given, 0) as advance_given,
  coalesce(aa.advance_count, 0) as advance_count,
  coalesce(sa.settled_invoice_total, 0) as settled_invoice_total,
  coalesce(sa.balance_owed, 0) as balance_owed,
  coalesce(sa.settlement_count, 0) as settlement_count
from combined c
left join advance_agg aa
  on aa.event_id = c.event_id and aa.department_id is not distinct from c.department_id and aa.vendor_key = c.vendor_key
left join settlement_agg sa
  on sa.event_id = c.event_id and sa.department_id is not distinct from c.department_id and sa.vendor_key = c.vendor_key
left join public.department d on d.id = c.department_id
left join public.vendor v on v.id = coalesce(aa.vendor_id, sa.vendor_id);

grant select on public.v_vendor_advance_position to authenticated;
