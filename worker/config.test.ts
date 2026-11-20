import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// wrangler.jsonc is the one file that decides what a deploy exposes. These pin the
// settings that keep the Worker behind Access, so an edit that opens a second way in
// fails here instead of in production.

const root = join(import.meta.dirname, '..')

type WranglerConfig = {
  main: string
  workers_dev: boolean
  preview_urls: boolean
  routes: { pattern: string; custom_domain?: boolean }[]
  assets: { directory: string; binding: string; run_worker_first: boolean }
  d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[]
  vars: Record<string, string>
}

const config = JSON.parse(
  readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n'),
) as WranglerConfig

describe('wrangler.jsonc', () => {
  it('exposes no URL other than the custom domain', () => {
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
    expect(config.routes).toEqual([{ pattern: 'atto1.myargus.cc', custom_domain: true }])
  })

  it('runs the Worker, and so the Access check, before serving any asset', () => {
    expect(config.assets.run_worker_first).toBe(true)
    expect(config.assets.binding).toBe('ASSETS')
    expect(config.assets.directory).toBe('./dist')
  })

  it('binds the D1 database the Worker and the migrate script use', () => {
    expect(config.d1_databases).toMatchObject([{ binding: 'DB', database_name: 'atto1', migrations_dir: 'migrations' }])
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['db:migrate']).toContain(`migrations apply ${config.d1_databases[0].database_name} `)
  })

  it('points at a Worker entry that exists and declares the Access and ingest settings the Worker reads', () => {
    expect(existsSync(join(root, config.main))).toBe(true)
    expect(Object.keys(config.vars).sort()).toEqual(['ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'INGEST_CLIENT_ID', 'INGEST_OWNER_SUBJECT', 'TRIGGER_CLIENT_ID'])
  })

  it('names the BYD collector service token and the owner it acts as by Secrets Manager key, never by value (atto1/90, atto1/104)', () => {
    // Empty, the Worker refuses every service token (worker/access.ts), so the collector gets a 401/403.
    expect(config.vars.INGEST_CLIENT_ID).toBe('@@ATTO_INGEST_CLIENT_ID@@')
    expect(config.vars.INGEST_OWNER_SUBJECT).toBe('@@ATTO_INGEST_OWNER_SUBJECT@@')
  })

  it('names the phone\'s service token by Secrets Manager key too (atto/6)', () => {
    // Empty, the Worker refuses the phone token, so a CarPlay trigger gets a 401.
    expect(config.vars.TRIGGER_CLIENT_ID).toBe('@@ATTO_TRIGGER_CLIENT_ID@@')
  })

  it('commits no private value: the D1 id, the team domain and the audience are Secrets Manager keys too', () => {
    expect(config.d1_databases[0].database_id).toBe('@@ATTO_D1_DATABASE_ID@@')
    expect(config.vars.ACCESS_TEAM_DOMAIN).toBe('@@ATTO_ACCESS_TEAM_DOMAIN@@')
    expect(config.vars.ACCESS_AUD).toBe('@@ATTO_ACCESS_AUD@@')
  })

  it('is deployed only through the rendered copy, never as committed', () => {
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    for (const name of ['db:migrate', 'deploy']) {
      expect(scripts[name], name).toMatch(/node scripts\/render-wrangler\.ts && wrangler .* --config wrangler\.deploy\.jsonc$/)
    }
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^wrangler\.deploy\.jsonc$/m)
  })
})
