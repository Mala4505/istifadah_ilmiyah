'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type SourceSystem = 'departmental' | 'audit'

/**
 * One reader link per portal, each carrying its own `SOURCE_SYSTEM` baked in
 * at mint time. Deliberately NOT one bookmarklet that detects which portal
 * it's on: the two portals render an "Entry Number" column that means a
 * different thing on each side (UBBL on Departmental, Main/Audit number on
 * Audit — see lib/import/portal-mapping.ts), and a misdetection there writes
 * a confidently wrong value instead of failing loudly. A separate,
 * clearly-labelled link per portal removes the guess entirely: the operator
 * already knows which portal they're looking at.
 */
const PORTAL_READER_SOURCES: readonly { sourceSystem: SourceSystem; portalName: string }[] = [
  { sourceSystem: 'departmental', portalName: 'Departmental portal' },
  { sourceSystem: 'audit', portalName: 'Audit portal' },
]

interface MintedToken {
  token: string
  id: number
  tokenPrefix: string
  sourceSystem: SourceSystem
  expiresAt: string
}

interface TokenRow {
  id: number
  token_prefix: string
  label: string | null
  source_system: SourceSystem
  created_at: string
  expires_at: string
  last_used_at: string | null
  use_count: number
  revoked_at: string | null
}

interface Props {
  isAdmin: boolean
  /** Contents of public/bookmarklet/read-portal.js, read server-side. */
  source: string
  hubUrl: string
}

/**
 * Packs the reader script into a `javascript:` URL.
 *
 * The token is substituted into the source rather than fetched at run time:
 * the dragged link has no session on the portal's origin, so there is nothing
 * for it to authenticate a fetch WITH — the token has to travel inside the
 * link itself. That is what makes it worth keeping short-lived and revocable
 * (see lib/scrape-token.ts).
 *
 * `encodeURIComponent` over the whole body preserves newlines as %0A, so the
 * source's `//` line comments still terminate correctly. Minifying first is
 * therefore unnecessary, and keeping the readable text means an operator who
 * inspects their own link can see exactly what it does.
 */
function packReaderLink(input: {
  source: string
  hubUrl: string
  token: string
  sourceSystem: SourceSystem
}): string {
  const body = input.source
    .replace(/__HUB_URL__/g, input.hubUrl.replace(/\/+$/, ''))
    .replace(/__TOKEN__/g, input.token)
    .replace(/__SOURCE_SYSTEM__/g, input.sourceSystem)
    .replace(/__VERSION__/g, new Date().toISOString().slice(0, 10))

  return `javascript:${encodeURIComponent(body)}`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function tokenState(row: TokenRow): string {
  if (row.revoked_at) return 'Revoked'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'Expired'
  return 'Live'
}

function portalName(sourceSystem: SourceSystem): string {
  return PORTAL_READER_SOURCES.find((s) => s.sourceSystem === sourceSystem)?.portalName ?? sourceSystem
}

interface MintCardProps {
  sourceSystem: SourceSystem
  portalName: string
  source: string
  hubUrl: string
  /** Live (non-revoked) tokens, so a just-revoked link disappears here too. */
  liveTokenIds: ReadonlySet<number>
  onMinted: () => void
}

/**
 * One portal's create-link flow: label input, mint button, and the
 * drag-to-install link once minted. Each instance carries its own state so
 * minting a Departmental link never disturbs an already-minted Audit link
 * sitting above/below it.
 */
function PortalReaderMintCard({
  sourceSystem,
  portalName,
  source,
  hubUrl,
  liveTokenIds,
  onMinted,
}: MintCardProps) {
  const [label, setLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [minted, setMinted] = useState<MintedToken | null>(null)

  const mint = useCallback(async () => {
    setMinting(true)
    try {
      const res = await fetch('/api/scrape-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSystem, label: label.trim() || null }),
      })
      const body = await res.json()
      if (!res.ok) {
        toastError(body.error, { title: 'Could not create a reader link.', context: 'portal-reader-workspace' })
        return
      }
      setMinted(body as MintedToken)
      toast.success('Reader link created — drag it to your bookmarks bar now.')
      onMinted()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setMinting(false)
    }
  }, [label, onMinted, sourceSystem])

  // A token revoked from the list below (including the one just minted)
  // must not go on showing its "drag this now" box as if still live.
  const stillLive = minted !== null && liveTokenIds.has(minted.id)

  const readerHref = useMemo(() => {
    if (!minted || !stillLive) return null
    return packReaderLink({ source, hubUrl, token: minted.token, sourceSystem: minted.sourceSystem })
  }, [minted, stillLive, source, hubUrl])

  // React 19 refuses to set `href` to a `javascript:` string via a normal
  // JSX prop -- it throws "React has blocked a javascript: URL as a
  // security precaution" instead, which silently breaks the drag-to-install
  // link entirely (no real href ever reaches the DOM, so the dragged
  // bookmark is empty). Setting it with the native DOM API through a ref
  // bypasses that guard -- it only intercepts React's own prop-driven
  // attribute writes, not an imperative `setAttribute` call. This is not an
  // XSS hole: the string comes from packReaderLink() above, built from our
  // own known-good source file plus a token WE minted, never from anything
  // a user typed in.
  const dragLinkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const el = dragLinkRef.current
    if (!el) return
    if (readerHref) {
      el.setAttribute('href', readerHref)
    } else {
      el.removeAttribute('href')
    }
  }, [readerHref])

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm font-medium">{portalName}</p>
      <p className="text-xs text-muted-foreground">
        Shown once and never again. Expires in 30 days and can be revoked at any time.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`token-label-${sourceSystem}`}>Label (optional)</Label>
          <Input
            id={`token-label-${sourceSystem}`}
            value={label}
            placeholder="e.g. my laptop"
            onChange={(e) => setLabel(e.target.value)}
            className="w-48"
          />
        </div>
        <Button onClick={() => void mint()} disabled={minting}>
          {minting ? 'Creating…' : `Create ${portalName} link`}
        </Button>
      </div>

      {minted && stillLive && readerHref && (
        <div className="rounded-md border border-dashed p-4">
          <p className="text-sm font-medium">
            Drag this to your bookmarks bar now — it will not be shown again.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Expires {formatDateTime(minted.expiresAt)}</p>
          <a
            ref={dragLinkRef}
            onClick={(e) => {
              // Clicking it here would run it against the Hub's own page,
              // which has no portal table on it — a confusing no-op. It is
              // meant to be dragged.
              e.preventDefault()
              toast.info('Drag this link to your bookmarks bar — clicking it here does nothing.')
            }}
            className="mt-3 inline-flex cursor-grab items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            Read {portalName}
          </a>
        </div>
      )}
    </div>
  )
}

