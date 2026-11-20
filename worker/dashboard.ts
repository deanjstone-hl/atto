// Reads everything the dashboard shows for one vehicle, as SQL scoped to one user.
// Every query binds user_id: that is the authorisation, the Worker-level replacement
// for the row-level security the Supabase design relied on (ADR-005).

import type { ChargingSession, RangeObservation, Vehicle, VehicleFeature } from '../src/lib/data-model/types'
import {
  RANGE_OBSERVATION_LIMIT,
  RECENT_SESSION_LIMIT,
  TRIP_READING_LIMIT,
  type DashboardResult,
} from '../src/lib/dashboard/types'
import type { D1Like } from './d1'

export class DashboardLoadError extends Error {
  constructor(table: string, cause: unknown) {
    super(`${table}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'DashboardLoadError'
  }
}

// D1 reports an unapplied migration as "no such table: vehicles".
const MISSING_TABLE = /no such table/i

class SchemaMissing extends Error {}

async function rows<Row>(table: string, run: () => Promise<{ results: Row[] }>): Promise<Row[]> {
  try {
    return (await run()).results
  } catch (error) {
    if (error instanceof Error && MISSING_TABLE.test(error.message)) throw new SchemaMissing(table)
    throw new DashboardLoadError(table, error)
  }
}

type ObservationRow = Omit<RangeObservation, 'climate_on'> & { climate_on: number | null }

// SQLite stores booleans as 0/1; the client gets booleans.
function observation(row: ObservationRow): RangeObservation {
  return { ...row, climate_on: row.climate_on === null ? null : row.climate_on === 1 }
}

export async function loadDashboard(db: D1Like, userId: string): Promise<DashboardResult> {
  try {
    const [vehicle] = await rows<Vehicle>('vehicles', () =>
      db
        .prepare(
          // The vehicle with the latest reading, so live data is never hidden behind a
          // second row (atto/5); with no readings anywhere, the oldest.
          `select * from vehicles v where user_id = ?1
           order by (select max(observed_at) from range_observations r
                     where r.vehicle_id = v.id and r.user_id = v.user_id) desc nulls last,
                    created_at asc
           limit 1`,
        )
        .bind(userId)
        .all<Vehicle>(),
    )
    if (vehicle === undefined) {
      return { kind: 'ready', data: { vehicle: null, sessions: [], observations: [], features: [], tripReadings: [] } }
    }

    const [sessions, observations, features, tripReadings] = await Promise.all([
      rows<ChargingSession>('charging_sessions', () =>
        db
          .prepare(
            `select * from charging_sessions where user_id = ?1 and vehicle_id = ?2
             order by started_at desc limit ?3`,
          )
          .bind(userId, vehicle.id, RECENT_SESSION_LIMIT)
          .all<ChargingSession>(),
      ),
      rows<ObservationRow>('range_observations', () =>
        db
          .prepare(
            `select * from range_observations where user_id = ?1 and vehicle_id = ?2
             order by observed_at desc limit ?3`,
          )
          .bind(userId, vehicle.id, RANGE_OBSERVATION_LIMIT)
          .all<ObservationRow>(),
      ),
      rows<VehicleFeature>('vehicle_features', () =>
        db
          .prepare(
            `select * from vehicle_features where user_id = ?1 and vehicle_id = ?2
             order by category asc, name asc`,
          )
          .bind(userId, vehicle.id)
          .all<VehicleFeature>(),
      ),
      rows<ObservationRow>('range_observations', () =>
        db
          .prepare(
            `select * from range_observations
             where user_id = ?1 and vehicle_id = ?2 and trigger_event is not null
             order by observed_at desc limit ?3`,
          )
          .bind(userId, vehicle.id, TRIP_READING_LIMIT)
          .all<ObservationRow>(),
      ),
    ])

    return {
      kind: 'ready',
      data: {
        vehicle,
        sessions,
        observations: observations.map(observation),
        features,
        tripReadings: tripReadings.map(observation),
      },
    }
  } catch (error) {
    if (error instanceof SchemaMissing) return { kind: 'schema-missing' }
    throw error
  }
}
