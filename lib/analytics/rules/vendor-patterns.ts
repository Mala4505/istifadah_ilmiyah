/**
 * Pillar C — vendor-level pattern detectors.
 *
 * Everything here reads ACROSS documents for one vendor. That is the whole
 * point: the findings in this file are structurally invisible to a per-document
 * check. Four bills of ₹24,000 each look unremarkable one at a time and cross
 * two statutory thresholds when added up.
 *
 * These detectors describe patterns. They do not assert intent, and their
 * descriptions are written so a reviewer reading one is told what was observed
 * and what it might mean — never that someone did something wrong. A tool that
 * accuses is a tool people route around.
 */

import {
  APPROVAL_LIMIT,
  CONCENTRATION_MIN_TOTAL,
  DUPLICATE_AMOUNT_TOLERANCE,
  DUPLICATE_WINDOW_DAYS,
  HIGH_SEVERITY_AMOUNT,
  MEDIUM_SEVERITY_AMOUNT,
  SPLITTING_MIN_BILL_COUNT,
  SPLITTING_NEAR_LIMIT_RATIO,
  SPLITTING_WINDOW_DAYS,
  TDS_194C_ANNUAL_AGGREGATE,
  TDS_194C_RATE_INDIVIDUAL,
  TDS_194C_RATE_OTHER,
  TDS_194C_SINGLE_PAYMENT,
} from '@/lib/analytics/thresholds'
import type { FlagProposal, Severity, VendorFacts, VendorPayment } from '@/lib/analytics/types'

const MS_PER_DAY = 86_400_000

function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

function severityForAmount(amount: number | null | undefined): Severity {
  if (amount == null) return 'low'
  if (amount >= HIGH_SEVERITY_AMOUNT) return 'high'
  if (amount >= MEDIUM_SEVERITY_AMOUNT) return 'medium'
  return 'low'
}

/**
 * The Indian financial year a date falls in: 1 April to 31 March.
 *
 * TDS aggregate limits are per financial year, so a calendar-year bucket would
 * both miss crossings that happen across a January boundary and invent ones that
 * do not exist across an April boundary.
 */
export function financialYearOf(isoDate: string): string {
  const date = new Date(isoDate)
  const year = date.getUTCFullYear()
  // getUTCMonth is 0-based; month index 3 is April.
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / MS_PER_DAY
}

/** Payments that carry a usable date and amount, oldest first. */
function datedPayments(vendor: VendorFacts): VendorPayment[] {
  return vendor.payments
    .filter((p) => p.invoiceDate != null && Number.isFinite(p.amount))
    .sort((a, b) => (a.invoiceDate as string).localeCompare(b.invoiceDate as string))
}

/** Stable, order-independent id list for a dedup key. */
function keyOf(payments: VendorPayment[]): string {
  return payments
    .map((p) => p.entryId ?? `d${p.documentExtractionId}`)
    .map(String)
    .sort()
    .join(',')
}

function relatedEntryIds(payments: VendorPayment[]): number[] {
  return payments
    .map((p) => p.entryId)
    .filter((id): id is number => id != null)
    .sort((a, b) => a - b)
}

/**
 * Cumulative payments to one vendor crossing a TDS deduction threshold.
 *
 * Section 194C bites on either limb independently — a single payment above
 * ₹30,000, or an annual aggregate above ₹1,00,000. The aggregate limb is the one
 * a per-document check can never see, and it is the limb the pilot corpus trips.
 *
 * IMPORTANT: 194C covers works contracts and services, NOT a straightforward
 * sale of goods. Whether a given vendor's supply is one or the other is a
 * judgement about the substance of the transaction that this code cannot make —
 * a furniture supplier delivering stock is a sale, the same supplier fabricating
 * and installing to specification is a works contract. The flag therefore
 * reports the crossing and asks for that determination rather than asserting a
 * liability.
 */
