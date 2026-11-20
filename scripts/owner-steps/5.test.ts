import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/5.sh merges the collector's duplicate vehicle into the owner's
// hand-made one (atto/5). These cases run it against a throwaway SQLite file standing in
// for D1, with stub `wrangler` and `bws`, so they prove what it reads, what it would write,
// what it leaves behind, and that the D1 database id never reaches its output.

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/owner-steps/5.sh')
const migrationsDir = join(root, 'migrations')
const DATABASE_ID = 'fake-d1-id-00000000'
const VIN = 'LC0CE4CB5S0123456'

// Mirrors `wrangler d1 execute --json --command|--file` against the SQLite file at $STUB_DB,
// and fails if the temporary config it is given does not hold the database id.
const wranglerJs = `
import { readFileSync, appendFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const config = JSON.parse(readFileSync(value('--config'), 'utf8'))
if (config.d1_databases?.[0]?.database_id !== process.env.STUB_DATABASE_ID) { console.error('stub: config has no database id'); process.exit(4) }
if (!args.includes('--remote')) { console.error('stub: not --remote'); process.exit(5) }
appendFileSync(process.env.STUB_DIR + '/wrangler.log', JSON.stringify({ config: value('--config'), file: args.includes('--file') }) + '\\n')
const db = new DatabaseSync(process.env.STUB_DB)
db.exec('pragma foreign_keys = on')
try {
  if (args.includes('--file')) {
    db.exec(readFileSync(value('--file'), 'utf8'))
    console.log(JSON.stringify([{ results: [], success: true }]))
  } else {
    console.log(JSON.stringify([{ results: db.prepare(value('--command')).all(), success: true }]))
  }
} catch (error) { console.error('stub: ' + error.message); process.exit(1) }
`

function write(path: string, body: string, mode = 0o644) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, mode)
}

type Seed = (db: DatabaseSync) => void

function world(seed: Seed) {
  const stub = mkdtempSync(join(tmpdir(), 'atto-5-'))
  const home = join(stub, 'home')
  const dbPath = join(stub, 'd1.sqlite')

  const source = new DatabaseSync(dbPath)
  source.exec('pragma foreign_keys = on')
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    source.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
  seed(source)
  source.close()

  write(join(stub, 'bin/wrangler.mjs'), wranglerJs)
  write(join(stub, 'bin/wrangler'), `#!/bin/bash\nexec "${process.execPath}" "${join(stub, 'bin/wrangler.mjs')}" "$@"\n`, 0o755)
  write(
    join(stub, 'bin/bws'),
    `#!/bin/bash\n[ "$BWS_ACCESS_TOKEN" = stub ] || exit 1\necho '[{"key":"ATTO_D1_DATABASE_ID","value":"${DATABASE_ID}"},{"key":"OTHER","value":"x"}]'\n`,
    0o755,
  )
  write(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub\n')

  const run = (args: string[] = []) => {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: home,
        STUB_DIR: stub,
        STUB_DB: dbPath,
        STUB_DATABASE_ID: DATABASE_ID,
      },
    })
    const calls = existsSync(join(stub, 'wrangler.log'))
      ? readFileSync(join(stub, 'wrangler.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { config: string; file: boolean })
      : []
    return { ...result, all: `${result.stdout}${result.stderr}`, calls, writes: calls.filter((call) => call.file).length }
  }
  const query = <Row>(sql: string): Row[] => {
    const db = new DatabaseSync(dbPath)
    try {
      return db.prepare(sql).all() as Row[]
    } finally {
      db.close()
    }
  }
  return { run, query }
}

const OWNER = 'owner-subject-0001'

