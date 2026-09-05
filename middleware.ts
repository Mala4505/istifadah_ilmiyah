// middleware.ts
//
// Next.js 16 renames this file to `proxy.ts` and the exported function to
// `proxy` (MASTER-PLAN §4.4b). On Next.js 15 — what this repo runs — the file
// must be named `middleware.ts` and export `middleware`. When the app moves
// to Next 16, rename the file and the export; the body below is unchanged.
//
// Nonce-based Content Security Policy, set once, in the app, per §4.4b. Do
// not also set CSP in IIS/the reverse proxy on the Windows Server — browsers
// apply the intersection of duplicate CSP headers, which produces breakage
// that looks like a code bug.
//
// style-src is 'unsafe-inline', not nonced, in every environment (confirmed
// 2026-08-12 against real report-only violations on /admin): Radix UI, which
// every components/ui/* primitive is built on (popover, select, dropdown,
// dialog, tooltip), sets positioning via inline style="..." attributes it
// generates at runtime -- there is no nonce or fixed hash to attach to those,
// since the value is different every render. A CSS-injection payload can at
// worst exfiltrate data via selectors/attribute-reads, not execute arbitrary
// code, so this is the standard, accepted trade-off wherever a nonce-based
// CSP meets a component library like this one. script-src stays fully
// strict (nonce + strict-dynamic, no unsafe-inline) -- that is where CSP's
// real value is, and nothing here weakens it.
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { publicEnv } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'

export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const supabase = publicEnv.NEXT_PUBLIC_SUPABASE_URL // https://<ref>.supabase.co
  const supabaseWs = supabase.replace('https://', 'wss://')

  // Report-only while tuning the policy (MASTER-PLAN §4.4b "roll it out
  // report-only first"); flip via CSP_REPORT_ONLY=false once the review
  // screen and document viewer have run clean for a few days of real use.
  const header = serverEnv.CSP_REPORT_ONLY
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy'

  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: ${supabase};
    font-src 'self';
    connect-src 'self' ${supabase} ${supabaseWs} https://*.sentry.io;
    worker-src 'self' blob:;
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    ${serverEnv.CSP_REPORT_ONLY ? '' : 'upgrade-insecure-requests;'}
  `.replace(/\s{2,}/g, ' ').trim()

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp) // Next reads the nonce from here

  // `@supabase/ssr` session refresh — the piece this middleware was missing.
  // Without calling `getUser()` on every request, the access token in the
  // session cookie is never refreshed, so a session silently goes stale in
  // Server Components (they can only read cookies, never write them — see
  // the comment in lib/supabase/server.ts). This is the standard
  // `@supabase/ssr` middleware recipe: a mutable `response` that gets
  // rebuilt every time Supabase's cookie adapter calls `setAll`, so the
  // refreshed cookies ride out on the response that's ultimately returned.
  //
  // `response` starts as the CSP-header-bearing NextResponse built above the
  // supabase client, and is intentionally re-pointed (not mutated in place)
  // inside `setAll`, per the recipe — each `NextResponse.next({ request })`
  // carries the request's headers (including the nonce/CSP set above)
  // forward, so rebuilding it here does not lose them.
  let response = NextResponse.next({ request: { headers: requestHeaders } })

  const supabaseClient = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request: { headers: requestHeaders } })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    }
  )

  // Do not remove: this is the call that actually refreshes the token.
  // Reading it via `getUser()` (not `getSession()`) also validates the JWT
  // against the Supabase Auth server rather than trusting an unverified
  // cookie value.
  await supabaseClient.auth.getUser()

  response.headers.set(header, csp)
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  // camera=(self) is deliberate — on-site staff photograph bills from their phones (§5).
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  return response
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico|pdf.worker.min.mjs|bookmarklet/).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
}
