// Turns what read-byd.py prints into what POST /api/ingest/byd accepts (ADR-006).
// Pure: no network, no clock except the one passed in.

// What the reader prints, and all of it. It never carries location, door or tyre data.
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
}

export type Observation = {
  observed_at: string
  soc_pct: number
  displayed_range_km: number
  odometer_km?: number
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
  return { vin, model_name, online, observed_at, soc_pct, range_km, odometer_km, charge_state }
}

export function toObservation(reading: Reading, now: Date): Observation | null {
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
  return observation
}

export function toVehicle(reading: Reading, config: { nickname: string; batteryKwh: number | null }): VehicleInput {
  const vehicle: VehicleInput = { vin: reading.vin, nickname: config.nickname }
  if (config.batteryKwh !== null) vehicle.battery_capacity_kwh = config.batteryKwh
  return vehicle
}
