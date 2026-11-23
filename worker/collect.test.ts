import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { clearAccessKeyCache } from './access'
import { handle, type Env } from './index'
import {
  AUDIENCE,
  NOW_SECONDS,
  TEAM_DOMAIN,
  createSigningKey,
  requestWith,
  signToken,
  validClaims,
  type SigningKey,
} from './test-support/access-tokens'
import { d1Over, migratedDatabase } from './test-support/sqlite-d1'

// The collect-trigger endpoints (atto/6): the phone's service token files a trigger, the
// collector's service token reads what is pending and acknowledges it.

const ownerSubject = 'subject-owner'
const strangerSubject = 'subject-stranger'
const ingestClientId = '0123456789abcdef0123456789abcdef.access'
const phoneClientId = 'phone-token-client.access'

let db: DatabaseSync
let key: SigningKey
let assets: Mock<(request: Request) => Promise<Response>>
let env: Env

const deps = () => ({ fetchKeys: async () => [key.publicJwk], now: () => NOW_SECONDS * 1000 })

const tokenFor = (clientId: string, overrides: Record<string, unknown> = {}) =>
  validClaims({ sub: '', email: undefined, common_name: clientId, type: 'app', ...overrides })

type Who = 'phone' | 'collector' | 'owner' | 'none'
type CallOptions = { as?: Who; claims?: Record<string, unknown>; method?: string; raw?: string; contentType?: string }

