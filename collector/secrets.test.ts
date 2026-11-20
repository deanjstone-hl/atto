import { describe, expect, it } from 'vitest'
import { loadSecrets, type Exec } from './secrets.ts'

const listing = JSON.stringify([
  { key: 'atto1-byd-username', value: 'atto@example.test' },
  { key: 'atto1-byd-password', value: 'p4ss' },
  { key: 'atto1-ingest-client-id', value: 'id.access' },
  { key: 'atto1-ingest-client-secret', value: 's3cret' },
  { key: 'unrelated', value: 'nope' },
])

describe('loadSecrets', () => {
  it('takes a value already in the environment and does not ask bws', async () => {
    const calls: string[][] = []
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args])
      return listing
    }
    const secrets = await loadSecrets(
      { BYD_USERNAME: 'u', BYD_PASSWORD: 'p', CF_ACCESS_CLIENT_ID: 'i', CF_ACCESS_CLIENT_SECRET: 's' },
      exec,
    )
    expect(secrets).toEqual({ bydUsername: 'u', bydPassword: 'p', clientId: 'i', clientSecret: 's' })
    expect(calls).toEqual([])
  })

  it('fetches the rest from Bitwarden Secrets Manager by secret name', async () => {
    const calls: string[][] = []
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args])
      return listing
    }
    const secrets = await loadSecrets({ BYD_USERNAME: 'u' }, exec)
    expect(secrets).toEqual({
      bydUsername: 'u',
      bydPassword: 'p4ss',
      clientId: 'id.access',
      clientSecret: 's3cret',
    })
    expect(calls).toEqual([['bws', 'secret', 'list', '--output', 'json']])
  })

  it('loads only the fields asked for, so the one-minute pick-up never reads the BYD login (atto/6)', async () => {
    const exec: Exec = async () => JSON.stringify([
      { key: 'atto1-ingest-client-id', value: 'id.access' },
      { key: 'atto1-ingest-client-secret', value: 's3cret' },
    ])
    expect(await loadSecrets({}, exec, ['clientId', 'clientSecret'])).toEqual({ clientId: 'id.access', clientSecret: 's3cret' })
  })

  it('names the missing secret, and never a value', async () => {
    const exec: Exec = async () => JSON.stringify([{ key: 'atto1-byd-username', value: 'atto@example.test' }])
    const failure = await loadSecrets({}, exec).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/atto1-byd-password/)
    expect((failure as Error).message).not.toMatch(/atto@example\.test/)
  })

  it('does not echo what bws printed when it cannot be read', async () => {
    const exec: Exec = async () => 'not json but p4ss'
    const failure = await loadSecrets({}, exec).catch((error: Error) => error)
    expect((failure as Error).message).not.toMatch(/p4ss/)
  })
})
