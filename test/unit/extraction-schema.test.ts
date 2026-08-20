import { describe, expect, it } from 'vitest'
import {
  buildTaxBreakdown,
  dropEmptyBills,
  extractionResponseSchema,
  extractionToolInputSchema,
  INSTRUMENT_TYPES,
  remapExtractionToActualPage,
  sanitizeExtractionResponse,
  type ExtractionBill,
  type ExtractionResponse,
} from '@/lib/extraction-schema'

/**
 * Base wire-shaped payload: every field present, matching what
 * `extractionToolInputSchema` (`strict: true`) actually sends back — text
 * fields are plain strings (`""` for absent, never `null`), numbers are
 * `number | null`. `bills[]` (Phase 2) replaces the old flat header fields +
 * top-level `line_items[]`; one bill is present by default.
 *
 * `rootOverrides` merges into the response root (pages, legibility, ... and,
 * if a test wants to replace `bills` wholesale, `bills` itself).
 * `billOverrides` merges into `bills[0]` — the common case of exercising one
 * header field or `line_items` without having to restate the whole bill.
 */
function baseInput(rootOverrides: Record<string, unknown> = {}, billOverrides: Record<string, unknown> = {}) {
  return {
    pages: [
      {
        page_number: 1,
        is_financial_document: true,
        skip_reason: null,
        classification_confidence: 0.95,
      },
    ],
    legibility: 'clear',
    extraction_confidence: 0.9,
    contains_non_latin_script: false,
    bills: [
      {
        page_number_start: 1,
        page_number_end: 1,
        instrument_type: 'tax_invoice',
        vendor_name: 'Adinath Furniture Pvt Ltd',
        vendor_gstin: '24AAKCA3560A1Z7',
        vendor_phone: '',
        vendor_email: '',
        vendor_address: '',
        invoice_number: 'AFPL/SOS/TI/65',
        invoice_date: '13/08/2025',
        place_of_supply: 'Maharashtra',
        subtotal: 3000,
        cgst_amount: null,
        sgst_amount: null,
        igst_amount: 540,
        tax_amount: 540,
        round_off: null,
        total_amount: 3540,
        notes: '',
        line_items: [],
        ...billOverrides,
      },
    ],
    ...rootOverrides,
  }
}

