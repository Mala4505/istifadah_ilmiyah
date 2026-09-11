/**
 * "Budget Utilization Report" PDF -- an A4 table shaped after the
 * department's own printed budget sheet (Sr. No / Department / Actuals /
 * Budget), with a "% of Budget Used" column appended at the end.
 *
 * Deliberately a real bordered table (unlike board-pack/pdf.ts's monospace
 * text grid) since this PDF -- not an .xlsx alongside it -- is the
 * deliverable here. Plain black-on-white throughout: no fills, no colour --
 * the source sheet highlights rows by hand, this export does not reproduce
 * that.
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

const PAGE_W = 595.28 // A4 pt, portrait
const PAGE_H = 841.89
const MARGIN = 40
const HEADER_ROW_H = 20
const BASE_ROW_H = 16
const LINE_H = 10 // per wrapped line inside a taller row

type Col = {
  header: string
  width: number
  align: 'left' | 'right'
}

const COLUMNS: Col[] = [
  { header: 'Sr. No', width: 35, align: 'left' },
  { header: 'Department', width: 195, align: 'left' },
  { header: 'Actual', width: 85, align: 'right' },
  { header: 'Budget', width: 85, align: 'right' },
  { header: '% of Budget Used', width: 115, align: 'right' },
]

/** Wraps `text` to `maxW` at `size`, returning the lines (at least one). */
function wrapText(text: string, font: import('pdf-lib').PDFFont, size: number, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(trial, size) > maxW && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = trial
    }
  }
  if (cur) lines.push(cur)
  return lines.length > 0 ? lines : ['']
}

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
  const black = rgb(0, 0, 0)

  let page = doc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  // Tracks each page's own header-top y, so its vertical borders (drawn once
  // the page is complete) span exactly that page's rows -- not some other
  // page's coordinates, which a single trailing draw-verticals-at-the-end
  // pass would get wrong the moment the table spans more than one page.
  let pageHeaderTop = 0

  // ---- Title + generated stamp (first page only) -------------------------
  page.drawText(pdfSafe('Budget Utilization Report'), { x: MARGIN, y, size: 16, font: bold, color: black })
  y -= 20
  const generatedLabel = `Generated: ${opts.generatedAt.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}${opts.eventName ? `  ·  ${opts.eventName}` : ''}`
  page.drawText(pdfSafe(generatedLabel), { x: MARGIN, y, size: 9, font, color: black })
  y -= 20

  function drawVerticalBorders(headerTop: number, bottom: number): void {
    let vx = tableX
    for (const col of COLUMNS) {
      page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y: bottom }, thickness: 0.4, color: black })
      vx += col.width
    }
    page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y: bottom }, thickness: 0.4, color: black })
  }

  function drawHeaderRow(): void {
    const rowTop = y
    let x = tableX
    for (const col of COLUMNS) {
      const textY = rowTop - HEADER_ROW_H + 6
      const label = pdfSafe(col.header)
      const textX =
        col.align === 'right' ? x + col.width - 6 - bold.widthOfTextAtSize(label, 9) : x + 4
      page.drawText(label, { x: textX, y: textY, size: 9, font: bold, color: black })
      x += col.width
    }
    // horizontal rules for the header
    page.drawLine({ start: { x: tableX, y: rowTop }, end: { x: tableX + tableW, y: rowTop }, thickness: 0.75, color: black })
    page.drawLine({
      start: { x: tableX, y: rowTop - HEADER_ROW_H },
      end: { x: tableX + tableW, y: rowTop - HEADER_ROW_H },
      thickness: 0.75,
      color: black,
    })
    pageHeaderTop = rowTop
    y = rowTop - HEADER_ROW_H
  }

  function newPage(): void {
    drawVerticalBorders(pageHeaderTop, y) // close out the page being left
    page = doc.addPage([PAGE_W, PAGE_H])
    y = PAGE_H - MARGIN
    drawHeaderRow()
  }

  drawHeaderRow()

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!
    const deptLines = wrapText(pdfSafe(r.department_name), font, 9, COLUMNS[1]!.width - 8)
    const rowH = Math.max(BASE_ROW_H, deptLines.length * LINE_H + 6)

    if (y - rowH < MARGIN) newPage()

    const rowTop = y
    const cells = [
      String(i + 1),
      null, // department drawn separately (may wrap)
      formatINR(r.actual_amount),
      formatINR(r.budget_amount),
      r.budget_status_note ?? formatPercent(r.pct_of_budget),
    ]

    let x = tableX
    for (let c = 0; c < COLUMNS.length; c += 1) {
      const col = COLUMNS[c]!
      if (c === 1) {
        deptLines.forEach((line, li) => {
          page.drawText(line, { x: x + 4, y: rowTop - 12 - li * LINE_H, size: 9, font, color: black })
        })
      } else {
        const label = pdfSafe(cells[c] as string)
        const textX = col.align === 'right' ? x + col.width - 6 - font.widthOfTextAtSize(label, 9) : x + 4
        page.drawText(label, { x: textX, y: rowTop - 12, size: 9, font, color: black })
      }
      x += col.width
    }

    y = rowTop - rowH
    page.drawLine({ start: { x: tableX, y }, end: { x: tableX + tableW, y }, thickness: 0.4, color: black })
  }

  drawVerticalBorders(pageHeaderTop, y) // close out the final page

  return doc.save()
}
