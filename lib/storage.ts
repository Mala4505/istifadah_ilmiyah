import 'server-only'

/**
 * Thin storage adapter (MASTER-PLAN §10, §3.8, §4.3): "put/get/signUrl.
 * Supabase Storage today, disk or S3 later." Server-only — never import
 * this from a Client Component. Uses `serverEnv.SUPABASE_SECRET_KEY`
 * directly via `@supabase/supabase-js`, not the shared app Supabase client
 * (that lives in `lib/supabase/*`, owned elsewhere, and is cookie/session
 * scoped — this adapter needs full storage access instead).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'
import { SUPABASE_DB_OPTIONS, bucketName } from '@/lib/db-schema'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/storage.ts was imported into browser code. It uses SUPABASE_SECRET_KEY and must never reach the client bundle.'
  )
}

/** Bucket name per §3.8. */
const BUCKET = bucketName('invoice-documents')

/** Anything the supabase-js storage `upload()` call accepts as a body. */
export type StorageFileBody = Blob | Buffer | ArrayBuffer | ArrayBufferView | string

let cachedClient: SupabaseClient | null = null

/** Lazily constructed so importing this file never throws before it's actually used. */
function getStorageClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SECRET_KEY, {
      db: SUPABASE_DB_OPTIONS,
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return cachedClient
}

/** Uploads (or overwrites) a document at `path` in the invoice-documents bucket. */
export async function putDocument(
  path: string,
  file: StorageFileBody,
  contentType?: string
): Promise<void> {
  const client = getStorageClient()
  const { error } = await client.storage.from(BUCKET).upload(path, file, {
    contentType,
    upsert: true,
  })
  if (error) {
    throw new Error(`putDocument("${path}") failed: ${error.message}`)
  }
}

/**
 * Returns a time-limited signed URL for `path`. Defaults to a 5-minute
 * expiry per §4.3.
 */
export async function getSignedUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const client = getStorageClient()
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds)
  if (error || !data) {
    throw new Error(`getSignedUrl("${path}") failed: ${error?.message ?? 'no signed URL returned'}`)
  }
  return data.signedUrl
}

/**
 * Returns a one-time signed URL the browser can PUT a file's bytes to
 * directly — used by /api/documents/upload-url so the ingest route never
 * has to receive the raw PDF itself. Vercel Serverless Functions hard-cap a
 * request body at 4.5MB regardless of this app's own limits; a PUT straight
 * to Supabase Storage never passes through a Vercel function at all, so it
 * isn't subject to that ceiling.
 */
export async function createUploadUrl(path: string): Promise<string> {
  const client = getStorageClient()
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    throw new Error(`createUploadUrl("${path}") failed: ${error?.message ?? 'no signed URL returned'}`)
  }
  return data.signedUrl
}

/**
 * Downloads a document's raw bytes back out of storage — used by the ingest
 * route to run its existing hash/page-count/PDF-sniff validation once the
 * browser has already PUT the file directly via `createUploadUrl` above,
 * rather than receiving those bytes as part of the ingest request itself.
 */
export async function getDocumentBytes(path: string): Promise<Uint8Array> {
  const client = getStorageClient()
  const { data, error } = await client.storage.from(BUCKET).download(path)
  if (error || !data) {
    throw new Error(`getDocumentBytes("${path}") failed: ${error?.message ?? 'no data returned'}`)
  }
  return new Uint8Array(await data.arrayBuffer())
}

/** Deletes a document at `path`. */
export async function deleteDocument(path: string): Promise<void> {
  const client = getStorageClient()
  const { error } = await client.storage.from(BUCKET).remove([path])
  if (error) {
    throw new Error(`deleteDocument("${path}") failed: ${error.message}`)
  }
}

/**
 * Size in bytes of the object at `path` according to storage metadata, WITHOUT
 * downloading it (security-audit-fix-plan.md 4.3: the ingest route must not pull
 * a huge object into memory just to find out it is over the cap). Returns null
 * when storage cannot say — the caller then falls back to its post-download check.
 */
export async function getDocumentSize(path: string): Promise<number | null> {
  try {
    const client = getStorageClient()
    const { data, error } = await client.storage.from(BUCKET).info(path)
    if (error || !data) return null
    return typeof data.size === 'number' ? data.size : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pending-upload ledger (security-audit-fix-plan.md 4.3). Every signed upload URL
// we hand out is recorded against the user it was issued to, so /api/documents/
// ingest can refuse to finalise a path that was issued to somebody else. Backed by
// public.pending_upload (supabase/migrations/20261015130000_pending_upload.sql),
// service-role only. Written to tolerate that migration not being pushed yet: a
// missing table is reported as 'table_missing' and callers fall back to the old
// behaviour, so deploying the code before the migration does not break uploads.
// ---------------------------------------------------------------------------

/** PostgREST / Postgres signals for "the table does not exist (yet)". */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    (/pending_upload/.test(error.message ?? '') && /does not exist|schema cache/.test(error.message ?? ''))
  )
}

export type PendingUploadStatus = 'ok' | 'other_user' | 'unknown' | 'table_missing' | 'error'

/** Records that `path` was issued to `userId`. Never throws. */
export async function recordPendingUpload(path: string, userId: string): Promise<PendingUploadStatus> {
  try {
    const client = getStorageClient()
    const { error } = await client.from('pending_upload').insert({ path, user_id: userId })
    if (!error) return 'ok'
    if (isMissingTable(error)) return 'table_missing'
    console.error('[storage] recordPendingUpload failed:', error)
    return 'error'
  } catch (err) {
    console.error('[storage] recordPendingUpload threw:', err)
    return 'error'
  }
}

/**
 * Checks `path` against the ledger for `userId`: 'ok' (issued to this user),
 * 'other_user' (issued to someone else), 'unknown' (table exists but no row —
 * never issued), 'table_missing' (migration not pushed yet), 'error' (lookup failed).
 */
export async function checkPendingUpload(path: string, userId: string): Promise<PendingUploadStatus> {
  try {
    const client = getStorageClient()
    const { data, error } = await client.from('pending_upload').select('user_id').eq('path', path).maybeSingle()
    if (error) {
      if (isMissingTable(error)) return 'table_missing'
      console.error('[storage] checkPendingUpload failed:', error)
      return 'error'
    }
    if (!data) return 'unknown'
    return data.user_id === userId ? 'ok' : 'other_user'
  } catch (err) {
    console.error('[storage] checkPendingUpload threw:', err)
    return 'error'
  }
}

/** Removes the ledger row once a path has been finalised. Best-effort. */
export async function clearPendingUpload(path: string): Promise<void> {
  try {
    const client = getStorageClient()
    await client.from('pending_upload').delete().eq('path', path)
  } catch {
    // Housekeeping only; the row is harmless once source_document owns the path.
  }
}
