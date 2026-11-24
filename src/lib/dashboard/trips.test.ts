import { describe, expect, it } from 'vitest'
import type { RangeObservation } from '../data-model/types'
import { fixtureTripReadings } from './fixtures'
import { buildTrips } from './trips'

// Trips are worked out from the readings a CarPlay connect or disconnect triggered
// (atto/6): each connect is paired with the next disconnect. Fake coordinates only.

let counter = 0
function reading(
  event: 'carplay_connect' | 'carplay_disconnect' | 'charge_start',
  observedAt: string,
  overrides: Partial<RangeObservation> = {},
): RangeObservation {
  counter += 1
  return {
    id: `reading-${counter}`,
    user_id: 'owner',
    created_at: observedAt,
    updated_at: observedAt,
    vehicle_id: 'vehicle',
    observed_at: observedAt,
    soc_pct: 80,
    displayed_range_km: 240,
    odometer_km: 5000,
    outside_temp_c: null,
    climate_on: null,
    notes: null,
    trigger_event: event,
    latitude: null,
    longitude: null,
    ...overrides,
  }
}

const connect = (at: string, overrides: Partial<RangeObservation> = {}) => reading('carplay_connect', at, overrides)
const disconnect = (at: string, overrides: Partial<RangeObservation> = {}) =>
  reading('carplay_disconnect', at, overrides)

describe('buildTrips', () => {
  it('pairs a connect with the next disconnect and works out what the drive used', () => {
    const [trip] = buildTrips(
      [
        connect('2026-11-01T01:00:00Z', { soc_pct: 80, displayed_range_km: 240, odometer_km: 5000, latitude: 0.25, longitude: 0.25 }),
        disconnect('2026-11-01T01:45:00Z', { soc_pct: 74, displayed_range_km: 222, odometer_km: 5031, latitude: 0.5, longitude: -0.5 }),
      ],
      30,
    )
    expect(trip).toEqual({
      id: expect.any(String),
      startedAt: '2026-11-01T01:00:00Z',
      endedAt: '2026-11-01T01:45:00Z',
      inProgress: false,
      durationMinutes: 45,
      distanceKm: 31,
      socUsedPct: 6,
      energyKwh: 1.8,
      rangeUsedKm: 18,
      start: { latitude: 0.25, longitude: 0.25 },
      end: { latitude: 0.5, longitude: -0.5 },
    })
  })

  it('does not rely on the input order, and lists the newest trip first', () => {
    const rows = [
      disconnect('2026-11-02T02:00:00Z'),
      connect('2026-11-01T01:00:00Z'),
      connect('2026-11-02T01:00:00Z'),
      disconnect('2026-11-01T02:00:00Z'),
    ]
    expect(buildTrips(rows, null).map((trip) => trip.startedAt)).toEqual(['2026-11-02T01:00:00Z', '2026-11-01T01:00:00Z'])
    expect(buildTrips([...rows].reverse(), null)).toEqual(buildTrips(rows, null))
  })

  it('shows a connect with no disconnect yet as in progress, with nothing used so far', () => {
    const [trip] = buildTrips([connect('2026-11-01T01:00:00Z', { latitude: 1, longitude: 2 })], 30)
    expect(trip).toMatchObject({
      inProgress: true,
      endedAt: null,
      durationMinutes: null,
      distanceKm: null,
      socUsedPct: null,
      energyKwh: null,
      rangeUsedKm: null,
      start: { latitude: 1, longitude: 2 },
      end: null,
    })
  })

  it('skips a disconnect that has no connect before it', () => {
    expect(buildTrips([disconnect('2026-11-01T01:00:00Z')], 30)).toEqual([])
    const trips = buildTrips(
      [disconnect('2026-11-01T01:00:00Z'), connect('2026-11-01T02:00:00Z'), disconnect('2026-11-01T03:00:00Z')],
      30,
    )
    expect(trips).toHaveLength(1)
    expect(trips[0].startedAt).toBe('2026-11-01T02:00:00Z')
  })

  it('treats a second connect as the start of the drive: the first never saw its disconnect', () => {
    const trips = buildTrips(
      [connect('2026-11-01T01:00:00Z'), connect('2026-11-01T02:00:00Z'), disconnect('2026-11-01T03:00:00Z')],
      30,
    )
    expect(trips.map((trip) => [trip.startedAt, trip.endedAt])).toEqual([['2026-11-01T02:00:00Z', '2026-11-01T03:00:00Z']])
  })

  it('leaves out what it cannot work out: no odometer, no battery capacity, no position', () => {
    const [trip] = buildTrips(
      [connect('2026-11-01T01:00:00Z', { odometer_km: null }), disconnect('2026-11-01T02:00:00Z', { odometer_km: 5040 })],
      null,
    )
    expect(trip).toMatchObject({ distanceKm: null, energyKwh: null, socUsedPct: 0, rangeUsedKm: 0, start: null, end: null })
  })

  it('reports nothing used rather than a negative amount when the car gained charge or range', () => {
    const [trip] = buildTrips(
      [
        connect('2026-11-01T01:00:00Z', { soc_pct: 60, displayed_range_km: 150, odometer_km: 5000 }),
        disconnect('2026-11-01T02:00:00Z', { soc_pct: 65, displayed_range_km: 160, odometer_km: 4990 }),
      ],
      30,
    )
    expect(trip).toMatchObject({ distanceKm: null, socUsedPct: null, energyKwh: null, rangeUsedKm: null })
  })

  it('ignores a reading carrying any other tag: a charge event is not a trip', () => {
    expect(buildTrips([reading('charge_start', '2026-11-01T01:00:00Z')], 30)).toEqual([])
    const trips = buildTrips(
      [connect('2026-11-01T01:00:00Z'), reading('charge_start', '2026-11-01T01:30:00Z'), disconnect('2026-11-01T02:00:00Z')],
      30,
    )
    expect(trips).toHaveLength(1)
    expect(trips[0].durationMinutes).toBe(60)
  })

  it('keeps a position that is missing on one end without inventing the other', () => {
    const [trip] = buildTrips(
      [connect('2026-11-01T01:00:00Z', { latitude: 3, longitude: 4 }), disconnect('2026-11-01T02:00:00Z')],
      30,
    )
    expect(trip.start).toEqual({ latitude: 3, longitude: 4 })
    expect(trip.end).toBeNull()
  })

  // atto/21: rows stored before the collector dropped BYD's no-fix 0, 0 still hold it.
  it('reads a stored 0, 0 as an unknown position, not a place', () => {
    const [trip] = buildTrips(
      [
        connect('2026-11-01T01:00:00Z', { latitude: 0, longitude: 0 }),
        disconnect('2026-11-01T02:00:00Z', { latitude: 0, longitude: 0 }),
      ],
      30,
    )
    expect(trip.start).toBeNull()
    expect(trip.end).toBeNull()
  })

  it('keeps a position with only one zero coordinate', () => {
    const [trip] = buildTrips([connect('2026-11-01T01:00:00Z', { latitude: 0, longitude: 4 })], 30)
    expect(trip.start).toEqual({ latitude: 0, longitude: 4 })
  })

  it('builds the fixture trips: one finished, one in progress', () => {
    const trips = buildTrips(fixtureTripReadings, 30)
    expect(trips.map((trip) => trip.inProgress)).toEqual([true, false])
    expect(trips[1]).toMatchObject({ distanceKm: 26, socUsedPct: 8, durationMinutes: 40 })
  })

  it('returns no trips for no readings', () => {
    expect(buildTrips([], 30)).toEqual([])
  })
})
