import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AccessDenied,
  AccessNotConfigured,
  clearAccessKeyCache,
  timingSafeEqual,
  type JwksFetcher,
  verifyAccess,
} from './access'
import {
  AUDIENCE,
  NOW_SECONDS,
  TEAM_DOMAIN,
  createSigningKey,
  json,
  requestWith,
  signToken,
  validClaims,
  type SigningKey,
} from './test-support/access-tokens'

const env = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE }

let key: SigningKey
let otherKey: SigningKey
let fetchKeys: Mock<JwksFetcher>
let nowMs = NOW_SECONDS * 1000

const deps = () => ({ fetchKeys, now: () => nowMs })

beforeEach(async () => {
  clearAccessKeyCache()
  nowMs = NOW_SECONDS * 1000
  key ??= await createSigningKey('key-1')
  otherKey ??= await createSigningKey('key-1')
  fetchKeys = vi.fn<JwksFetcher>(async () => [key.publicJwk])
})

async function expectDenied(token: string | null, reason: RegExp) {
  await expect(verifyAccess(requestWith(token), env, deps())).rejects.toThrow(reason)
  await expect(verifyAccess(requestWith(token), env, deps())).rejects.toBeInstanceOf(AccessDenied)
}

describe('verifyAccess', () => {
  it('returns the subject and email of a valid token', async () => {
    const identity = await verifyAccess(requestWith(await signToken(key)), env, deps())
    expect(identity).toEqual({ subject: '5f3c9a2e-1111-4222-8333-444455556666', email: 'owner@example.com' })
    expect(fetchKeys).toHaveBeenCalledWith(TEAM_DOMAIN)
  })

  it('accepts a string audience and a token with no email', async () => {
    const token = await signToken(key, validClaims({ aud: AUDIENCE, email: undefined }))
    await expect(verifyAccess(requestWith(token), env, deps())).resolves.toMatchObject({ email: null })
  })

  it('accepts any one of several audiences', async () => {
    const token = await signToken(key, validClaims({ aud: ['other-app', AUDIENCE] }))
    await expect(verifyAccess(requestWith(token), env, deps())).resolves.toBeDefined()
  })

  it('fetches the signing keys once and reuses them', async () => {
    const token = await signToken(key)
    await verifyAccess(requestWith(token), env, deps())
    await verifyAccess(requestWith(token), env, deps())
    expect(fetchKeys).toHaveBeenCalledTimes(1)
  })

  it('refetches once for an unknown key id, after the refetch interval', async () => {
    const rotated = await createSigningKey('key-2')
    await verifyAccess(requestWith(await signToken(key)), env, deps())
    fetchKeys.mockImplementation(async () => [key.publicJwk, rotated.publicJwk])

    await expectDenied(await signToken(rotated), /unknown signing key/)
    expect(fetchKeys).toHaveBeenCalledTimes(1)

    nowMs += 61_000
    const identity = await verifyAccess(requestWith(await signToken(rotated, validClaims({ exp: NOW_SECONDS + 7200 }))), env, deps())
    expect(identity.subject).toBeDefined()
    expect(fetchKeys).toHaveBeenCalledTimes(2)
  })

  describe('refuses', () => {
    it('a request with no Access header', async () => {
      await expectDenied(null, /no Access token/)
    })

    it.each(['', 'abc', 'a.b', 'a.b.c.d'])('the malformed token %j', async (token) => {
      await expectDenied(token, /no Access token|three-part|base64url|JSON object/)
    })

    it('an unsigned (alg none) token', async () => {
      const token = `${json({ alg: 'none', kid: 'key-1' })}.${json(validClaims())}.`
      await expectDenied(token, /unsupported algorithm/)
    })

    it('an HMAC token', async () => {
      const token = `${json({ alg: 'HS256', kid: 'key-1' })}.${json(validClaims())}.c2ln`
      await expectDenied(token, /unsupported algorithm/)
    })

    it('a token with no key id', async () => {
      const token = await signToken(key, validClaims(), { alg: 'RS256' })
      await expectDenied(token, /no key id/)
    })

    it('a token signed by a different key with the same key id', async () => {
      await expectDenied(await signToken(otherKey), /bad signature/)
    })

    it('a token whose payload was changed after signing', async () => {
      const [header, , signature] = (await signToken(key)).split('.')
      const forged = `${header}.${json(validClaims({ sub: 'someone-else' }))}.${signature}`
      await expectDenied(forged, /bad signature/)
    })

    it('a token for another audience', async () => {
      await expectDenied(await signToken(key, validClaims({ aud: ['another-app'] })), /wrong audience/)
    })

    it('a token with no audience', async () => {
      await expectDenied(await signToken(key, validClaims({ aud: undefined })), /wrong audience/)
    })

    it('a token from another team', async () => {
      await expectDenied(await signToken(key, validClaims({ iss: 'https://evil.cloudflareaccess.com' })), /wrong issuer/)
    })

    it('an expired token, beyond the clock skew', async () => {
      await expectDenied(await signToken(key, validClaims({ exp: NOW_SECONDS - 61 })), /expired/)
    })

    it('a token with no expiry', async () => {
      await expectDenied(await signToken(key, validClaims({ exp: undefined })), /expired/)
    })

    it('a token that is not valid yet, beyond the clock skew', async () => {
      await expectDenied(await signToken(key, validClaims({ nbf: NOW_SECONDS + 61 })), /not yet valid/)
    })

    it.each([undefined, '', 42, 'x'.repeat(201)])('a token whose subject is %j', async (sub) => {
      await expectDenied(await signToken(key, validClaims({ sub })), /no usable subject/)
    })

    it('every token when the signing keys cannot be fetched', async () => {
      fetchKeys.mockRejectedValue(new Error('network down'))
      await expectDenied(await signToken(key), /signing keys unavailable/)
    })

    it('a token whose signing key is not an RSA key', async () => {
      fetchKeys.mockResolvedValue([{ kty: 'oct', kid: 'key-1', k: 'AAAA' }])
      await expectDenied(await signToken(key), /unknown signing key/)
    })
  })

  it('tolerates a minute of clock skew', async () => {
    const token = await signToken(key, validClaims({ exp: NOW_SECONDS - 59, nbf: NOW_SECONDS + 59 }))
    await expect(verifyAccess(requestWith(token), env, deps())).resolves.toBeDefined()
  })

  describe('with Access not configured', () => {
    it.each([
      ['no team domain', { ACCESS_AUD: AUDIENCE }],
      ['an empty team domain', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUDIENCE }],
      ['a team domain outside cloudflareaccess.com', { ACCESS_TEAM_DOMAIN: 'evil.example.com', ACCESS_AUD: AUDIENCE }],
      ['a team domain with a path', { ACCESS_TEAM_DOMAIN: 'owner.cloudflareaccess.com/x', ACCESS_AUD: AUDIENCE }],
      ['no audience', { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }],
      ['a blank audience', { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: '  ' }],
    ])('refuses even a valid token with %s', async (_label, badEnv) => {
      const token = await signToken(key)
      await expect(verifyAccess(requestWith(token), badEnv, deps())).rejects.toBeInstanceOf(AccessNotConfigured)
      expect(fetchKeys).not.toHaveBeenCalled()
    })
  })
})

describe('timingSafeEqual', () => {
  it.each([
    ['same', 'same', true],
    ['same', 'sama', false],
    ['same', 'sam', false],
    ['', 'x', false],
    ['', '', true],
    ['é', 'é', true],
  ])('compares %j with %j', (left, right, expected) => {
    expect(timingSafeEqual(left, right)).toBe(expected)
  })
})
