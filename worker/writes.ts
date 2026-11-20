// The write endpoints: one POST per table the owner can enter data into. Each is bound
// to the Access subject exactly as the reads in dashboard.ts are, so the body can never
// choose user_id or id. The rules mirror the CHECK constraints in migrations/ through
// the validators in src/lib/data-model/validation.ts, which the entry forms share; the
// database stays the authority, and a CHECK it still raises answers 422 as well.
//
// There is deliberately no update or delete: a write here only ever adds a row.

import type { ChargerType, FeatureCategory } from '../src/lib/data-model/types'
import {
  validateChargingSession,
  validateRangeObservation,
  validateVehicle,
  validateVehicleFeature,
  type ValidationErrors,
} from '../src/lib/data-model/validation'
import type { D1Like } from './d1'
import { json } from './json'
import { TRIGGER_EVENTS } from './trigger-events'

const MAX_BODY_CHARACTERS = 16_384

const CHARGER_TYPES: readonly ChargerType[] = ['ac_home', 'ac_public', 'dc_fast']
const FEATURE_CATEGORIES: readonly FeatureCategory[] = [
  'battery',
  'charging',
  'performance',
  'dimensions',
  'safety',
  'driver_assistance',
  'infotainment',
  'comfort',
  'other',
]

// An instant must carry its offset; "2026-10-07T01:00" would otherwise mean the
// Worker's local time. It is stored as ISO 8601 UTC, as the migration expects.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

type Field =
  | { kind: 'text'; required?: boolean; trim?: boolean }
  | { kind: 'number'; required?: boolean }
  | { kind: 'boolean' }
  | { kind: 'timestamp'; required?: boolean }
  | { kind: 'date' }
  | { kind: 'enum'; values: readonly string[]; required?: boolean }

type Entity = {
  table: string
  // The row belongs to a vehicle, which must be the caller's.
  vehicleScoped: boolean
  fields: Record<string, Field>
  // Fields only the collector's ingest may set: a signed-in person's POST refuses them.
  ingestOnly?: readonly string[]
  validate: (input: never) => ValidationErrors<never>
  shape?: (row: Record<string, unknown>) => Record<string, unknown>
}

const vehicleId: Field = { kind: 'text', required: true }

export const ENTITIES = {
  vehicles: {
    table: 'vehicles',
    vehicleScoped: false,
    fields: {
      nickname: { kind: 'text', required: true, trim: true },
      vin: { kind: 'text' },
      model_year: { kind: 'number' },
      variant: { kind: 'text' },
      battery_capacity_kwh: { kind: 'number' },
      purchased_on: { kind: 'date' },
    },
    validate: validateVehicle,
  },
  'charging-sessions': {
    table: 'charging_sessions',
    vehicleScoped: true,
    fields: {
      vehicle_id: vehicleId,
      started_at: { kind: 'timestamp', required: true },
      ended_at: { kind: 'timestamp' },
      energy_kwh: { kind: 'number', required: true },
      cost_cents: { kind: 'number' },
      currency: { kind: 'text' },
      charger_type: { kind: 'enum', values: CHARGER_TYPES, required: true },
      location_name: { kind: 'text' },
      start_soc_pct: { kind: 'number' },
      end_soc_pct: { kind: 'number' },
      odometer_km: { kind: 'number' },
      notes: { kind: 'text' },
    },
    validate: validateChargingSession,
  },
  'range-observations': {
    table: 'range_observations',
    vehicleScoped: true,
    fields: {
      vehicle_id: vehicleId,
      observed_at: { kind: 'timestamp' },
      soc_pct: { kind: 'number', required: true },
      displayed_range_km: { kind: 'number', required: true },
      odometer_km: { kind: 'number' },
      outside_temp_c: { kind: 'number' },
      climate_on: { kind: 'boolean' },
      notes: { kind: 'text' },
      trigger_event: { kind: 'enum', values: TRIGGER_EVENTS },
      latitude: { kind: 'number' },
      longitude: { kind: 'number' },
    },
    ingestOnly: ['trigger_event', 'latitude', 'longitude'],
    validate: validateRangeObservation,
    // SQLite stores booleans as 0/1; the client gets booleans.
    shape: (row) => ({ ...row, climate_on: row.climate_on === null ? null : row.climate_on === 1 }),
  },
  'vehicle-features': {
    table: 'vehicle_features',
    vehicleScoped: true,
    fields: {
      vehicle_id: vehicleId,
      category: { kind: 'enum', values: FEATURE_CATEGORIES, required: true },
      name: { kind: 'text', required: true, trim: true },
      value: { kind: 'text', required: true, trim: true },
      unit: { kind: 'text' },
      manual_reference: { kind: 'text' },
      notes: { kind: 'text' },
    },
    validate: validateVehicleFeature,
  },
} as const satisfies Record<string, Entity>

export type EntityName = keyof typeof ENTITIES

export function isEntityName(name: string): name is EntityName {
  return Object.hasOwn(ENTITIES, name)
}

export type Fields = Record<string, string>

export function failed(fields: Fields): Response {
  return json({ error: 'validation_failed', fields }, 422)
}