export function detectTdsThreshold(vendor: VendorFacts): FlagProposal[] {
  const payments = datedPayments(vendor)
  if (payments.length === 0) return []

  const byFy = new Map<string, VendorPayment[]>()
  for (const payment of payments) {
    const fy = financialYearOf(payment.invoiceDate as string)
    const bucket = byFy.get(fy)
    if (bucket === undefined) byFy.set(fy, [payment])
    else bucket.push(payment)
  }

  const proposals: FlagProposal[] = []

  for (const [fy, fyPayments] of byFy) {
    const total = fyPayments.reduce((sum, p) => sum + p.amount, 0)
    const largest = fyPayments.reduce((max, p) => (p.amount > max.amount ? p : max), fyPayments[0] as VendorPayment)

    const crossesAggregate = total > TDS_194C_ANNUAL_AGGREGATE
    const crossesSingle = largest.amount > TDS_194C_SINGLE_PAYMENT
    if (!crossesAggregate && !crossesSingle) continue

    // Unknown constitution defaults to the 2% (non-individual) rate. That is the
    // higher of the two, and understating a potential liability is the more
    // costly error here — the flag says which assumption it made.
    const rateKnown = vendor.isIndividual != null
    const rate = vendor.isIndividual === true ? TDS_194C_RATE_INDIVIDUAL : TDS_194C_RATE_OTHER
    const estimated = Math.round(total * rate * 100) / 100

    const limbs: string[] = []
    if (crossesSingle) {
      limbs.push(`a single bill of ${inr(largest.amount)} (limit ${inr(TDS_194C_SINGLE_PAYMENT)})`)
    }
    if (crossesAggregate) {
      limbs.push(
        `${fyPayments.length} bills totalling ${inr(total)} (annual limit ${inr(TDS_194C_ANNUAL_AGGREGATE)})`
      )
    }

    proposals.push({
      flagType: 'tds_threshold',
      dedupKey: `tds_threshold:${vendor.vendorId}:${fy}`,
      severity: severityForAmount(total >= HIGH_SEVERITY_AMOUNT ? total : estimated),
      entryId: null,
      relatedEntryIds: relatedEntryIds(fyPayments),
      vendorId: vendor.vendorId,
      amountAtRisk: estimated,
      description:
        `${vendor.displayName} was paid ${inr(total)} across ${fyPayments.length} ` +
        `bill${fyPayments.length === 1 ? '' : 's'} in ${fy}, crossing the section 194C threshold via ` +
        `${limbs.join(' and ')}. If these are works-contract or service payments rather than a sale of ` +
        `goods, TDS of about ${inr(estimated)} (at ${(rate * 100).toFixed(0)}%) should have been deducted ` +
        `at source. Confirm the nature of the supply.`,
      evidence: {
        financial_year: fy,
        cumulative_amount: total,
        bill_count: fyPayments.length,
        largest_single_payment: largest.amount,
        crosses_single_payment_limb: crossesSingle,
        crosses_annual_aggregate_limb: crossesAggregate,
        assumed_rate_pct: rate * 100,
        rate_basis: rateKnown
          ? vendor.isIndividual
            ? 'Vendor recorded as an individual/HUF — 1%.'
            : 'Vendor recorded as non-individual — 2%.'
          : 'Vendor constitution unknown; the higher 2% rate was assumed.',
        estimate: true,
        requires_human_determination:
          'Section 194C applies to works contracts and services, not to a pure sale of goods.',
      },
    })
  }

  return proposals
}

/**
 * Several bills to one vendor, clustered in time.
 *
 * Runs in one of two modes depending on whether the organisation has a
 * delegated approval limit (see APPROVAL_LIMIT):
 *
 *   SPLITTING mode (limit set) — counts only bills BELOW the limit and fires
 *     when they together exceed it. That is a control breach: spend that never
 *     reached the approver it should have. A vendor who also submitted one
 *     large, properly-approved bill has not thereby made their small ones
 *     suspicious, so above-limit bills are excluded from the group.
 *
 *   CONCENTRATION mode (no limit) — counts all bills and fires on a materially
 *     large cluster. Nothing has been breached, because there is no control to
 *     breach; the pattern is reported because one engagement billed in parts is
 *     worth knowing about either way, and because it is the shape that trips the
 *     TDS aggregate limb. Severity is capped accordingly.
 *
 * In both modes the description asks a question rather than making an accusation.
 */