describe('extractionResponseSchema — new fields round-trip', () => {
  it.each(INSTRUMENT_TYPES)('accepts %s as a valid instrument_type', (value) => {
    const parsed = extractionResponseSchema.parse(baseInput({}, { instrument_type: value }))
    expect(parsed.bills[0]!.instrument_type).toBe(value)
  })

  it('maps an unrecognized non-empty instrument_type to "other"', () => {
    const parsed = extractionResponseSchema.parse(baseInput({}, { instrument_type: 'credit_note' }))
    expect(parsed.bills[0]!.instrument_type).toBe('other')
  })

  it('maps an empty-string instrument_type to null (absent, not classified)', () => {
    const parsed = extractionResponseSchema.parse(baseInput({}, { instrument_type: '' }))
    expect(parsed.bills[0]!.instrument_type).toBeNull()
  })

  it('trims whitespace before matching instrument_type', () => {
    const parsed = extractionResponseSchema.parse(baseInput({}, { instrument_type: '  bill_of_supply  ' }))
    expect(parsed.bills[0]!.instrument_type).toBe('bill_of_supply')
  })

  it('round-trips place_of_supply as text, empty string becomes null', () => {
    const withValue = extractionResponseSchema.parse(baseInput({}, { place_of_supply: '27' }))
    expect(withValue.bills[0]!.place_of_supply).toBe('27')

    const absent = extractionResponseSchema.parse(baseInput({}, { place_of_supply: '' }))
    expect(absent.bills[0]!.place_of_supply).toBeNull()
  })

  it('round-trips round_off, including the legitimate 0 value', () => {
    const zero = extractionResponseSchema.parse(baseInput({}, { round_off: 0 }))
    expect(zero.bills[0]!.round_off).toBe(0)

    const negative = extractionResponseSchema.parse(baseInput({}, { round_off: -0.4 }))
    expect(negative.bills[0]!.round_off).toBe(-0.4)

    const absent = extractionResponseSchema.parse(baseInput({}, { round_off: null }))
    expect(absent.bills[0]!.round_off).toBeNull()
  })

  it('round-trips cgst_amount/sgst_amount/igst_amount independently', () => {
    const parsed = extractionResponseSchema.parse(
      baseInput({}, { cgst_amount: 270, sgst_amount: 270, igst_amount: null })
    )
    expect(parsed.bills[0]!.cgst_amount).toBe(270)
    expect(parsed.bills[0]!.sgst_amount).toBe(270)
    expect(parsed.bills[0]!.igst_amount).toBeNull()
  })

  it('accepts multiple bills, each with its own page range and header fields', () => {
    const parsed = extractionResponseSchema.parse(
      baseInput({
        bills: [
          {
            page_number_start: 1,
            page_number_end: 2,
            instrument_type: 'tax_invoice',
            vendor_name: 'Vendor One',
            vendor_gstin: '',
            vendor_phone: '',
            vendor_email: '',
            vendor_address: '',
            invoice_number: 'INV-1',
            invoice_date: '',
            place_of_supply: '',
            subtotal: 1000,
            cgst_amount: null,
            sgst_amount: null,
            igst_amount: null,
            tax_amount: null,
            round_off: null,
            total_amount: 1000,
            notes: '',
            line_items: [],
          },
          {
            page_number_start: 3,
            page_number_end: 3,
            instrument_type: 'retail_cash_memo',
            vendor_name: 'Vendor Two',
            vendor_gstin: '',
            vendor_phone: '',
            vendor_email: '',
            vendor_address: '',
            invoice_number: 'INV-2',
            invoice_date: '',
            place_of_supply: '',
            subtotal: 500,
            cgst_amount: null,
            sgst_amount: null,
            igst_amount: null,
            tax_amount: null,
            round_off: null,
            total_amount: 500,
            notes: '',
            line_items: [],
          },
        ],
      })
    )
    expect(parsed.bills).toHaveLength(2)
    expect(parsed.bills[0]!.vendor_name).toBe('Vendor One')
    expect(parsed.bills[0]!.page_number_start).toBe(1)
    expect(parsed.bills[0]!.page_number_end).toBe(2)
    expect(parsed.bills[1]!.vendor_name).toBe('Vendor Two')
    expect(parsed.bills[1]!.page_number_start).toBe(3)
  })

  it('accepts an empty bills array — a page classified as non-financial has none', () => {
    // Was "rejects" under the old whole-document design (bills: z.array(...).min(1)).
    // Per-page extraction (lib/jobs/handlers/extract.ts) sends one page per call, and
    // a page that's a cheque photo or a permission letter has zero bills by definition
    // — see extractionResponseSchema's doc comment.
    const parsed = extractionResponseSchema.parse(baseInput({ bills: [] }))
    expect(parsed.bills).toEqual([])
  })
})

describe('buildTaxBreakdown', () => {
  function extraction(overrides: Partial<ExtractionBill> = {}): ExtractionBill {
    const bill = extractionResponseSchema.parse(
      baseInput({}, { cgst_amount: null, sgst_amount: null, igst_amount: null })
    ).bills[0]!
    return { ...bill, ...overrides }
  }

  it('returns null when none of the three components were extracted', () => {
    expect(buildTaxBreakdown(extraction())).toBeNull()
  })

  it('builds the intrastate (CGST+SGST) shape, igst null, cess always null', () => {
    // Creative Frames & Decor style invoice — intrastate Gujarat-to-Gujarat supply.
    const result = buildTaxBreakdown(extraction({ cgst_amount: 135, sgst_amount: 135, igst_amount: null }))
    expect(result).toEqual({
      cgst: { rate: null, amount: 135 },
      sgst: { rate: null, amount: 135 },
      igst: null,
      cess: null,
    })
  })

  it('builds the interstate (IGST) shape, cgst/sgst null', () => {
    // Adinath Furniture — Surat (Gujarat) supplier billing a Maharashtra buyer.
    const result = buildTaxBreakdown(extraction({ cgst_amount: null, sgst_amount: null, igst_amount: 540 }))
    expect(result).toEqual({
      cgst: null,
      sgst: null,
      igst: { rate: null, amount: 540 },
      cess: null,
    })
  })

  it('never populates rate — only amount is captured on the wire', () => {
    const result = buildTaxBreakdown(extraction({ cgst_amount: 100, sgst_amount: 100, igst_amount: null }))
    expect(result?.cgst?.rate).toBeNull()
    expect(result?.sgst?.rate).toBeNull()
  })
})

