// The ingest endpoint (ADR-006): `POST /api/ingest/byd`, the one path the named Access
// service token may call. The collector (collector/) posts what it read from the BYD
// cloud: the vehicle, one reading and, when a charge has just ended, that session.
//
// Insert-only, like every other write: the vehicle is found by (user_id, VIN), or is the
// owner's only vehicle when that has no VIN yet (which then gets the VIN, and nothing else),
// and is made if missing (an existing one is otherwise never changed); a reading or session already stored is reported as a duplicate, not
// stored again, so a retry after a lost response is safe.
// Everything is validated before anything is written, so a bad body leaves no vehicle.
// Every row belongs to the Access subject the Worker was configured with, never to a
// value in the body.

import { databaseFailure, failed, insertRow, readObject, validateRow, type Fields } from './writes'
import type { D1Like } from './d1'
import { json } from './json'

const TOP_LEVEL = ['vehicle', 'observation', 'charging_session']
// A stand-in for the vehicle id, which is only known once the vehicle exists.
const PENDING_VEHICLE_ID = 'pending'

type Part = 'created' | 'duplicate' | 'none'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function prefixed(prefix: string, errors: Fields): Fields {
  return Object.fromEntries(Object.entries(errors).map(([key, message]) => [`${prefix}.${key}`, message]))
}

// The vehicle a reading belongs to: the one carrying this VIN, else the owner's only
// vehicle when it has no VIN (a car added by hand before the collector ran), else none.
// Without the second rule every reading lands on a new row beside the hand-made vehicle
// and the dashboard never shows it (atto/5). Claiming a missing VIN is the one change
// ingest makes to an existing row: it fills the VIN of that vehicle and nothing else, never
// the nickname or any other field the owner set, so later readings match by VIN. Two or
// more vehicles, or one with another VIN, is not something to guess at, so a new vehicle
// is made as before.
async function findVehicle(db: D1Like, ownerId: string, vin: string): Promise<{ id: string } | null> {
  const byVin = await db
    .prepare('select id from vehicles where user_id = ?1 and vin = ?2')
    .bind(ownerId, vin)
    .first<{ id: string }>()
  if (byVin) return byVin
  const { results } = await db
    .prepare('select id, vin from vehicles where user_id = ?1 limit 2')
    .bind(ownerId)
    .all<{ id: string; vin: string | null }>()
  const [only] = results
  if (results.length !== 1 || only.vin !== null) return null
  await db
    .prepare('update vehicles set vin = ?3 where user_id = ?1 and id = ?2 and vin is null')
    .bind(ownerId, only.id, vin)
    .all()
  return { id: only.id }
}

export async function ingestByd(request: Request, db: D1Like, ownerId: string): Promise<Response> {
  const body = await readObject(request)
  if (body instanceof Response) return body

  const errors: Fields = {}
  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL.includes(key)) errors[key] = `${key} is not a field`
  }

  const vehicleInput = body.vehicle
  const vehicle = isObject(vehicleInput)
    ? validateRow('vehicles', vehicleInput)
    : { errors: { vehicle: 'Required' } as Fields }
  if ('errors' in vehicle) Object.assign(errors, prefixed('vehicle', vehicle.errors))
  else if (typeof vehicle.values.vin !== 'string') errors['vehicle.vin'] = 'Required'

  const checked = (key: 'observation' | 'charging_session', entity: 'range-observations' | 'charging-sessions') => {
    const input = body[key]
    if (input === undefined) return null
    if (!isObject(input)) {
      errors[key] = 'Must be an object'
      return null
    }
    const result = validateRow(entity, input, { vehicle_id: PENDING_VEHICLE_ID })
    if ('errors' in result) {
      Object.assign(errors, prefixed(key, result.errors))
      return null
    }
    return result.values
  }
  const observation = checked('observation', 'range-observations')
  const chargingSession = checked('charging_session', 'charging-sessions')
  if (body.observation === undefined && body.charging_session === undefined) {
    errors.observation = 'Send an observation, a charging_session or both'
  }
  // A placeholder reading (atto/20): 0% and 0 km with an odometer of 0 or none is not the car.
  if (
    observation !== null &&
    observation.soc_pct === 0 &&
    observation.displayed_range_km === 0 &&
    (observation.odometer_km === undefined || observation.odometer_km === null || observation.odometer_km === 0)
  ) {
    errors.observation = 'Refused: 0% charge, 0 km range and no odometer is an empty reading, not the car'
  }

  if (Object.keys(errors).length > 0 || 'errors' in vehicle) return failed(errors)

  try {
    let vehicleId: string
    const existing = await findVehicle(db, ownerId, vehicle.values.vin as string)
    if (existing) vehicleId = existing.id
    else {
      const created = await insertRow(db, ownerId, 'vehicles', vehicle.values)
      vehicleId = String(created?.id)
    }

    // An odometer never goes down: a lower one is a client mistake, and stored it would make the
    // trips and the dashboard wrong. Only checked against a vehicle that already exists.
    if (existing && typeof observation?.odometer_km === 'number') {
      const highest = await db
        .prepare('select max(odometer_km) as highest from range_observations where user_id = ?1 and vehicle_id = ?2')
        .bind(ownerId, vehicleId)
        .first<{ highest: number | null }>()
      if (highest?.highest != null && observation.odometer_km < highest.highest) {
        return failed({
          'observation.odometer_km': `Lower than the highest odometer stored for this vehicle (${highest.highest} km)`,
        })
      }
    }

    const store = async (
      values: Record<string, unknown> | null,
      entity: 'range-observations' | 'charging-sessions',
      table: string,
      timeColumn: string,
    ): Promise<Part> => {
      if (values === null) return 'none'
      const stored = await db
        .prepare(`select id from ${table} where user_id = ?1 and vehicle_id = ?2 and ${timeColumn} = ?3`)
        .bind(ownerId, vehicleId, values[timeColumn])
        .first()
      if (stored) return 'duplicate'
      await insertRow(db, ownerId, entity, { ...values, vehicle_id: vehicleId })
      return 'created'
    }

    const observationResult = await store(observation, 'range-observations', 'range_observations', 'observed_at')
    const sessionResult = await store(chargingSession, 'charging-sessions', 'charging_sessions', 'started_at')
    const created = observationResult === 'created' || sessionResult === 'created'
    return json(
      { vehicle_id: vehicleId, observation: observationResult, charging_session: sessionResult },
      created || !existing ? 201 : 200,
    )
  } catch (error) {
    return databaseFailure(error)
  }
}
