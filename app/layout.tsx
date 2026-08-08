import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import './globals.css'

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
        {/* Mounted once, app-wide — every screen calls `toast()` from 'sonner'
            directly rather than each owning its own <Toaster/>. */}
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  )
}
