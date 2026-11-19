// Cloudflare Access JWT verification for the Worker (ADR-005).
//
// Access sits in front of the hostname and forwards a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. The Worker does not trust that Access is in
// front of it: it verifies the token itself and fails closed. Anything missing,
// malformed, expired, for another audience or issuer, or signed by an unknown key
// is refused, and a Worker with no Access settings refuses every request.
//
// Only RS256 is accepted, so an `alg: none` or HMAC-with-the-public-key token is
// refused before any key is looked up. The signature check is crypto.subtle's; the
// issuer and audience comparisons use timingSafeEqual below so they take the same
// time wherever a mismatch is.

export type AccessEnv = {
  // `<team>.cloudflareaccess.com`
  ACCESS_TEAM_DOMAIN?: string
  // The Access application's audience tag.
  ACCESS_AUD?: string
  // The one Access service token allowed to ingest (ADR-006): its client id, which Access
  // signs into the token's `common_name`. Empty, no service token is accepted.
  INGEST_CLIENT_ID?: string
  // The Access `sub` of the owner. An ingesting service token writes as this user_id.
  // Empty, no service token is accepted.
  INGEST_OWNER_SUBJECT?: string
}

export type AccessIdentity = {
  // Access's stable user id (the `sub` claim). Every row is owned by it.
  subject: string
  email: string | null
  // Set only for the named ingest service token (ADR-006): it is not a person, and
  // the Worker lets it reach one path only.
  serviceToken?: true
}

export class AccessDenied extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'AccessDenied'
  }
}

// Access is not configured: the Worker cannot tell who is calling, so it serves nobody.
export class AccessNotConfigured extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'AccessNotConfigured'
  }
}

export type Jwk = JsonWebKey & { kid?: string }
export type JwksFetcher = (teamDomain: string) => Promise<Jwk[]>

export type AccessDeps = {
  fetchKeys?: JwksFetcher
  now?: () => number
}

const TEAM_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/
const CLOCK_SKEW_SECONDS = 60
const MAX_SUBJECT_LENGTH = 200
const KEY_CACHE_SECONDS = 600
// A token with an unknown `kid` forces a refetch (keys rotate); at most one a minute,
// so garbage tokens cannot make the Worker hammer Access's certs endpoint.
const KEY_REFETCH_MIN_SECONDS = 60

export function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new AccessDenied('not base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    if (error instanceof AccessDenied) throw error
  }
  throw new AccessDenied('token segment is not a JSON object')
}

const defaultFetchKeys: JwksFetcher = async (teamDomain) => {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`)
  const body = (await response.json()) as { keys?: Jwk[] }
  return Array.isArray(body.keys) ? body.keys : []
}

type KeyCache = { teamDomain: string; keys: Jwk[]; fetchedAt: number }
let keyCache: KeyCache | null = null

export function clearAccessKeyCache(): void {
  keyCache = null
}

async function findKey(teamDomain: string, kid: string, fetchKeys: JwksFetcher, nowSeconds: number) {
  const cached = keyCache?.teamDomain === teamDomain ? keyCache : null
  const fresh = cached !== null && nowSeconds - cached.fetchedAt < KEY_CACHE_SECONDS
  const hit = fresh ? cached.keys.find((key) => key.kid === kid) : undefined
  if (hit) return hit

  const mayRefetch = cached === null || nowSeconds - cached.fetchedAt >= KEY_REFETCH_MIN_SECONDS
  if (!mayRefetch) return undefined

  const keys = await fetchKeys(teamDomain)
  keyCache = { teamDomain, keys, fetchedAt: nowSeconds }
  return keys.find((key) => key.kid === kid)
}

function configuration(env: AccessEnv): { teamDomain: string; audience: string } {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase() ?? ''
  const audience = env.ACCESS_AUD?.trim() ?? ''
  if (!TEAM_DOMAIN_PATTERN.test(teamDomain)) {
    throw new AccessNotConfigured('ACCESS_TEAM_DOMAIN is not a <team>.cloudflareaccess.com domain')
  }
  if (audience === '') throw new AccessNotConfigured('ACCESS_AUD is empty')
  return { teamDomain, audience }
}

function audiences(claim: unknown): string[] {
  if (typeof claim === 'string') return [claim]
  if (Array.isArray(claim)) return claim.filter((entry): entry is string => typeof entry === 'string')
  return []
}

// Resolves to who is calling, or throws AccessDenied (not signed in as far as the
// Worker can tell) or AccessNotConfigured. It never returns a partial identity.
export async function verifyAccess(
  request: Request,
  env: AccessEnv,
  deps: AccessDeps = {},
): Promise<AccessIdentity> {
  const { teamDomain, audience } = configuration(env)
  const fetchKeys = deps.fetchKeys ?? defaultFetchKeys
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000)

  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) throw new AccessDenied('no Access token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessDenied('not a three-part JWT')
  const [encodedHeader, encodedPayload, encodedSignature] = parts

  const header = decodeJson(encodedHeader)
  if (header.alg !== 'RS256') throw new AccessDenied('unsupported algorithm')
  if (typeof header.kid !== 'string' || header.kid === '') throw new AccessDenied('no key id')

  let jwk: Jwk | undefined
  try {
    jwk = await findKey(teamDomain, header.kid, fetchKeys, nowSeconds)
  } catch {
    // Cannot reach Access's keys: nothing can be verified, so nothing is allowed.
    throw new AccessDenied('signing keys unavailable')
  }
  if (!jwk || jwk.kty !== 'RSA') throw new AccessDenied('unknown signing key')

  let verified = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    )
  } catch (error) {
    if (error instanceof AccessDenied) throw error
  }
  if (!verified) throw new AccessDenied('bad signature')

  const claims = decodeJson(encodedPayload)

  const issuerMatches = typeof claims.iss === 'string' && timingSafeEqual(claims.iss, `https://${teamDomain}`)
  // Every audience is compared, with no early exit, so a match's position leaks nothing.
  const audienceMatches = audiences(claims.aud)
    .map((candidate) => timingSafeEqual(candidate, audience))
    .reduce((any, matches) => any || matches, false)
  if (!issuerMatches) throw new AccessDenied('wrong issuer')
  if (!audienceMatches) throw new AccessDenied('wrong audience')

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new AccessDenied('expired')
  }
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) {
    throw new AccessDenied('not yet valid')
  }

  const subject = claims.sub
  if (typeof subject === 'string' && subject !== '') {
    if (subject.length > MAX_SUBJECT_LENGTH) throw new AccessDenied('no usable subject')
    return { subject, email: typeof claims.email === 'string' ? claims.email : null }
  }

  // A service-token JWT has no `sub`. Only the one named in INGEST_CLIENT_ID is accepted,
  // and it acts as the owner for ingest; any other service token is refused.
  const clientId = env.INGEST_CLIENT_ID?.trim() ?? ''
  const ownerSubject = env.INGEST_OWNER_SUBJECT?.trim() ?? ''
  const named =
    clientId !== '' && ownerSubject !== '' && typeof claims.common_name === 'string' && timingSafeEqual(claims.common_name, clientId)
  if (named && ownerSubject.length <= MAX_SUBJECT_LENGTH) return { subject: ownerSubject, email: null, serviceToken: true }
  throw new AccessDenied('no usable subject')
}
