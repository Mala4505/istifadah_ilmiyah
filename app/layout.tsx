import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Istifada Ilmiyah Financial Hub',
  description: 'Reconciliation, review and reporting for Istifada Ilmiyah event finance.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
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
