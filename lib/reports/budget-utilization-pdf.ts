/**
 * "Budget Utilization Report" PDF -- an A4 table shaped after the
 * department's own printed budget sheet (Sr. No / Department / Budget /
 * Actuals), with a "% of Budget Used" column appended at the end.
 *
 * Deliberately a real bordered table (unlike board-pack/pdf.ts's monospace
 * text grid) since this PDF -- not an .xlsx alongside it -- is the
 * deliverable here. Styled (dark header band, zebra-striped rows, a muted
 * grid) but *uniformly* so -- every row gets the same treatment regardless
 * of its numbers. The source sheet highlights individual rows by hand to
 * flag specific departments; this export does not reproduce that, since a
 * value-driven colour would misrepresent the export as carrying the same
 * manual judgement calls.
 *
 * Single page, always: row height and font size scale down from their ideal
 * values so the whole department list -- however long -- lands on one A4
 * sheet rather than spilling onto a second (the point of a printable
 * one-pager). Department names are a single truncated line rather than
 * wrapped, so every row's height is identical and that scaling math is exact
 * instead of a wrap-dependent estimate.
 *
 * `buildBudgetUtilizationPdf(rows, opts)` -> the PDF as bytes. Pure: no I/O.
 * pdf-lib is dynamically imported, same pattern as lib/reports/board-pack/pdf.ts.
 */

import { formatINR, formatPercent } from '@/lib/reports/format'
import type { DepartmentBudgetVsActualRow } from '@/lib/reports/sections/shared'

/**
 * pdf-lib's StandardFonts are WinAnsi-encoded and throw on any character they
 * can't represent (₹, smart punctuation, non-Latin department names). No
 * embeddable Unicode font exists in this stack, so text is degraded instead:
 * ₹ -> "Rs ", dashes/quotes -> ASCII, anything else outside Latin-1 -> "?".
 */
function pdfSafe(text: string): string {
  return text
    .replace(/₹/g, 'Rs ')
    .replace(/[‒-―−]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\xFF]/g, '?')
}

/** Truncates `text` with a trailing "..." if it doesn't fit `maxW` at `size`. */
function truncateToWidth(text: string, font: import('pdf-lib').PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let end = text.length
  while (end > 0 && font.widthOfTextAtSize(text.slice(0, end) + '...', size) > maxW) end -= 1
  return text.slice(0, end) + '...'
}

const PAGE_W = 595.28 // A4 pt, portrait
const PAGE_H = 841.89
const MARGIN = 36

type Col = {
  header: string
  width: number
  align: 'left' | 'right'
}

const COLUMNS: Col[] = [
  { header: 'SR. NO', width: 38, align: 'left' },
  { header: 'DEPARTMENT', width: 192, align: 'left' },
  { header: 'BUDGET', width: 85, align: 'right' },
  { header: 'ACTUAL', width: 85, align: 'right' },
  { header: '% OF BUDGET USED', width: 115, align: 'right' },
]

// Ideal (uncompressed) sizing -- used as-is whenever the row count comfortably
// fits; scaled down together, with floors, only when it wouldn't.
const IDEAL_HEADER_H = 22
const IDEAL_ROW_H = 16
const IDEAL_ROW_FONT = 9
const IDEAL_HEADER_FONT = 8.5
const MIN_ROW_H = 8
const MIN_HEADER_H = 12
const MIN_ROW_FONT = 5
const MIN_HEADER_FONT = 5.5