export function detectVendorSplitting(vendor: VendorFacts): FlagProposal[] {
  const limit = APPROVAL_LIMIT
  const splittingMode = limit !== null

  // In concentration mode there is no limit to sit under, so every bill counts.
  const underLimit = splittingMode
    ? datedPayments(vendor).filter((p) => p.amount < limit)
    : datedPayments(vendor)
  if (underLimit.length < SPLITTING_MIN_BILL_COUNT) return []

  const proposals: FlagProposal[] = []
  // Ids already accounted for by a reported cluster. Because `start` ascends and
  // each group is maximal for its start, a later qualifying group is a suffix of
  // an earlier one whenever their windows overlap — four bills in one week would
  // otherwise report [1,2,3,4] AND [2,3,4] as two separate findings. A group
  // whose every member is already covered is that same cluster seen again, so it
  // is suppressed; a group introducing any new bill is a genuinely new cluster.
  const coveredIds = new Set<string>()

  // Sliding window: for each start, take every bill within the window and test
  // the group.
  for (let start = 0; start < underLimit.length; start += 1) {
    const group: VendorPayment[] = []
    for (let i = start; i < underLimit.length; i += 1) {
      const candidate = underLimit[i] as VendorPayment
      const first = underLimit[start] as VendorPayment
      if (daysBetween(first.invoiceDate as string, candidate.invoiceDate as string) > SPLITTING_WINDOW_DAYS) {
        break
      }
      group.push(candidate)
    }

    if (group.length < SPLITTING_MIN_BILL_COUNT) continue
    const total = group.reduce((sum, p) => sum + p.amount, 0)

    // The materiality floor: the limit itself when there is one, otherwise the
    // concentration threshold.
    const floor = splittingMode ? limit : CONCENTRATION_MIN_TOTAL
    if (total <= floor) continue

    const memberIds = group.map((p) => String(p.entryId ?? `d${p.documentExtractionId}`))
    if (memberIds.every((id) => coveredIds.has(id))) continue
    for (const id of memberIds) coveredIds.add(id)

    const key = keyOf(group)

    const nearLimit = splittingMode
      ? group.filter((p) => p.amount >= limit * SPLITTING_NEAR_LIMIT_RATIO).length
      : 0
    const spanDays = Math.round(
      daysBetween(group[0]?.invoiceDate as string, group[group.length - 1]?.invoiceDate as string)
    )
    const dayLabel = `${spanDays} day${spanDays === 1 ? '' : 's'}`

    proposals.push({
      flagType: 'vendor_splitting',
      dedupKey: `vendor_splitting:${vendor.vendorId}:${key}`,
      // Splitting mode: the exposure is the whole total, because that is what went
      // through without the approval the aggregate would have required.
      // Concentration mode: nothing was breached, so the finding is capped at
      // medium no matter how large — reporting an un-breached pattern as "high"
      // alongside genuine control failures is how a queue stops being read.
      severity: splittingMode
        ? severityForAmount(total)
        : severityForAmount(total) === 'high'
          ? 'medium'
          : severityForAmount(total),
      entryId: null,
      relatedEntryIds: relatedEntryIds(group),
      vendorId: vendor.vendorId,
      amountAtRisk: total,
      description: splittingMode
        ? `${vendor.displayName} submitted ${group.length} bills within ${dayLabel}, each below the ` +
          `${inr(limit)} approval limit but totalling ${inr(total)}` +
          (nearLimit > 0 ? `, with ${nearLimit} sitting close to the limit.` : '.') +
          ` Confirm whether these are genuinely separate scopes of work or one engagement billed in parts.`
        : `${vendor.displayName} submitted ${group.length} bills within ${dayLabel}, totalling ` +
          `${inr(total)}. No approval limit is configured, so this is not a control breach — it is ` +
          `reported so you can confirm whether these are separate scopes of work or one engagement ` +
          `billed in parts, and because clusters like this are what cross the TDS aggregate threshold.`,
      evidence: {
        mode: splittingMode ? 'approval_limit' : 'concentration',
        bill_count: group.length,
        total_amount: total,
        approval_limit: limit,
        // Recorded explicitly so a reader months from now knows the absence of a
        // limit was a confirmed fact, not an unset config value.
        approval_limit_configured: splittingMode,
        window_days: spanDays,
        bills_near_limit: nearLimit,
        amounts: group.map((p) => p.amount),
        invoice_numbers: group.map((p) => p.invoiceNumber),
      },
    })
  }

  return proposals
}

