/**
 * Pillar A — per-document tax and statutory compliance detectors.
 *
 * Every detector here fires on ONE verified document. None of them needs
 * history, a catalog, or a benchmark, which is why this is the part of Phase 2
 * that works on the corpus that exists today rather than waiting for ~200
 * documents to accumulate.
 *
 * Two rules govern everything in this file:
 *
 *  1. Abstain on absent data. A null field means "not captured", never "zero".
 *     A detector that treats a missing subtotal as ₹0 will report a tax mismatch
 *     on every handwritten cash memo in the corpus.
 *
 *  2. Never present an estimate as a measurement. Where a figure is inferred
 *     (credit lost at an assumed 18%), the flag says so in its evidence and the
 *     UI renders it as an estimate.
 */

import { tallyWithinTolerance } from '@/lib/normalize'
import { isInterstateSupply, validateGstin } from '@/lib/analytics/gstin'
import {
  ASSUMED_GST_RATE_FOR_ESTIMATES,
  GST_NOT_CHARGED_MIN_AMOUNT,
  GST_RATE_TOLERANCE_PCT,
  GST_STANDARD_RATES,
  HIGH_SEVERITY_AMOUNT,
  MEDIUM_SEVERITY_AMOUNT,
} from '@/lib/analytics/thresholds'
import type { DocumentFacts, FlagProposal, InstrumentType, Severity } from '@/lib/analytics/types'

/**
 * Instruments issued by a supplier who is NOT registered for GST.
 *
 * A bill of supply is deliberately excluded: it is the correct instrument for a
 * composition-scheme or exempt supplier, so the absence of tax on one is lawful,
 * not a leak. Treating the two alike would flag a compliant vendor and miss the
 * distinction that makes the finding actionable.
 */
const UNREGISTERED_INSTRUMENTS: ReadonlySet<InstrumentType> = new Set<InstrumentType>([
  'retail_cash_memo',
  'letterhead_bill',
  'receipt',
])

/** Instruments that must carry a GSTIN to be valid. */
const GST_BEARING_INSTRUMENTS: ReadonlySet<InstrumentType> = new Set<InstrumentType>([
  'tax_invoice',
])

/** Escalates a finding by the money attached to it. */
function severityForAmount(amount: number | null | undefined): Severity {
  if (amount == null) return 'low'
  if (amount >= HIGH_SEVERITY_AMOUNT) return 'high'
  if (amount >= MEDIUM_SEVERITY_AMOUNT) return 'medium'
  return 'low'
}

/** Rupee figure for display inside a description. */
function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

function vendorLabel(doc: DocumentFacts): string {
  return doc.vendorName?.trim() || `vendor #${doc.vendorId ?? 'unknown'}`
}

/**
 * No GST charged by a supplier who appears to be unregistered.
 *
 * The money is real but indirect: the organisation pays the full invoice and
 * cannot claim the input tax credit it would have got from a registered
 * supplier, so the effective cost of the purchase is higher than the number on
 * the page. The estimate below is what that difference is worth.
 */
export function detectGstNotCharged(doc: DocumentFacts): FlagProposal | null {
  if (doc.instrumentType == null) return null
  if (!UNREGISTERED_INSTRUMENTS.has(doc.instrumentType)) return null
  if (doc.totalAmount == null) return null
  if (doc.totalAmount < GST_NOT_CHARGED_MIN_AMOUNT) return null

  // If tax was actually charged, the instrument classification is the problem,
  // not the tax. Leave it to gstin_missing rather than reporting a false leak.
  if (doc.taxAmount != null && doc.taxAmount > 0) return null

  const rate = ASSUMED_GST_RATE_FOR_ESTIMATES
  // The invoice total IS the taxable value here — no tax was added to it — so
  // the credit foregone is total × rate, not the tax-inclusive back-calculation.
  const creditForegone = Math.round(doc.totalAmount * (rate / 100) * 100) / 100

  return {
    flagType: 'gst_not_charged',
    dedupKey: `gst_not_charged:${doc.documentExtractionId}`,
    severity: severityForAmount(creditForegone),
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: creditForegone,
    description:
      `${vendorLabel(doc)} billed ${inr(doc.totalAmount)} on a ${doc.instrumentType.replace(/_/g, ' ')} ` +
      `with no GST and no GSTIN. Input tax credit of approximately ${inr(creditForegone)} ` +
      `is not claimable on this purchase.`,
    evidence: {
      instrument_type: doc.instrumentType,
      total_amount: doc.totalAmount,
      tax_amount: doc.taxAmount,
      vendor_gstin: doc.vendorGstin,
      assumed_gst_rate: rate,
      estimate: true,
      estimate_basis:
        'Credit foregone assumes the standard 18% slab; the actual applicable rate has not been determined.',
    },
  }
}

/**
 * A tax invoice with no GSTIN on it.
 *
 * A tax invoice is by definition issued by a registered supplier, so a missing
 * GSTIN means either the document is mis-classified or the credit claimed
 * against it will be rejected. Both need a human.
 */
