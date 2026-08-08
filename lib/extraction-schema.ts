/**
 * Single source of truth for the Claude tool-use extraction schema
 * (MASTER-PLAN §8, §3.8).
 *
 * The Zod schema below is the runtime-validated shape of what
 * `lib/claude-client.ts` gets back from the model. The hand-written JSON
 * schema (`extractionToolInputSchema`) is the wire shape sent to Claude as
 * the tool's `input_schema` — the two are kept in this one file, side by
 * side, so a field can never drift between "what we ask for" and "what we
 * validate," and both map field-for-field onto the `document_extraction` /
 * `document_extraction_line_item` columns in §3.8.
 *
 * package.json is frozen for this session, so this is a hand-written JSON
 * schema rather than a zod-to-json-schema conversion — there is no third
 * option that avoids a new dependency.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Zod schema — validated shape of the extraction response
// ---------------------------------------------------------------------------

export const SKIP_REASONS = ['bank_cheque', 'passbook', 'unrelated_document', 'blank', 'other'] as const
export const skipReasonSchema = z.enum(SKIP_REASONS)
export type SkipReason = z.infer<typeof skipReasonSchema>

export const LEGIBILITY_VALUES = ['clear', 'partial', 'poor'] as const
export const legibilitySchema = z.enum(LEGIBILITY_VALUES)
export type Legibility = z.infer<typeof legibilitySchema>

/** Per-page classification (§8 point 3: "classification-before-extraction is a real gate"). */
export const extractionPageSchema = z.object({
  page_number: z.number().int().positive(),
  is_financial_document: z.boolean(),
  skip_reason: skipReasonSchema.nullable(),
  classification_confidence: z.number().min(0).max(1),
})
export type ExtractionPage = z.infer<typeof extractionPageSchema>

/** One line item, tagged with the page it came from (§8, §3.8). */
export const extractionLineItemSchema = z.object({
  page_number: z.number().int().positive(),
  line_order: z.number().int().nonnegative(),
  description: z.string().nullable(),
  hsn_sac_code: z.string().nullable(),
  quantity: z.number().nullable(),
  quantity_raw_text: z.string().nullable(),
  unit: z.string().nullable(),
  list_rate: z.number().nullable(),
  discount_pct: z.number().nullable(),
  discount_note: z.string().nullable(),
  net_rate: z.number().nullable(),
  line_amount: z.number().nullable(),
})
export type ExtractionLineItem = z.infer<typeof extractionLineItemSchema>

/**
 * The full extraction response for one document (all pages, one call —
 * §8 point 3). Header fields map onto `document_extraction.*_ocr` columns;
 * `line_items[]` map onto `document_extraction_line_item.*_ocr` columns.
 */
export const extractionResponseSchema = z.object({
  pages: z.array(extractionPageSchema).min(1),
  legibility: legibilitySchema,
  extraction_confidence: z.number().min(0).max(1),
  contains_non_latin_script: z.boolean(),

  vendor_name: z.string().nullable(),
  vendor_gstin: z.string().nullable(),
  vendor_phone: z.string().nullable(),
  vendor_address: z.string().nullable(),
  invoice_number: z.string().nullable(),
  /** ISO 8601 date string (`YYYY-MM-DD`), or null when not legible/present. */
  invoice_date: z.string().nullable(),
  subtotal: z.number().nullable(),
  tax_amount: z.number().nullable(),
  total_amount: z.number().nullable(),
  notes: z.string().nullable(),

  line_items: z.array(extractionLineItemSchema),
})
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>

// ---------------------------------------------------------------------------
// Hand-written JSON schema — the Anthropic tool `input_schema` wire shape
// ---------------------------------------------------------------------------

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const

export const extractionToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_number: { type: 'integer', minimum: 1 },
          is_financial_document: { type: 'boolean' },
          skip_reason: {
            anyOf: [{ type: 'string', enum: [...SKIP_REASONS] }, { type: 'null' }],
          },
          classification_confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['page_number', 'is_financial_document', 'skip_reason', 'classification_confidence'],
      },
    },
    legibility: { type: 'string', enum: [...LEGIBILITY_VALUES] },
    extraction_confidence: { type: 'number', minimum: 0, maximum: 1 },
    contains_non_latin_script: { type: 'boolean' },

    vendor_name: nullableString,
    vendor_gstin: nullableString,
    vendor_phone: nullableString,
    vendor_address: nullableString,
    invoice_number: nullableString,
    invoice_date: nullableString,
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    total_amount: nullableNumber,
    notes: nullableString,

    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_number: { type: 'integer', minimum: 1 },
          line_order: { type: 'integer', minimum: 0 },
          description: nullableString,
          hsn_sac_code: nullableString,
          quantity: nullableNumber,
          quantity_raw_text: nullableString,
          unit: nullableString,
          list_rate: nullableNumber,
          discount_pct: nullableNumber,
          discount_note: nullableString,
          net_rate: nullableNumber,
          line_amount: nullableNumber,
        },
        required: [
          'page_number',
          'line_order',
          'description',
          'hsn_sac_code',
          'quantity',
          'quantity_raw_text',
          'unit',
          'list_rate',
          'discount_pct',
          'discount_note',
          'net_rate',
          'line_amount',
        ],
      },
    },
  },
  required: [
    'pages',
    'legibility',
    'extraction_confidence',
    'contains_non_latin_script',
    'vendor_name',
    'vendor_gstin',
    'vendor_phone',
    'vendor_address',
    'invoice_number',
    'invoice_date',
    'subtotal',
    'tax_amount',
    'total_amount',
    'notes',
    'line_items',
  ],
} as const

export const EXTRACTION_TOOL_NAME = 'record_document_extraction'

export const EXTRACTION_TOOL_DESCRIPTION =
  'Record the structured extraction of a financial document (invoice, chit, or receipt) that may span ' +
  'multiple pages. Classify every page first — only line items sourced from pages where ' +
  'is_financial_document is true will be kept. Extract header fields (vendor identity including GSTIN, ' +
  'phone, and address for later vendor-clustering; invoice number/date; subtotal/tax/total) and every ' +
  'line item, each tagged with the page it was read from. Use null for any field that is illegible or ' +
  'genuinely absent — never guess or fabricate a value.'

/** The exact shape `messages.create({ tools: [...] })` expects, with `strict: true`. */
export interface AnthropicStrictTool {
  name: string
  description: string
  input_schema: typeof extractionToolInputSchema
  strict: true
}

export function buildExtractionTool(): AnthropicStrictTool {
  return {
    name: EXTRACTION_TOOL_NAME,
    description: EXTRACTION_TOOL_DESCRIPTION,
    input_schema: extractionToolInputSchema,
    strict: true,
  }
}

// ---------------------------------------------------------------------------
// Pure post-processing
// ---------------------------------------------------------------------------

/**
 * Hard-drops line items whose source page was classified
 * `is_financial_document = false` (MASTER-PLAN §8 point 3:
 * "classification-before-extraction is a real gate rather than a prompt
 * instruction"). This is the code-level enforcement of that gate — it does
 * not trust the model to have already excluded them.
 */
export function filterNonFinancialLineItems(extraction: ExtractionResponse): ExtractionResponse {
  const financialPageNumbers = new Set(
    extraction.pages.filter((page) => page.is_financial_document).map((page) => page.page_number)
  )

  return {
    ...extraction,
    line_items: extraction.line_items.filter((item) => financialPageNumbers.has(item.page_number)),
  }
}
