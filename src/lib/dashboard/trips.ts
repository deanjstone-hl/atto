// Trips, worked out from the readings a CarPlay connect or disconnect triggered (atto/6).
// The collector tags such a reading with its event; a trip is a connect reading paired with
// the next disconnect reading. Pure: no I/O and no formatting.

import { isNoFix } from '../data-model/position'
import type { RangeObservation } from '../data-model/types'

export type Position = { latitude: number; longitude: number }

export type Trip = {
  // The connect reading's id.
  id: string
  startedAt: string
  // Null while the trip is in progress: a connect with no disconnect after it.
  endedAt: string | null
  inProgress: boolean
  durationMinutes: number | null
  distanceKm: number | null
  socUsedPct: number | null
  // State of charge used times the battery capacity; null without a capacity.
  energyKwh: number | null
  rangeUsedKm: number | null
  start: Position | null
  end: Position | null
}

const CONNECT = 'carplay_connect'
const DISCONNECT = 'carplay_disconnect'

// Rows stored before the collector dropped BYD's no-fix 0, 0 (atto/21) still hold it: unknown.
function position(row: RangeObservation): Position | null {
  if (row.latitude === null || row.longitude === null || isNoFix(row.latitude, row.longitude)) return null
  return { latitude: row.latitude, longitude: row.longitude }
}

// What a drive used is a fall in the car's own numbers. A rise (it was charged, or the
// range estimate moved) says nothing about use, so it is left out rather than shown negative.
function fall(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null
  const difference = from - to
  return difference >= 0 ? difference : null
}

function rise(from: number | null, to: number | null): number | null {
  return from === null || to === null ? null : fall(to, from)
}

function started(open: RangeObservation): Trip {
  return {
    id: open.id,
    startedAt: open.observed_at,
    endedAt: null,
    inProgress: true,
    durationMinutes: null,
    distanceKm: null,
    socUsedPct: null,
    energyKwh: null,
    rangeUsedKm: null,
    start: position(open),
    end: null,
  }
}

function finished(open: RangeObservation, close: RangeObservation, batteryKwh: number | null): Trip {
  const socUsedPct = fall(open.soc_pct, close.soc_pct)
  const minutes = (Date.parse(close.observed_at) - Date.parse(open.observed_at)) / 60_000
  return {
    ...started(open),
    endedAt: close.observed_at,
    inProgress: false,
    durationMinutes: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null,
    distanceKm: rise(open.odometer_km, close.odometer_km),
    socUsedPct,
    energyKwh: socUsedPct === null || batteryKwh === null ? null : Math.round((socUsedPct / 100) * batteryKwh * 100) / 100,
    rangeUsedKm: fall(open.displayed_range_km, close.displayed_range_km),
    end: position(close),
  }
}

export function buildTrips(readings: RangeObservation[], batteryKwh: number | null): Trip[] {
  const ordered = readings
    .filter((row) => row.trigger_event === CONNECT || row.trigger_event === DISCONNECT)
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))

  const trips: Trip[] = []
  let open: RangeObservation | null = null
  for (const row of ordered) {
    if (row.trigger_event === CONNECT) {
      // A connect while one is open means the earlier drive never saw its disconnect
      // (the phone was out of signal, or the shortcut did not run): it is dropped, and
      // this one starts the next trip.
      open = row
    } else if (open !== null) {
      trips.push(finished(open, row, batteryKwh))
      open = null
    }
  }
  if (open !== null) trips.push(started(open))
  return trips.reverse()
}