// Type and presence only; whether a value is in range is the validators' job.
function parseField(field: Field, value: unknown): { value: unknown } | { error: string } {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' ? { value: field.trim ? value.trim() : value } : { error: 'Must be text' }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { value } : { error: 'Must be a number' }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { error: 'Must be true or false' }
    case 'timestamp':
      return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
        ? { value }
        : { error: 'Must be an ISO 8601 date and time with a time zone, e.g. 2026-10-07T01:00:00Z' }
    case 'date':
      return typeof value === 'string' ? { value } : { error: 'Must be a date, YYYY-MM-DD' }
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
        ? { value }
        : { error: `Must be one of: ${field.values.join(', ')}` }
  }
}

function parseBody(entity: Entity, body: Record<string, unknown>): { values: Record<string, unknown> } | { errors: Fields } {
  const errors: Fields = {}
  const values: Record<string, unknown> = {}

  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(entity.fields, key)) errors[key] = `${key} is not a field`
  }
  for (const [name, field] of Object.entries(entity.fields)) {
    const given = body[name]
    if (given === undefined || given === null) {
      if ('required' in field && field.required) errors[name] = 'Required'
      else if (given === null) values[name] = null
      continue
    }
    const parsed = parseField(field, given)
    if ('error' in parsed) errors[name] = parsed.error
    else values[name] = parsed.value
  }
  return Object.keys(errors).length > 0 ? { errors } : { values }
}

export async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return json({ error: 'unsupported_media_type' }, 415)

  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_BODY_CHARACTERS) return json({ error: 'payload_too_large' }, 413)
  const text = await request.text()
  if (text.length > MAX_BODY_CHARACTERS) return json({ error: 'payload_too_large' }, 413)

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'invalid_json' }, 400)
  return body as Record<string, unknown>
}

export function databaseFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/no such table/i.test(message)) return json({ error: 'schema_missing' }, 503)
  if (/UNIQUE constraint failed/i.test(message)) return json({ error: 'already_exists' }, 409)
  if (/FOREIGN KEY constraint failed/i.test(message)) return json({ error: 'vehicle_not_found' }, 404)
  if (/CHECK constraint failed/i.test(message)) return failed({})
  console.error('atto1: write failed', error)
  return json({ error: 'write_failed' }, 500)
}

// Everything the entity's rules need, before any write. `supplied` holds values the Worker
// sets itself (a vehicle id it looked up); a body that names one of them is refused, so a
// caller can never choose them.
export function validateRow(
  name: EntityName,
  input: Record<string, unknown>,
  supplied: Record<string, unknown> = {},
): { values: Record<string, unknown> } | { errors: Fields } {
  const entity: Entity = ENTITIES[name]

  const clashes = Object.keys(supplied).filter((key) => Object.hasOwn(input, key))
  if (clashes.length > 0) return { errors: Object.fromEntries(clashes.map((key) => [key, `${key} is not a field`])) }

  const parsed = parseBody(entity, { ...input, ...supplied })
  if ('errors' in parsed) return parsed
  const { values } = parsed

  const ruleErrors = entity.validate(values as never) as Fields
  if (Object.keys(ruleErrors).length > 0) return { errors: ruleErrors }

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    if (field.kind === 'timestamp' && typeof values[fieldName] === 'string') {
      values[fieldName] = new Date(values[fieldName]).toISOString()
    }
  }
  return { values }
}

// Adds one row for the user and returns it. `values` must have passed validateRow.
export async function insertRow(
  db: D1Like,
  userId: string,
  name: EntityName,
  values: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const entity: Entity = ENTITIES[name]
  const columns = ['user_id', ...Object.keys(values)]
  const bound = [userId, ...Object.values(values).map((value) => (typeof value === 'boolean' ? Number(value) : value))]
  // Table and column names come from the entity table above, never from the request.
  return db
    .prepare(
      `insert into ${entity.table} (${columns.join(', ')})
       values (${columns.map((_, index) => `?${index + 1}`).join(', ')}) returning *`,
    )
    .bind(...bound)
    .first<Record<string, unknown>>()
}

export async function createRecord(request: Request, db: D1Like, userId: string, name: EntityName): Promise<Response> {
  const entity: Entity = ENTITIES[name]

  const body = await readObject(request)
  if (body instanceof Response) return body

  const refused = Object.keys(body).filter((key) => (entity.ingestOnly ?? []).includes(key))
  if (refused.length > 0) return failed(Object.fromEntries(refused.map((key) => [key, `${key} is not a field`])))

  const validated = validateRow(name, body)
  if ('errors' in validated) return failed(validated.errors)
  const { values } = validated

  try {
    if (entity.vehicleScoped) {
      const vehicle = await db
        .prepare('select id from vehicles where id = ?1 and user_id = ?2')
        .bind(values.vehicle_id, userId)
        .first<{ id: string }>()
      if (vehicle === null) return json({ error: 'vehicle_not_found' }, 404)
    }

    const row = await insertRow(db, userId, name, values)
    return json(entity.shape && row ? entity.shape(row) : row, 201)
  } catch (error) {
    return databaseFailure(error)
  }
}