export function detectGstinMissing(doc: DocumentFacts): FlagProposal | null {
  if (doc.instrumentType == null) return null
  if (!GST_BEARING_INSTRUMENTS.has(doc.instrumentType)) return null
  if (doc.vendorGstin != null && doc.vendorGstin.trim() !== '') return null

  return {
    flagType: 'gstin_missing',
    dedupKey: `gstin_missing:${doc.documentExtractionId}`,
    severity: 'high',
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: doc.taxAmount ?? null,
    description:
      `${vendorLabel(doc)} issued a tax invoice with no supplier GSTIN recorded. ` +
      (doc.taxAmount != null
        ? `The ${inr(doc.taxAmount)} of GST charged cannot be claimed as credit without it.`
        : 'Input tax credit cannot be claimed without it.'),
    evidence: {
      instrument_type: doc.instrumentType,
      invoice_number: doc.invoiceNumber,
      tax_amount: doc.taxAmount,
      total_amount: doc.totalAmount,
    },
  }
}

/**
 * A GSTIN that is present but structurally impossible.
 *
 * Catches OCR misreads and data-entry transpositions via the check digit. It
 * cannot tell you the GSTIN is deregistered or belongs to someone else — only
 * the GST portal can — and the description says so, so nobody reads a clean
 * result as confirmation the supplier is genuine.
 */
export function detectGstinInvalid(doc: DocumentFacts): FlagProposal | null {
  if (doc.vendorGstin == null || doc.vendorGstin.trim() === '') return null

  const result = validateGstin(doc.vendorGstin)
  if (result.valid) return null
  // 'empty' is unreachable given the guard above, but abstaining is still the
  // right response if it somehow is not: absence is gstin_missing's business.
  if (result.reason === 'empty') return null

  return {
    flagType: 'gstin_invalid',
    dedupKey: `gstin_invalid:${doc.documentExtractionId}:${result.gstin}`,
    severity: 'high',
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: doc.taxAmount ?? null,
    description:
      `GSTIN "${result.gstin}" on ${vendorLabel(doc)}'s invoice is not structurally valid. ` +
      `${result.message} Verify against the invoice before claiming credit.`,
    evidence: {
      gstin_as_read: doc.vendorGstin,
      gstin_normalized: result.gstin,
      failure_reason: result.reason,
      expected_check_digit: result.expectedCheckDigit ?? null,
      note: 'Structural check only — does not confirm the GSTIN is registered or active.',
    },
  }
}

/**
 * Subtotal + tax + round-off does not reconcile to the total.
 *
 * Uses the same tolerance as the existing line-item tally check (§7, §9.4) so a
 * reviewer sees one consistent notion of "within tolerance" across the app
 * rather than two rules that disagree at the margin.
 */
export function detectTaxMathMismatch(doc: DocumentFacts): FlagProposal | null {
  if (doc.subtotal == null || doc.totalAmount == null) return null

  const tax = doc.taxAmount ?? 0
  const roundOff = doc.roundOff ?? 0
  const computed = doc.subtotal + tax + roundOff

  if (tallyWithinTolerance(computed, doc.totalAmount)) return null

  const variance = Math.round((doc.totalAmount - computed) * 100) / 100

  return {
    flagType: 'tax_math_mismatch',
    dedupKey: `tax_math_mismatch:${doc.documentExtractionId}`,
    severity: severityForAmount(Math.abs(variance)),
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: Math.abs(variance),
    description:
      `Invoice arithmetic does not reconcile: ${inr(doc.subtotal)} subtotal + ${inr(tax)} tax` +
      (roundOff !== 0 ? ` + ${inr(roundOff)} round-off` : '') +
      ` = ${inr(computed)}, but the stated total is ${inr(doc.totalAmount)} ` +
      `(${variance > 0 ? 'over' : 'under'} by ${inr(Math.abs(variance))}).`,
    evidence: {
      subtotal: doc.subtotal,
      tax_amount: doc.taxAmount,
      round_off: doc.roundOff,
      computed_total: computed,
      stated_total: doc.totalAmount,
      variance,
    },
  }
}

/**
 * The implied GST rate is not a rate that exists.
 *
 * Computed as tax ÷ subtotal rather than read off the invoice, because the
 * printed rate and the charged amount are exactly what can disagree.
 */
