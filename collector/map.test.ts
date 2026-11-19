import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReading, toObservation, toVehicle, type Reading } from './map.ts'

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
    const parsed = parseReading({ ...reading(), latitude: -33.8, longitude: 151.2 })
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(reading()).sort())
  })
})

describe('toObservation', () => {
  const now = new Date('2026-11-07T02:00:00Z')

  it('maps charge, range and odometer, and uses the car’s own timestamp', () => {
    expect(toObservation(reading(), now)).toEqual({
      observed_at: '2026-11-07T01:00:00.000Z',
      soc_pct: 53,
      displayed_range_km: 164,
      odometer_km: 3447,
    })
  })

  it('rounds to whole numbers, as the table needs', () => {
    expect(toObservation(reading({ soc_pct: 52.6, range_km: 163.4, odometer_km: 3446.7 }), now)).toMatchObject({
      soc_pct: 53,
      displayed_range_km: 163,
      odometer_km: 3447,
    })
  })

  it('falls back to the collector clock when the car sent no timestamp', () => {
    expect(toObservation(reading({ observed_at: null }), now)?.observed_at).toBe('2026-11-07T02:00:00.000Z')
  })

  it('leaves the odometer out when the car did not send one', () => {
    expect(toObservation(reading({ odometer_km: null }), now)).not.toHaveProperty('odometer_km')
  })

  it.each([
    ['no charge', { soc_pct: null }],
    ['no range', { range_km: null }],
    ['a charge above 100', { soc_pct: 101 }],
    ['a negative range', { range_km: -1 }],
  ])('stores nothing for %s', (_label, overrides) => {
    expect(toObservation(reading(overrides), now)).toBeNull()
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
    expect(toObservation(parked, new Date())).toEqual({
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
