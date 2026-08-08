# Invoice OCR & Verification System — Technical Specification

**Prepared for:** Istifada Ilmiyah event finance/budgeting team
**Purpose:** Hand-off spec for a developer to build an invoice upload → OCR → database → staff-verification web app

---

## 1. Goals

1. Staff upload scanned invoices (PDF or photo) as they come in, instead of batching everything at year-end.
2. The system extracts structured data (vendor, invoice number, date, line items, totals) automatically.
3. The system automatically flags anomalies — vendor-name clustering, duplicate payments, rate drift, missing documentation — using the same checks performed manually on this year's data.
4. Staff review and sign off on extracted data daily, prioritized by risk, rather than reviewing every line item with equal effort.
5. Reports (rate reference card, vendor summaries, flag digest) are queryable at any time during the event, not just after.

---

## 2. High-Level Architecture

```
Upload → Classify (typed vs handwritten) → Extract (OCR parser or Claude vision)
       → Structured DB → Claude flag pass (nightly batch) → Staff review queue
       → Verified ledger → Reports
```

**Two extraction paths, chosen per-invoice:**

| Path | Trigger | Engine | Why |
|---|---|---|---|
| A | Machine-printed GST invoice detected | Dedicated OCR/invoice parser (e.g. Google Document AI Invoice Parser) | Cheap (~$0.01/page), fast, purpose-built field extraction on clean typed text |
| B | Handwritten / informal chit, or Path A confidence below threshold | Claude API (vision) | Handles messy handwriting, inconsistent layouts, and can flag its own uncertainty |

Route by a simple heuristic first (presence of a machine-printed GST header block, text density from a quick OCR confidence check), with staff able to manually re-route a misclassified invoice.

---

## 3. Data Model

### 3.1 `invoices` (header-level, one row per invoice)

| Column | Type | Notes |
|---|---|---|
| `invoice_id` | UUID, PK | |
| `source_file_id` | FK → `source_files` | which upload batch this came from |
| `page_number` | INT | page in the source file, for traceability |
| `vendor_name_raw` | TEXT | exactly as it appears on the invoice |
| `vendor_id` | FK → `vendors`, nullable | resolved after vendor-matching step (see 5.3) |
| `invoice_number` | TEXT | |
| `invoice_date` | DATE | |
| `budget_head` | TEXT / enum | Mawaid, Venue Setup, Transport, etc. — can be auto-suggested, staff-confirmed |
| `subtotal` | NUMERIC(12,2) | |
| `tax_amount` | NUMERIC(12,2) | |
| `total_amount` | NUMERIC(12,2) | |
| `extraction_method` | enum('ocr_parser','claude_vision','manual') | |
| `extraction_confidence` | NUMERIC(3,2) | 0–1, from whichever engine ran |
| `gst_number_present` | BOOLEAN | |
| `legibility` | enum('clear','partial','poor') | |
| `payment_status` | enum('not_verified','paid','flagged') | |
| `verified_by` | FK → `staff_users`, nullable | |
| `verified_at` | TIMESTAMP, nullable | |
| `created_at` | TIMESTAMP | |

### 3.2 `line_items` (one row per line item)

| Column | Type | Notes |
|---|---|---|
| `line_item_id` | UUID, PK | |
| `invoice_id` | FK → `invoices` | |
| `description` | TEXT | |
| `hsn_sac_code` | TEXT, nullable | |
| `quantity` | NUMERIC(10,2) | |
| `unit` | TEXT | pcs, kg, sqft, day, etc. |
| `list_rate` | NUMERIC(12,2), nullable | |
| `discount_pct` | NUMERIC(5,2), nullable | |
| `net_rate` | NUMERIC(12,2) | |
| `line_amount` | NUMERIC(12,2) | |

### 3.3 `vendors` (resolved/canonical vendor identity — separate from raw name on invoice)

| Column | Type | Notes |
|---|---|---|
| `vendor_id` | UUID, PK | |
| `canonical_name` | TEXT | the "real" name if a cluster is consolidated |
| `phone` | TEXT, nullable | used for clustering detection |
| `address` | TEXT, nullable | used for clustering detection |
| `gstin` | TEXT, nullable | |
| `cluster_group_id` | UUID, nullable | groups vendor rows sharing phone/address into one economic entity |

### 3.4 `flags`

| Column | Type | Notes |
|---|---|---|
| `flag_id` | UUID, PK | |
| `invoice_id` | FK → `invoices`, nullable | |
| `line_item_id` | FK → `line_items`, nullable | |
| `flag_type` | enum | see §5.4 |
| `severity` | enum('low','medium','high') | |
| `description` | TEXT | model-generated explanation |
| `amount_at_risk` | NUMERIC(12,2), nullable | |
| `status` | enum('open','confirmed','dismissed') | staff-managed |
| `resolved_by` | FK → `staff_users`, nullable | |

