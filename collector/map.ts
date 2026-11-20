// Turns what read-byd.py prints into what POST /api/ingest/byd accepts (ADR-006).
// Pure: no network, no clock except the one passed in.

import type { TriggerEvent } from '../worker/trigger-events.ts'

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
  // Set on a CarPlay-triggered reading only; the position never without the event.
  trigger_event?: TriggerEvent
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

// `event` is set only for a run a CarPlay connect or disconnect triggered: it tags the
// reading, and only then does the reading carry the car's position. A position the Worker
// would refuse (out of range) is dropped, so the reading and its tag still go through.
export function toObservation(reading: Reading, now: Date, event?: TriggerEvent): Observation | null {
  const { soc_pct, range_km, odometer_km } = reading
  if (soc_pct === null || range_km === null) return null
  const soc = Math.round(soc_pct)
  const range = Math.round(range_km)
  if (soc < 0 || soc > 100 || range < 0) return null

  const observation: Observation = {
    observed_at: new Date(reading.observed_at ?? now).toISOString(),
    soc_pct: soc,
    displayed_range_km: range,
  }
  if (odometer_km !== null && odometer_km >= 0) observation.odometer_km = Math.round(odometer_km)
  if (event !== undefined) {
    observation.trigger_event = event
    const { latitude, longitude } = reading
    if (latitude !== undefined && longitude !== undefined && isPosition(latitude, longitude)) {
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
