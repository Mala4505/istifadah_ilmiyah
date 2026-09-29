<!-- converted from gold-template-2-bills.xlsx -->

## Sheet: Instructions
| Gold-label template — 2 bills |
| --- |
|  |
| Fill in the "Bill 1" and "Bill 2" sheets by reading the actual PDF yourself, |
| not by looking at what the OCR pipeline extracted. That is the whole point of a |
| gold set — it measures the pipeline against the truth, not against itself. |
|  |
| HEADER FIELDS (top block of each sheet) |
| source_file          Exact PDF filename, including extension, exactly as it |
|                      sits in the Invoices/ folder (case + spacing matter). |
| vendor_name          As printed on the invoice. |
| invoice_number       Trimmed, no extra spaces. |
| invoice_date         YYYY-MM-DD. Leave blank if the invoice has no date. |
| subtotal             Number only (no currency symbol, no commas), before tax. |
| tax_amount           Number only — total tax (CGST+SGST+IGST combined). |
| total_amount         Number only — the grand total. Check this against the |
|                      invoice's own arithmetic yourself; it is the highest- |
|                      weighted field the scorer checks. |
| is_gujarati_or_devanagari   TRUE or FALSE — does the invoice contain Gujarati |
|                             or Devanagari script anywhere that matters? |
| notes                Anything worth flagging: poor scan quality, a mixed-in |
|                      non-financial page, an ambiguous total, etc. |
|  |
| LINE ITEMS (table below the header block on each sheet) |
| line_order    0, 1, 2... in the order printed on the invoice. |
| description   The item/service name, as printed (this is the "name" field). |
| quantity      Number, if printed. Leave blank if not shown. |
| discount      Free text — only fill this if the invoice prints an explicit |
|               discount line. Leave blank otherwise; do not guess a discount. |
| amount        Number only — the line total as printed. |
|  |
| Notes on scope: |
| - description + amount are what test/score.ts currently compares against the |
|   pipeline. quantity/discount are captured for completeness and for when the |
|   gold harness is widened to check them too — fill them in if you can, but |
|   they will not affect today's score. |
| - Leave a field truly blank (not "0" or "N/A") when the invoice does not show |
|   it — blank means null, which is itself a real, checkable answer. |
| - Add as many line-item rows as the bill actually has; the template ships with |
|   15 blank rows per sheet as a starting point, not a cap. |
|  |
| Once both sheets are filled in, send the file back and it will be converted |
| into test/gold-blind-notes.json (the format test/gold.README.md describes) |
| and folded into the gold set via npm run gold:build. |
## Sheet: Bill 1
| Field | Value |  |  |  |
| --- | --- | --- | --- | --- |
| source_file | D:\Idara Maliyah\Code\Istifadah Ilmiyah\Invoices\test1.pdf |  |  |  |
| vendor_name | Poonam Ajak Kumar Sharma |  |  |  |
| vendor_email | poonamajaykumar056@gmail.com |  |  |  |
| invoice_number | 120 |  |  |  |
| invoice_date | 2026-07-15 00:00:00 |  |  |  |
| subtotal | 9750 |  |  |  |
| tax_amount |  |  |  |  |
| total_amount | 9750 |  |  |  |
| is_gujarati_or_devanagari | False |  |  |  |
| notes |  |  |  |  |
|  |  |  |  |  |
| LINE ITEMS |  |  |  |  |
| line_order | description (name) | quantity | rate | amount |
| 0 | labour | 11 | 850 | 9350 |
| 1 | Ek Gadi Kachra | 1 | 400 | 400 |
| 2 |  |  |  |  |
| 3 |  |  |  |  |
| 4 |  |  |  |  |
| 5 |  |  |  |  |
| 6 |  |  |  |  |
| 7 |  |  |  |  |
| 8 |  |  |  |  |
| 9 |  |  |  |  |
| 10 |  |  |  |  |
| 11 |  |  |  |  |
| 12 |  |  |  |  |
| 13 |  |  |  |  |
| 14 |  |  |  |  |
## Sheet: Bill 2
| Field | Value |  |  |  |
| --- | --- | --- | --- | --- |
| source_file | D:\Idara Maliyah\Code\Istifadah Ilmiyah\Invoices\test2.pdf |  |  |  |
| vendor_name | Juser S. Saleh |  |  |  |
| vendor_email | abbasindoor@gmail.com |  |  |  |
| invoice_number | 756 |  |  |  |
| invoice_date | 2026-07-26 00:00:00 |  |  |  |
| subtotal | 12500 |  |  |  |
| tax_amount |  |  |  |  |
| total_amount | 12500 |  |  |  |
| is_gujarati_or_devanagari | True |  |  |  |
| notes |  |  |  |  |
|  |  |  |  |  |
| LINE ITEMS |  |  |  |  |
| line_order | description (name) | quantity | rate | amount |
| 0 | 1 Salve + 2 Towels | 1 | 7000 | 7000 |
| 1 | 1 Sadka 2 Towels | 1 | 5000 | 5000 |
| 2 | Rick Bhara |  |  | 500 |
| 3 |  |  |  |  |
| 4 |  |  |  |  |
| 5 |  |  |  |  |
| 6 |  |  |  |  |
| 7 |  |  |  |  |
| 8 |  |  |  |  |
| 9 |  |  |  |  |
| 10 |  |  |  |  |
| 11 |  |  |  |  |
| 12 |  |  |  |  |
| 13 |  |  |  |  |
| 14 |  |  |  |  |