// "Toothless" added by hand on 17 Nov (no VIN, one reading); "ATTO 1" made by the first
// collector post on 21 Nov (the VIN, two readings and a charging session).
function duplicate(db: DatabaseSync) {
  db.exec(`
    insert into vehicles (id, user_id, nickname, vin, model_year, created_at) values
      ('hand', '${OWNER}', 'Toothless', null, 2025, '2026-11-17T07:57:00.000Z');
    insert into vehicles (id, user_id, nickname, vin, battery_capacity_kwh, created_at) values
      ('auto', '${OWNER}', 'ATTO 1', '${VIN}', 30, '2026-11-20T21:57:00.000Z');
    insert into range_observations (user_id, vehicle_id, observed_at, soc_pct, displayed_range_km, odometer_km) values
      ('${OWNER}', 'hand', '2026-11-17T07:58:00Z', 29, 89, 4503),
      ('${OWNER}', 'auto', '2026-11-20T21:57:48Z', 75, 234, 4624),
      ('${OWNER}', 'auto', '2026-11-20T22:00:28Z', 75, 234, 4624);
    insert into charging_sessions (user_id, vehicle_id, started_at, energy_kwh, charger_type) values
      ('${OWNER}', 'auto', '2026-11-20T10:00:00Z', 10, 'ac_home'),
      ('${OWNER}', 'hand', '2026-11-16T10:00:00Z', 8, 'ac_home');
    insert into vehicle_features (user_id, vehicle_id, category, name, value) values
      ('${OWNER}', 'hand', 'battery', 'Capacity', '43.2');
    insert into maintenance_records (user_id, vehicle_id, performed_on, category, title) values
      ('${OWNER}', 'hand', '2026-11-01', 'tyres', 'Rotate');
    insert into notes (user_id, vehicle_id, title) values ('${OWNER}', 'hand', 'Note');
  `)
}

