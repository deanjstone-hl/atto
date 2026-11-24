import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isEmptyReading, parseReading, toObservation, toVehicle, type Reading } from './map.ts'

const reading = (overrides: Partial<Reading> = {}): Reading => ({
  vin: 'LC0CE4CB5S0123456',
  model_name: 'ATTO 1',
  online: true,
  observed_at: '2026-11-07T01:00:00.000Z',
  soc_pct: 53,
  range_km: 164,
  odometer_km: 3447,
  charge_state: 15,
  ...overrides,
})

describe('parseReading', () => {
  it('accepts what the reader prints', () => {
    expect(parseReading(JSON.parse(JSON.stringify(reading())))).toEqual(reading())
  })

  it.each([
    ['not an object', 'x'],
    ['no VIN', { ...reading(), vin: '' }],
    ['a non-numeric charge', { ...reading(), soc_pct: '53' }],
    ['a missing field', { vin: 'LC0CE4CB5S0123456' }],
  ])('refuses %s', (_label, input) => {
    expect(() => parseReading(input)).toThrow(/reading/i)
  })

  it('does not keep fields the reader should never send', () => {
    const parsed = parseReading({ ...reading(), door_lock: 1, tyre_pressure: 2.5 })
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(reading()).sort())
  })

  // Only a CarPlay-triggered run asks the reader for the position (atto/6, ADR-006).
  it('keeps a position only when the reader printed both numbers', () => {
    expect(parseReading({ ...reading(), latitude: 1.5, longitude: -2.5 })).toMatchObject({ latitude: 1.5, longitude: -2.5 })
    expect(parseReading({ ...reading(), latitude: null, longitude: null })).not.toHaveProperty('latitude')
    expect(parseReading({ ...reading(), latitude: 1.5, longitude: null })).not.toHaveProperty('latitude')
    expect(parseReading(reading())).not.toHaveProperty('latitude')
  })

  it('refuses a mistyped position rather than guessing', () => {
    expect(() => parseReading({ ...reading(), latitude: '1.5', longitude: 2 })).toThrow(/reading/i)
  })
})

describe('isEmptyReading', () => {
  it('is true for a reading with no timestamp, or with charge, range and odometer all 0', () => {
    expect(isEmptyReading(reading({ observed_at: null }))).toBe(true)
    expect(isEmptyReading(reading({ soc_pct: 0, range_km: 0, odometer_km: 0 }))).toBe(true)
  })

  it('is false for a real reading, including one that simply lacks a range or odometer', () => {
    expect(isEmptyReading(reading())).toBe(false)
    expect(isEmptyReading(reading({ soc_pct: null }))).toBe(false)
    expect(isEmptyReading(reading({ soc_pct: 0, range_km: 0, odometer_km: null }))).toBe(false)
  })
})

describe('toObservation', () => {
  it('maps charge, range and odometer, and uses the car’s own timestamp', () => {
    expect(toObservation(reading())).toEqual({
      observed_at: '2026-11-07T01:00:00.000Z',
      soc_pct: 53,
      displayed_range_km: 164,
      odometer_km: 3447,
    })
  })

  it('rounds to whole numbers, as the table needs', () => {
    expect(toObservation(reading({ soc_pct: 52.6, range_km: 163.4, odometer_km: 3446.7 }))).toMatchObject({
      soc_pct: 53,
      displayed_range_km: 163,
      odometer_km: 3447,
    })
  })

  // atto/20: BYD answered a placeholder (no timestamp, 0% / 0 km / odometer 0) at the moment
  // the charger stopped. Posting it closed the open session and dropped a 15-hour charge.
  it('stores nothing when the car sent no timestamp: a reading without its own time is untrustworthy', () => {
    expect(toObservation(reading({ observed_at: null }))).toBeNull()
  })

  it('stores nothing for the empty placeholder reading (0%, 0 km, odometer 0, no timestamp)', () => {
    expect(
      toObservation(reading({ observed_at: null, soc_pct: 0, range_km: 0, odometer_km: 0, charge_state: 0 })),
    ).toBeNull()
  })

  it('stores nothing when charge, range and odometer are all 0, even with a timestamp', () => {
    expect(toObservation(reading({ soc_pct: 0, range_km: 0, odometer_km: 0 }))).toBeNull()
  })

  it('still stores a flat battery that has a range or an odometer', () => {
    expect(toObservation(reading({ soc_pct: 0, range_km: 0, odometer_km: 3447 }))).toMatchObject({
      soc_pct: 0,
      odometer_km: 3447,
    })
  })

  it('leaves the odometer out when the car did not send one', () => {
    expect(toObservation(reading({ odometer_km: null }))).not.toHaveProperty('odometer_km')
  })

  it.each([
    ['no charge', { soc_pct: null }],
    ['no range', { range_km: null }],
    ['a charge above 100', { soc_pct: 101 }],
    ['a negative range', { range_km: -1 }],
  ])('stores nothing for %s', (_label, overrides) => {
    expect(toObservation(reading(overrides))).toBeNull()
  })
})

