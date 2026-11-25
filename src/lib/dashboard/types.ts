// What GET /api/dashboard returns. The Worker builds it (worker/dashboard.ts) and the
// client reads it (src/lib/api.ts); this file is the one definition both import.

import type { ChargeProgress, ChargingSession, RangeObservation, Vehicle, VehicleFeature } from '../data-model/types'

export const RECENT_SESSION_LIMIT = 5
export const RANGE_OBSERVATION_LIMIT = 60
// The readings a CarPlay trigger tagged, which the trips view pairs into trips (atto/6).
export const TRIP_READING_LIMIT = 200

export type DashboardData = {
  vehicle: Vehicle | null
  sessions: ChargingSession[]
  observations: RangeObservation[]
  features: VehicleFeature[]
  tripReadings: RangeObservation[]
  // The newest poll of a charge still going, or null (atto/19). Only the vehicle's latest charge
  // while the latest reading is still that poll; never a finished one.
  chargeInProgress: ChargeProgress | null
}

export type DashboardResult =
  | { kind: 'ready'; data: DashboardData }
  // The tables do not exist yet: the D1 migration has not been applied.
  | { kind: 'schema-missing' }
