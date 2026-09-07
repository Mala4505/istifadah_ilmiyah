/**
 * Permanently delete every object in the private 'invoice-documents' storage
 * bucket. Companion to scripts/wipe-pdfs-keep-entries.sql -- that script clears
 * Supabase's storage *catalog* (storage.objects rows); this one deletes the
 * actual file bytes through the storage API, which is the only reliable way to
 * reclaim the space.
 *
 * Run AFTER the SQL wipe (or before -- order doesn't matter), from the repo root:
 *
 *   node --env-file=.env scripts/empty-invoice-bucket.mjs
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env (already there
 * for the app). Uses the service-role key -- it bypasses storage RLS.
 *
 * Irreversible. There is no undo and no trash.
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
const BUCKET = 'invoice-documents'
const PAGE = 1000

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY. Run with: node --env-file=.env scripts/empty-invoice-bucket.mjs')
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

/** Recursively collect every object key under `prefix`. */
async function collect(prefix, acc) {
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      // A storage "folder" has no `id`; a real object does.
      if (item.id === null || item.id === undefined) {
        await collect(path, acc)
      } else {
        acc.push(path)
      }
    }
    if (data.length < PAGE) break
  }
  return acc
}

const keys = await collect('', [])
console.log(`Found ${keys.length} object(s) in ${BUCKET}.`)

let removed = 0
for (let i = 0; i < keys.length; i += PAGE) {
  const batch = keys.slice(i, i + PAGE)
  const { error } = await supabase.storage.from(BUCKET).remove(batch)
  if (error) throw new Error(`remove batch at ${i} failed: ${error.message}`)
  removed += batch.length
  console.log(`  removed ${removed}/${keys.length}`)
}

console.log(keys.length === 0 ? 'Bucket already empty.' : `Done. Deleted ${removed} object(s).`)
