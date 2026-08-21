import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/app-shell/logo'

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-16 text-center">
      <Logo imageClassName="w-24" />
      <div className="flex flex-col items-center gap-3">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-primary">
          Ref · not on file
        </p>
        <p className="font-display text-7xl font-black leading-none tabular-nums text-primary">404</p>
        <h1 className="max-w-md font-display text-2xl font-semibold [text-wrap:balance]">
          No record at this reference
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This page isn&rsquo;t in the ledger. It may have moved, been renamed, or the link&rsquo;s out of
          date.
        </p>
        <p className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          CASE — 404 · NOT ON FILE
        </p>
      </div>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/">Back to Hub</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/entries">Go to Entries</Link>
        </Button>
      </div>
    </main>
  )
}
