# `gold.json` — labeling instructions

This is the regression-harness fixture described in MASTER-PLAN §9.1. It is a
skeleton right now: 21 entries, one per real invoice PDF in `Invoices/`, every
value field `null`/empty/false and `labeled: false`.

**Labeling this file is the user's task (§11 item 1), not something the
agent should guess at.** Fabricating values here would be worse than useless
— `test/score.ts` would silently score against wrong ground truth and every
number it prints would be meaningless. Nothing in this repo writes labels
into `gold.json` automatically.

**Timing:** this gates **Phase 1B day 5**, not Phase 1A. There is no rush —
roughly two weeks of runway before it blocks anything. It does *not* block
today's work; `npm run score` already runs safely against an unlabeled file
(it prints "0/21 labeled" and exits cleanly rather than crashing).

## Why two passes, not one

§9.1 splits the 21 into two groups deliberately, and the split matters more
than it looks:

- **10 invoices labeled from scratch (~50 min).** Open the PDF, read it, type
  the values in `gold.json` directly. Never look at model output first. This
  is the trustworthy core of the gold set — labeled blind, so it measures the
  pipeline honestly instead of measuring agreement with the pipeline.
- **11 invoices labeled by correction (~20 min).** Once extraction exists,
  run it once, export a pre-filled sheet, and correct what's wrong. Faster,
  but **anchored**: a reviewer shown `"Acm"` accepts it far more often than
  they'd type `"Acm"` unprompted (§9.1, §9.3 item 1). Fine for eleven
  documents under focused attention — not fine as the whole set, which is
  exactly why the first ten exist as a check against it.

If every entry were labeled by correction, the gold set would inherit the
correction log's optimism bias and stop being able to catch silent misses —
the one thing §9.1 says the gold set exists to do that the correction log
cannot (§9 comparison table: "Catches silent misses — Yes" for the gold set,
"No" for the correction log).

## How to label an entry

Each entry in `gold.json` looks like:

```json
{
  "source_file": "002 venue Setup Al Nafees Tech.pdf",
  "labeled": false,
  "vendor_name": null,
  "invoice_number": null,
  "invoice_date": null,
  "subtotal": null,
  "tax_amount": null,
  "total_amount": null,
  "line_items": [],
  "is_gujarati_or_devanagari": false,
  "notes": ""
}
```

Fill in the real values read from `Invoices/<source_file>`, then set
`"labeled": true`. Suggested field conventions (match whatever
`lib/extraction-schema.ts` ends up using once it exists, so `score.ts`'s
comparisons line up cleanly):

- `vendor_name` — string, as printed on the invoice.
- `invoice_number` — string, trimmed (no leading/trailing whitespace).
- `invoice_date` — `YYYY-MM-DD` string, or `null` if the invoice has none.
- `subtotal`, `tax_amount`, `total_amount` — numbers (not strings), in
  rupees, two-decimal precision as printed.
  - **Check `total_amount` against the PDF's own arithmetic independently**
    (§9.1). It carries the most scoring weight and is the field anchoring
    damages most in the correction-based half of the set.
- `line_items` — array of `{ description, amount }` (add fields as the real
  schema needs them), one per line on the invoice.
- `is_gujarati_or_devanagari` — `true` if the invoice contains Gujarati or
  Devanagari script text anywhere that matters to extraction.
- `notes` — anything about the invoice worth flagging (poor scan quality, a
  non-financial page mixed in, an ambiguous total, etc).

## Which 10 to label blind

No fixed prescription here — any 10 of the 21 work, as long as they're
labeled before looking at any model output. A reasonable approach: pick 10
spread across different vendors/formats rather than 10 consecutive numbers,
so the blind core also gives some format diversity.

## After labeling

Run `npm run score`. Entries with `"labeled": false` are skipped with a
console message; only labeled entries are scored. See §9.1 for the bars each
metric needs to clear before shipping.
