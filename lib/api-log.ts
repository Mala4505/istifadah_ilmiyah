import 'server-only'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

function requestIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0]!.trim()
  return request.headers.get('x-real-ip')
}

/**
 * API usage tracking (new requirement). Writes through the service-role
 * admin client so a route reachable signed-out (or one whose auth check
 * failed) still gets logged, independent of whatever RLS context — or lack
 * of one — the request ran under. Logging failures are swallowed: an
 * outage in the log table must never take down the route it's wrapping.
 */
async function logApiRequest(input: {
  userId: string | null
  route: string
  method: string
  statusCode: number
  latencyMs: number
  ip: string | null
}) {
  try {
    const admin = createAdminClient()
    await admin.from('api_request_log').insert({
      user_id: input.userId,
      route: input.route,
      method: input.method,
      status_code: input.statusCode,
      latency_ms: input.latencyMs,
      ip: input.ip,
    })
  } catch {
    // Best-effort only.
  }
}

/**
 * Wraps a Route Handler to record one api_request_log row per invocation.
 * `routeName` is a fixed label (e.g. "/api/import"), not request.url, so
 * rows group cleanly regardless of query string.
 */
export function withApiLogging<H extends (request: NextRequest, ...rest: never[]) => Promise<Response>>(
  routeName: string,
  handler: H
): H {
  return (async (request: NextRequest, ...rest: never[]) => {
    const start = Date.now()
    const ip = requestIp(request)

    let response: Response
    try {
      response = await handler(request, ...rest)
    } catch (error) {
      await logApiRequest({
        userId: null,
        route: routeName,
        method: request.method,
        statusCode: 500,
        latencyMs: Date.now() - start,
        ip,
      })
      throw error
    }

    let userId: string | null = null
    try {
      const supabase = await createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      userId = user?.id ?? null
    } catch {
      // Unauthenticated or unavailable session — logged with a null user.
    }

    await logApiRequest({
      userId,
      route: routeName,
      method: request.method,
      statusCode: response.status,
      latencyMs: Date.now() - start,
      ip,
    })

    return response
  }) as H
}
