import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedDatabase } from './test-support/sqlite-d1'

// Migration 0002 (atto/6): the collect trigger queue, and the tag and location a CarPlay-
// triggered reading carries. Obvious fake coordinates only.

const user = 'a0000000-0000-4000-8000-00000000000a'
const otherUser = 'b0000000-0000-4000-8000-00000000000b'

let db: DatabaseSync
let vehicleId: string

beforeAll(() => {
  db = migratedDatabase()
  vehicleId = (
    db.prepare("insert into vehicles (user_id, nickname) values (?, 'Atto') returning id").get(user) as { id: string }
  ).id
})

afterAll(() => {
  db.close()
})

const insertReading = (columns: string, values: unknown[]) =>
  db
    .prepare(
      `insert into range_observations (user_id, vehicle_id, soc_pct, displayed_range_km, ${columns})
       values (?, ?, 50, 150, ${values.map(() => '?').join(', ')})`,
    )
    .run(user, vehicleId, ...(values as never[]))

describe('migration 0002: collect triggers', () => {
  it('adds the trigger and ack tables', () => {
    const names = db
      .prepare("select name from sqlite_master where type = 'table' and name like 'collect_%' order by name")
      .all()
    expect(names).toEqual([{ name: 'collect_acks' }, { name: 'collect_triggers' }])
  })

  it('stores a trigger with a generated id and a UTC request time', () => {
    const row = db
      .prepare("insert into collect_triggers (user_id, event) values (?, 'carplay_connect') returning id, requested_at")
      .get(user) as { id: string; requested_at: string }
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('keeps the event list out of the schema (the Worker owns it) but not its shape', () => {
    const insert = db.prepare('insert into collect_triggers (user_id, event) values (?, ?)')
    expect(() => insert.run(user, 'charge_start')).not.toThrow()
    for (const bad of ['', 'Carplay Connect', 'x'.repeat(41), 'drop;table']) {
      expect(() => insert.run(user, bad)).toThrow(/CHECK constraint failed/)
    }
  })

  it('takes one ack per trigger and never an ack for a missing trigger', () => {
    const { id } = db
      .prepare("insert into collect_triggers (user_id, event) values (?, 'carplay_disconnect') returning id")
      .get(user) as { id: string }
    const ack = db.prepare('insert into collect_acks (trigger_id, user_id) values (?, ?) returning acked_at')
    expect((ack.get(id, user) as { acked_at: string }).acked_at).toMatch(/Z$/)
    expect(() => ack.run(id, user)).toThrow(/UNIQUE constraint failed/)
    expect(() => ack.run('missing', user)).toThrow(/FOREIGN KEY constraint failed/)
  })

  it("will not ack another user's trigger", () => {
    const { id } = db
      .prepare("insert into collect_triggers (user_id, event) values (?, 'carplay_connect') returning id")
      .get(user) as { id: string }
    expect(() => db.prepare('insert into collect_acks (trigger_id, user_id) values (?, ?)').run(id, otherUser)).toThrow(
      /FOREIGN KEY constraint failed/,
    )
  })
})

describe('migration 0002: reading tag and location', () => {
  it('leaves existing readings untagged and without a position', () => {
    insertReading('odometer_km', [3000])
    const row = db
      .prepare('select trigger_event, latitude, longitude from range_observations order by created_at limit 1')
      .get()
    expect(row).toEqual({ trigger_event: null, latitude: null, longitude: null })
  })

  it('stores a tagged reading with a position', () => {
    expect(() => insertReading('trigger_event, latitude, longitude', ['carplay_connect', 0, 0])).not.toThrow()
    expect(() => insertReading('trigger_event', ['carplay_disconnect'])).not.toThrow()
  })

  it.each([
    ['a position without a tag', 'latitude, longitude', [10, 20]],
    ['a latitude without a longitude', 'trigger_event, latitude', ['carplay_connect', 10]],
    ['a longitude without a latitude', 'trigger_event, longitude', ['carplay_connect', 10]],
    ['a latitude above 90', 'trigger_event, latitude, longitude', ['carplay_connect', 91, 0]],
    ['a longitude below -180', 'trigger_event, latitude, longitude', ['carplay_connect', 0, -181]],
    ['a malformed tag', 'trigger_event', ['Car Play']],
  ])('rejects %s', (_label, columns, values) => {
    expect(() => insertReading(columns, values)).toThrow(/CHECK constraint failed/)
  })
})