### 3.5 `rate_reference` (running benchmark table, grows over time — same idea as this year's Excel rate card)

| Column | Type | Notes |
|---|---|---|
| `item_key` | TEXT | normalized item description (e.g. "astral_upvc_pipe_1in") |
| `vendor_id` | FK → `vendors` | |
| `net_rate` | NUMERIC(12,2) | |
| `unit` | TEXT | |
| `observed_date` | DATE | |
| `source_invoice_id` | FK → `invoices` | |

---

## 4. Claude API Integration

### 4.1 Model selection

| Task | Suggested model | Why |
|---|---|---|
| Vision extraction of handwritten/messy invoices | `claude-sonnet-5` | Strong vision + reasonable cost for per-invoice calls |
| Nightly flagging/cross-referencing pass | `claude-sonnet-5` (or `claude-opus-4-8` if flagging quality needs to be maximized) | Reasoning across many rows, not just one document |
| High-volume simple re-checks (e.g. re-verify OCR parser's low-confidence fields) | `claude-haiku-4-5` | Cheaper, faster, adequate for narrow re-checks |

Check `docs.claude.com` for current per-model pricing before finalizing a budget — rates and model lineup do change.

### 4.2 Extraction call (per invoice, Path B)

Use the Messages API with a PDF or image content block plus a **tool_use (function-calling) schema** to force structured JSON output rather than parsing free text — this is the reliable way to get consistent fields.

```json
POST /v1/messages
{
  "model": "claude-sonnet-5",
  "max_tokens": 2000,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "<base64>" } },
        { "type": "text", "text": "Extract this invoice into the invoice_extraction tool. If a field is illegible, set it null and note it in the notes field. Do not guess numbers you cannot read clearly." }
      ]
    }
  ],
  "tools": [
    {
      "name": "invoice_extraction",
      "description": "Structured extraction of an invoice",
      "input_schema": {
        "type": "object",
        "properties": {
          "vendor_name": { "type": "string" },
          "invoice_number": { "type": "string" },
          "invoice_date": { "type": "string" },
          "gst_number_present": { "type": "boolean" },
          "legibility": { "type": "string", "enum": ["clear", "partial", "poor"] },
          "subtotal": { "type": "number" },
          "tax_amount": { "type": "number" },
          "total_amount": { "type": "number" },
          "line_items": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "description": { "type": "string" },
                "hsn_sac_code": { "type": "string" },
                "quantity": { "type": "number" },
                "unit": { "type": "string" },
                "list_rate": { "type": "number" },
                "discount_pct": { "type": "number" },
                "net_rate": { "type": "number" },
                "line_amount": { "type": "number" }
              },
              "required": ["description", "line_amount"]
            }
          },
          "notes": { "type": "string" }
        },
        "required": ["vendor_name", "total_amount", "line_items"]
      }
    }
  ],
  "tool_choice": { "type": "tool", "name": "invoice_extraction" }
}
```

Parse the `tool_use` block from the response into your `invoices` / `line_items` tables.

### 4.3 Batch processing (recommended for the daily-verification cadence)

Since staff review happens daily rather than instantly on upload, route the day's accumulated invoices through the **Batch API** (typically completes within an hour, ~50% cheaper than synchronous calls). Trigger a nightly job:

1. Collect all invoices uploaded since the last run.
2. Submit a batch request per invoice (extraction) or a single batch containing all flagging cross-checks (see 4.4).
3. On completion, write results into the database and generate the next day's review queue.

If staff need same-day feedback on a specific high-priority upload, allow a manual "process now" button that calls the synchronous Messages API for just that invoice (costs more per-call, used sparingly).

### 4.4 Flagging pass — prompt design

Run this as a separate nightly Claude call (or scheduled batch) that receives a summarized set of *new* invoices/vendors plus enough existing context to detect patterns — not the raw images again, just the structured rows.

**What to send:**
- New invoices' structured data (vendor, phone/address if captured, invoice number, amount, date, item list)
- Existing vendor table (name, phone, address, cluster_group_id)
- Existing rate_reference table entries for matching item_keys

**What to ask for (as a tool schema, similar pattern to §4.2):**
- `vendor_cluster_flags`: pairs/groups of vendor rows sharing phone/address under different names
- `duplicate_payment_flags`: matching vendor + invoice number + amount appearing more than once
- `rate_drift_flags`: same vendor, same/similar item, rate changed beyond a threshold (e.g. >10%) between invoices
- `missing_document_flags`: ledger entries with no matching invoice_id (requires a periodic join against your existing budget ledger, not just the invoice table)
- `rate_benchmark_flags`: new invoice rate significantly above the `rate_reference` table's best known rate for that item_key

This mirrors exactly what was done manually on this year's data (the meat-vendor cluster, the Able Computer mismatch, the Basta Hardware price comparison) — the difference is it runs automatically, incrementally, as each day's invoices come in.

### 4.5 Vendor-matching / clustering logic

Fuzzy-match new vendor rows against the `vendors` table on:
- Exact or near-exact phone number match
- Address string similarity (e.g. Levenshtein/token-overlap above a threshold)
- GSTIN prefix similarity (same PAN, different GST suffix — as seen with the "Al Burhan" family)

When a match is found, either auto-assign to an existing `cluster_group_id` (high-confidence match) or create a `flags` row of type `vendor_cluster_flags` for staff to confirm (lower-confidence match). Do not auto-merge vendor identities without a staff confirmation step — this affects payment routing and should not be fully automatic.

---

## 5. OCR Parser Integration (Path A — typed invoices)

If using Google Document AI's Invoice Parser (or equivalent):

1. Upload the page image/PDF to the processor endpoint.
2. Parse the returned key-value fields (vendor, invoice number, date, line items, total) into the same `invoices`/`line_items` schema as the Claude path, so downstream flagging logic is engine-agnostic.
3. Capture the parser's own confidence scores per field; anything below your chosen threshold (e.g. 0.85) gets routed to Claude vision as a fallback rather than accepted as-is.
4. Store `extraction_method = 'ocr_parser'` so you can later measure which engine is more reliable for your invoice mix and adjust routing.

---

## 6. Staff Review Workflow

1. **Review queue** — a list view sorted by: open flags (high severity first) → extraction confidence (lowest first) → invoice amount (highest first). This puts the highest-risk, least-certain, most-material items in front of staff first.
2. **Review screen** — side-by-side: the original scanned image and the extracted structured fields, editable inline. Staff can accept, correct, or reject each field.
3. **Flag resolution** — for each open flag on an invoice, staff marks it `confirmed` (real issue, needs follow-up action) or `dismissed` (false positive, e.g. two different vendors that legitimately share a building).
4. **Sign-off** — once all line items and flags on an invoice are addressed, staff marks `verified_at`/`verified_by`. Only verified invoices count toward "closed" totals in reports.
5. **Audit trail** — every edit, flag resolution, and sign-off is logged with user + timestamp (required for a finance workflow; don't allow silent overwrites).

---

## 7. Reporting

Generate on demand (or scheduled daily digest) from verified data:

- **Rate reference card** — auto-updated version of this year's Excel, queryable by item/vendor/date.
- **Vendor cluster summary** — running list of consolidated vendor groups and total spend per group.
- **Flags digest** — open flags by severity and ₹ at risk, sent to the budget team each morning.
- **Budget-head burn rate** — running total vs. allocated ceiling per category (Mawaid, Venue Setup, etc.), so overspend is visible during the event, not after.

---

## 8. Non-Functional Requirements

- **Access control:** staff review actions should be tied to authenticated user accounts (not shared logins) — needed for the audit trail in §6.4 to mean anything.
- **Data residency/privacy:** invoices contain vendor bank details and phone numbers — treat the storage bucket and database with the same access restrictions as any financial system (encrypted at rest, restricted IAM roles, no public bucket access).
- **Retention:** keep original scanned images indefinitely (or per your organization's retention policy) — they're the source of truth if a structured field is ever disputed.
- **Idempotency:** re-uploading the same physical invoice should be detectable (e.g. hash the source image) and flagged rather than silently creating a duplicate row.

---

## 9. Suggested Build Phases

1. **Phase 1 — Upload & storage:** file upload, source_files/invoices tables, manual entry fallback.
2. **Phase 2 — Extraction:** wire up OCR parser (Path A) and Claude vision (Path B) with the routing logic; populate `invoices`/`line_items`.
3. **Phase 3 — Flagging:** nightly Claude batch job for cluster/duplicate/rate-drift/benchmark flags.
4. **Phase 4 — Review UI:** staff queue, review screen, sign-off, audit trail.
5. **Phase 5 — Reporting:** rate card, cluster summary, flags digest, burn-rate dashboard.

Phases 1–2 alone would already replace this year's manual OCR-and-flag process with something running continuously; phases 3–5 are what make it genuinely more efficient than doing it by hand each year.
