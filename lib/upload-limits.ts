import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Fallback used only when `app_settings`' singleton row can't be read (a
 * transient error, or -- pre-migration -- the row not existing yet). Mirrors
 * the column's own DB default (20260822000008_app_settings.sql) so a read
 * failure degrades to the same conservative limit the table ships with,
 * rather than silently allowing an unbounded upload through.
 */
export const DEFAULT_MAX_UPLOAD_PAGES = 20

/**
 * Reads the admin-configured page-count ceiling a single PDF upload may not
 * exceed (app/api/documents/ingest/route.ts's validation, /settings' admin
 * "Upload limits" card). Accepts either the session client
 * (lib/supabase/server.ts) or the service-role admin client
 * (lib/supabase/admin.ts) -- both are plain `SupabaseClient` instances under
 * the hood, and `app_settings_select`'s RLS policy allows any signed-in
 * staff member to read it anyway, so there is no privilege reason to
 * require one over the other; callers pass whichever client they already
 * have on hand. Untyped (`SupabaseClient` with no `Database` generic)
 * because neither factory in this codebase passes one -- matches every
 * other server action here, which reads/writes through the same untyped
 * client rather than fighting PostgREST's generated builder types for one
 * table.
 *
 * Fails open to `DEFAULT_MAX_UPLOAD_PAGES` on any error rather than
 * throwing -- a transient read failure here must not be able to block every
 * upload on the site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment: no Database generic exists to type this against.
export async function getMaxUploadPages(client: SupabaseClient<any, any, any>): Promise<number> {
  try {
    const { data, error } = await client.from('app_settings').select('max_upload_pages').eq('id', 1).maybeSingle()
    if (error || !data) return DEFAULT_MAX_UPLOAD_PAGES
    return data.max_upload_pages
  } catch {
    return DEFAULT_MAX_UPLOAD_PAGES
  }
}
