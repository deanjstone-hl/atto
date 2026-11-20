// Where the collector's four secrets come from (ADR-006): the environment when set (a
// manual run), otherwise Bitwarden Secrets Manager by secret name, so an unattended timer
// needs only the bws access token. A value is never logged and never put in an error.

export type Exec = (file: string, args: string[]) => Promise<string>

export type Secrets = { bydUsername: string; bydPassword: string; clientId: string; clientSecret: string }

const SOURCES: { field: keyof Secrets; env: string; secretName: string }[] = [
  { field: 'bydUsername', env: 'BYD_USERNAME', secretName: 'atto1-byd-username' },
  { field: 'bydPassword', env: 'BYD_PASSWORD', secretName: 'atto1-byd-password' },
  { field: 'clientId', env: 'CF_ACCESS_CLIENT_ID', secretName: 'atto1-ingest-client-id' },
  { field: 'clientSecret', env: 'CF_ACCESS_CLIENT_SECRET', secretName: 'atto1-ingest-client-secret' },
]

const SECRET_NAMES: Record<keyof Secrets, true> = { bydUsername: true, bydPassword: true, clientId: true, clientSecret: true }

async function bwsValues(exec: Exec): Promise<Map<string, string>> {
  const output = await exec('bws', ['secret', 'list', '--output', 'json'])
  let listing: unknown
  try {
    listing = JSON.parse(output)
  } catch {
    throw new Error('bws secret list did not print JSON')
  }
  const values = new Map<string, string>()
  if (Array.isArray(listing)) {
    for (const entry of listing) {
      if (typeof entry?.key === 'string' && typeof entry?.value === 'string') values.set(entry.key, entry.value)
    }
  }
  return values
}

export async function loadSecrets<Field extends keyof Secrets = keyof Secrets>(
  env: Record<string, string | undefined>,
  exec: Exec,
  fields: readonly Field[] = Object.keys(SECRET_NAMES) as Field[],
): Promise<Pick<Secrets, Field>> {
  const found: Partial<Secrets> = {}
  const wanted = SOURCES.filter(({ field }) => (fields as readonly string[]).includes(field))
  const missing = wanted.filter(({ field, env: name }) => {
    const value = env[name]
    if (value) found[field] = value
    return !value
  })

  if (missing.length > 0) {
    const values = await bwsValues(exec)
    const absent: string[] = []
    for (const { field, secretName } of missing) {
      const value = values.get(secretName)
      if (value) found[field] = value
      else absent.push(secretName)
    }
    if (absent.length > 0) throw new Error(`Bitwarden Secrets Manager has no secret named: ${absent.join(', ')}`)
  }
  return found as Pick<Secrets, Field>
}
