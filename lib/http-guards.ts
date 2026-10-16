/**
 * Small, dependency-free request guards shared by the Route Handlers
 * (security-audit-fix-plan.md Phase 4.3 / 4.5). Deliberately plain TypeScript
 * with no `next/*` imports so each piece is unit-testable on its own
 * (test/unit/http-guards.test.ts).
 *
 * Every function takes anything shaped like `Headers` (`{ get(name) }`), so a
 * Route Handler passes `request.headers` and a test passes `new Headers(...)`.
 */

type HeaderReader = { get(name: string): string | null }

/** Result of a failed guard: the status + plain-English message to send. */
export interface GuardProblem {
  status: number
  error: string
}

/**
 * True when the request declares a JSON body (`application/json`, with or
 * without a charset). A cross-site HTML form can only send form/text content
 * types without a CORS preflight, so requiring JSON closes the "simple
 * request" CSRF route into cookie-authenticated JSON endpoints.
 */
export function isJsonContentType(headers: HeaderReader): boolean {
  const type = (headers.get('content-type') ?? '').trim().toLowerCase()
  return type === 'application/json' || type.startsWith('application/json;')
}

/** Host part (lower-cased, with port) of a URL-ish string, or null. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Same-origin check for cookie-authenticated, state-changing requests.
 *
 * A browser always sends `Origin` on a cross-site POST/DELETE, and a page on
 * another site cannot forge it. We accept the request when the Origin's host
 * equals the host the request itself was addressed to (`x-forwarded-host` /
 * `host`) OR the configured site URL. Comparing with the request's own host
 * (not only NEXT_PUBLIC_SITE_URL) keeps Vercel preview deployments and
 * localhost working without any extra configuration.
 *
 * No `Origin` header at all means a non-browser client (curl, a server job) —
 * those carry no ambient cookies, so they are let through unless the browser
 * metadata `Sec-Fetch-Site` says the request is cross-site.
 */
export function isSameOrigin(headers: HeaderReader, siteUrl?: string | null): boolean {
  const origin = headers.get('origin')
  if (!origin) {
    const fetchSite = (headers.get('sec-fetch-site') ?? '').toLowerCase()
    return fetchSite !== 'cross-site'
  }
  if (origin === 'null') return false
  const originHost = hostOf(origin)
  if (!originHost) return false

  const requestHost = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase()
  if (requestHost && originHost === requestHost) return true

  const siteHost = siteUrl ? hostOf(siteUrl) : null
  return siteHost !== null && originHost === siteHost
}

/**
 * Combined guard for a cookie-authenticated JSON route. Returns the problem to
 * send (415 for a non-JSON content type, 403 for a cross-site Origin), or null
 * when the request is fine.
 */
export function jsonRequestProblem(
  headers: HeaderReader,
  opts: { siteUrl?: string | null; checkOrigin: boolean }
): GuardProblem | null {
  if (!isJsonContentType(headers)) {
    return { status: 415, error: 'This request must be sent as JSON.' }
  }
  if (opts.checkOrigin && !isSameOrigin(headers, opts.siteUrl)) {
    return { status: 403, error: 'This request did not come from the app.' }
  }
  return null
}

/** 403 problem when a cookie-authenticated request came from another site, else null. */
export function originProblem(headers: HeaderReader, siteUrl?: string | null): GuardProblem | null {
  return isSameOrigin(headers, siteUrl)
    ? null
    : { status: 403, error: 'This request did not come from the app.' }
}

/**
 * True when the declared `Content-Length` already exceeds `maxBytes`. Used to
 * refuse an oversize body before reading any of it. A missing or malformed
 * header returns false (the caller still checks the real size after reading).
 */
export function declaredLengthExceeds(headers: HeaderReader, maxBytes: number): boolean {
  const raw = headers.get('content-length')
  if (!raw) return false
  const length = Number(raw)
  return Number.isFinite(length) && length > maxBytes
}

/**
 * The caller's IP as seen by Vercel's edge: `x-real-ip` (set by the platform),
 * else the RIGHTMOST `x-forwarded-for` hop (the one the platform's own proxy
 * appended). The leftmost hop is whatever the client claimed, so it is never
 * used. Returns null when neither header is present.
 */
export function clientIpFromHeaders(headers: HeaderReader): string | null {
  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  const forwardedFor = headers.get('x-forwarded-for')
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map((hop) => hop.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last
  }
  return null
}
