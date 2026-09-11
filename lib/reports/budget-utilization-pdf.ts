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
const HEADER_ROW_H = 24
const BASE_ROW_H = 18
const LINE_H = 10 // per wrapped line inside a taller row

type Col = {
  header: string
  width: number
  align: 'left' | 'right'
}

const COLUMNS: Col[] = [
  { header: 'SR. NO', width: 40, align: 'left' },
  { header: 'DEPARTMENT', width: 190, align: 'left' },
  { header: 'BUDGET', width: 85, align: 'right' },
  { header: 'ACTUAL', width: 85, align: 'right' },
  { header: '% OF BUDGET USED', width: 115, align: 'right' },
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

  // A restrained, uniform palette -- no colour is ever chosen by a row's
  // values, only by its position (header vs. body, even vs. odd row).
  const ink = rgb(0.11, 0.11, 0.13)
  const headerBg = rgb(0.17, 0.21, 0.29)
  const headerText = rgb(1, 1, 1)
  const stripeBg = rgb(0.94, 0.95, 0.97)
  const gridColor = rgb(0.72, 0.73, 0.76)
  const titleColor = rgb(0.08, 0.09, 0.11)
  const subtitleColor = rgb(0.42, 0.44, 0.48)
  const accentColor = headerBg

  let page = doc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  // Tracks each page's own header-top y, so its vertical borders (drawn once
  // the page is complete) span exactly that page's rows -- not some other
  // page's coordinates, which a single trailing draw-verticals-at-the-end
  // pass would get wrong the moment the table spans more than one page.
  let pageHeaderTop = 0

  // ---- Title + generated stamp (first page only) -------------------------
  page.drawText(pdfSafe('Budget Utilization Report'), { x: MARGIN, y, size: 20, font: bold, color: titleColor })
  y -= 18
  const generatedLabel = `Generated ${opts.generatedAt.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}${opts.eventName ? `   ·   ${opts.eventName}` : ''}`
  page.drawText(pdfSafe(generatedLabel), { x: MARGIN, y, size: 9, font, color: subtitleColor })
  y -= 10
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableW, y }, thickness: 1.5, color: accentColor })
  y -= 14

  function drawVerticalBorders(headerTop: number, bottom: number): void {
    let vx = tableX
    for (const col of COLUMNS) {
      page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y: bottom }, thickness: 0.5, color: gridColor })
      vx += col.width
    }
    page.drawLine({ start: { x: vx, y: headerTop }, end: { x: vx, y: bottom }, thickness: 0.5, color: gridColor })
  }

  function drawHeaderRow(): void {
    const rowTop = y
    page.drawRectangle({ x: tableX, y: rowTop - HEADER_ROW_H, width: tableW, height: HEADER_ROW_H, color: headerBg })
    let x = tableX
    for (const col of COLUMNS) {
      const textY = rowTop - HEADER_ROW_H + 8
      const label = pdfSafe(col.header)
      const textX =
        col.align === 'right' ? x + col.width - 6 - bold.widthOfTextAtSize(label, 8.5) : x + 6
      page.drawText(label, { x: textX, y: textY, size: 8.5, font: bold, color: headerText })
      x += col.width
    }
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
    const deptLines = wrapText(pdfSafe(r.department_name), font, 9, COLUMNS[1]!.width - 10)
    const rowH = Math.max(BASE_ROW_H, deptLines.length * LINE_H + 8)

    if (y - rowH < MARGIN) newPage()

    const rowTop = y
    if (i % 2 === 1) {
      page.drawRectangle({ x: tableX, y: rowTop - rowH, width: tableW, height: rowH, color: stripeBg })
    }

    const cells = [
      String(i + 1),
      null, // department drawn separately (may wrap)
      formatINR(r.budget_amount),
      formatINR(r.actual_amount),
      r.budget_status_note ?? formatPercent(r.pct_of_budget),
    ]

    let x = tableX
    for (let c = 0; c < COLUMNS.length; c += 1) {
      const col = COLUMNS[c]!
      if (c === 1) {
        deptLines.forEach((line, li) => {
          page.drawText(line, { x: x + 6, y: rowTop - 13 - li * LINE_H, size: 9, font, color: ink })
        })
      } else {
        const label = pdfSafe(cells[c] as string)
        const textX = col.align === 'right' ? x + col.width - 6 - font.widthOfTextAtSize(label, 9) : x + 6
        page.drawText(label, { x: textX, y: rowTop - 13, size: 9, font, color: ink })
      }
      x += col.width
    }

    y = rowTop - rowH
    page.drawLine({ start: { x: tableX, y }, end: { x: tableX + tableW, y }, thickness: 0.5, color: gridColor })
  }

  drawVerticalBorders(pageHeaderTop, y) // close out the final page

  return doc.save()
}
