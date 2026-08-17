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
import type { TaxBreakdown } from '@/lib/analytics/types'

// ---------------------------------------------------------------------------
// Zod schema — validated shape of the extraction response
// ---------------------------------------------------------------------------

export const SKIP_REASONS = [
  'bank_cheque',
  'passbook',
  'unrelated_document',
  'blank',
  'other',
  // Added by migration 20260814000002: a Gujarati land-permission letter in the
  // pilot corpus had nowhere correct to land and fell into 'unrelated_document',
  // which is wrong in a way that costs money later — these are REQUIRED
  // supporting documentation, not noise, and the missing_documentation detector
  // needs to tell the two apart.
  'permission_letter',
  'agreement',
  'photo',
] as const
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

/**
 * Mirrors the CHECK constraint on `document_extraction.instrument_type_ocr`
 * (migration 20260814000002). This is THE distinction a downstream compliance
 * detector needs: it cannot tell "unregistered vendor, no GST, that's fine"
 * from "tax invoice missing its GSTIN, that's a problem" without it.
 */
export const INSTRUMENT_TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'retail_cash_memo',
  'letterhead_bill',
  'proforma_invoice',
  'quotation',
  'receipt',
  'delivery_challan',
  'other',
] as const
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number]
const INSTRUMENT_TYPE_SET: ReadonlySet<string> = new Set(INSTRUMENT_TYPES)

/**
 * `instrument_type` is deliberately a plain (non-union) string on the wire —
 * see `textField` usage in `extractionToolInputSchema` below — rather than an
 * `enum`-constrained field. Combining a fixed value set with the `""`-for-
 * absent convention every other text field uses would be awkward: `""` is
 * neither a valid instrument type nor an obviously correct thing for the model
 * to write when it can't tell. Validation against the known set happens
 * entirely here instead, on the way in from the wire.
 *
 * Two decisions this transform makes:
 *  - Empty string (nothing extracted / page too poor to classify) becomes
 *    `null`, consistent with `absentTextAsNull` everywhere else.
 *  - A non-empty value that is NOT one of INSTRUMENT_TYPES becomes `'other'`
 *    rather than `null`. The model returning something recognisable-but-
 *    unlisted (e.g. it wrote "credit_note") is meaningfully different from it
 *    returning nothing — 'other' is exactly the bucket the CHECK constraint
 *    provides for that case, and collapsing it to `null` would make it
 *    indistinguishable from "not classified", defeating the column's purpose
 *    for the compliance detector.
 */
const instrumentTypeOrNull = z.string().transform((value): InstrumentType | null => {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return INSTRUMENT_TYPE_SET.has(trimmed) ? (trimmed as InstrumentType) : 'other'
})

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

  /** One of INSTRUMENT_TYPES, or null — see instrumentTypeOrNull above. */
  instrument_type: instrumentTypeOrNull,

  vendor_name: absentTextAsNull,
  vendor_gstin: absentTextAsNull,
  vendor_phone: absentTextAsNull,
  vendor_email: absentTextAsNull,
  vendor_address: absentTextAsNull,
  invoice_number: absentTextAsNull,
  /** ISO 8601 date string (`YYYY-MM-DD`), or null when not legible/present. */
  invoice_date: isoDateOrNull,
  /** Raw "Place of Supply" text as printed (e.g. "Maharashtra" or "27"). State
   *  code resolution happens downstream (lib/analytics/gstin.ts), not here. */
  place_of_supply: absentTextAsNull,
  subtotal: z.number().nullable(),
  /** CGST/SGST/IGST amounts — see buildTaxBreakdown below for how these three
   *  flat numbers become the nested tax_breakdown_ocr jsonb shape. Rates are
   *  intentionally not captured (see buildTaxBreakdown's comment). */
  cgst_amount: z.number().nullable(),
  sgst_amount: z.number().nullable(),
  igst_amount: z.number().nullable(),
  tax_amount: z.number().nullable(),
  /** Explicit "Round Off" line some invoices print. */
  round_off: z.number().nullable(),
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

    // Plain string, not enum-constrained — see instrumentTypeOrNull above for why.
    instrument_type: textField,

    vendor_name: textField,
    vendor_gstin: textField,
    vendor_phone: textField,
    vendor_email: textField,
    vendor_address: textField,
    invoice_number: textField,
    invoice_date: textField,
    place_of_supply: textField,
    subtotal: nullableNumber,
    cgst_amount: nullableNumber,
    sgst_amount: nullableNumber,
    igst_amount: nullableNumber,
    tax_amount: nullableNumber,
    round_off: nullableNumber,
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
    'instrument_type',
    'vendor_name',
    'vendor_gstin',
    'vendor_phone',
    'vendor_email',
    'vendor_address',
    'invoice_number',
    'invoice_date',
    'place_of_supply',
    'subtotal',
    'cgst_amount',
    'sgst_amount',
    'igst_amount',
    'tax_amount',
    'round_off',
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
  'phone, email, and address for later vendor-clustering; invoice number/date; subtotal/tax/total) and every ' +
  'line item, each tagged with the page it was read from. Write invoice_date as ISO YYYY-MM-DD (the ' +
  'source is usually DD/MM/YYYY — convert it). For anything illegible or genuinely absent, use an ' +
  'empty string in a text field and null in a numeric field — never guess or fabricate a value. Also ' +
  'classify instrument_type — one of tax_invoice, bill_of_supply, retail_cash_memo, letterhead_bill, ' +
  'proforma_invoice, quotation, receipt, delivery_challan, or other — since a GST tax invoice missing ' +
  'its GSTIN is a compliance problem while an unregistered vendor\'s cash memo charging no GST is not, ' +
  'and only the instrument type tells those two cases apart. When the document is a GST invoice, also ' +
  'capture place_of_supply (the state name or code printed as "Place of Supply") and report tax split ' +
  'by component — cgst_amount, sgst_amount, and igst_amount — instead of only a combined tax_amount, ' +
  'and capture round_off when the invoice prints an explicit rounding line.'

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

