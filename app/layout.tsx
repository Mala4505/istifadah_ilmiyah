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
        {/* Mounted here (not per-screen) so any screen can `import { toast } from
            'sonner'` and just call it — the import screen (day 2) is the first
            consumer, but this was missing for every screen, not just this one. */}
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  )
}
