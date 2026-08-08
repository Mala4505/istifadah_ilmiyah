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

/** Deletes a document at `path`. */
export async function deleteDocument(path: string): Promise<void> {
  const client = getStorageClient()
  const { error } = await client.storage.from(BUCKET).remove([path])
  if (error) {
    throw new Error(`deleteDocument("${path}") failed: ${error.message}`)
  }
}