/**
 * Assembles the three flat CGST/SGST/IGST amounts captured on the wire into
 * the nested shape `document_extraction.tax_breakdown_ocr` (jsonb) and
 * `lib/analytics/types.ts`'s `TaxBreakdown` actually expect:
 *   { cgst: {rate, amount} | null, sgst: {...} | null, igst: {...} | null, cess: null }
 *
 * Modelling this as six-to-eight separate nested `anyOf`-typed sub-fields on
 * the wire tool schema (cgst_rate, cgst_amount, sgst_rate, sgst_amount, ...)
 * would have pushed the union-type count uncomfortably close to the 16 limit
 * documented above `extractionToolInputSchema`, for a per-component *rate*
 * that the compliance detector consuming this column does not actually read
 * — only `.amount` is load-bearing there (a deliberate scope decision, not an
 * oversight). So the wire schema stays flat (3 nullableNumber fields) and
 * this pure function does the reshaping on the way in, the same role
 * `filterNonFinancialLineItems` plays for line items. `rate` is always
 * written as null; `cess` is not captured on the wire at all (rare in the
 * pilot corpus) and is always null.
 *
 * Returns null — not an all-null object — when none of the three components
 * were extracted, consistent with every other "nothing here" value in this
 * schema and with tax_breakdown_ocr being a genuinely nullable column.
 */
export function buildTaxBreakdown(extraction: ExtractionResponse): TaxBreakdown | null {
  const { cgst_amount, sgst_amount, igst_amount } = extraction
  if (cgst_amount === null && sgst_amount === null && igst_amount === null) return null

  return {
    cgst: cgst_amount === null ? null : { rate: null, amount: cgst_amount },
    sgst: sgst_amount === null ? null : { rate: null, amount: sgst_amount },
    igst: igst_amount === null ? null : { rate: null, amount: igst_amount },
    cess: null,
  }
}

/**
 * Code-level backstop for leaked tool-call syntax in OCR text fields
 * (hub-refinements-plan.md §3b). Real example observed in production: a
 * GSTIN field showed `</antml.parameter><parameter name="vendor_phone">+91
 * 9925755` -- Claude's own internal tool-call formatting, leaked into the
 * field's text content. `strict: true` tool calling (lib/claude-client.ts,
 * buildExtractionTool) guarantees the JSON *structure* is valid but does not
 * constrain what text the model puts *inside* a string field, so a momentary
 * hallucination of the model's own formatting can end up as literal field
 * content -- the prompt instruction in buildSystemPrompt is Layer 1, this is
 * Layer 2, same "never trust the model alone" posture as
 * filterNonFinancialLineItems above and isOwnOrgGstin in
 * lib/jobs/handlers/extract.ts.
 *
 * Deliberately permissive rather than a strict XML/HTML parser, but not so
 * permissive that it catches numeric comparisons: real invoice/line-item
 * text legitimately contains unspaced `<`/`>` used as comparators (e.g.
 * "Rate<100, Qty>5", "Weight <100kg, discount >50Rs applies") -- a first
 * version of this pattern that allowed a digit to open the "tag name" and
 * let `[^>]*` span arbitrary text between the brackets wrongly blanked
 * exactly this kind of text. Two constraints fix that while still catching
 * the real leak shape: the tag name must start with a letter (real
 * tool-call/XML element names always do; a numeric comparator never does),
 * and anything after the tag name must look like well-formed attributes
 * (`\s+name="value"` or `\s+name`), not arbitrary text up to the next `>`.
 * A closing tag (`</...>`) is the strongest signal (the real-world example
 * above), but an opening tag reads the same way to a downstream consumer,
 * so both are caught by one pattern.
 */
