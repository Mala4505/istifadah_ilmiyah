/**
 * Security audit 2026-10-15, Phase 8 -- "every server action must refuse an anonymous caller".
 *
 * Every export of a `'use server'` file is a public POST endpoint, whether or not the UI
 * ever calls it (this is how `confirmVendorAlias` shipped with no auth at all). This test
 * walks app/, lib/ and components/, finds every file whose FIRST statement is a
 * `'use server'` directive, imports it, and calls every exported async function with
 * plausible dummy arguments while there is NO signed-in user. For each call it asserts:
 *
 *   1. the function never returns a success-shaped result ({ ok: true }, a non-empty
 *      list, a signed url, ...);
 *   2. it never reaches for a privileged resource: the service-role Supabase client,
 *      a service-role storage helper, the job queue / OCR handlers, a direct `pg`
 *      connection, the network (fetch), or the scrape-token store;
 *   3. at least one of the argument sets actually reached an authentication check
 *      (session lookup). Without this, an action could "pass" only because input
 *      validation rejected our dummy args before it ever got to its (missing) guard.
 *
 * Everything runs offline: Supabase, pg, fetch, storage, queue and handlers are stubbed
 * below, and the "session" client answers every query with a permission error, exactly
 * as PostgREST answers an anonymous caller. Nothing here talks to a real service.
 *
 * Exceptions are EXPLICIT and justified in the arrays right below (ALLOWLIST, RLS_ONLY,
 * SKIPPED, KNOWN_GAPS) -- discover and justify, never hide. If you add a server action
 * that is meant to be public, it has to be added here with a reason; if you add one that
 * is not, this test is what tells you that you forgot the guard.
 *
 * Run: `npm test` (offline, part of the default unit project).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// Both are the MOCKED versions (see vi.mock above); used only by the canary tests below.
import { createAdminClient } from '@/lib/supabase/admin'
import { getStaffContext } from '@/lib/export/auth'

// ---------------------------------------------------------------------------
// Shared mutable state, visible to the (hoisted) module mocks below.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const SERVICE_KEY = 'test-service-role-secret-key'
  const state = {
    /** Privileged resources touched during the current call. */
    forbidden: [] as string[],
    /** Number of authentication look-ups during the current call. */
    authLookups: 0,
    /** Number of queries/RPCs sent through the session client (RLS answers those). */
    dbCalls: 0,
    /** Writes attempted through the (RLS-protected) session client; informational. */
    sessionWrites: [] as string[],
  }

  const NO_SESSION_ERROR = {
    message: 'JWT required (test stub: no session)',
    code: '42501',
    details: null,
    hint: null,
  }

  /** Chainable, awaitable stand-in for a PostgREST query builder as seen by `anon`. */
  function queryBuilder(label: string) {
    const result = { data: null, error: NO_SESSION_ERROR, count: null, status: 401, statusText: 'Unauthorized' }
    const proxy: any = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result).then(res, rej)
        return (..._args: unknown[]) => {
          if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
            state.sessionWrites.push(`${label}.${String(prop)}`)
          }
          return proxy
        }
      },
      apply() {
        return proxy
      },
    })
    return proxy
  }

  function noSessionClient() {
    const noUser = { message: 'Auth session missing!', name: 'AuthSessionMissingError', status: 400 }
    return {
      auth: {
        getUser: async () => {
          state.authLookups++
          return { data: { user: null }, error: noUser }
        },
        getClaims: async () => {
          state.authLookups++
          return { data: null, error: noUser }
        },
        getSession: async () => {
          state.authLookups++
          return { data: { session: null }, error: null }
        },
        signInWithPassword: async () => ({
          data: { user: null, session: null },
          error: { message: 'Invalid login credentials', name: 'AuthApiError', status: 400 },
        }),
        signOut: async () => ({ error: null }),
        updateUser: async () => ({ data: { user: null }, error: noUser }),
        signUp: async () => ({ data: { user: null, session: null }, error: noUser }),
        resetPasswordForEmail: async () => ({ data: null, error: noUser }),
        get admin(): never {
          state.forbidden.push('session client .auth.admin')
          throw new Error('auth.admin is service-role only')
        },
      },
      from: (table: string) => {
        state.dbCalls++
        return queryBuilder(`from(${table})`)
      },
      rpc: (fn: string) => {
        state.dbCalls++
        state.sessionWrites.push(`rpc(${fn})`)
        return queryBuilder(`rpc(${fn})`)
      },
      storage: {
        from(bucket: string) {
          state.forbidden.push(`session client storage.from(${bucket})`)
          throw new Error('storage is service-role only here')
        },
      },
    }
  }

  /** A module whose every export is a tripwire: calling anything records it and throws. */
  function tripwireModule(label: string, extra: Record<string, unknown> = {}) {
    const target: Record<string | symbol, unknown> = { ...extra }
    return new Proxy(target, {
      has: () => true,
      get(t, prop) {
        if (prop === 'then' || prop === '__esModule' || typeof prop === 'symbol') return t[prop as any]
        if (prop in t) return t[prop as string]
        return (..._args: unknown[]) => {
          state.forbidden.push(`${label}.${String(prop)}()`)
          throw new Error(`${label}.${String(prop)} used without a session`)
        }
      },
    })
  }

  return { SERVICE_KEY, state, noSessionClient, tripwireModule }
})

