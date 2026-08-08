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
import { NextResponse, type NextRequest } from 'next/server'
import { publicEnv, serverEnv } from '@/lib/env'

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const supabase = publicEnv.NEXT_PUBLIC_SUPABASE_URL // https://<ref>.supabase.co
  const supabaseWs = supabase.replace('https://', 'wss://')

  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`};
    img-src 'self' blob: data: ${supabase};
    font-src 'self';
    connect-src 'self' ${supabase} ${supabaseWs} https://*.sentry.io;
    worker-src 'self' blob:;
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests;
  `.replace(/\s{2,}/g, ' ').trim()

  // Report-only while tuning the policy (MASTER-PLAN §4.4b "roll it out
  // report-only first"); flip via CSP_REPORT_ONLY=false once the review
  // screen and document viewer have run clean for a few days of real use.
  const header = serverEnv.CSP_REPORT_ONLY
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy'

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp) // Next reads the nonce from here

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(header, csp)
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  // camera=(self) is deliberate — on-site staff photograph bills from their phones (§5).
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  return res
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
}
