'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
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
 * Packs the bookmarklet source into a `javascript:` URL.
 *
 * The token is substituted into the source rather than fetched by the
 * bookmarklet at run time: the bookmarklet has no session on the portal's
 * origin, so there is nothing for it to authenticate a fetch WITH — the token
 * has to travel inside the bookmark. That is what makes it worth keeping short
 * lived and revocable (see lib/scrape-token.ts).
 *
 * `encodeURIComponent` over the whole body preserves newlines as %0A, so the
 * source's `//` line comments still terminate correctly. Minifying first is
 * therefore unnecessary, and keeping the readable text means an operator who
 * inspects their own bookmark can see exactly what it does.
 */
function packBookmarklet(input: {
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

export function BookmarkletWorkspace({ isAdmin, source, hubUrl }: Props) {
  const [sourceSystem, setSourceSystem] = useState<SourceSystem>('audit')
  const [label, setLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [minted, setMinted] = useState<MintedToken | null>(null)
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loadingTokens, setLoadingTokens] = useState(false)

  const loadTokens = useCallback(async () => {
    if (!isAdmin) return
    setLoadingTokens(true)
    try {
      const res = await fetch('/api/scrape-token')
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error ?? 'Could not load tokens.')
        return
      }
      setTokens(body.tokens ?? [])
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setLoadingTokens(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void loadTokens()
  }, [loadTokens])

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
        toast.error(body.error ?? 'Could not create a token.')
        return
      }
      setMinted(body as MintedToken)
      toast.success('Token created — drag the link below to your bookmarks bar now.')
      void loadTokens()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setMinting(false)
    }
  }, [sourceSystem, label, loadTokens])

  const revoke = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/scrape-token?id=${id}`, { method: 'DELETE' })
        const body = await res.json()
        if (!res.ok) {
          toast.error(body.error ?? 'Could not revoke.')
          return
        }
        toast.success('Token revoked.')
        if (minted?.id === id) setMinted(null)
        void loadTokens()
      } catch {
        toast.error('Could not reach the server.')
      }
    },
    [loadTokens, minted]
  )

  const bookmarkletHref = useMemo(() => {
    if (!minted) return null
    return packBookmarklet({
      source,
      hubUrl,
      token: minted.token,
      sourceSystem: minted.sourceSystem,
    })
  }, [minted, source, hubUrl])

  // React 19 refuses to set `href` to a `javascript:` string via a normal
  // JSX prop -- it throws "React has blocked a javascript: URL as a
  // security precaution" instead, which silently breaks the drag-to-install
  // link entirely (no real href ever reaches the DOM, so the dragged
  // bookmark is empty). Setting it with the native DOM API through a ref
  // bypasses that guard -- it only intercepts React's own prop-driven
  // attribute writes, not an imperative `setAttribute` call. This is not an
  // XSS hole: the string comes from packBookmarklet() above, built from our
  // own known-good source file plus a token WE minted, never from anything
  // a user typed in.
  const dragLinkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const el = dragLinkRef.current
    if (!el) return
    if (bookmarkletHref) {
      el.setAttribute('href', bookmarkletHref)
    } else {
      el.removeAttribute('href')
    }
  }, [bookmarkletHref])

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Admins only</CardTitle>
          <CardDescription>
            Creating a portal-reader token lets its holder submit an import, so it is restricted to
            the same role that may run one.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>How this works</CardTitle>
          <CardDescription>
            You stay logged into the portal yourself. Nothing here ever stores a portal password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="ml-4 list-decimal space-y-1.5 text-sm text-muted-foreground">
            <li>Create a token below and drag the blue link to your browser&rsquo;s bookmarks bar.</li>
            <li>Open the portal, log in as normal, and go to the entry list.</li>
            <li>
              Set the table to show all rows if it is paginated, then click the bookmark. It reads
              what is on screen and sends it here as a dry run.
            </li>
            <li>Read the summary it shows, then press <em>Commit</em> if it looks right.</li>
          </ol>
          <p className="mt-3 text-sm text-muted-foreground">
            If the portal blocks the upload, the bookmark saves a <code>.json</code> file instead —
            upload that on the Import screen.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a reader token</CardTitle>
          <CardDescription>
            The token is shown once and never again. It expires in 12 hours and can be revoked at
            any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="source-system">Portal</Label>
              <select
                id="source-system"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value as SourceSystem)}
              >
                <option value="audit">Audit portal</option>
                <option value="departmental">Departmental portal</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token-label">Label (optional)</Label>
              <Input
                id="token-label"
                value={label}
                placeholder="e.g. my laptop"
                onChange={(e) => setLabel(e.target.value)}
                className="w-56"
              />
            </div>
            <Button onClick={() => void mint()} disabled={minting}>
              {minting ? 'Creating…' : 'Create token'}
            </Button>
          </div>

          {minted && bookmarkletHref && (
            <div className="rounded-md border border-dashed p-4">
              <p className="text-sm font-medium">
                Drag this to your bookmarks bar now — it will not be shown again.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Expires {formatDateTime(minted.expiresAt)} · reads the{' '}
                {minted.sourceSystem === 'audit' ? 'Audit' : 'Departmental'} portal
              </p>
              <a
                ref={dragLinkRef}
                onClick={(e) => {
                  // Clicking it here would run it against the Hub's own page,
                  // which has no portal table on it — a confusing no-op. It is
                  // meant to be dragged.
                  e.preventDefault()
                  toast.info('Drag this link to your bookmarks bar — clicking it here does nothing.')
                }}
                className="mt-3 inline-block cursor-grab rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              >
                Read {minted.sourceSystem === 'audit' ? 'Audit' : 'Departmental'} portal → Hub
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tokens</CardTitle>
          <CardDescription>
            Only the first 8 characters are stored in readable form, so a token cannot be recovered
            here — revoke and create a new one instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingTokens ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prefix</TableHead>
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
                    <TableCell className="font-mono text-xs">{row.token_prefix}…</TableCell>
                    <TableCell>{row.source_system}</TableCell>
                    <TableCell>{row.label ?? '—'}</TableCell>
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
        </CardContent>
      </Card>
    </div>
  )
}
