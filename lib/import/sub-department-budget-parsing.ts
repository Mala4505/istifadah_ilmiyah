/**
 * Pure, DB-free helpers for the sub-department-budget import — a near-exact
 * mirror of lib/import/department-budget-parsing.ts, but for a three-column
 * sheet (department name, sub-department name, budget amount) since
 * sub-department names are only unique *within* a department (see the
 * sub-department feature plan's "Budget import pipeline" section).
 *
 * `pickField`, `normalizeDepartmentName`, `parseAmount`, `isTotalRowMarker`,
 * `DEPARTMENT_KEYS`, and `AMOUNT_KEYS` are reused as-is from
 * department-budget-parsing.ts rather than duplicated — same normalization
 * rules apply to sub-department names as to department names (near-exact
 * match, not fuzzy resolution), so `normalizeDepartmentName` doubles as the
 * sub-department normalizer too.
 *
 * Also reused by components/import/sub-department-budget-row-log-table.tsx
 * so the dry-run preview's column-matching stays in lockstep with what the
 * importer itself actually reads.
 */

export {
  AMOUNT_KEYS,
  DEPARTMENT_KEYS,
  isTotalRowMarker,
  normalizeDepartmentName,
  normalizeKey,
  parseAmount,
  pickField,
  TOTAL_ROW_MARKERS,
} from '@/lib/import/department-budget-parsing'

export const SUB_DEPARTMENT_KEYS = [
  'sub department',
  'sub-department',
  'sub department name',
  'subdepartment',
  'sub dept',
] as const