const LEAKED_TAG_PATTERN =
  /<\/?[a-zA-Z][\w:.-]*(?:\s+[\w:.-]+(?:=(?:"[^"<>]*"|'[^'<>]*'|[^\s<>]+))?)*\s*\/?>/

/** Result of scanning one object's string fields for leaked tag syntax. */
export interface SanitizeLeakedTagSyntaxResult<T> {
  /** Shallow copy of the input, with every matching field set to null. */
  cleaned: T
  /** Field names (from `fields`) whose value was blanked. Empty when nothing matched. */
  blankedFields: string[]
}

/**
 * Scans the given fields of `obj` for tag-shaped content and blanks any that
 * match, same "blank it, don't write corrupted text" posture as
 * `isOwnOrgGstin` nulling `vendor_gstin_ocr` in lib/jobs/handlers/extract.ts.
 *
 * Generic over T rather than typed to ExtractionResponse directly: the same
 * scanning behaviour is needed for the header extraction object AND for each
 * line item (see HEADER_TEXT_FIELDS_TO_SANITIZE / LINE_ITEM_TEXT_FIELDS_TO_SANITIZE
 * below), and those two shapes share no common field list -- only the
 * mechanics of "check this field, blank it if it matches" are shared.
 */
export function sanitizeLeakedTagSyntax<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly (keyof T)[]
): SanitizeLeakedTagSyntaxResult<T> {
  // Mutated as a loosely-typed record rather than T directly: T's fields are
  // typed `string | null` (every field this is called with went through
  // absentTextAsNull), but TypeScript cannot see that generically through a
  // `keyof T` index, so the cast happens once here rather than fighting the
  // type system at every assignment below.
  const cleaned: Record<string, unknown> = { ...obj }
  const blankedFields: string[] = []

  for (const field of fields) {
    const key = field as string
    const value = cleaned[key]
    if (typeof value === 'string' && LEAKED_TAG_PATTERN.test(value)) {
      cleaned[key] = null
      blankedFields.push(key)
    }
  }

  return { cleaned: cleaned as T, blankedFields }
}

/** Header text fields to scan -- every free-text field on the extraction response
 *  (absentTextAsNull-typed). instrument_type and invoice_date are excluded: both
 *  are transformed against a fixed value set / ISO date shape, not raw OCR text,
 *  so leaked tag syntax could never survive their transforms unnoticed. */
export const HEADER_TEXT_FIELDS_TO_SANITIZE = [
  'vendor_name',
  'vendor_gstin',
  'vendor_phone',
  'vendor_email',
  'vendor_address',
  'invoice_number',
  'place_of_supply',
  'notes',
] as const satisfies readonly (keyof ExtractionResponse)[]

/** Line-item text fields to scan -- every free-text field on a line item
 *  (absentTextAsNull-typed); quantity/rate/amount fields are numeric and excluded. */
export const LINE_ITEM_TEXT_FIELDS_TO_SANITIZE = [
  'description',
  'hsn_sac_code',
  'quantity_raw_text',
  'unit',
  'discount_note',
] as const satisfies readonly (keyof ExtractionLineItem)[]

/** Result of sanitizing a whole extraction response, header and every line item. */
export interface ExtractionSanitizeResult {
  cleaned: ExtractionResponse
  /** e.g. `['vendor_phone', 'line_items[2].description']`. Empty when nothing was blanked. */
  blankedFields: string[]
}

/**
 * Runs `sanitizeLeakedTagSyntax` over the header fields and every line item of
 * one extraction response, and rolls the results into a single field list --
 * lib/jobs/handlers/extract.ts raises ONE `ocr_leaked_tag_syntax` exception
 * per document_extraction naming every blanked field, not one exception per
 * field (a flood of duplicate exceptions for the same document is less useful
 * to a reviewer than one that lists everything).
 */
export function sanitizeExtractionResponse(extraction: ExtractionResponse): ExtractionSanitizeResult {
  const header = sanitizeLeakedTagSyntax(extraction, HEADER_TEXT_FIELDS_TO_SANITIZE)
  const blankedFields = [...header.blankedFields]

  const line_items = extraction.line_items.map((item, index) => {
    const { cleaned, blankedFields: itemFields } = sanitizeLeakedTagSyntax(item, LINE_ITEM_TEXT_FIELDS_TO_SANITIZE)
    if (itemFields.length > 0) {
      blankedFields.push(...itemFields.map((field) => `line_items[${index}].${field}`))
    }
    return cleaned
  })

  return {
    cleaned: { ...header.cleaned, line_items },
    blankedFields,
  }
}
