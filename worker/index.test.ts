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

const ownerSubject = 'subject-owner'
const strangerSubject = 'subject-stranger'

let db: DatabaseSync
let key: SigningKey
let assets: Mock<(request: Request) => Promise<Response>>
let env: Env

const deps = () => ({ fetchKeys: async () => [key.publicJwk], now: () => NOW_SECONDS * 1000 })

async function call(path: string, options: { as?: string | null; method?: string; token?: string | null } = {}) {
  const token =
    options.token !== undefined
      ? options.token
      : await signToken(key, validClaims({ sub: options.as ?? ownerSubject }))
  return handle(requestWith(token, `https://atto1.myargus.cc${path}`, { method: options.method }), env, deps())
}

beforeEach(async () => {
  clearAccessKeyCache()
  key ??= await createSigningKey()
  db = migratedDatabase()
  assets = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))
  env = { DB: d1Over(db), ASSETS: { fetch: assets }, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

function addVehicle(userId: string, nickname: string) {
  db.prepare('insert into vehicles (user_id, nickname) values (?, ?)').run(userId, nickname)
}

describe('authentication', () => {
  it.each(['/api/me', '/api/dashboard', '/', '/index.html', '/assets/app.js', '/api/unknown'])(
    'refuses %s with no Access token, before touching assets or D1',
    async (path) => {
      const response = await call(path, { token: null })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
      expect(assets).not.toHaveBeenCalled()
    },
  )

  it('refuses a token for another audience', async () => {
    const token = await signToken(key, validClaims({ aud: ['another-app'] }))
    expect((await call('/api/me', { token })).status).toBe(401)
  })

  it('does not say why a token was refused', async () => {
    const token = await signToken(key, validClaims({ exp: NOW_SECONDS - 3600 }))
    const response = await call('/api/me', { token })
    expect(JSON.stringify(await response.json())).not.toMatch(/expired|signature|audience/i)
  })

  it.each([
    ['no team domain', { ACCESS_AUD: AUDIENCE }],
    ['no audience', { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }],
  ])('serves nobody when Access has %s configured', async (_label, access) => {
    env = { DB: env.DB, ASSETS: env.ASSETS, ...access }
    for (const path of ['/api/me', '/api/dashboard', '/']) {
      const response = await call(path)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'access_not_configured' })
    }
    expect(assets).not.toHaveBeenCalled()
  })

  it('does not accept the Access cookie in place of the header', async () => {
    const token = await signToken(key)
    const request = new Request('https://atto1.myargus.cc/api/me', { headers: { cookie: `CF_Authorization=${token}` } })
    expect((await handle(request, env, deps())).status).toBe(401)
  })
})

describe('GET /api/me', () => {
  it('returns who Access says is calling, uncached', async () => {
    const response = await call('/api/me')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ subject: ownerSubject, email: 'owner@example.com' })
  })
})

describe('GET /api/dashboard', () => {
  it('returns the signed-in user\'s data only', async () => {
    addVehicle(ownerSubject, 'Mine')
    addVehicle(strangerSubject, 'Theirs')

    const mine = (await (await call('/api/dashboard')).json()) as { kind: string; data: { vehicle: { nickname: string } } }
    expect(mine.data.vehicle.nickname).toBe('Mine')

    const theirs = (await (await call('/api/dashboard', { as: strangerSubject })).json()) as typeof mine
    expect(theirs.data.vehicle.nickname).toBe('Theirs')
  })

  it('gives a user with no vehicle an empty dashboard', async () => {
    addVehicle(strangerSubject, 'Theirs')
    expect(await (await call('/api/dashboard')).json()).toEqual({
      kind: 'ready',
      data: { vehicle: null, sessions: [], observations: [], features: [] },
    })
  })

  it('reports schema-missing before the migration is applied', async () => {
    env = { ...env, DB: d1Over(new DatabaseSync(':memory:')) }
    expect(await (await call('/api/dashboard')).json()).toEqual({ kind: 'schema-missing' })
  })

  it('answers 500 without leaking the database error', async () => {
    env = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1_ERROR: secret table detail')
        },
      },
    }
    const response = await call('/api/dashboard')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'dashboard_unavailable' })
  })
})

describe('routing', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s on a read route: it only answers GET', async (method) => {
    const response = await call('/api/dashboard', { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('answers 404 for an unknown API route and never falls through to the assets', async () => {
    const response = await call('/api/nope')
    expect(response.status).toBe(404)
    expect(assets).not.toHaveBeenCalled()
  })

  it('hands authenticated page requests to the static assets', async () => {
    const response = await call('/anything')
    expect(response.status).toBe(200)
    expect(assets).toHaveBeenCalledTimes(1)
  })

  it('refuses a write to a page route', async () => {
    expect((await call('/', { method: 'POST' })).status).toBe(405)
    expect(assets).not.toHaveBeenCalled()
  })
})
