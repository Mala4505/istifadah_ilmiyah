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

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/storage.ts was imported into browser code. It uses SUPABASE_SECRET_KEY and must never reach the client bundle.'
  )
}

/** Bucket name per §3.8. */
const BUCKET = 'invoice-documents'

/** Anything the supabase-js storage `upload()` call accepts as a body. */
export type StorageFileBody = Blob | Buffer | ArrayBuffer | ArrayBufferView | string

let cachedClient: SupabaseClient | null = null

/** Lazily constructed so importing this file never throws before it's actually used. */
function getStorageClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SECRET_KEY, {
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
