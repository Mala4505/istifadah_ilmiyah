// Shared sizing for the hand-drawn SVG matrices in /reports
// (heatmap-matrix-chart, zone-economics-matrix-chart, zone-category-matrix-chart).
//
// Each matrix lays out at its container's measured width (useChartWidth) at
// scale 1 — viewBox width === rendered width — so 11px labels stay 11px on a
// phone instead of shrinking with a fixed viewBox. Cell width stretches to
// fill the card but is capped (MAX_CELL_W) so a wide monitor doesn't draw
// giant cells, and floored (MIN_CELL_W) so a many-column matrix scrolls
// sideways on a phone (the wrapper is overflow-x-auto) rather than cramming
// cells to slivers.

export const MATRIX_MIN_CELL_W = 34
export const MATRIX_MAX_CELL_W = 72
export const MATRIX_CELL_H = 30
export const MATRIX_PAD_RIGHT = 64 // room for the last angled column label
export const MATRIX_PAD_BOTTOM = 6
// ~6.3px per character at 11px in the app's sans font.
const CHAR_PX = 6.3

export type MatrixLayout = {
  rowLabelW: number
  rowLabelChars: number
  cellW: number
  svgWidth: number
}

export function matrixLayout(containerWidth: number, colCount: number): MatrixLayout {
  const rowLabelW = containerWidth < 480 ? 116 : 168
  const rowLabelChars = Math.max(8, Math.floor((rowLabelW - 12) / CHAR_PX))
  const available = containerWidth - rowLabelW - MATRIX_PAD_RIGHT
  const cellW = Math.round(
    Math.min(MATRIX_MAX_CELL_W, Math.max(MATRIX_MIN_CELL_W, available / Math.max(1, colCount)))
  )
  return { rowLabelW, rowLabelChars, cellW, svgWidth: rowLabelW + colCount * cellW + MATRIX_PAD_RIGHT }
}

/** Height of the angled (-40°) column-label band for labels truncated to
 *  `chars` characters at 11px. */
export function matrixColLabelHeight(chars: number): number {
  return Math.round(Math.sin((40 * Math.PI) / 180) * chars * CHAR_PX) + 22
}

export function truncateLabel(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