export async function buildBudgetUtilizationPdf(
  rows: DepartmentBudgetVsActualRow[],
  opts: { eventName: string | null; generatedAt: Date }
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const tableW = COLUMNS.reduce((s, c) => s + c.width, 0)
  const tableX = MARGIN
  const page = doc.addPage([PAGE_W, PAGE_H])

  // A restrained, uniform palette -- no colour is ever chosen by a row's
  // values, only by its position (header vs. body, even vs. odd row).
  const ink = rgb(0.11, 0.11, 0.13)
  const headerBg = rgb(0.17, 0.21, 0.29)
  const headerText = rgb(1, 1, 1)
  const stripeBg = rgb(0.94, 0.95, 0.97)
  const gridColor = rgb(0.72, 0.73, 0.76)
  const titleColor = rgb(0.08, 0.09, 0.11)
  const reportNameColor = rgb(0.28, 0.3, 0.34)
  const subtitleColor = rgb(0.48, 0.5, 0.54)
  const accentColor = headerBg

  let y = PAGE_H - MARGIN

  // ---- Header block --------------------------------------------------------
  // Event name leads (the reader's "which event is this") with the report
  // name as the secondary line underneath -- swapped from the report name
  // leading, since the event is what distinguishes one export from the next.
  if (opts.eventName) {
    page.drawText(pdfSafe(opts.eventName), { x: MARGIN, y, size: 19, font: bold, color: titleColor })
    y -= 18
    page.drawText(pdfSafe('Budget Utilization Report'), { x: MARGIN, y, size: 12, font: bold, color: reportNameColor })
    y -= 15
  } else {
    page.drawText(pdfSafe('Budget Utilization Report'), { x: MARGIN, y, size: 19, font: bold, color: titleColor })
    y -= 18
  }
  const generatedLabel = `Generated ${opts.generatedAt.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`
  page.drawText(pdfSafe(generatedLabel), { x: MARGIN, y, size: 9, font, color: subtitleColor })
  y -= 9
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableW, y }, thickness: 1.5, color: accentColor })
  y -= 12

  const headerTop = y
  const availableH = headerTop - MARGIN
  const n = Math.max(rows.length, 1)

  // Scale header + row sizing down together so `n` rows always land on this
  // one page, however long the department list gets.
  const idealTotal = IDEAL_HEADER_H + n * IDEAL_ROW_H
  const scale = idealTotal > availableH ? Math.max(availableH / idealTotal, 0) : 1
  const headerH = Math.max(MIN_HEADER_H, IDEAL_HEADER_H * scale)
  const rowH = Math.max(MIN_ROW_H, IDEAL_ROW_H * scale)
  const headerFontSize = Math.max(MIN_HEADER_FONT, IDEAL_HEADER_FONT * scale)
  const rowFontSize = Math.max(MIN_ROW_FONT, IDEAL_ROW_FONT * scale)

  // ---- Header row ------------------------------------------------------
  page.drawRectangle({ x: tableX, y: headerTop - headerH, width: tableW, height: headerH, color: headerBg })
  {
    let x = tableX
    for (const col of COLUMNS) {
      const textY = headerTop - headerH / 2 - headerFontSize * 0.36
      const label = pdfSafe(col.header)
      const textX =
        col.align === 'right' ? x + col.width - 6 - bold.widthOfTextAtSize(label, headerFontSize) : x + 6
      page.drawText(label, { x: textX, y: textY, size: headerFontSize, font: bold, color: headerText })
      x += col.width
    }
  }
  y = headerTop - headerH

  // ---- Body rows ---------------------------------------------------------
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!
    const rowTop = y
    if (i % 2 === 1) {
      page.drawRectangle({ x: tableX, y: rowTop - rowH, width: tableW, height: rowH, color: stripeBg })
    }

    const deptLabel = truncateToWidth(pdfSafe(r.department_name), font, rowFontSize, COLUMNS[1]!.width - 12)
    const cells = [
      String(i + 1),
      deptLabel,
      formatINR(r.budget_amount),
      formatINR(r.actual_amount),
      r.budget_status_note ?? formatPercent(r.pct_of_budget),
    ]

    const textY = rowTop - rowH / 2 - rowFontSize * 0.36
    let x = tableX
    for (let c = 0; c < COLUMNS.length; c += 1) {
      const col = COLUMNS[c]!
      const label = pdfSafe(cells[c]!)
      const textX = col.align === 'right' ? x + col.width - 6 - font.widthOfTextAtSize(label, rowFontSize) : x + 6
      page.drawText(label, { x: textX, y: textY, size: rowFontSize, font, color: ink })
      x += col.width
    }

    y = rowTop - rowH
    page.drawLine({ start: { x: tableX, y }, end: { x: tableX + tableW, y }, thickness: 0.5, color: gridColor })
  }

  // ---- Table borders -----------------------------------------------------
  let vx = tableX
  for (const col of COLUMNS) {
    page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y }, thickness: 0.5, color: gridColor })
    vx += col.width
  }
  page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y }, thickness: 0.5, color: gridColor })

  return doc.save()
}
