// Signs Access-shaped JWTs with a throwaway RSA key, and serves its public half
// the way Access's certs endpoint does.

export const TEAM_DOMAIN = 'owner.cloudflareaccess.com'
export const AUDIENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
export const NOW_SECONDS = 1_793_000_000

const encoder = new TextEncoder()

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const json = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)))

export type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey & { kid: string } }

export async function createSigningKey(kid = 'key-1'): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { kid, privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid } }
}

export type Claims = Record<string, unknown>

export function validClaims(overrides: Claims = {}): Claims {
  return {
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUDIENCE],
    sub: '5f3c9a2e-1111-4222-8333-444455556666',
    email: 'owner@example.com',
    iat: NOW_SECONDS - 10,
    nbf: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  }
}

export async function signToken(
  key: SigningKey,
  claims: Claims = validClaims(),
  header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' },
): Promise<string> {
  const signingInput = `${json(header)}.${json(claims)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, encoder.encode(signingInput))
  return `${signingInput}.${base64Url(signature)}`
}

export function requestWith(token: string | null, url = 'https://atto1.myargus.cc/api/dashboard', init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('cf-access-jwt-assertion', token)
  return new Request(url, { ...init, headers })
}