// ---------------------------------------------------------------------------
// Module mocks (hoisted by vitest)
// ---------------------------------------------------------------------------
vi.mock('server-only', () => ({}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  // React's `cache` is a request-scoped memo in Server Components; identity is what we want here.
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn }
})

vi.mock('next/headers', () => {
  const store = {
    getAll: () => [],
    get: () => undefined,
    has: () => false,
    set: () => undefined,
    delete: () => undefined,
  }
  return { cookies: async () => store, headers: async () => new Headers() }
})

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  updateTag: () => undefined,
  refresh: () => undefined,
  unstable_cache: <T,>(fn: T) => fn,
}))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;replace;${url}` })
  },
  permanentRedirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;replace;${url}` })
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  },
}))

vi.mock('@/lib/env', () => ({
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_SENTRY_DSN: '',
  },
}))

vi.mock('@/lib/env.server', () => ({
  serverEnv: {
    SUPABASE_SECRET_KEY: h.SERVICE_KEY,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    DATABASE_URL: 'postgres://nobody@localhost:1/none',
    SENTRY_AUTH_TOKEN: '',
    DEPLOY_TARGET: 'vercel',
    CSP_REPORT_ONLY: true,
    WORKER_ID: 'test',
    ITS_LOGIN_EMAIL_DOMAIN: 'members.istifadah.internal',
    COMMUNITY_GSTIN: '',
    COMMUNITY_NAME: '',
    OCR_AUTO_ESCALATION: false,
    OCR_USE_BATCH_API: false,
  },
}))

// Event selection comes from a cookie + a DB read. Pin it to "an open, current event" so
// actions get PAST their cookie-based "this event is closed" early exit and actually reach
// their authorisation logic -- otherwise a missing guard would hide behind that exit.
vi.mock('@/lib/events/current', () => {
  const event = {
    id: 1,
    name: 'Test event',
    hijriYear: '1448',
    startsOn: null,
    endsOn: null,
    isCurrent: true,
    createdAt: '2026-01-01T00:00:00Z',
  }
  return {
    ACTIVE_EVENT_COOKIE: 'active_event_id',
    getCurrentEvent: async () => event,
    getSelectedEventId: async () => 1,
    getSelectedEvent: async () => event,
    getAllEvents: async () => [event],
    isEventMutable: () => true,
  }
})

// The session-bound client: what every action gets when nobody is signed in.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.noSessionClient(),
  getAuthUser: async () => {
    h.state.authLookups++
    return null
  },
  getCachedUser: async () => {
    h.state.authLookups++
    return null
  },
}))

// The service-role door. Any use without a session is a finding.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.state.forbidden.push('createAdminClient()')
    throw new Error('service-role client used without a session')
  },
}))

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
  return {
    ...actual,
    createClient: (_url: string, key: string) => {
      if (key === h.SERVICE_KEY) {
        h.state.forbidden.push('@supabase/supabase-js createClient(service-role key)')
        throw new Error('service-role client used without a session')
      }
      return h.noSessionClient()
    },
  }
})