describe('toObservation for a triggered run (atto/6)', () => {
  // 0.5, -0.5 is an obvious fake.
  const located = reading({ latitude: 0.5, longitude: -0.5 })

  it('tags the reading with the event and adds the position', () => {
    expect(toObservation(located, 'carplay_connect')).toEqual({
      observed_at: '2026-11-07T01:00:00.000Z',
      soc_pct: 53,
      displayed_range_km: 164,
      odometer_km: 3447,
      trigger_event: 'carplay_connect',
      latitude: 0.5,
      longitude: -0.5,
    })
  })

  it('tags a reading that has no position (the GPS read failed) and sends none', () => {
    const observation = toObservation(reading(), 'carplay_disconnect')
    expect(observation).toMatchObject({ trigger_event: 'carplay_disconnect' })
    expect(observation).not.toHaveProperty('latitude')
    expect(observation).not.toHaveProperty('longitude')
  })

  // atto/21: BYD answers 0, 0 when the car has no GPS fix. That is the placeholder, not a place
  // (null island is in the Gulf of Guinea), and it showed as "Start: 0.0000, 0.0000" on a trip.
  it('treats 0, 0 as no fix: it keeps the reading and its tag and sends no position', () => {
    const observation = toObservation(reading({ latitude: 0, longitude: 0 }), 'carplay_connect')
    expect(observation).toMatchObject({ trigger_event: 'carplay_connect', soc_pct: 53 })
    expect(observation).not.toHaveProperty('latitude')
    expect(observation).not.toHaveProperty('longitude')
  })

  it('still sends a position with one zero coordinate: the equator and the prime meridian are real places', () => {
    expect(toObservation(reading({ latitude: 0, longitude: 10 }), 'carplay_connect')).toMatchObject({ latitude: 0, longitude: 10 })
    expect(toObservation(reading({ latitude: 10, longitude: 0 }), 'carplay_connect')).toMatchObject({ latitude: 10, longitude: 0 })
  })

  it('never sends a position for a timer run, whatever the reading holds', () => {
    const observation = toObservation(located)
    expect(observation).not.toHaveProperty('trigger_event')
    expect(observation).not.toHaveProperty('latitude')
    expect(observation).not.toHaveProperty('longitude')
  })

  it.each([
    ['a latitude above 90', { latitude: 91, longitude: 0 }],
    ['a longitude below -180', { latitude: 0, longitude: -181 }],
  ])('drops %s, keeping the reading and its tag, instead of losing the whole poll to a 422', (_label, position) => {
    const observation = toObservation(reading(position), 'carplay_connect')
    expect(observation).toMatchObject({ trigger_event: 'carplay_connect', soc_pct: 53 })
    expect(observation).not.toHaveProperty('latitude')
  })
})

describe('toVehicle', () => {
  it('names the vehicle and sends the capacity only when it is configured', () => {
    expect(toVehicle(reading(), { nickname: 'ATTO 1', batteryKwh: 30 })).toEqual({
      vin: 'LC0CE4CB5S0123456',
      nickname: 'ATTO 1',
      battery_capacity_kwh: 30,
    })
    expect(toVehicle(reading(), { nickname: 'ATTO 1', batteryKwh: null })).toEqual({
      vin: 'LC0CE4CB5S0123456',
      nickname: 'ATTO 1',
    })
  })
})

describe('the reader fixtures', () => {
  // Shaped like read-byd.py's output for a parked car
  // (53 %, 164 km, 3,447 km) with a made-up VIN; the charging one is invented, because no
  // charge has been read live yet.
  const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))

  it('parse and map', () => {
    const parked = parseReading(fixture('reading-parked.json'))
    expect(toObservation(parked)).toEqual({
      observed_at: '2026-10-21T07:15:00.000Z',
      soc_pct: 53,
      displayed_range_km: 164,
      odometer_km: 3447,
    })
    expect(parseReading(fixture('reading-charging.json')).charge_state).toBe(1)
  })

  it('carry no coordinates', () => {
    for (const name of ['reading-parked.json', 'reading-charging.json']) {
      expect(JSON.stringify(fixture(name))).not.toMatch(/lat|lon/i)
    }
  })
})
