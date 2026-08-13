/**
 * Policy thresholds for the analytics engine.
 *
 * These are deliberately in one file, named, and commented with their source.
 * They are policy, not logic: the statutory ones move when the law moves, and
 * the discretionary ones are the user's call, not the code's. Burying a number
 * like 100000 inside a detector makes it invisible when it needs to change and
 * impossible to explain when a reviewer asks why something was flagged.
 *
 * Statutory figures are current as of FY 2025-26. They are marked as such so a
 * future reader knows to re-check rather than assume.
 */

/** ------------------------------------------------------------------ TDS */

/**
 * Section 194C (payments to contractors). Two independent triggers — either one
 * alone obliges the payer to deduct at source:
 *   - any SINGLE payment above ₹30,000
 *   - AGGREGATE payments to one contractor above ₹1,00,000 in the financial year
 *
 * The aggregate limb is the one that matters here. The pilot corpus contains a
 * vendor billed across four separate documents; no single one crosses ₹30,000,
 * but together they clear the annual limit — which is precisely the case a
 * per-document check cannot see.
 */
export const TDS_194C_SINGLE_PAYMENT = 30_000
export const TDS_194C_ANNUAL_AGGREGATE = 100_000

/** 1% where the payee is an individual or HUF, 2% otherwise. */
export const TDS_194C_RATE_INDIVIDUAL = 0.01
export const TDS_194C_RATE_OTHER = 0.02

/** ------------------------------------------------------------------ GST */

/**
 * The standard slabs. An implied rate (tax ÷ taxable value) outside this set is
 * either a mis-keyed figure or a rate that no longer exists — both worth a look.
 * 0 is included: a legitimately exempt supply is not an anomaly.
 */
// Typed as readonly number[] rather than a literal-union `as const`: these are
// values to compare against, not a type, and the literal union makes ordinary
// arithmetic over them (Math.max, nearest-slab reduction) fail to typecheck.
export const GST_STANDARD_RATES: readonly number[] = [
  0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28,
]

/**
 * Tolerance on the implied-rate comparison, in percentage points.
 *
 * Rounding on the invoice means an 18% line rarely computes to exactly 18.000 —
 * a ₹3,000 taxable value with ₹540 tax is exact, but a ₹24,600 line with a
 * rounded ₹4,428 is 17.998%. Anything inside this band is arithmetic, not a
 * finding.
 */
export const GST_RATE_TOLERANCE_PCT = 0.15

/**
 * Rate assumed when estimating credit lost on a no-GST purchase.
 *
 * Every GST-charging vendor in the pilot corpus charged 18%, and 18% is the
 * default slab for the works-contract and furniture supplies this spend is made
 * of. It is an ASSUMPTION, and every flag that uses it says so in its evidence
 * rather than presenting the estimate as a measured figure.
 */
export const ASSUMED_GST_RATE_FOR_ESTIMATES = 18

/**
 * Below this, a vendor charging no GST is not worth a reviewer's time.
 *
 * Small over-the-counter purchases from unregistered suppliers are ordinary and
 * unavoidable. Flagging a ₹2,690 stationery cash memo produces noise that buries
 * the ₹92,000 finding sitting next to it in the same queue.
 */
export const GST_NOT_CHARGED_MIN_AMOUNT = 20_000

/** ------------------------------- Repeat billing / vendor splitting */

/**
 * The organisation's delegated financial authority limit — the amount above
 * which a purchase needs higher sign-off.
 *
 * NULL, confirmed with the user 2026-08-12: no formal limit exists.
 *
 * This is not a missing configuration value, it is a fact about the
 * organisation, and it changes what the detector can honestly claim. With a
 * limit, several bills that each sit under it and together sit over it are a
 * control breach — spend that never reached the person who should have approved
 * it. Without one there is no control to breach, so the same shape is reported
 * as a concentration pattern worth a look, at lower severity, and the flag says
 * so rather than implying a rule was broken.
 *
 * Set this to a number if a limit is ever introduced; the detector switches to
 * the stricter reading automatically.
 */
export const APPROVAL_LIMIT: number | null = null

/** Minimum number of bills before a cluster is a pattern rather than a coincidence. */
export const SPLITTING_MIN_BILL_COUNT = 3

/** Bills must fall inside this window to count as one cluster. */
export const SPLITTING_WINDOW_DAYS = 30

/**
 * How close to the limit a bill has to sit to look deliberate.
 *
 * A bill at 96% of the limit is a different signal from one at 20%. Only used
 * when APPROVAL_LIMIT is set; ignored in concentration mode.
 */
export const SPLITTING_NEAR_LIMIT_RATIO = 0.8

/**
 * In concentration mode (no approval limit), the total a cluster must reach
 * before it is worth surfacing.
 *
 * Without a limit to measure against, this is the only thing keeping the
 * detector from reporting every vendor billed three times for small amounts.
 */
export const CONCENTRATION_MIN_TOTAL = 50_000

/** --------------------------------------------- Duplicate payment */

/** Two bills this far apart or closer, for the same vendor, are duplicate candidates. */
export const DUPLICATE_WINDOW_DAYS = 90

/**
 * Amounts within this fraction of each other count as "the same amount".
 *
 * Exact equality misses the real duplicate-payment pattern, where the same work
 * is billed twice with a small difference in rounding or a line added.
 */
export const DUPLICATE_AMOUNT_TOLERANCE = 0.005

/** ------------------------------------------------ Rate benchmark */

/**
 * A family needs this many observations, from at least two vendors, before its
 * median means anything.
 *
 * Below it the "benchmark" is one vendor's price restated as a standard, and
 * every other vendor is measured against a sample of one. The pilot corpus is
 * far below this for every family — which is the honest reason Pillar D reports
 * "not enough data" rather than a number.
 */
export const RATE_BENCHMARK_MIN_OBSERVATIONS = 5
export const RATE_BENCHMARK_MIN_VENDORS = 2

/** How far above the family median a rate has to sit before it is flagged. */
export const RATE_ABOVE_BENCHMARK_PCT = 25

/** ------------------------------------------------------ Severity */

/** Amount at risk at or above which a finding is escalated to high severity. */
export const HIGH_SEVERITY_AMOUNT = 50_000
export const MEDIUM_SEVERITY_AMOUNT = 10_000
