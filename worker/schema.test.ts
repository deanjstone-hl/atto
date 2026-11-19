import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedDatabase } from './test-support/sqlite-d1'

const userA = 'a0000000-0000-4000-8000-00000000000a'
const userB = 'b0000000-0000-4000-8000-00000000000b'

let db: DatabaseSync

function insertVehicle(userId: string, nickname = 'Atto'): string {
  const row = db
    .prepare('insert into vehicles (user_id, nickname) values (?, ?) returning id')
    .get(userId, nickname) as { id: string }
  return row.id
}

beforeAll(() => {
  db = migratedDatabase()
})

afterAll(() => {
  db.close()
})

describe('schema', () => {
  it('creates every entity table', () => {
    const rows = db
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
      .all()
    expect(rows).toEqual([
      { name: 'charging_sessions' },
      { name: 'maintenance_records' },
      { name: 'notes' },
      { name: 'range_observations' },
      { name: 'vehicle_features' },
      { name: 'vehicles' },
    ])
  })

  it('generates uuid v4 ids and UTC ISO timestamps', () => {
    const vehicleId = insertVehicle(userA)
    expect(vehicleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const row = db.prepare('select created_at, updated_at from vehicles where id = ?').get(vehicleId) as {
      created_at: string
      updated_at: string
    }
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(row.created_at).toISOString()).toBe(row.created_at)
  })

  it('accepts a valid charging session and defaults currency to AUD', () => {
    const vehicleId = insertVehicle(userA)
    const row = db
      .prepare(
        `insert into charging_sessions
           (user_id, vehicle_id, started_at, ended_at, energy_kwh, cost_cents, charger_type)
         values (?, ?, '2026-10-07T01:00:00Z', '2026-10-07T03:00:00Z', 21.4, 642, 'ac_home')
         returning currency, energy_kwh`,
      )
      .get(userA, vehicleId)
    expect(row).toEqual({ currency: 'AUD', energy_kwh: 21.4 })
  })

  it.each([
    ['an end before the start', "'2026-10-07T03:00:00Z'", "'2026-10-07T01:00:00Z'", '10', '100', '20', '80'],
    ['an unparseable end', "'2026-10-07T01:00:00Z'", "'yesterday'", '10', '100', '20', '80'],
    ['an unparseable start', "'not a time'", 'null', '10', '100', '20', '80'],
    ['zero energy', "'2026-10-07T01:00:00Z'", 'null', '0', '100', '20', '80'],
    ['negative cost', "'2026-10-07T01:00:00Z'", 'null', '10', '-1', '20', '80'],
    ['a fractional cost', "'2026-10-07T01:00:00Z'", 'null', '10', '12.5', '20', '80'],
    ['state of charge above 100', "'2026-10-07T01:00:00Z'", 'null', '10', '100', '20', '101'],
    ['end state of charge below start', "'2026-10-07T01:00:00Z'", 'null', '10', '100', '80', '20'],
  ])('rejects a charging session with %s', (_label, startedAt, endedAt, energy, cost, startSoc, endSoc) => {
    const vehicleId = insertVehicle(userA)
    expect(() =>
      db
        .prepare(
          `insert into charging_sessions
             (user_id, vehicle_id, started_at, ended_at, energy_kwh, cost_cents,
              charger_type, start_soc_pct, end_soc_pct)
           values (?, ?, ${startedAt}, ${endedAt}, ${energy}, ${cost}, 'dc_fast', ${startSoc}, ${endSoc})`,
        )
        .run(userA, vehicleId),
    ).toThrow(/CHECK constraint failed|cannot store REAL/)
  })

  it('rejects a charger type outside the vocabulary', () => {
    const vehicleId = insertVehicle(userA)
    expect(() =>
      db
        .prepare(
          `insert into charging_sessions (user_id, vehicle_id, started_at, energy_kwh, charger_type)
           values (?, ?, '2026-10-07T01:00:00Z', 5, 'wireless')`,
        )
        .run(userA, vehicleId),
    ).toThrow(/CHECK constraint failed/)
  })

  it.each(['NOT-A-VIN', 'WVWZZZ1JZXW00000I', 'WVWZZZ1JZXW0000'])('rejects the malformed VIN %s', (vin) => {
    expect(() =>
      db.prepare("insert into vehicles (user_id, nickname, vin) values (?, 'x', ?)").run(userA, vin),
    ).toThrow(/CHECK constraint failed/)
  })

  it('accepts a well-formed VIN and keeps it unique per user', () => {
    const insert = db.prepare("insert into vehicles (user_id, nickname, vin) values (?, 'x', 'LGXC76D17T0000001')")
    insert.run(userA)
    expect(() => insert.run(userA)).toThrow(/UNIQUE constraint failed/)
    expect(() => insert.run(userB)).not.toThrow()
  })

  it("prevents linking a row to another user's vehicle", () => {
    const otherUsersVehicle = insertVehicle(userB)
    expect(() =>
      db
        .prepare('insert into range_observations (user_id, vehicle_id, soc_pct, displayed_range_km) values (?, ?, 50, 150)')
        .run(userA, otherUsersVehicle),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('keeps feature names unique per vehicle and category', () => {
    const vehicleId = insertVehicle(userA)
    const insert = db.prepare(
      `insert into vehicle_features (user_id, vehicle_id, category, name, value, unit)
       values (?, ?, 'battery', 'Usable capacity', '43.2', 'kWh')`,
    )
    insert.run(userA, vehicleId)
    expect(() => insert.run(userA, vehicleId)).toThrow(/UNIQUE constraint failed/)
  })

  it.each([
    ['maintenance due before it was performed', "'2026-10-01'", "'2026-09-01'"],
    ['an impossible calendar day', "'2026-02-30'", 'null'],
    ['a date with a time on it', "'2026-10-01T00:00:00Z'", 'null'],
  ])('rejects %s', (_label, performedOn, nextDueOn) => {
    const vehicleId = insertVehicle(userA)
    expect(() =>
      db
        .prepare(
          `insert into maintenance_records (user_id, vehicle_id, performed_on, category, title, next_due_on)
           values (?, ?, ${performedOn}, 'scheduled_service', 'Service', ${nextDueOn})`,
        )
        .run(userA, vehicleId),
    ).toThrow(/CHECK constraint failed/)
  })

  it('stores tags as a JSON array and rejects an empty tag', () => {
    const insertNote = db.prepare('insert into notes (user_id, title, tags) values (?, ?, ?) returning tags')
    expect(insertNote.get(userA, 'ok', JSON.stringify(['tyres', 'winter']))).toEqual({ tags: '["tyres","winter"]' })
    expect(() => insertNote.run(userA, 'bad', JSON.stringify(['tyres', '']))).toThrow(/CHECK constraint failed/)
    expect(() => insertNote.run(userA, 'bad', 'not json')).toThrow(/CHECK constraint failed|malformed JSON/)
    expect(() => insertNote.run(userA, 'bad', '{"a":1}')).toThrow(/CHECK constraint failed/)
  })

  it('stores booleans as 0 or 1 only', () => {
    const vehicleId = insertVehicle(userA)
    const insert = db.prepare(
      'insert into range_observations (user_id, vehicle_id, soc_pct, displayed_range_km, climate_on) values (?, ?, 50, 150, ?)',
    )
    expect(() => insert.run(userA, vehicleId, 1)).not.toThrow()
    expect(() => insert.run(userA, vehicleId, 2)).toThrow(/CHECK constraint failed/)
  })

  it('detaches notes and cascades children when a vehicle is deleted', () => {
    const vehicleId = insertVehicle(userA)
    const note = db
      .prepare("insert into notes (user_id, vehicle_id, title) values (?, ?, 'Keep me') returning id")
      .get(userA, vehicleId) as { id: string }
    db.prepare(
      "insert into charging_sessions (user_id, vehicle_id, started_at, energy_kwh, charger_type) values (?, ?, '2026-10-07T01:00:00Z', 5, 'ac_public')",
    ).run(userA, vehicleId)

    db.prepare('delete from vehicles where id = ?').run(vehicleId)

    expect(db.prepare('select vehicle_id, user_id from notes where id = ?').all(note.id)).toEqual([
      { vehicle_id: null, user_id: userA },
    ])
    expect(db.prepare('select 1 from charging_sessions where vehicle_id = ?').all(vehicleId)).toHaveLength(0)
  })

  it('bumps updated_at on update', () => {
    const vehicleId = insertVehicle(userA)
    db.prepare("update vehicles set updated_at = '2000-01-01T00:00:00.000Z' where id = ?").run(vehicleId)
    db.prepare("update vehicles set nickname = 'Renamed' where id = ?").run(vehicleId)
    const row = db.prepare('select updated_at from vehicles where id = ?').get(vehicleId) as { updated_at: string }
    expect(new Date(row.updated_at).getUTCFullYear()).toBeGreaterThan(2000)
  })
})
