// Turns what read-byd.py prints into what POST /api/ingest/byd accepts (ADR-006).
// Pure: no network, no clock except the one passed in.

import { isNoFix } from '../src/lib/data-model/position.ts'
import { isTriggerEvent, type ReadingEvent } from '../worker/trigger-events.ts'

// What the reader prints, and all of it. It never carries door or tyre data, and it carries
// the position only when it was run with --with-location, which only a CarPlay-triggered
// run does (atto/6, ADR-006).
export type Reading = {
  vin: string
  model_name: string | null
  online: boolean
  // The car's own timestamp for the reading, ISO 8601 UTC.
  observed_at: string | null
  soc_pct: number | null
  range_km: number | null
  odometer_km: number | null
  // pybyd's ChargingState as sent: 1 charging, 0 not, 15 "connected" (unreliable), null unknown.
  charge_state: number | null
  // Present only when the reader was asked for the position and got one.
  latitude?: number
  longitude?: number
}

export type Observation = {
  observed_at: string
  soc_pct: number
  displayed_range_km: number
  odometer_km?: number
  // Set on a CarPlay-triggered or charge-triggered reading only; the position never without
  // the event, and only with a CarPlay one.
  trigger_event?: ReadingEvent
  latitude?: number
  longitude?: number
}

export type VehicleInput = { vin: string; nickname: string; battery_capacity_kwh?: number }

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value))
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function parseReading(input: unknown): Reading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('reading is not an object')
  }
  const raw = input as Record<string, unknown>
  const { vin, model_name, online, observed_at, soc_pct, range_km, odometer_km, charge_state } = raw
  if (typeof vin !== 'string' || vin === '') throw new Error('reading has no VIN')
  if (
    !isStringOrNull(model_name) ||
    typeof online !== 'boolean' ||
    !isStringOrNull(observed_at) ||
    !isNumberOrNull(soc_pct) ||
    !isNumberOrNull(range_km) ||
    !isNumberOrNull(odometer_km) ||
    !isNumberOrNull(charge_state)
  ) {
    throw new Error('reading has a missing or mistyped field')
  }
  const { latitude, longitude } = raw
  if (!isNumberOrNull(latitude ?? null) || !isNumberOrNull(longitude ?? null)) {
    throw new Error('reading has a missing or mistyped field')
  }
  const parsed: Reading = { vin, model_name, online, observed_at, soc_pct, range_km, odometer_km, charge_state }
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    parsed.latitude = latitude
    parsed.longitude = longitude
  }
  return parsed
}

const isPosition = (latitude: number, longitude: number) =>
  latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180

// BYD answers a placeholder realtime when the car's data is not ready (24 Nov 2026, atto/20: no
// timestamp, 0% / 0 km / odometer 0, at the moment the charger stopped). A reading with no
// timestamp of its own, or with charge, range and odometer all 0, is that placeholder, not the
// car; it is never recorded, and never closes or opens a session. Only an all-zero reading
// counts: a flat battery still has an odometer.
export const isEmptyReading = (reading: Reading): boolean =>
  reading.observed_at === null ||
  (reading.soc_pct === 0 && reading.range_km === 0 && reading.odometer_km === 0)

// `event` is set only for a run something triggered: it tags the reading. Only a CarPlay
// connect or disconnect also gives it the car's position (a charge run never reads one, atto/8).
// A position the Worker would refuse (out of range) or that is BYD's no-fix 0, 0 (atto/21) is
// dropped, so the reading and its tag still go through.
export function toObservation(reading: Reading, event?: ReadingEvent): Observation | null {
  const { soc_pct, range_km, odometer_km } = reading
  if (isEmptyReading(reading) || soc_pct === null || range_km === null || reading.observed_at === null) return null
  const soc = Math.round(soc_pct)
  const range = Math.round(range_km)
  if (soc < 0 || soc > 100 || range < 0) return null

  const observation: Observation = {
    observed_at: new Date(reading.observed_at).toISOString(),
    soc_pct: soc,
    displayed_range_km: range,
  }
  if (odometer_km !== null && odometer_km >= 0) observation.odometer_km = Math.round(odometer_km)
  if (event !== undefined) {
    observation.trigger_event = event
    const { latitude, longitude } = reading
    if (
      isTriggerEvent(event) &&
      latitude !== undefined &&
      longitude !== undefined &&
      isPosition(latitude, longitude) &&
      !isNoFix(latitude, longitude)
    ) {
      observation.latitude = latitude
      observation.longitude = longitude
    }
  }
  return observation
}

export function toVehicle(reading: Reading, config: { nickname: string; batteryKwh: number | null }): VehicleInput {
  const vehicle: VehicleInput = { vin: reading.vin, nickname: config.nickname }
  if (config.batteryKwh !== null) vehicle.battery_capacity_kwh = config.batteryKwh
  return vehicle
}
