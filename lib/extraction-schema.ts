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

/**
 * A text field whose "absent" value is an empty string on the wire, normalised
 * back to `null` here.
 *
 * A `strict: true` tool caps how many parameters may be union-typed
 * (nullable counts as a union): more than 16 and the request is rejected with
 *   400 invalid_request_error: "Schemas contains too many parameters with
 *   union types (21 parameters with type arrays or anyOf) ... limit: 16"
 * This schema legitimately needs ~21 optional fields, so the text ones give up
 * their `| null` on the wire and use `""` for "illegible or genuinely absent"
 * instead. Numbers keep `| null`, because 0 is a real invoice value and there
 * is no safe numeric sentinel.
 *
 * The transform means no consumer ever sees `""`: `document_extraction` and
 * `document_extraction_line_item` receive SQL NULL exactly as before, so the
 * §3.8 column semantics and the `_ocr`/`_verified` correction log are
 * unaffected. `null` is still accepted as input for robustness.
 */
const absentTextAsNull = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null || value.trim() === '' ? null : value))

/**
 * `invoice_date` normalised to ISO `YYYY-MM-DD`, or null.
 *
 * `document_extraction.invoice_date_ocr` is a real `date` column, so anything
 * that is not a valid ISO date is a write error, not a data-quality nuance:
 * a real sample came back as "15/08/2025" and Postgres rejected the insert
 * with `date/time field value out of range`.
 *
 * Indian invoices are overwhelmingly written DD/MM/YYYY, so a slash- or
 * dot-separated date is read day-first. When the first component is > 12 that
 * is unambiguous; when both are <= 12 the day-first reading is the local
 * convention and is what these vendors use. Anything still unparseable becomes
 * null — a reviewer types the right date on the review screen (Day 4), which
 * is far better than a confidently wrong one or a failed run.
 */
const isoDateOrNull = z
  .union([z.string(), z.null()])
  .transform((value) => {
    if (value === null) return null
    const raw = value.trim()
    if (raw === '') return null

    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
    if (iso) return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!) ? raw : null

    const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw)
    if (dayFirst) {
      const day = +dayFirst[1]!
      const month = +dayFirst[2]!
      const year = +dayFirst[3]!
      if (!isRealDate(year, month, day)) return null
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }

    return null
  })

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

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
  description: absentTextAsNull,
  hsn_sac_code: absentTextAsNull,
  quantity: z.number().nullable(),
  quantity_raw_text: absentTextAsNull,
  unit: absentTextAsNull,
  list_rate: z.number().nullable(),
  discount_pct: z.number().nullable(),
  discount_note: absentTextAsNull,
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

  vendor_name: absentTextAsNull,
  vendor_gstin: absentTextAsNull,
  vendor_phone: absentTextAsNull,
  vendor_address: absentTextAsNull,
  invoice_number: absentTextAsNull,
  /** ISO 8601 date string (`YYYY-MM-DD`), or null when not legible/present. */
  invoice_date: isoDateOrNull,
  subtotal: z.number().nullable(),
  tax_amount: z.number().nullable(),
  total_amount: z.number().nullable(),
  notes: absentTextAsNull,

  line_items: z.array(extractionLineItemSchema),
})
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>

// ---------------------------------------------------------------------------
// Hand-written JSON schema — the Anthropic tool `input_schema` wire shape
// ---------------------------------------------------------------------------

/**
 * Text fields are plain (non-union) strings on the wire and use `""` for
 * "absent" — see `absentTextAsNull` above for why, and for the normalisation
 * back to null. Numbers stay nullable: 0 is a real invoice value.
 */
const textField = { type: 'string' } as const
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const

/**
 * NOTE — no `minimum` / `maximum` / `minItems` anywhere below.
 *
 * A `strict: true` tool compiles its `input_schema` into a constrained decoder,
 * and that decoder supports only a subset of JSON Schema: numerical
 * constraints (`minimum`, `maximum`, `multipleOf`), string-length constraints,
 * and complex array constraints are all rejected. Sending them is not ignored
 * — the request fails outright with
 *   400 invalid_request_error: "tools.0.custom: For 'integer' type, property
 *   'minimum' is not supported"
 * which is what every extraction call did until this was stripped.
 *
 * Nothing is lost: the bounds still exist on the Zod schema above, which is
 * what actually validates the model's output in `extractDocument`. Range
 * checking simply happens on our side of the wire instead of the model's.
 * (This is exactly what the Python/TS SDK helpers do automatically when they
 * convert a Pydantic/Zod schema; this schema is hand-written, so it is done
 * by hand.)
 */
export const extractionToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_number: { type: 'integer' },
          is_financial_document: { type: 'boolean' },
          skip_reason: {
            anyOf: [{ type: 'string', enum: [...SKIP_REASONS] }, { type: 'null' }],
          },
          classification_confidence: { type: 'number' },
        },
        required: ['page_number', 'is_financial_document', 'skip_reason', 'classification_confidence'],
      },
    },
    legibility: { type: 'string', enum: [...LEGIBILITY_VALUES] },
    extraction_confidence: { type: 'number' },
    contains_non_latin_script: { type: 'boolean' },

    vendor_name: textField,
    vendor_gstin: textField,
    vendor_phone: textField,
    vendor_address: textField,
    invoice_number: textField,
    invoice_date: textField,
    subtotal: nullableNumber,
    tax_amount: nullableNumber,
    total_amount: nullableNumber,
    notes: textField,

    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_number: { type: 'integer' },
          line_order: { type: 'integer' },
          description: textField,
          hsn_sac_code: textField,
          quantity: nullableNumber,
          quantity_raw_text: textField,
          unit: textField,
          list_rate: nullableNumber,
          discount_pct: nullableNumber,
          discount_note: textField,
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
  'line item, each tagged with the page it was read from. Write invoice_date as ISO YYYY-MM-DD (the ' +
  'source is usually DD/MM/YYYY — convert it). For anything illegible or genuinely absent, use an ' +
  'empty string in a text field and null in a numeric field — never guess or fabricate a value.'

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