// Service-role helpers / workers / queue: tripwires, never run for real.
vi.mock('@/lib/storage', () => h.tripwireModule('lib/storage'))
vi.mock('@/lib/jobs/handlers/extract', () => h.tripwireModule('jobs/handlers/extract'))
vi.mock('@/lib/jobs/handlers/rescope-extract', () => h.tripwireModule('jobs/handlers/rescope-extract'))
vi.mock('@/lib/jobs/trigger-worker', () => h.tripwireModule('jobs/trigger-worker'))
vi.mock('@/lib/jobs/queue', () => h.tripwireModule('jobs/queue'))
vi.mock('@/lib/scrape-token', () => h.tripwireModule('lib/scrape-token'))

// A direct database connection (events.createEvent uses one). Never allowed without a session.
vi.mock('pg', () => {
  class Tripwire {
    constructor() {
      h.state.forbidden.push('pg connection constructed')
    }
    connect() {
      h.state.forbidden.push('pg.connect()')
      throw new Error('pg used without a session')
    }
    query() {
      h.state.forbidden.push('pg.query()')
      throw new Error('pg used without a session')
    }
    end() {}
  }
  return { default: { Pool: Tripwire, Client: Tripwire }, Pool: Tripwire, Client: Tripwire }
})

// ---------------------------------------------------------------------------
// Explicit exceptions. Key format: '<repo-relative path>:<exportName>'.
// ---------------------------------------------------------------------------

/**
 * Legitimately public (pre-login) or preference-only exports. Each entry says what is allowed:
 *   adminClient  - may use the service-role client (still must not return success)
 *   success      - may return an { ok: true } shaped result with no session
 *   noAuthLookup - not required to consult the session at all
 */
const ALLOWLIST: Record<string, { reason: string; adminClient?: boolean; success?: boolean; noAuthLookup?: boolean }> = {
  'lib/actions/auth.ts:loginWithIts': {
    reason:
      'The login form action: by definition called before a session exists. Its rate limiter reads/writes auth_login_attempt through the service-role client (there is no session to write with). It must still never report success for a wrong/absent session -- it does not: the stubbed password check fails.',
    adminClient: true,
    noAuthLookup: true,
  },
  'lib/actions/auth.ts:signOut': {
    reason:
      'Sign-out clears the caller\'s own cookie and redirects to /login; with no session it is a harmless no-op. Returns void.',
    noAuthLookup: true,
  },
  'lib/actions/reports.ts:setCompareBasis': {
    reason:
      'Writes only the caller\'s own display-preference cookie (report_compare_basis) after validating the value against a fixed list. No data access at all.',
    success: true,
    noAuthLookup: true,
  },
  'lib/actions/reports.ts:toggleReportPin': {
    reason:
      'Writes only the caller\'s own "pinned reports" cookie after validating the section id against a fixed list. No data access at all.',
    success: true,
    noAuthLookup: true,
  },
  'lib/actions/review.ts:setReviewQueueScope': {
    reason:
      'Writes only the caller\'s own review_queue_scope display cookie (pending / reviewed / all) after validating it against that fixed list. No data access; the queue page re-checks RLS on every read.',
    success: true,
    noAuthLookup: true,
  },
  'lib/actions/review.ts:setReviewQueueAssignee': {
    reason:
      'Writes (or clears) only the caller\'s own review_queue_assignee display cookie after checking it is a UUID. No data access; a forged value just filters the caller\'s own, RLS-scoped queue.',
    success: true,
    noAuthLookup: true,
  },
}

/**
 * Read helpers that carry no explicit auth call BY DESIGN: they read through the
 * session-bound client, so row-level security (not app code) decides what comes back, and
 * with no session RLS returns nothing. They still must not use any privileged resource
 * and must not return data. (Contrast with a helper that uses the service-role client --
 * that one needs an explicit guard and is NOT allowed here.)
 */