/**
 * The same amount billed twice by the same vendor inside a short window.
 *
 * Two independent signals, reported as one flag type at different severities:
 * a repeated INVOICE NUMBER is close to conclusive, while a repeated amount is
 * suggestive — genuinely recurring charges (monthly rent, a fixed daily rate)
 * produce identical amounts legitimately, which is why the window matters.
 */
export function detectDuplicatePayment(vendor: VendorFacts): FlagProposal[] {
  const payments = datedPayments(vendor)
  const proposals: FlagProposal[] = []
  const seen = new Set<string>()

  for (let i = 0; i < payments.length; i += 1) {
    for (let j = i + 1; j < payments.length; j += 1) {
      const a = payments[i] as VendorPayment
      const b = payments[j] as VendorPayment

      const gap = daysBetween(a.invoiceDate as string, b.invoiceDate as string)
      // Sorted by date, so once one partner is out of range every later one is.
      if (gap > DUPLICATE_WINDOW_DAYS) break

      const sameInvoiceNumber =
        a.invoiceNumber != null &&
        b.invoiceNumber != null &&
        a.invoiceNumber.trim() !== '' &&
        a.invoiceNumber.trim().toLowerCase() === b.invoiceNumber.trim().toLowerCase()

      const larger = Math.max(Math.abs(a.amount), Math.abs(b.amount))
      const sameAmount =
        larger > 0 && Math.abs(a.amount - b.amount) / larger <= DUPLICATE_AMOUNT_TOLERANCE

      if (!sameInvoiceNumber && !sameAmount) continue

      const key = keyOf([a, b])
      if (seen.has(key)) continue
      seen.add(key)

      // The exposure is one of the two payments — if it is a duplicate, that is
      // what was paid twice.
      const exposure = Math.min(a.amount, b.amount)

      proposals.push({
        flagType: 'duplicate_payment',
        dedupKey: `duplicate_payment:${vendor.vendorId}:${key}`,
        severity: sameInvoiceNumber ? 'high' : severityForAmount(exposure),
        entryId: a.entryId ?? b.entryId ?? null,
        relatedEntryIds: relatedEntryIds([a, b]),
        vendorId: vendor.vendorId,
        amountAtRisk: exposure,
        description: sameInvoiceNumber
          ? `${vendor.displayName} has two records against invoice number "${a.invoiceNumber}" ` +
            `(${inr(a.amount)} on ${a.invoiceDate}, ${inr(b.amount)} on ${b.invoiceDate}). ` +
            `An invoice number should appear once.`
          : `${vendor.displayName} billed ${inr(a.amount)} on ${a.invoiceDate} and ${inr(b.amount)} on ` +
            `${b.invoiceDate}, ${Math.round(gap)} day${Math.round(gap) === 1 ? '' : 's'} apart. ` +
            `Confirm these are separate charges and not the same one recorded twice.`,
        evidence: {
          match_basis: sameInvoiceNumber ? 'invoice_number' : 'amount',
          gap_days: Math.round(gap),
          first: { date: a.invoiceDate, amount: a.amount, invoice_number: a.invoiceNumber },
          second: { date: b.invoiceDate, amount: b.amount, invoice_number: b.invoiceNumber },
        },
      })
    }
  }

  return proposals
}

/** Runs every vendor-level detector for one vendor. */
export function runVendorDetectors(vendor: VendorFacts): FlagProposal[] {
  return [
    ...detectTdsThreshold(vendor),
    ...detectVendorSplitting(vendor),
    ...detectDuplicatePayment(vendor),
  ]
}
