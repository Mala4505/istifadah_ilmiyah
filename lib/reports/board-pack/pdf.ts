/**
 * Board pack -- PDF builder. reporting-blueprint.md §5.
 *
 * REAL, not a stub -- but deliberately basic. This stack has no headless
 * chromium / HTML-to-PDF path (only pdf-lib for structure and pdfjs-dist for
 * reading), and the org's outward format of record is the .xlsx workbook. So
 * the PDF is a plain text rendering of the Brief: the cover line, the 5 KPI
 * tiles, the "what changed this week" sentences, the department league table
 * as a monospace-ish text grid, and the "needs decision" list. No charts.
 *
 * `buildBoardPackPdf(data)` -> the PDF as bytes. Pure: no I/O, no framework
 * imports. pdf-lib is dynamically imported (same pattern as lib/pdf.ts) so it
 * never lands in a bundle that doesn't call this.
 */

import { formatINR, formatPercent } from '@/lib/reports/format'
import type { BoardPackData } from '@/lib/reports/board-pack/types'

/**
 * pdf-lib's StandardFonts are WinAnsi-encoded and throw on any character they
 * can't represent (₹ = U+20B9, non-Latin vendor/department names, smart
 * punctuation). There is no embeddable Unicode font in this stack, so the text
 * PDF substitutes: ₹ -> "Rs ", dashes/quotes -> ASCII, and anything still
 * outside Latin-1 -> "?". The .xlsx workbook keeps every character intact --
 * this only degrades the secondary text rendering.
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

const PAGE_W = 595.28 // A4 pt
const PAGE_H = 841.89
const MARGIN = 48
const LINE = 14

type Ctx = {
  doc: import('pdf-lib').PDFDocument
  font: import('pdf-lib').PDFFont
  bold: import('pdf-lib').PDFFont
  page: import('pdf-lib').PDFPage
  y: number
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H])
  ctx.y = PAGE_H - MARGIN
}

function ensure(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx)
}

/** Wraps `text` to the content width at `size` and returns the lines. */
function wrap(text: string, font: import('pdf-lib').PDFFont, size: number): string[] {
  const maxW = PAGE_W - MARGIN * 2
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

function draw(ctx: Ctx, text: string, opts: { size?: number; bold?: boolean; indent?: number } = {}): void {
  const size = opts.size ?? 10
  const font = opts.bold ? ctx.bold : ctx.font
  const indent = opts.indent ?? 0
  for (const line of wrap(pdfSafe(text), font, size)) {
    ensure(ctx, LINE)
    ctx.page.drawText(line, { x: MARGIN + indent, y: ctx.y, size, font })
    ctx.y -= LINE
  }
}

function gap(ctx: Ctx, n = 1): void {
  ctx.y -= LINE * n
}

function heading(ctx: Ctx, text: string): void {
  gap(ctx, 0.5)
  ensure(ctx, LINE * 2)
  draw(ctx, text, { size: 13, bold: true })
  gap(ctx, 0.25)
}

/** Fixed-width text row: pads each cell to its column width with spaces. Uses
 *  the regular font at 8pt so ~95 chars fit the content width. */
function textRow(cells: string[], widths: number[]): string {
  return cells
    .map((raw, i) => {
      const c = pdfSafe(raw)
      return c.length > widths[i]! ? c.slice(0, widths[i]! - 1) + '~' : c.padEnd(widths[i]!)
    })
    .join(' ')
}

export async function buildBoardPackPdf(data: BoardPackData): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN }

  // ---- Cover -----------------------------------------------------------
  draw(ctx, 'Board pack', { size: 20, bold: true })
  gap(ctx, 0.25)
  draw(ctx, data.eventName ?? '(no event selected)', { size: 12, bold: true })
  const window =
    data.eventStartsOn || data.eventEndsOn
      ? `Event window: ${data.eventStartsOn ?? '?'} to ${data.eventEndsOn ?? '?'}`
      : 'Event window: not set'
  draw(ctx, window, { size: 9 })
  draw(ctx, `Generated ${new Date(data.generatedAt).toLocaleString('en-IN')}`, { size: 9 })
  draw(ctx, 'The workbook (.xlsx) alongside this PDF is the deliverable of record; this is a text summary.', { size: 8 })

  if (data.warnings.length > 0) {
    gap(ctx, 0.5)
    draw(ctx, 'Data warnings:', { size: 9, bold: true })
    for (const w of data.warnings) draw(ctx, `- ${w}`, { size: 8, indent: 8 })
  }

  // ---- KPIs ----------------------------------------------------------
  heading(ctx, 'Headline KPIs')
  for (const k of data.kpis) {
    draw(ctx, k.label, { size: 9, bold: true })
    draw(ctx, k.delta ? `${k.value}  -  ${k.delta}` : k.value, { size: 10, indent: 8 })
    gap(ctx, 0.25)
  }

  // ---- What changed --------------------------------------------------
  heading(ctx, 'What changed this week')
  if (data.narrative.length === 0) {
    draw(ctx, 'No narrative points this week.', { size: 9 })
  } else {
    data.narrative.forEach((s, i) => draw(ctx, `${i + 1}. ${s}`, { size: 9 }))
  }

  gap(ctx, 0.5)
  heading(ctx, 'The ten things most worth attention')
  if (data.digest.length === 0) {
    draw(ctx, 'Nothing surfaced or worsened in the last 7 days.', { size: 9 })
  } else {
    for (const item of data.digest) {
      const amt = item.amount != null ? formatINR(item.amount) : '-'
      const age = item.ageDays != null ? `${item.ageDays}d` : '-'
      draw(ctx, `${item.rank}. ${item.headline}`, { size: 9 })
      draw(ctx, `${amt}  |  owner: ${item.owner}  |  age: ${age}`, { size: 8, indent: 12 })
      gap(ctx, 0.2)
    }
  }

  // ---- Department league (text grid) --------------------------------
  heading(ctx, 'Department league')
  const widths = [22, 12, 8, 12, 8, 10, 8]
  const headerRow = textRow(['Department', 'Spend', 'Share', 'Budget', '%Bud', 'Land%', 'Doc%'], widths)
  ensure(ctx, LINE)
  ctx.page.drawText(headerRow, { x: MARGIN, y: ctx.y, size: 8, font: bold })
  ctx.y -= LINE
  if (data.league.length === 0) {
    draw(ctx, 'No departments with spend yet.', { size: 9 })
  } else {
    for (const r of data.league) {
      const row = textRow(
        [
          r.departmentName,
          formatINR(r.spend),
          r.spendSharePct != null ? formatPercent(r.spendSharePct) : '-',
          r.budgetAmount != null ? formatINR(r.budgetAmount) : '-',
          r.pctOfBudget != null ? formatPercent(r.pctOfBudget) : '-',
          r.projectedLandingPct != null ? formatPercent(r.projectedLandingPct) : '-',
          r.documentCoveragePct != null ? formatPercent(r.documentCoveragePct) : '-',
        ],
        widths
      )
      ensure(ctx, LINE)
      ctx.page.drawText(row, { x: MARGIN, y: ctx.y, size: 8, font })
      ctx.y -= LINE
    }
  }

  // ---- Needs decision ----------------------------------------------
  heading(ctx, 'Needs your decision')
  if (data.needsDecision.length === 0) {
    draw(ctx, 'No open issues.', { size: 9 })
  } else {
    for (const r of data.needsDecision) {
      const amt = r.amountAtRisk != null ? formatINR(r.amountAtRisk) : '-'
      draw(ctx, `[${r.severity}] ${r.description ?? r.issueType}`, { size: 9 })
      draw(ctx, `${amt}  |  owner: ${r.owner}  |  age: ${r.ageDays}d`, { size: 8, indent: 12 })
      gap(ctx, 0.2)
    }
  }

  return doc.save()
}
