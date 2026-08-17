import { describe, expect, it } from 'vitest'
import {
  buildTaxBreakdown,
  extractionResponseSchema,
  extractionToolInputSchema,
  INSTRUMENT_TYPES,
  sanitizeExtractionResponse,
  type ExtractionResponse,
} from '@/lib/extraction-schema'

/**
 * Base wire-shaped payload: every field present, matching what
 * `extractionToolInputSchema` (`strict: true`) actually sends back — text
 * fields are plain strings (`""` for absent, never `null`), numbers are
 * `number | null`. Individual tests override only what they're exercising.
 */
function baseInput(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

describe('extractionResponseSchema — new fields round-trip', () => {
  it.each(INSTRUMENT_TYPES)('accepts %s as a valid instrument_type', (value) => {
    const parsed = extractionResponseSchema.parse(baseInput({ instrument_type: value }))
    expect(parsed.instrument_type).toBe(value)
  })

  it('maps an unrecognized non-empty instrument_type to "other"', () => {
    const parsed = extractionResponseSchema.parse(baseInput({ instrument_type: 'credit_note' }))
    expect(parsed.instrument_type).toBe('other')
  })

  it('maps an empty-string instrument_type to null (absent, not classified)', () => {
    const parsed = extractionResponseSchema.parse(baseInput({ instrument_type: '' }))
    expect(parsed.instrument_type).toBeNull()
  })

  it('trims whitespace before matching instrument_type', () => {
    const parsed = extractionResponseSchema.parse(baseInput({ instrument_type: '  bill_of_supply  ' }))
    expect(parsed.instrument_type).toBe('bill_of_supply')
  })

  it('round-trips place_of_supply as text, empty string becomes null', () => {
    const withValue = extractionResponseSchema.parse(baseInput({ place_of_supply: '27' }))
    expect(withValue.place_of_supply).toBe('27')

    const absent = extractionResponseSchema.parse(baseInput({ place_of_supply: '' }))
    expect(absent.place_of_supply).toBeNull()
  })

  it('round-trips round_off, including the legitimate 0 value', () => {
    const zero = extractionResponseSchema.parse(baseInput({ round_off: 0 }))
    expect(zero.round_off).toBe(0)

    const negative = extractionResponseSchema.parse(baseInput({ round_off: -0.4 }))
    expect(negative.round_off).toBe(-0.4)

    const absent = extractionResponseSchema.parse(baseInput({ round_off: null }))
    expect(absent.round_off).toBeNull()
  })

  it('round-trips cgst_amount/sgst_amount/igst_amount independently', () => {
    const parsed = extractionResponseSchema.parse(
      baseInput({ cgst_amount: 270, sgst_amount: 270, igst_amount: null })
    )
    expect(parsed.cgst_amount).toBe(270)
    expect(parsed.sgst_amount).toBe(270)
    expect(parsed.igst_amount).toBeNull()
  })
})

describe('buildTaxBreakdown', () => {
  function extraction(overrides: Partial<ExtractionResponse> = {}): ExtractionResponse {
    return {
      ...extractionResponseSchema.parse(baseInput({ cgst_amount: null, sgst_amount: null, igst_amount: null })),
      ...overrides,
    }
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
      baseInput({
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
      })
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
    expect(cleaned.vendor_gstin).toBeNull()
    expect(blankedFields).toEqual(['vendor_gstin'])
    // Everything else on the header is untouched, not just vendor_gstin.
    expect(cleaned.vendor_name).toBe(extraction.vendor_name)
    expect(cleaned.invoice_number).toBe(extraction.invoice_number)
  })

  it('blanks a line-item field containing leaked tag syntax, tagged by index', () => {
    const extraction = extractionWithLineItems({}, { description: 'Chairs <parameter name="foo">' })
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(cleaned.line_items[0]?.description).toBeNull()
    expect(blankedFields).toEqual(['line_items[0].description'])
    // The rest of the line item survives untouched.
    expect(cleaned.line_items[0]?.hsn_sac_code).toBe('9401')
    expect(cleaned.line_items[0]?.line_amount).toBe(2000)
  })

  it('reports every blanked field across header and line items in one call', () => {
    const extraction = extractionWithLineItems({ vendor_phone: '<foo>' }, { discount_note: '</bar>' })
    const { blankedFields } = sanitizeExtractionResponse(extraction)
    expect(blankedFields).toEqual(['vendor_phone', 'line_items[0].discount_note'])
  })

  it('does not flag a bare angle bracket that is not tag-shaped', () => {
    // "<" not immediately followed by a word/namespace token is real invoice
    // text (e.g. a quantity threshold), not leaked formatting.
    const extraction = extractionWithLineItems({ notes: 'Item < 5kg, price > 100' })
    const { cleaned, blankedFields } = sanitizeExtractionResponse(extraction)
    expect(blankedFields).toEqual([])
    expect(cleaned.notes).toBe('Item < 5kg, price > 100')
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
      expect(cleaned.line_items[0]?.discount_note).toBe(text)
    }
  )
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

  it('the four new fields (round_off, cgst/sgst/igst_amount) are exactly 4 new union parameters', () => {
    // Pre-existing count, from before this change: subtotal, tax_amount,
    // total_amount, skip_reason, quantity, list_rate, discount_pct, net_rate,
    // line_amount = 9. New: round_off, cgst_amount, sgst_amount, igst_amount = 4.
    // instrument_type and place_of_supply are plain (non-union) strings and add none.
    const count = countUnionTypedProperties(extractionToolInputSchema)
    expect(count).toBe(13)
  })
})
