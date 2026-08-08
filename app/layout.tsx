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
        {/* Mounted once, globally — every screen's `toast(...)` calls render here.
            Not present yet elsewhere in the tree; added here since /export and
            /exceptions (this agent's screens) depend on it and it was missing. */}
        <Toaster richColors closeButton />
      </body>
    </html>
  )
}
