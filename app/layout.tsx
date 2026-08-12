import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Fraunces, Public_Sans, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

// Nonce-based CSP (middleware.ts, MASTER-PLAN §4.4b) requires every page to render
// dynamically, per request -- a statically-optimized page is prerendered at build time
// with no per-request nonce, so its script tags never get one and every script on the
// page is silently blocked once CSP is enforced (verified: /login was being statically
// optimized and shipped zero nonces anywhere in its HTML, which breaks the login form's
// hydration entirely under CSP_REPORT_ONLY=false). Forcing it here, once, at the root
// layout, is simpler and safer than remembering it per-page as new routes are added.
export const dynamic = 'force-dynamic'

// Header face — h1-h6 pick this up via the base rule in globals.css.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
})

// Body face — everything else.
const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
})

// Reserved for the numbers people actually entered — amounts, counts, ITS
// numbers — never for prose. Tabular figures, unambiguous 0/O and 1/l/I.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title: 'Istifadah Ilmiyah',
  description: 'Reconciliation, review and reporting for Istifadah Ilmiyah event finance.',
}

// Sets the `dark` class before hydration so the first paint matches the
// user's saved preference. Light is the default for anyone who hasn't
// toggled yet -- deliberately ignores the OS setting. No next-themes —
// this project stays off that dependency, see components/ui/sonner.tsx.
const themeScript = `
try {
  var stored = localStorage.getItem('theme');
  document.documentElement.classList.toggle('dark', stored === 'dark');
} catch (e) {}
`

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // The theme script is the one inline <script> this app writes by hand (everything
  // else is Next's own, which reads its nonce automatically from the CSP header --
  // see middleware.ts). A hand-written inline script needs its nonce passed explicitly,
  // or it's silently blocked the moment CSP_REPORT_ONLY flips to false (confirmed
  // 2026-08-12 against a real report-only violation on /admin).
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fraunces.variable} ${publicSans.variable} ${plexMono.variable}`}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        {children}
        {/* Mounted once, app-wide (not per-screen) so any screen can
            `import { toast } from 'sonner'` and just call it — every screen
            calls `toast()` directly rather than each owning its own
            <Toaster/>. */}
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  )
}