describe('sanitizeExtractionResponse — leaked tool-call tag syntax backstop (§3b)', () => {
  /**
   * Real example from hub-refinements-plan.md §3b: a GSTIN field once showed
   * `</antml.parameter><parameter name="vendor_phone">+91 9925755` — Claude's
   * own internal tool-call formatting leaked into the field's text content.
   */
  const LEAKED_TAG_EXAMPLE = '</antml.parameter><parameter name="vendor_phone">+91 9925755'

  function extractionWithLineItems(
    headerOverrides: Record<string, unknown> = {},
    lineItemOverrides: Record<string, unknown> = {}
  ): ExtractionResponse {
    return extractionResponseSchema.parse(
      baseInput(
        {},
        {
          ...headerOverrides,
          line_items: [
            {
              page_number: 1,
              line_order: 0,
              description: 'Chairs x4',
              hsn_sac_code: '9401',
              quantity: 4,
              quantity_raw_text: '4 nos',
              unit: 'NOS',
              list_rate: 500,
              discount_pct: 0,
              discount_note: '',
              net_rate: 500,
              line_amount: 2000,
              ...lineItemOverrides,
            },
          ],
        }
      )
    )
  }

  it('passes a clean extraction through untouched', () => {
    const extraction = extractionWithLineItems()
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(blankedFields).toEqual([])
    expect(cleaned).toEqual(extraction)
  })

  it('blanks a header field containing leaked tool-call tag syntax', () => {
    const extraction = extractionWithLineItems({ vendor_gstin: LEAKED_TAG_EXAMPLE })
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(cleaned.bills[0]?.vendor_gstin).toBeNull()
    expect(blankedFields).toEqual(['bills[0].vendor_gstin'])
    // Everything else on the header is untouched, not just vendor_gstin.
    expect(cleaned.bills[0]?.vendor_name).toBe(extraction.bills[0]?.vendor_name)
    expect(cleaned.bills[0]?.invoice_number).toBe(extraction.bills[0]?.invoice_number)
  })

  it('blanks a line-item field containing leaked tag syntax, tagged by bill and line index', () => {
    const extraction = extractionWithLineItems({}, { description: 'Chairs <parameter name="foo">' })
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(cleaned.bills[0]?.line_items[0]?.description).toBeNull()
    expect(blankedFields).toEqual(['bills[0].line_items[0].description'])
    // The rest of the line item survives untouched.
    expect(cleaned.bills[0]?.line_items[0]?.hsn_sac_code).toBe('9401')
    expect(cleaned.bills[0]?.line_items[0]?.line_amount).toBe(2000)
  })

  it('reports every blanked field across header and line items in one call', () => {
    const extraction = extractionWithLineItems({ vendor_phone: '<foo>' }, { discount_note: '</bar>' })
    const { blankedFields } = sanitizeExtractionResponse(extraction)
    expect(blankedFields).toEqual(['bills[0].vendor_phone', 'bills[0].line_items[0].discount_note'])
  })

  it('does not flag a bare angle bracket that is not tag-shaped', () => {
    // "<" not immediately followed by a word/namespace token is real invoice
    // text (e.g. a quantity threshold), not leaked formatting.
    const extraction = extractionWithLineItems({ notes: 'Item < 5kg, price > 100' })
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(blankedFields).toEqual([])
    expect(cleaned.bills[0]?.notes).toBe('Item < 5kg, price > 100')
  })

  it.each([
    'Item<5kg box, discount>10%',
    'Rate<100, Qty>5',
    'Weight <100kg, discount >50Rs applies',
  ])(
    'does not flag an unspaced numeric comparison as tag-shaped: %s',
    (text) => {
      // Regression: an earlier version of LEAKED_TAG_PATTERN let a digit open
      // the "tag name" and let arbitrary text span to the next `>`, so real
      // line-item text using `<`/`>` as comparators was wrongly blanked.
      const extraction = extractionWithLineItems({}, { discount_note: text })
      const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
      expect(blankedFields).toEqual([])
      expect(cleaned.bills[0]?.line_items[0]?.discount_note).toBe(text)
    }
  )

  it('scopes blanked-field names to the right bill in a multi-bill document', () => {
    const parsed = extractionResponseSchema.parse(
      baseInput({
        pages: [
          { page_number: 1, is_financial_document: true, skip_reason: null, classification_confidence: 0.95 },
          { page_number: 2, is_financial_document: true, skip_reason: null, classification_confidence: 0.95 },
        ],
        bills: [
          {
            page_number_start: 1,
            page_number_end: 1,
            instrument_type: 'tax_invoice',
            vendor_name: 'Vendor One',
            vendor_gstin: '',
            vendor_phone: '',
            vendor_email: '',
            vendor_address: '',
            invoice_number: 'INV-1',
            invoice_date: '',
            place_of_supply: '',
            subtotal: null,
            cgst_amount: null,
            sgst_amount: null,
            igst_amount: null,
            tax_amount: null,
            round_off: null,
            total_amount: null,
            notes: '',
            line_items: [],
          },
          {
            page_number_start: 2,
            page_number_end: 2,
            instrument_type: 'tax_invoice',
            vendor_name: 'Vendor Two',
            vendor_gstin: LEAKED_TAG_EXAMPLE,
            vendor_phone: '',
            vendor_email: '',
            vendor_address: '',
            invoice_number: 'INV-2',
            invoice_date: '',
            place_of_supply: '',
            subtotal: null,
            cgst_amount: null,
            sgst_amount: null,
            igst_amount: null,
            tax_amount: null,
            round_off: null,
            total_amount: null,
            notes: '',
            line_items: [],
          },
        ],
      })
    )
    const { cleaned, blankedFields } = sanitizeExtractionResponse(parsed)
    expect(blankedFields).toEqual(['bills[1].vendor_gstin'])
    expect(cleaned.bills[0]?.vendor_gstin).toBe(parsed.bills[0]?.vendor_gstin)
    expect(cleaned.bills[1]?.vendor_gstin).toBeNull()
  })
})