async function call(path: string, payload: unknown, options: CallOptions = {}) {
  const who = options.as ?? 'phone'
  const claims =
    options.claims ??
    (who === 'phone'
      ? tokenFor(phoneClientId)
      : who === 'collector'
        ? tokenFor(ingestClientId)
        : validClaims({ sub: ownerSubject }))
  const token = who === 'none' ? null : await signToken(key, claims)
  const method = options.method ?? 'POST'
  const request = requestWith(token, `https://atto1.myargus.cc${path}`, {
    method,
    headers: { 'content-type': options.contentType ?? 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : (options.raw ?? JSON.stringify(payload)),
  })
  return handle(request, env, deps())
}

const trigger = (payload: unknown, options: CallOptions = {}) => call('/api/collect/trigger', payload, options)
const pending = (options: CallOptions = {}) =>
  call('/api/collect/pending', null, { as: 'collector', method: 'GET', ...options })
const ack = (payload: unknown, options: CallOptions = {}) =>
  call('/api/collect/ack', payload, { as: 'collector', ...options })

type Row = Record<string, unknown>
const rows = (table: string): Row[] => db.prepare(`select * from ${table} order by rowid`).all() as Row[]

const addTrigger = (userId: string, event: string, requestedAt?: string): string => {
  const row =
    requestedAt === undefined
      ? db.prepare('insert into collect_triggers (user_id, event) values (?, ?) returning id').get(userId, event)
      : db
          .prepare('insert into collect_triggers (user_id, event, requested_at) values (?, ?, ?) returning id')
          .get(userId, event, requestedAt)
  return (row as { id: string }).id
}
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

beforeEach(async () => {
  clearAccessKeyCache()
  key ??= await createSigningKey()
  db = migratedDatabase()
  assets = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('<!doctype html>'))
  env = {
    DB: d1Over(db),
    ASSETS: { fetch: assets },
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    INGEST_CLIENT_ID: ingestClientId,
    INGEST_OWNER_SUBJECT: ownerSubject,
    TRIGGER_CLIENT_ID: phoneClientId,
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('POST /api/collect/trigger', () => {
  it.each(['carplay_connect', 'carplay_disconnect'])('files a %s trigger for the owner and answers 202', async (event) => {
    const response = await trigger({ event })
    expect(response.status).toBe(202)
    const stored = rows('collect_triggers')
    expect(stored).toMatchObject([{ user_id: ownerSubject, event }])
    expect(await response.json()).toEqual({ id: stored[0].id, event })
  })

  it('files each request: two taps are two rows (the collector coalesces them)', async () => {
    await trigger({ event: 'carplay_connect' })
    await trigger({ event: 'carplay_connect' })
    expect(rows('collect_triggers')).toHaveLength(2)
  })

  it.each([
    ['no event', {}],
    ['an unknown event', { event: 'ignition_on' }],
    ['a charge event: the car starts those, the phone never files them (atto/8)', { event: 'charge_start' }],
    ['a charge stop, for the same reason', { event: 'charge_stop' }],
    ['a non-string event', { event: 7 }],
    ['an extra field', { event: 'carplay_connect', requested_at: '2020-01-01T00:00:00Z' }],
    ['a user_id', { event: 'carplay_connect', user_id: 'someone' }],
  ])('answers 422 for %s and files nothing', async (_label, payload) => {
    expect((await trigger(payload)).status).toBe(422)
    expect(rows('collect_triggers')).toEqual([])
  })

  it('answers 415 for a body that is not JSON and 400 for malformed JSON', async () => {
    expect((await trigger(null, { contentType: 'text/plain', raw: 'x' })).status).toBe(415)
    expect((await trigger(null, { raw: '{' })).status).toBe(400)
  })

  it('answers only POST', async () => {
    const response = await trigger(null, { method: 'GET' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('answers 503 until the migration is applied', async () => {
    env = { ...env, DB: d1Over(new DatabaseSync(':memory:')) }
    expect((await trigger({ event: 'carplay_connect' })).status).toBe(503)
  })
})

describe('who may file a trigger', () => {
  it('refuses the collector token: each token reaches its own paths', async () => {
    expect((await trigger({ event: 'carplay_connect' }, { as: 'collector' })).status).toBe(403)
    expect(rows('collect_triggers')).toEqual([])
  })

  it('refuses a signed-in person: the path is for the phone token only', async () => {
    expect((await trigger({ event: 'carplay_connect' }, { as: 'owner' })).status).toBe(403)
    expect(rows('collect_triggers')).toEqual([])
  })

  it('refuses a request with no token', async () => {
    expect((await trigger({ event: 'carplay_connect' }, { as: 'none' })).status).toBe(401)
  })

  it('refuses a service token with another client id', async () => {
    const claims = tokenFor('someone-else.access')
    expect((await trigger({ event: 'carplay_connect' }, { claims })).status).toBe(401)
  })

  it.each([
    ['no phone client id', { TRIGGER_CLIENT_ID: '' }],
    ['no phone client id at all', { TRIGGER_CLIENT_ID: undefined }],
    ['no owner subject', { INGEST_OWNER_SUBJECT: '' }],
  ])('refuses the phone token when the Worker has %s configured', async (_label, settings) => {
    env = { ...env, ...settings }
    expect((await trigger({ event: 'carplay_connect' })).status).toBe(401)
    expect(rows('collect_triggers')).toEqual([])
  })

  it('never lets one token be both: a phone id equal to the collector id stays the collector', async () => {
    env = { ...env, TRIGGER_CLIENT_ID: ingestClientId }
    expect((await trigger({ event: 'carplay_connect' }, { as: 'collector' })).status).toBe(403)
    expect((await pending()).status).toBe(200)
  })

  it('still refuses an expired phone token', async () => {
    const claims = tokenFor(phoneClientId, { exp: NOW_SECONDS - 3600 })
    expect((await trigger({ event: 'carplay_connect' }, { claims })).status).toBe(401)
  })
})

describe('what the phone token may not do', () => {
  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/dashboard'],
    ['GET', '/'],
    ['GET', '/assets/app.js'],
    ['GET', '/api/collect/pending'],
    ['POST', '/api/collect/ack'],
    ['POST', '/api/ingest/byd'],
    ['POST', '/api/vehicles'],
    ['POST', '/api/range-observations'],
    ['GET', '/api/collect/other'],
  ])('refuses %s %s', async (method, path) => {
    const response = await call(path, { event: 'carplay_connect' }, { as: 'phone', method })
    expect(response.status).toBe(403)
    expect(assets).not.toHaveBeenCalled()
    expect(rows('collect_triggers')).toEqual([])
  })

  it('cannot read or add what the collector sends: the collector token is not accepted on /api/ingest/byd as the phone', async () => {
    expect((await call('/api/ingest/byd', {}, { as: 'phone' })).status).toBe(403)
  })
})

describe('what the collector token may not do', () => {
  it.each([
    ['GET', '/api/dashboard'],
    ['POST', '/api/vehicles'],
    ['GET', '/api/collect/other'],
    ['POST', '/api/collect/other'],
  ])('refuses %s %s', async (method, path) => {
    expect((await call(path, {}, { as: 'collector', method })).status).toBe(403)
  })

  it.each([
    ['GET', '/api/collect/pending'],
    ['POST', '/api/collect/ack'],
  ])('refuses a signed-in person on %s %s', async (method, path) => {
    expect((await call(path, { trigger_ids: [] }, { as: 'owner', method })).status).toBe(403)
  })
})

describe('GET /api/collect/pending', () => {
  it('lists the owner\'s unacknowledged triggers, oldest first', async () => {
    const first = addTrigger(ownerSubject, 'carplay_connect', minutesAgo(5))
    const second = addTrigger(ownerSubject, 'carplay_disconnect', minutesAgo(1))
    const response = await pending()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      triggers: [
        { id: first, event: 'carplay_connect', requested_at: expect.stringMatching(/Z$/) },
        { id: second, event: 'carplay_disconnect', requested_at: expect.stringMatching(/Z$/) },
      ],
    })
  })

  it('leaves out an acknowledged trigger', async () => {
    const done = addTrigger(ownerSubject, 'carplay_connect', minutesAgo(5))
    const open = addTrigger(ownerSubject, 'carplay_disconnect', minutesAgo(1))
    db.prepare('insert into collect_acks (trigger_id, user_id) values (?, ?)').run(done, ownerSubject)
    const body = (await (await pending()).json()) as { triggers: { id: string }[] }
    expect(body.triggers.map((row) => row.id)).toEqual([open])
  })

  it("leaves out another user's trigger", async () => {
    addTrigger(strangerSubject, 'carplay_connect')
    expect(await (await pending()).json()).toEqual({ triggers: [] })
  })

  it('leaves out a trigger older than 30 minutes: a reading taken now says nothing about it', async () => {
    addTrigger(ownerSubject, 'carplay_connect', minutesAgo(31))
    const fresh = addTrigger(ownerSubject, 'carplay_disconnect', minutesAgo(29))
    const body = (await (await pending()).json()) as { triggers: { id: string }[] }
    expect(body.triggers.map((row) => row.id)).toEqual([fresh])
  })

  it('answers only GET and writes nothing', async () => {
    addTrigger(ownerSubject, 'carplay_connect')
    const wrong = await call('/api/collect/pending', {}, { as: 'collector', method: 'POST' })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET')
    await pending()
    expect(rows('collect_acks')).toEqual([])
  })
})

describe('POST /api/collect/ack', () => {
  it('adds an ack row for each trigger and reports how many were new', async () => {
    const one = addTrigger(ownerSubject, 'carplay_connect')
    const two = addTrigger(ownerSubject, 'carplay_disconnect')
    const response = await ack({ trigger_ids: [one, two] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ acked: 2 })
    expect(rows('collect_acks')).toHaveLength(2)
    expect(await (await pending()).json()).toEqual({ triggers: [] })
  })

  it('is safe to repeat: an acknowledged trigger is not acknowledged twice', async () => {
    const one = addTrigger(ownerSubject, 'carplay_connect')
    await ack({ trigger_ids: [one] })
    const again = await ack({ trigger_ids: [one] })
    expect(await again.json()).toEqual({ acked: 0 })
    expect(rows('collect_acks')).toHaveLength(1)
  })

  it("ignores an unknown id and another user's trigger", async () => {
    const theirs = addTrigger(strangerSubject, 'carplay_connect')
    const response = await ack({ trigger_ids: [theirs, 'no-such-trigger'] })
    expect(await response.json()).toEqual({ acked: 0 })
    expect(rows('collect_acks')).toEqual([])
  })

  it('never updates or deletes a trigger', async () => {
    const one = addTrigger(ownerSubject, 'carplay_connect')
    const before = rows('collect_triggers')
    await ack({ trigger_ids: [one] })
    expect(rows('collect_triggers')).toEqual(before)
  })

  it.each([
    ['no ids', {}],
    ['an empty list', { trigger_ids: [] }],
    ['a non-list', { trigger_ids: 'abc' }],
    ['a non-string id', { trigger_ids: [1] }],
    ['an oversize id', { trigger_ids: ['x'.repeat(65)] }],
    ['more than 50 ids', { trigger_ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) }],
    ['an extra field', { trigger_ids: ['a'], user_id: 'someone' }],
  ])('answers 422 for %s', async (_label, payload) => {
    expect((await ack(payload)).status).toBe(422)
  })

  it('answers only POST', async () => {
    const response = await call('/api/collect/ack', null, { as: 'collector', method: 'GET' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })
})