describe('scripts/owner-steps/5.sh', () => {
  it('refuses an unknown argument', () => {
    expect(world(duplicate).run(['--now']).status).toBe(2)
  })

  it('merges the duplicate onto one vehicle named Toothless, with the VIN and every row', () => {
    const w = world(duplicate)
    const result = w.run()
    expect(result.status, result.all).toBe(0)

    expect(w.query('select id, nickname, vin, model_year, battery_capacity_kwh, created_at from vehicles')).toEqual([
      {
        id: 'auto',
        nickname: 'Toothless',
        vin: VIN,
        model_year: 2025,
        battery_capacity_kwh: 30,
        created_at: '2026-11-17T07:57:00.000Z',
      },
    ])
    expect(w.query('select vehicle_id, odometer_km from range_observations order by observed_at')).toEqual([
      { vehicle_id: 'auto', odometer_km: 4503 },
      { vehicle_id: 'auto', odometer_km: 4624 },
      { vehicle_id: 'auto', odometer_km: 4624 },
    ])
    expect(w.query('select vehicle_id from charging_sessions')).toEqual([{ vehicle_id: 'auto' }, { vehicle_id: 'auto' }])
    expect(w.query('select vehicle_id from vehicle_features')).toEqual([{ vehicle_id: 'auto' }])
    expect(w.query('select vehicle_id from maintenance_records')).toEqual([{ vehicle_id: 'auto' }])
    expect(w.query('select vehicle_id from notes')).toEqual([{ vehicle_id: 'auto' }])

    expect(result.stdout).toContain('Vehicles now:')
    expect(result.stdout).toContain('Vehicles after:')
    expect(result.stdout).toContain("verify ok: it is named 'Toothless'")
    expect(result.stdout).toContain('verify ok: it holds every reading')
    expect(result.stderr).not.toContain('FAILED')
  })

  it('does its reads before and after the one write', () => {
    const result = world(duplicate).run()
    expect(result.calls.map((call) => call.file)).toEqual([false, true, false])
  })

  it('changes nothing under --dry-run, and prints the SQL it would run', () => {
    const w = world(duplicate)
    const result = w.run(['--dry-run'])
    expect(result.status, result.all).toBe(0)
    expect(result.writes).toBe(0)
    expect(w.query('select nickname from vehicles order by created_at')).toEqual([{ nickname: 'Toothless' }, { nickname: 'ATTO 1' }])
    expect(result.stdout).toContain('[dry-run]')
    expect(result.stdout).toContain("delete from vehicles where id = 'hand'")
  })

  it('does nothing when run again after the merge', () => {
    const w = world(duplicate)
    w.run()
    const again = w.run()
    expect(again.status, again.all).toBe(0)
    expect(again.stdout).toContain('Nothing to merge: 1 vehicle(s).')
    expect(again.writes).toBe(1) // only the first run's write
  })

  it('has nothing to merge with no vehicle at all', () => {
    const result = world(() => undefined).run()
    expect(result.status, result.all).toBe(0)
    expect(result.stdout).toContain('Nothing to merge: 0 vehicle(s).')
    expect(result.writes).toBe(0)
  })

  it('stops with nothing changed when the two vehicles belong to different users', () => {
    const w = world((db) => {
      db.exec(`
        insert into vehicles (id, user_id, nickname, created_at) values ('hand', '${OWNER}', 'Toothless', '2026-11-17T07:57:00.000Z');
        insert into vehicles (id, user_id, nickname, vin, created_at) values ('auto', 'someone-else-0002', 'ATTO 1', '${VIN}', '2026-11-20T21:57:00.000Z');
      `)
    })
    const result = w.run()
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('different users')
    expect(result.stderr).toContain('ATTO_INGEST_OWNER_SUBJECT')
    expect(result.writes).toBe(0)
    expect(w.query('select id from vehicles')).toHaveLength(2)
  })

  it.each([
    ['both have a VIN', `insert into vehicles (id, user_id, nickname, vin, created_at) values ('a', 'u', 'A', 'LC0CE4CB5S0123456', '2026-01-01T00:00:00.000Z'), ('b', 'u', 'B', 'LC0CE4CB5S0654321', '2026-02-01T00:00:00.000Z');`],
    ['neither has a VIN', `insert into vehicles (id, user_id, nickname, created_at) values ('a', 'u', 'A', '2026-01-01T00:00:00.000Z'), ('b', 'u', 'B', '2026-02-01T00:00:00.000Z');`],
    ['the older one has the VIN', `insert into vehicles (id, user_id, nickname, vin, created_at) values ('a', 'u', 'A', 'LC0CE4CB5S0123456', '2026-01-01T00:00:00.000Z'); insert into vehicles (id, user_id, nickname, created_at) values ('b', 'u', 'B', '2026-02-01T00:00:00.000Z');`],
    ['there are three', `insert into vehicles (id, user_id, nickname, created_at) values ('a', 'u', 'A', '2026-01-01T00:00:00.000Z'), ('b', 'u', 'B', '2026-02-01T00:00:00.000Z'), ('c', 'u', 'C', '2026-03-01T00:00:00.000Z');`],
  ])('changes nothing when the shape is unexpected: %s', (_label, sql) => {
    const w = world((db) => db.exec(sql))
    const result = w.run()
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('Unexpected shape')
    expect(result.writes).toBe(0)
  })

  it('never prints the database id, and deletes its temporary config', () => {
    const w = world(duplicate)
    const result = w.run()
    expect(result.all).not.toContain(DATABASE_ID)
    expect(result.calls.length).toBeGreaterThan(0)
    for (const call of result.calls) expect(existsSync(call.config)).toBe(false)
  })

  it('prints a cut user id, never the full one, and no VIN', () => {
    const result = world(duplicate).run()
    expect(result.all).not.toContain(OWNER)
    expect(result.all).not.toContain(VIN)
    expect(result.all).toContain(`${OWNER.slice(0, 6)}...`)
  })

  it('fails before touching D1 when Secrets Manager has no database id', () => {
    const w = world(duplicate)
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: join(tmpdir(), 'atto-5-nohome'), STUB_DB: 'unused' },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.bws_token')
    expect(w.query('select id from vehicles')).toHaveLength(2)
  })
})