describe('extractionToolInputSchema — union-type parameter budget', () => {
  /**
   * A `strict: true` Anthropic tool rejects a schema with more than 16
   * union-typed (`anyOf`/type-array) parameters, counted across the whole
   * tool — top-level fields AND fields nested inside array `items` — not
   * just top-level fields (see the comment above `absentTextAsNull` in
   * lib/extraction-schema.ts, which documents the real 400 this hit in
   * production once). This test walks the actual schema object rather than
   * hard-coding a number, so it fails loudly if a future change pushes the
   * count over budget instead of silently shipping a broken tool definition.
   */
  function countUnionTypedProperties(schema: unknown): number {
    if (schema === null || typeof schema !== 'object') return 0
    let count = 0
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const propSchema of Object.values(value as Record<string, unknown>)) {
          if (
            propSchema &&
            typeof propSchema === 'object' &&
            'anyOf' in (propSchema as Record<string, unknown>)
          ) {
            count += 1
          }
          count += countUnionTypedProperties(propSchema)
        }
      } else if (typeof value === 'object') {
        count += countUnionTypedProperties(value)
      }
    }
    return count
  }

  it('stays at or under the 16-parameter limit observed in production', () => {
    const count = countUnionTypedProperties(extractionToolInputSchema)
    expect(count).toBeLessThanOrEqual(16)
  })

  it('moving header fields under bills.items.properties does not add new union parameters', () => {
    // Pre-existing count, unchanged by the Phase 2 bills[] move: skip_reason
    // (pages.items) = 1; subtotal, tax_amount, total_amount, cgst_amount,
    // sgst_amount, igst_amount, round_off (bills.items) = 7; quantity,
    // list_rate, discount_pct, net_rate, line_amount (bills.items.line_items.items)
    // = 5. Total 13 — same total as before the move, since instrument_type,
    // vendor_*, invoice_number, invoice_date, place_of_supply, notes stay
    // plain (non-union) strings and page_number_start/page_number_end are
    // plain integers, none of which were ever union-typed.
    const count = countUnionTypedProperties(extractionToolInputSchema)
    expect(count).toBe(13)
  })
})