const RLS_ONLY: Record<string, string> = {
  'lib/actions/entry-classification-defaults.ts:getRecentClassificationDefaults':
    'Read-only lookup of a vendor\'s previous zone/head via the session client; RLS returns no rows for an anonymous caller (asserted below by the null result).',
}

/** Exports that cannot be exercised generically. Documented so the gap in coverage is visible. */
const SKIPPED: Record<string, string> = {
  // (none needed today -- every export is exercised; add entries here with a reason if one ever cannot be)
}

/**
 * REAL unguarded actions found by this test. The suite stays green so the main session can
 * triage, but every entry is printed as a loud warning on each run. Fix the action, then
 * delete the entry (the test prints a note when an entry no longer reproduces).
 */
const KNOWN_GAPS: Record<string, string> = {
  // None found on 2026-10-15: every export either gates on a role / session first, goes
  // through the RLS-bound session client only, or is in ALLOWLIST above with a reason.
  // Format when needed:  'lib/actions/x.ts:someAction': 'what is unguarded and why it matters',
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '../..')
const SCAN_DIRS = ['app', 'lib', 'components']

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full)
  }
}

/** True when the file's FIRST statement is a 'use server' directive (comments may precede it). */
function hasTopLevelUseServer(file: string): boolean {
  const head = fs.readFileSync(file, 'utf8').slice(0, 4000)
  return /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*['"]use server['"]/.test(head)
}

const discovered: string[] = []
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) continue
  const files: string[] = []
  walk(abs, files)
  for (const f of files) if (hasTopLevelUseServer(f)) discovered.push(f)
}
discovered.sort()
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/')

type Loaded = { file: string; rel: string; mod?: Record<string, unknown>; error?: unknown }
const loaded: Loaded[] = []
for (const file of discovered) {
  try {
    const mod = (await import(/* @vite-ignore */ file.split(path.sep).join('/'))) as Record<string, unknown>
    loaded.push({ file, rel: rel(file), mod })
  } catch (error) {
    loaded.push({ file, rel: rel(file), error })
  }
}

// ---------------------------------------------------------------------------
// Dummy argument construction
// ---------------------------------------------------------------------------
const UUID = '00000000-0000-4000-8000-000000000001'