/**
 * "Portal Reader" (previously "bookmarklet" in this UI — same feature, a
 * plainer name). Mints a short-lived, portal-scoped token per source system
 * and hands the operator a drag-to-install link that reads that portal's
 * on-screen table straight into the Hub, without ever storing a portal
 * password.
 */
export function PortalReaderWorkspace({ isAdmin, source, hubUrl }: Props) {
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loadingTokens, setLoadingTokens] = useState(false)

  const loadTokens = useCallback(async () => {
    if (!isAdmin) return
    setLoadingTokens(true)
    try {
      const res = await fetch('/api/scrape-token')
      const body = await res.json()
      if (!res.ok) {
        toastError(body.error, { title: 'Could not load reader links.', context: 'portal-reader-workspace' })
        return
      }
      // Revoked links are dead — showing them here would just be clutter.
      setTokens((body.tokens ?? []).filter((t: TokenRow) => !t.revoked_at))
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setLoadingTokens(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void loadTokens()
  }, [loadTokens])

  const liveTokenIds = useMemo(() => new Set(tokens.map((t) => t.id)), [tokens])

  const revoke = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/scrape-token?id=${id}`, { method: 'DELETE' })
        const body = await res.json()
        if (!res.ok) {
          toastError(body.error, { title: 'Could not revoke.', context: 'portal-reader-workspace' })
          return
        }
        toast.success('Reader link revoked.')
        void loadTokens()
      } catch {
        toast.error('Could not reach the server.')
      }
    },
    [loadTokens]
  )

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Admins only</CardTitle>
          <CardDescription>
            Creating a Portal Reader link lets its holder submit an import, so it is restricted to
            the same role that may run one.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal Reader</CardTitle>
        <CardDescription>
          Reads the Departmental or Audit portal&rsquo;s table straight into the Hub. You stay
          logged into the portal yourself — nothing here ever stores a portal password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="ml-4 list-decimal space-y-1.5 text-sm text-muted-foreground">
          <li>Create a link for the portal you need below and drag it to your bookmarks bar.</li>
          <li>Open that portal, log in as normal, and go to the entry list.</li>
          <li>Set the table to show all rows if it is paginated, then click the matching bookmark.</li>
          <li>Preview what it read, or commit straight away if you trust it.</li>
        </ol>

        {PORTAL_READER_SOURCES.map(({ sourceSystem, portalName: name }) => (
          <PortalReaderMintCard
            key={sourceSystem}
            sourceSystem={sourceSystem}
            portalName={name}
            source={source}
            hubUrl={hubUrl}
            liveTokenIds={liveTokenIds}
            onMinted={loadTokens}
          />
        ))}

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-sm font-medium">Reader links</p>
          <p className="text-xs text-muted-foreground">
            The drag-to-install link only ever appears once, right after you create it — by
            design, the Hub never stores it in a form it could show you again. If you didn&rsquo;t
            drag it in time, revoke it below and create a new one; that&rsquo;s expected, not an
            error.
          </p>
          {loadingTokens ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reader links yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Portal</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Uses</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{portalName(row.source_system)}</TableCell>
                    <TableCell>{row.label ?? row.token_prefix + '…'}</TableCell>
                    <TableCell>{tokenState(row)}</TableCell>
                    <TableCell>{formatDateTime(row.expires_at)}</TableCell>
                    <TableCell>{formatDateTime(row.last_used_at)}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.use_count}</TableCell>
                    <TableCell className="text-right">
                      {tokenState(row) === 'Live' && (
                        <Button variant="ghost" size="sm" onClick={() => void revoke(row.id)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