describe('dropEmptyBills — per-page extraction phantom-bill backstop', () => {
  function parsed(billOverrides: Record<string, unknown> = {}): ExtractionResponse {
    return extractionResponseSchema.parse(baseInput({}, billOverrides))
  }

  it('keeps a bill with a real total_amount', () => {
    const result = dropEmptyBills(parsed({ total_amount: 3540 }))
    expect(result.bills).toHaveLength(1)
  })

  it('keeps a bill with no total_amount but a line item carrying an amount', () => {
    const result = dropEmptyBills(
      parsed({
        total_amount: null,
        line_items: [
          {
            page_number: 1,
            line_order: 0,
            description: 'Item',
            hsn_sac_code: '',
            quantity: null,
            quantity_raw_text: '',
            unit: '',
            list_rate: null,
            discount_pct: null,
            discount_note: '',
            net_rate: null,
            line_amount: 500,
          },
        ],
      })
    )
    expect(result.bills).toHaveLength(1)
  })

  it('drops a bill with a vendor name and invoice number but no amount anywhere', () => {
    // The exact shape a misclassified non-financial page (a government ID
    // card, a bank cheque) produced on the first real test of per-page
    // extraction: a plausible-looking name lifted from printed text, no real
    // charge behind it.
    const result = dropEmptyBills(
      parsed({
        vendor_name: 'Income Tax Department',
        invoice_number: 'IHBPS6933J',
        total_amount: null,
        line_items: [],
      })
    )
    expect(result.bills).toHaveLength(0)
  })

  it('drops a bill with every field null and no line items', () => {
    const result = dropEmptyBills(
      parsed({
        vendor_name: '',
        invoice_number: '',
        total_amount: null,
        line_items: [],
      })
    )
    expect(result.bills).toHaveLength(0)
  })
})

describe('remapExtractionToActualPage — per-page extraction page-number correction', () => {
  it('rewrites the page classification, bill page range, and line item page numbers all to the real page number', () => {
    const extraction = extractionResponseSchema.parse(
      baseInput(
        {},
        {
          line_items: [
            {
              page_number: 1,
              line_order: 0,
              description: 'Item',
              hsn_sac_code: '',
              quantity: null,
              quantity_raw_text: '',
              unit: '',
              list_rate: null,
              discount_pct: null,
              discount_note: '',
              net_rate: null,
              line_amount: 500,
            },
          ],
        }
      )
    )
    // Sanity check on the fixture itself: a split single-page PDF always
    // reports page 1, regardless of which page of the original document it
    // actually was.
    expect(extraction.pages[0]!.page_number).toBe(1)

    const remapped = remapExtractionToActualPage(extraction, 6)

    expect(remapped.pages[0]!.page_number).toBe(6)
    expect(remapped.bills[0]!.page_number_start).toBe(6)
    expect(remapped.bills[0]!.page_number_end).toBe(6)
    expect(remapped.bills[0]!.line_items[0]!.page_number).toBe(6)
  })

  it('does not mutate the input', () => {
    const extraction = extractionResponseSchema.parse(baseInput())
    remapExtractionToActualPage(extraction, 4)
    expect(extraction.pages[0]!.page_number).toBe(1)
    expect(extraction.bills[0]!.page_number_start).toBe(1)
  })
})
