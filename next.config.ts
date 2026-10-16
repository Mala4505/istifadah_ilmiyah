import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

// output: 'standalone' — the portability kit (MASTER-PLAN §10, §13). A standalone
// build runs identically under `node server.js` on Vercel or the Windows Server;
// nothing here may branch on the host.
const nextConfig: NextConfig = {
  output: 'standalone',
  // No serverExternalPackages entry for pdfjs-dist anymore — lib/pdf.ts's
  // server-side code (getPdfPageCount, splitPdfPage) no longer imports it at
  // all, having moved to pdf-lib specifically because pdfjs-dist's worker
  // plumbing did not survive Vercel's serverless bundling (see
  // getPdfPageCount's doc comment in lib/pdf.ts for the full story — this is
  // what the "Cannot find module '.../pdf.worker.mjs'" errors were).
  // pdfjs-dist is still a real dependency (package.json) for
  // components/review/pdf-viewer.tsx's browser-side rendering, which is
  // unaffected: that ships to the client as a normal webpack bundle with its
  // worker served as a static asset, not read off a serverless function's
  // filesystem, so it was never the same failure mode.
  eslint: {
    // next build already fails on ESLint errors by default — this just makes it explicit.
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Long-lived caching for static assets served straight out of `public/`
  // that are content-addressed by filename change, not by URL (pdf.js's
  // worker script, the bookmarklet). These are also excluded from the
  // middleware matcher (middleware.ts) so the request never triggers CSP
  // nonce construction or a Supabase auth call (getClaims()/getUser()) — see
  // docs/performance-remediation-plan.md item 3.2.
  async headers() {
    return [
      {
        // Anti-clickjacking (security-audit-fix-plan.md 4.1 / M7). Works even
        // while the CSP is still Report-Only; CSP's `frame-ancestors 'none'`
        // (middleware.ts) says the same thing once enforced. Nothing in the app
        // iframes itself. Set once here for every path, API included.
        source: '/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      },
      {
        // Middleware's matcher skips /api (middleware.ts), so API responses get
        // none of its security headers. Mirror the relevant ones here, plus
        // no-store so a signed-in response is never cached by a shared proxy.
        source: '/api/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        source: '/pdf.worker.min.mjs',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/bookmarklet/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ]
  },
}

// withSentryConfig wires up source-map upload at build time (MASTER-PLAN §2,
// §11.1 Day 7). It reads SENTRY_AUTH_TOKEN / org / project straight from
// process.env itself (that's how the Sentry CLI and its webpack plugin work),
// not through lib/env.server.ts — this runs in the Next.js build script,
// never in a bundle shipped to a browser, so the server-only boundary in
// lib/env.server.ts doesn't apply here. Safe to leave enabled with no auth
// token / DSN set: the plugin just skips the upload and next build proceeds
// (confirmed against this repo's default empty-DSN local setup).
export default withSentryConfig(nextConfig, {
  silent: true,
  // Source maps are only uploaded when SENTRY_AUTH_TOKEN is set (CI/deploy);
  // local builds without it proceed without uploading.
  widenClientFileUpload: true,
  webpack: {
    treeshake: { removeDebugLogging: true },
  },
})
