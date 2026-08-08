import type { Metadata } from 'next'
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
      <body className="antialiased">{children}</body>
    </html>
  )
}