/** Splits a function's declared parameter list (from its source) into top-level chunks. */
function declaredParams(fn: Function): string[] {
  const src = Function.prototype.toString.call(fn)
  const open = src.indexOf('(')
  if (open === -1) return []
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth === 0) break
    }
  }
  const inner = src.slice(open + 1, i)
  const parts: string[] = []
  let cur = ''
  depth = 0
  for (const c of inner) {
    if (c === '(' || c === '{' || c === '[') depth++
    if (c === ')' || c === '}' || c === ']') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** Property names an object parameter is expected to carry, read from the source text. */
function objectKeys(fn: Function, param: string): string[] {
  const keys = new Set<string>()
  const destructured = /^\{([\s\S]*)\}(?:\s*=.*)?$/.exec(param)
  if (destructured) {
    for (const raw of destructured[1]!.split(',')) {
      const key = raw.split(/[:=]/)[0]!.trim()
      if (/^\w+$/.test(key)) keys.add(key)
    }
    return [...keys]
  }
  const name = /^(\w+)/.exec(param)?.[1]
  if (!name) return []
  const src = Function.prototype.toString.call(fn)
  for (const m of src.matchAll(new RegExp(`\\b${name}\\??\\.(\\w+)`, 'g'))) keys.add(m[1]!)
  // `const { a, b } = input` in the body
  for (const m of src.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${name}\\b`, 'g'))) {
    for (const raw of m[1]!.split(',')) {
      const key = raw.split(/[:=]/)[0]!.trim()
      if (/^\w+$/.test(key)) keys.add(key)
    }
  }
  return [...keys]
}

const NAMED_ARRAYS: Record<string, unknown> = {
  pairs: [{ documentId: 1, entryId: 1 }],
  lineItems: [{ description: 'x', quantity: 1, rate: 1, amount: 1 }],
  line_items: [{ description: 'x', quantity: 1, rate: 1, amount: 1 }],
  bindings: [{ action: 'x', key: 'k' }],
  overrides: [],
}

function valueFor(key: string): unknown {
  if (key in NAMED_ARRAYS) return NAMED_ARRAYS[key]
  if (/(staff|user|assignee|assigned)\w*Ids$/i.test(key)) return [UUID]
  if (/(staff|user|assignee|assigned)\w*Id$/i.test(key) || key === 'assignedTo') return UUID
  if (/Ids$/.test(key) || key === 'ids') return [1]
  if (/gstin/i.test(key)) return '27AAPFU0939F1ZV'
  if (/its/i.test(key)) return '12345678'
  if (/e-?mail/i.test(key)) return 'someone@example.com'
  if (/password/i.test(key)) return 'Correct-Horse-Battery-9'
  if (/date|On$|At$/i.test(key)) return '2026-01-01'
  if (/^(outcome)$/i.test(key)) return 'resolved'
  if (/^(role)$/i.test(key)) return 'admin'
  if (/^(scope)$/i.test(key)) return 'all'
  if (/^(reason)$/i.test(key)) return 'other'
  if (/^(basis)$/i.test(key)) return 'budget'
  if (/Id$/.test(key) || key === 'id') return 1
  if (/^(is|has|enabled|confirmed|force|takeover|verified|active|skip|override)/i.test(key)) return true
  if (/(number|amount|count|total|rate|quantity|order|page|limit|offset|value|pages|index|days)$/i.test(key)) return 1
  return 'x'
}

/** Property names that mean "this parameter is a string/array/map", not "this is an options object". */
const BUILTIN_PROPS = new Set([
  'trim', 'length', 'toLowerCase', 'toUpperCase', 'slice', 'map', 'filter', 'forEach', 'includes', 'some',
  'every', 'join', 'split', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'push', 'indexOf', 'reduce',
  'find', 'has', 'add', 'get', 'set', 'toString', 'localeCompare', 'normalize', 'test', 'match', 'padStart',
  'concat', 'sort', 'flatMap', 'at', 'toFixed', 'trimStart', 'trimEnd', 'charAt', 'substring', 'size',
])

function valueForParam(fn: Function, param: string): unknown {
  const bare = param.split('=')[0]!.trim()
  const keys = objectKeys(fn, bare.startsWith('{') ? param : bare).filter((k) => !BUILTIN_PROPS.has(k))
  if (bare.startsWith('{') || keys.length > 0) {
    return Object.fromEntries(keys.map((k) => [k, valueFor(k)]))
  }
  return valueFor(bare)
}

/**
 * Hand-written "valid-looking" arguments for actions whose input is validated by a zod
 * schema we cannot see from the outside (so the name-driven guess above would be rejected
 * by validation before the action ever reached its guard). Tried FIRST.
 */
const ARG_OVERRIDES: Record<string, unknown[][]> = {
  'lib/actions/account.ts:changeOwnPassword': [
    [{ currentPassword: 'Old-Password-12345', newPassword: 'New-Password-67890', confirmPassword: 'New-Password-67890' }],
  ],
  'lib/actions/review.ts:flagReviewException': [
    [{ sourceDocumentId: 1, documentExtractionId: 1, entryId: 1, reason: 'not_clear', note: 'x' }],
    [{ sourceDocumentId: 1, documentExtractionId: 1, entryId: null, reason: 'other', note: 'looks wrong' }],
  ],
  'lib/actions/entries.ts:createManualEntry': [
    [
      {
        departmentId: 1,
        budgetHeadId: 1,
        vendorName: 'Test vendor',
        amount: 100,
        date: '2026-01-01',
        type: 'invoice',
        remark: 'x',
        invoiceNumber: 'INV-1',
      },
    ],
  ],
  // The search helpers return early below 2 characters, before they would touch anything.
  'lib/actions/documents.ts:searchEntriesForAttach': [['acme traders']],
  'lib/actions/review.ts:searchReviewVendors': [['acme traders']],
  'lib/actions/entries.ts:replaceProvisionalUbblNumber': [[{ entryId: 1, ubblNumber: 'M-1' }]],
  'lib/actions/entry-enrichment.ts:saveEntryEnrichment': [
    [{ entryId: 1, adminHeadId: 1, zoneId: 1, remark: 'x' }],
  ],
  'lib/actions/entry-enrichment.ts:setEntryClassification': [[{ entryId: 1, adminHeadId: 1, zoneId: 1 }]],
  'lib/actions/entry-enrichment.ts:setSettlesEntry': [[1, 2]],
  'lib/actions/documents.ts:getInboxMatchCandidates': [[[1], [1]]],
  'lib/actions/flags.ts:resolveFlag': [[{ flagId: 1, entryId: 1, outcome: 'dismissed' }]],
}

/** Argument lists to try for one function: hand-written first, then a name-driven guess, plus blunt fallbacks. */
function argCandidates(fn: Function, key: string): unknown[][] {
  const params = declaredParams(fn).filter((p) => p !== '')
  const plausible = params.map((p) => valueForParam(fn, p))
  const candidates: unknown[][] = [...(ARG_OVERRIDES[key] ?? []), plausible]
  // A blunt kitchen-sink for single-object actions whose source did not reveal their keys.
  candidates.push(params.map(() => ({ id: 1, ids: [1], documentId: 1, entryId: 1, reason: 'other' })))
  candidates.push(params.map(() => 1))
  candidates.push(params.map(() => 'x'))
  candidates.push([])
  return candidates
}

// ---------------------------------------------------------------------------
// Result classification
// ---------------------------------------------------------------------------
type Outcome = 'success' | 'denied' | 'empty' | 'unknown'

function classify(result: unknown): Outcome {
  if (result === undefined || result === null) return 'empty'
  if (typeof result === 'string') return result.length > 0 ? 'success' : 'empty'
  if (typeof result === 'number' || typeof result === 'boolean') return result ? 'success' : 'empty'
  if (Array.isArray(result)) return result.length === 0 ? 'empty' : 'success'
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    // `{ ok: true, results: [] }` carries no data: that is what a read gives an anonymous caller.
    const carriesNothing = (rec: Record<string, unknown>, ignore: string[]) =>
      Object.entries(rec).every(
        ([k, v]) =>
          ignore.includes(k) ||
          v === null ||
          v === undefined ||
          v === false ||
          v === 0 ||
          v === '' ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
      )
    if ('ok' in r) {
      if (r.ok !== true) return 'denied'
      return Object.keys(r).length > 1 && carriesNothing(r, ['ok']) ? 'empty' : 'success'
    }
    if ('success' in r) return r.success === true ? 'success' : 'denied'
    if (!('error' in r && r.error) && carriesNothing(r, [])) return 'empty'
    if (typeof r.error === 'string' && r.error) return 'denied'
    if (r.error) return 'denied'
    // Bulk results: { updated: 0, failed: [...] } style -- success only if something changed.
    const counters = ['deleted', 'attached', 'updated', 'created', 'resolved', 'count', 'succeeded', 'voided']
    for (const c of counters) if (typeof r[c] === 'number' && (r[c] as number) > 0) return 'success'
    if (counters.some((c) => c in r)) return 'denied'
    if ('url' in r && r.url) return 'success'
    return 'unknown'
  }
  return 'unknown'
}

const isNextControlFlow = (e: unknown) =>
  typeof (e as { digest?: unknown })?.digest === 'string' &&
  /^NEXT_(REDIRECT|HTTP_ERROR_FALLBACK|NOT_FOUND)/.test((e as { digest: string }).digest)

type CallReport = {
  args: unknown[]
  outcome: Outcome | 'threw' | 'redirect'
  threw?: string
  forbidden: string[]
  authLookups: number
  dbCalls: number
  result?: unknown
}

async function callOnce(fn: (...a: any[]) => Promise<unknown>, args: unknown[]): Promise<CallReport> {
  h.state.forbidden = []
  h.state.authLookups = 0
  h.state.dbCalls = 0
  h.state.sessionWrites = []
  let outcome: CallReport['outcome']
  let threw: string | undefined
  let result: unknown
  try {
    result = await Promise.race([
      fn(...args),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 4s')), 4000)),
    ])
    outcome = classify(result)
  } catch (e) {
    if (isNextControlFlow(e)) outcome = 'redirect'
    else {
      outcome = 'threw'
      threw = e instanceof Error ? e.message : String(e)
    }
  }
  return {
    args,
    outcome,
    threw,
    forbidden: [...h.state.forbidden],
    authLookups: h.state.authLookups,
    dbCalls: h.state.dbCalls,
    result,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    h.state.forbidden.push(`fetch(${String(args[0])})`)
    throw new Error('network used without a session')
  })
})

const notes: string[] = []
afterAll(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Printed with the real console after restore, so it is visible in the run output.
  if (notes.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('\n[server-actions-auth-guard]\n' + notes.map((n) => '  - ' + n).join('\n') + '\n')
  }
})

// Canaries: prove the tripwires above really fire, so a green run means "guarded", not "blind".
// Each one imitates a classic mistake and must be CAUGHT by the same call harness.
describe('harness canaries (the test must be able to fail)', () => {
  it('flags an action that reaches for the service-role client with no guard', async () => {
    const unguarded = async () => {
      const admin = createAdminClient()
      return { ok: true, row: admin }
    }
    const report = await callOnce(unguarded, [])
    expect(report.forbidden).toContain('createAdminClient()')
  })

  it('flags an action that returns success-shaped data to an anonymous caller', async () => {
    const report = await callOnce(async () => ({ ok: true, url: 'https://signed.example/doc.pdf' }), [])
    expect(report.outcome).toBe('success')
    const list = await callOnce(async () => [{ id: 1 }], [])
    expect(list.outcome).toBe('success')
  })

  it('flags an action that uses the network or a pg connection', async () => {
    const viaFetch = await callOnce(async () => {
      await fetch('https://example.invalid/')
      return { ok: false, error: 'x' }
    }, [])
    expect(viaFetch.forbidden.some((f) => f.startsWith('fetch('))).toBe(true)
  })

  it('treats a real role gate as denying: getStaffContext() sees nobody', async () => {
    // The shared gate (lib/export/auth.ts) is REAL code running on the stubbed session.
    const report = await callOnce(async () => getStaffContext(), [])
    expect(report.outcome).toBe('empty')
    expect(report.authLookups).toBeGreaterThan(0)
  })
})

describe('server-action discovery', () => {
  it('finds the known set of use-server files (guards against the scan silently finding nothing)', () => {
    const found = loaded.map((l) => l.rel)
    for (const must of [
      'lib/actions/review.ts',
      'lib/actions/admin.ts',
      'lib/actions/documents.ts',
      'lib/actions/auth.ts',
      'app/(app)/reports/board-pack-actions.ts',
    ]) {
      expect(found, `${must} must be discovered`).toContain(must)
    }
    expect(found.length).toBeGreaterThanOrEqual(15)
  })

  it('imports every use-server file cleanly under the stubs', () => {
    const broken = loaded.filter((l) => l.error).map((l) => `${l.rel}: ${String((l.error as Error)?.message ?? l.error)}`)
    expect(broken).toEqual([])
  })

  it("exports only async functions from 'use server' files (Next.js refuses anything else at build time)", () => {
    const bad: string[] = []
    for (const l of loaded) {
      for (const [name, value] of Object.entries(l.mod ?? {})) {
        if (name === 'default') continue
        if (typeof value !== 'function' || (value as Function).constructor.name !== 'AsyncFunction') {
          bad.push(`${l.rel}:${name}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('has no stale entries in the allow/skip/gap lists', () => {
    const real = new Set<string>()
    for (const l of loaded) for (const name of Object.keys(l.mod ?? {})) real.add(`${l.rel}:${name}`)
    const stale = [
      ...Object.keys(ALLOWLIST),
      ...Object.keys(RLS_ONLY),
      ...Object.keys(SKIPPED),
      ...Object.keys(KNOWN_GAPS),
    ].filter((k) => !real.has(k))
    expect(stale, 'these entries name exports that no longer exist -- remove them').toEqual([])
  })
})

for (const l of loaded) {
  if (!l.mod) continue
  describe(`${l.rel} -- anonymous caller`, () => {
    for (const [name, value] of Object.entries(l.mod!)) {
      if (typeof value !== 'function') continue
      const key = `${l.rel}:${name}`

      if (SKIPPED[key]) {
        it.skip(`${name}: SKIPPED -- ${SKIPPED[key]}`, () => undefined)
        continue
      }

      it(`${name} refuses an anonymous caller`, async () => {
        const allow = ALLOWLIST[key]
        const fn = value as (...a: any[]) => Promise<unknown>
        const reports: CallReport[] = []
        for (const args of argCandidates(fn, key)) reports.push(await callOnce(fn, args))

        const problems: string[] = []

        // 1. never a success-shaped result
        if (!allow?.success) {
          for (const r of reports) {
            if (r.outcome === 'success') {
              problems.push(`returned a success-shaped result ${JSON.stringify(r.result)?.slice(0, 120)} for args ${JSON.stringify(r.args)?.slice(0, 120)}`)
            }
          }
        }
        // 2. never a privileged resource
        if (!allow?.adminClient) {
          const touched = new Set(reports.flatMap((r) => r.forbidden))
          for (const t of touched) problems.push(`reached privileged resource without a session: ${t}`)
        }
        // 3. the action got far enough to be answered by the auth layer: either it looked the
        //    session up (a role gate), or it sent a query through the session-bound client
        //    (where row-level security answers "no session"). If neither ever happened, every
        //    argument set was stopped by input validation / early exits and the guard was never
        //    exercised -- so a missing guard could hide there. Add a better ARG_OVERRIDES entry.
        const exercised = reports.some((r) => r.authLookups > 0 || r.dbCalls > 0)
        const needsLookup = !allow?.noAuthLookup && !RLS_ONLY[key]
        if (needsLookup && !exercised) {
          problems.push(
            'no argument set reached an auth check or a session query (either the action has no guard, or our dummy args were rejected by input validation first -- add an ARG_OVERRIDES entry)'
          )
        }
        // RLS-only helpers must hand back nothing.
        if (RLS_ONLY[key]) {
          for (const r of reports) {
            if (!['empty', 'denied', 'threw'].includes(r.outcome)) problems.push(`RLS-only helper returned data (${r.outcome})`)
          }
        }
        // Unrecognised result shapes are surfaced rather than silently accepted.
        for (const r of reports) {
          if (r.outcome === 'unknown') problems.push(`unclassifiable result ${JSON.stringify(r.result)?.slice(0, 120)}`)
        }
        // A timeout means the stubs did not cover something -- a test problem, so say so.
        for (const r of reports) {
          if (r.threw?.startsWith('TIMEOUT')) problems.push(`call timed out (stub gap) for args ${JSON.stringify(r.args)?.slice(0, 80)}`)
        }

        if (process.env.GUARD_DEBUG && problems.length > 0) {
          const nl = String.fromCharCode(10)
          const probs = problems.map((p) => '  PROBLEM ' + p).join(nl)
          const calls = reports
            .map((r) => '  ARGS ' + JSON.stringify(r.args)?.slice(0, 150) + ' -> ' + r.outcome + ' ' + (r.threw ?? JSON.stringify(r.result)?.slice(0, 100) ?? '') + ' auth=' + r.authLookups + ' db=' + r.dbCalls)
            .join(nl)
          process.stderr.write(nl + '### ' + key + nl + probs + nl + calls + nl)
        }

        if (KNOWN_GAPS[key]) {
          if (problems.length > 0) {
            notes.push(`KNOWN GAP ${key}: ${KNOWN_GAPS[key]} -- reproduces: ${problems[0]}`)
          } else {
            notes.push(`KNOWN GAP ${key} no longer reproduces -- delete it from KNOWN_GAPS`)
          }
          return
        }
        expect(problems.map((p) => `  - ${p}`).join('\n'), `${key} should refuse an anonymous caller`).toBe('')
      })
    }
  })
}
