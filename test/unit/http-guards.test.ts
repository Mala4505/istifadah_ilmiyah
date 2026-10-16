import { describe, expect, it } from 'vitest'
import {
  clientIpFromHeaders,
  declaredLengthExceeds,
  isJsonContentType,
  isSameOrigin,
  jsonRequestProblem,
} from '@/lib/http-guards'

const h = (init: Record<string, string>) => new Headers(init)

describe('isJsonContentType', () => {
  it('accepts application/json with and without charset', () => {
    expect(isJsonContentType(h({ 'content-type': 'application/json' }))).toBe(true)
    expect(isJsonContentType(h({ 'content-type': 'Application/JSON; charset=utf-8' }))).toBe(true)
  })
  it('rejects form, text, multipart and missing types', () => {
    expect(isJsonContentType(h({ 'content-type': 'text/plain' }))).toBe(false)
    expect(isJsonContentType(h({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false)
    expect(isJsonContentType(h({ 'content-type': 'application/jsonp' }))).toBe(false)
    expect(isJsonContentType(h({}))).toBe(false)
  })
})

describe('isSameOrigin', () => {
  const site = 'https://istifadah-ilmiyah.vercel.app'
  it('accepts an Origin matching the request host', () => {
    expect(isSameOrigin(h({ origin: 'https://preview-abc.vercel.app', host: 'preview-abc.vercel.app' }), site)).toBe(true)
  })
  it('prefers x-forwarded-host over host', () => {
    expect(
      isSameOrigin(h({ origin: 'https://app.example.org', host: 'internal:3000', 'x-forwarded-host': 'app.example.org' }), site)
    ).toBe(true)
  })
  it('accepts the configured site URL', () => {
    expect(isSameOrigin(h({ origin: site, host: 'internal:3000' }), site)).toBe(true)
  })
  it('rejects a foreign Origin and the literal "null" Origin', () => {
    expect(isSameOrigin(h({ origin: 'https://evil.example', host: 'istifadah-ilmiyah.vercel.app' }), site)).toBe(false)
    expect(isSameOrigin(h({ origin: 'null', host: 'istifadah-ilmiyah.vercel.app' }), site)).toBe(false)
    expect(isSameOrigin(h({ origin: 'not a url', host: 'x' }), site)).toBe(false)
  })
  it('lets a header-less non-browser client through, but not a cross-site fetch', () => {
    expect(isSameOrigin(h({}), site)).toBe(true)
    expect(isSameOrigin(h({ 'sec-fetch-site': 'same-origin' }), site)).toBe(true)
    expect(isSameOrigin(h({ 'sec-fetch-site': 'cross-site' }), site)).toBe(false)
  })
})

describe('jsonRequestProblem', () => {
  const base = { 'content-type': 'application/json', host: 'a.test' }
  it('returns 415 for the wrong content type', () => {
    expect(jsonRequestProblem(h({ 'content-type': 'text/plain', host: 'a.test' }), { checkOrigin: true })?.status).toBe(415)
  })
  it('returns 403 for a cross-site Origin when checking origin', () => {
    expect(jsonRequestProblem(h({ ...base, origin: 'https://evil.example' }), { checkOrigin: true })?.status).toBe(403)
  })
  it('skips the Origin check when asked (bearer-token callers)', () => {
    expect(jsonRequestProblem(h({ ...base, origin: 'https://portal.example' }), { checkOrigin: false })).toBeNull()
  })
  it('passes a same-origin JSON request', () => {
    expect(jsonRequestProblem(h({ ...base, origin: 'https://a.test' }), { checkOrigin: true })).toBeNull()
  })
})

describe('declaredLengthExceeds', () => {
  it('flags only a declared length over the cap', () => {
    expect(declaredLengthExceeds(h({ 'content-length': '5000000' }), 4_000_000)).toBe(true)
    expect(declaredLengthExceeds(h({ 'content-length': '4000000' }), 4_000_000)).toBe(false)
    expect(declaredLengthExceeds(h({}), 4_000_000)).toBe(false)
    expect(declaredLengthExceeds(h({ 'content-length': 'abc' }), 4_000_000)).toBe(false)
  })
})

describe('clientIpFromHeaders', () => {
  it('prefers x-real-ip', () => {
    expect(clientIpFromHeaders(h({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('203.0.113.9')
  })
  it('falls back to the RIGHTMOST x-forwarded-for hop, never the client-supplied leftmost', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1, 203.0.113.9' }))).toBe('203.0.113.9')
  })
  it('returns null with neither header', () => {
    expect(clientIpFromHeaders(h({}))).toBeNull()
  })
})