export function detectGstRateAnomaly(doc: DocumentFacts): FlagProposal | null {
  if (doc.subtotal == null || doc.subtotal <= 0) return null
  if (doc.taxAmount == null) return null

  const impliedRate = (doc.taxAmount / doc.subtotal) * 100
  const matchesSlab = GST_STANDARD_RATES.some(
    (slab) => Math.abs(impliedRate - slab) <= GST_RATE_TOLERANCE_PCT
  )
  if (matchesSlab) return null

  // On an exact tie (an implied 15% is equidistant from the 12% and 18% slabs)
  // take the HIGHER slab. The nearest slab is only used to quantify the
  // discrepancy, and choosing the lower one would understate what may be
  // under-charged tax — a compliance check should not round in the direction
  // that makes the finding look smaller.
  const nearest = GST_STANDARD_RATES.reduce((best, slab) => {
    const slabDistance = Math.abs(impliedRate - slab)
    const bestDistance = Math.abs(impliedRate - best)
    if (slabDistance < bestDistance) return slab
    if (slabDistance === bestDistance) return Math.max(slab, best)
    return best
  })
  const expectedTax = Math.round(doc.subtotal * (nearest / 100) * 100) / 100
  const difference = Math.round((doc.taxAmount - expectedTax) * 100) / 100

  return {
    flagType: 'gst_rate_anomaly',
    dedupKey: `gst_rate_anomaly:${doc.documentExtractionId}`,
    severity: severityForAmount(Math.abs(difference)),
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: Math.abs(difference),
    description:
      `GST works out to ${impliedRate.toFixed(2)}% of the ${inr(doc.subtotal)} taxable value, ` +
      `which is not a valid slab. At the nearest slab (${nearest}%) the tax would be ` +
      `${inr(expectedTax)} rather than the ${inr(doc.taxAmount)} charged.`,
    evidence: {
      subtotal: doc.subtotal,
      tax_amount: doc.taxAmount,
      implied_rate_pct: Math.round(impliedRate * 100) / 100,
      nearest_slab_pct: nearest,
      expected_tax_at_nearest_slab: expectedTax,
      difference,
    },
  }
}

/**
 * IGST charged where CGST+SGST was due, or the reverse.
 *
 * The buyer pays the same either way, which is why this goes unnoticed — but the
 * credit is unclaimable until the supplier amends the return, so the cost is
 * real and it is the full tax amount, not a fraction of it.
 *
 * Abstains whenever either state is unknown. In the pilot corpus the place of
 * supply is printed on the GST invoices and absent on everything else, so
 * abstaining is the common path, not the exception.
 */
export function detectGstTypeMismatch(doc: DocumentFacts): FlagProposal | null {
  if (doc.taxBreakdown == null) return null
  if (doc.instrumentType !== 'tax_invoice') return null

  const supplier = validateGstin(doc.vendorGstin)
  if (!supplier.valid) return null

  const interstate = isInterstateSupply(supplier.stateCode, doc.placeOfSupplyStateCode)
  if (interstate === null) return null

  const igst = doc.taxBreakdown.igst?.amount ?? 0
  const cgst = doc.taxBreakdown.cgst?.amount ?? 0
  const sgst = doc.taxBreakdown.sgst?.amount ?? 0

  // Nothing charged under either head — that is gst_not_charged's territory.
  if (igst === 0 && cgst === 0 && sgst === 0) return null

  const chargedIgst = igst > 0
  const chargedIntraState = cgst > 0 || sgst > 0

  // Correct in both directions: interstate wants IGST alone, intrastate wants
  // the CGST/SGST pair alone.
  if (interstate && chargedIgst && !chargedIntraState) return null
  if (!interstate && chargedIntraState && !chargedIgst) return null

  const wrongAmount = interstate ? cgst + sgst : igst
  const expected = interstate ? 'IGST' : 'CGST + SGST'
  const charged = chargedIgst && chargedIntraState ? 'both IGST and CGST/SGST' : chargedIgst ? 'IGST' : 'CGST + SGST'

  return {
    flagType: 'gst_type_mismatch',
    dedupKey: `gst_type_mismatch:${doc.documentExtractionId}`,
    severity: severityForAmount(wrongAmount || doc.taxAmount),
    entryId: doc.entryId,
    vendorId: doc.vendorId,
    amountAtRisk: wrongAmount || doc.taxAmount,
    description:
      `Supply from ${supplier.stateName ?? `state ${supplier.stateCode}`} to state ` +
      `${doc.placeOfSupplyStateCode} is ${interstate ? 'inter' : 'intra'}-state and should carry ` +
      `${expected}, but the invoice charges ${charged}. The credit is not claimable until the ` +
      `supplier amends it.`,
    evidence: {
      supplier_state_code: supplier.stateCode,
      place_of_supply_state_code: doc.placeOfSupplyStateCode,
      is_interstate: interstate,
      expected_head: expected,
      igst_amount: igst,
      cgst_amount: cgst,
      sgst_amount: sgst,
    },
  }
}

/** Every per-document detector, in the order they are evaluated. */
const DOCUMENT_DETECTORS = [
  detectGstinInvalid,
  detectGstinMissing,
  detectGstNotCharged,
  detectTaxMathMismatch,
  detectGstRateAnomaly,
  detectGstTypeMismatch,
] as const

/**
 * Runs every per-document compliance detector against one verified document.
 *
 * Unverified extractions are skipped outright. Flagging a compliance problem off
 * an unreviewed OCR read means the reviewer is chasing the model's mistakes
 * rather than the vendor's, and the correction log (§9.2) shows those mistakes
 * are common enough to swamp the real findings.
 */
export function runComplianceDetectors(doc: DocumentFacts): FlagProposal[] {
  if (doc.verifiedAt == null) return []

  const proposals: FlagProposal[] = []
  for (const detector of DOCUMENT_DETECTORS) {
    const proposal = detector(doc)
    if (proposal !== null) proposals.push(proposal)
  }
  return proposals
}
