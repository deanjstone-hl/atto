// Hand-maintained mirror of migrations/ (the D1 schema, ADR-005). It stays
// hand-written: the schema is small, and SQLite's loose column types (0/1 booleans,
// JSON-text tags, text timestamps) are mapped to the shapes below by the Worker, so a
// generator's output would not match what the client receives. Change the migration,
// this file and validation.ts together.
//
// Units: km, kWh, integer cents + ISO 4217 currency, degrees Celsius,
// state of charge as 0-100. Timestamps are ISO 8601 UTC strings; dates are
// `YYYY-MM-DD`. `user_id` is the Cloudflare Access subject; the Worker sets it,
// so no insert type carries it.

export type ChargerType = 'ac_home' | 'ac_public' | 'dc_fast'

export type FeatureCategory =
  | 'battery'
  | 'charging'
  | 'performance'
  | 'dimensions'
  | 'safety'
  | 'driver_assistance'
  | 'infotainment'
  | 'comfort'
  | 'other'

export type MaintenanceCategory =
  | 'scheduled_service'
  | 'tyres'
  | 'repair'
  | 'recall'
  | 'inspection'
  | 'software_update'
  | 'other'

type Timestamps = {
  created_at: string
  updated_at: string
}

type Owned = {
  id: string
  user_id: string
}

export type Vehicle = Owned &
  Timestamps & {
    nickname: string
    vin: string | null
    model_year: number | null
    variant: string | null
    battery_capacity_kwh: number | null
    purchased_on: string | null
  }

export type ChargingSession = Owned &
  Timestamps & {
    vehicle_id: string
    started_at: string
    ended_at: string | null
    energy_kwh: number
    cost_cents: number | null
    currency: string
    charger_type: ChargerType
    location_name: string | null
    start_soc_pct: number | null
    end_soc_pct: number | null
    odometer_km: number | null
    notes: string | null
  }

export type RangeObservation = Owned &
  Timestamps & {
    vehicle_id: string
    observed_at: string
    soc_pct: number
    displayed_range_km: number
    odometer_km: number | null
    outside_temp_c: number | null
    climate_on: boolean | null
    notes: string | null
    // The event this reading was taken for (`carplay_connect`, `carplay_disconnect`); null
    // for a timer reading. Set by the collector only (atto/6).
    trigger_event: string | null
    // The car's position, on a reading that carries a trigger_event and no other (ADR-006).
    latitude: number | null
    longitude: number | null
  }

// One collector poll of the charge still going, insert-only (migration 0003, atto/19). There
// is no updated_at: a row is never changed. The dashboard reads the newest one.
export type ChargeProgress = Owned & {
  vehicle_id: string
  started_at: string
  observed_at: string
  start_soc_pct: number
  soc_pct: number
  // Null when the collector has no battery capacity to work energy out from.
  energy_kwh: number | null
  created_at: string
}

export type VehicleFeature = Owned &
  Timestamps & {
    vehicle_id: string
    category: FeatureCategory
    name: string
    value: string
    unit: string | null
    manual_reference: string | null
    notes: string | null
  }

export type MaintenanceRecord = Owned &
  Timestamps & {
    vehicle_id: string
    performed_on: string
    category: MaintenanceCategory
    title: string
    description: string | null
    provider: string | null
    odometer_km: number | null
    cost_cents: number | null
    currency: string
    next_due_on: string | null
    next_due_km: number | null
  }

export type Note = Owned &
  Timestamps & {
    vehicle_id: string | null
    title: string
    body: string
    tags: string[]
    pinned: boolean
  }

// Columns with a database default, or nullable, are optional on insert. `id`,
// `user_id` and the timestamps are never sent: the database or the Worker sets them.
type Optional<Row, Keys extends keyof Row> = Omit<Row, Keys> & Partial<Pick<Row, Keys>>

type NullableKeys<Row> = {
  [Key in keyof Row]-?: null extends Row[Key] ? Key : never
}[keyof Row]

type InsertOf<Row, Extra extends keyof Row = never> = Optional<
  Omit<Row, keyof Owned | keyof Timestamps>,
  Extract<Exclude<keyof Row, keyof Owned | keyof Timestamps>, NullableKeys<Row> | Extra>
>

export type VehicleInsert = InsertOf<Vehicle>
export type ChargingSessionInsert = InsertOf<ChargingSession, 'currency'>
export type RangeObservationInsert = InsertOf<RangeObservation, 'observed_at'>
export type ChargeProgressInsert = InsertOf<ChargeProgress>
export type VehicleFeatureInsert = InsertOf<VehicleFeature>
export type MaintenanceRecordInsert = InsertOf<MaintenanceRecord, 'currency'>
export type NoteInsert = InsertOf<Note, 'body' | 'tags' | 'pinned'>
