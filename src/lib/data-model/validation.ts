// Client-side mirrors of the CHECK constraints in migrations/ (D1), so
// forms can report problems before a round trip. The database stays the
// authority; keep both in step when either changes.

import type {
  ChargingSessionInsert,
  MaintenanceRecordInsert,
  NoteInsert,
  RangeObservationInsert,
  VehicleFeatureInsert,
  VehicleInsert,
} from './types'

export type ValidationErrors<T> = Partial<Record<keyof T, string>>

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isValid<T>(errors: ValidationErrors<T>): boolean {
  return Object.keys(errors).length === 0
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ''
}

function textLengthError(value: string, label: string, max: number): string | undefined {
  if (value.trim() === '') return `${label} is required`
  if (value.trim().length > max) return `${label} must be at most ${max} characters`
  return undefined
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

// The round trip matters: Date.parse rolls 2025-02-30 over to March, where SQLite's
// date() check rejects it.
function isDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function isPercentage(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100
}

type Optional<T> = T | null | undefined

function isPresent<T>(value: Optional<T>): value is T {
  return value !== null && value !== undefined
}

export function validateVehicle(input: VehicleInsert): ValidationErrors<VehicleInsert> {
  const errors: ValidationErrors<VehicleInsert> = {}
  const nicknameError = textLengthError(input.nickname, 'Nickname', 80)
  if (nicknameError) errors.nickname = nicknameError
  if (isPresent(input.vin) && !VIN_PATTERN.test(input.vin)) {
    errors.vin = 'VIN must be 17 characters, A-Z and 0-9, excluding I, O and Q'
  }
  if (
    isPresent(input.model_year) &&
    !(Number.isInteger(input.model_year) && input.model_year >= 2020 && input.model_year <= 2100)
  ) {
    errors.model_year = 'Model year must be between 2020 and 2100'
  }
  if (isPresent(input.variant) && input.variant.length > 80) {
    errors.variant = 'Variant must be at most 80 characters'
  }
  if (isPresent(input.battery_capacity_kwh) && !(input.battery_capacity_kwh > 0)) {
    errors.battery_capacity_kwh = 'Battery capacity must be greater than 0 kWh'
  }
  if (isPresent(input.purchased_on) && !isDate(input.purchased_on)) {
    errors.purchased_on = 'Purchase date must be YYYY-MM-DD'
  }
  return errors
}

export function validateChargingSession(
  input: ChargingSessionInsert,
): ValidationErrors<ChargingSessionInsert> {
  const errors: ValidationErrors<ChargingSessionInsert> = {}
  const startValid = isTimestamp(input.started_at)
  if (!startValid) errors.started_at = 'Start time is not a valid date/time'
  if (isPresent(input.ended_at)) {
    if (!isTimestamp(input.ended_at)) {
      errors.ended_at = 'End time is not a valid date/time'
    } else if (startValid && Date.parse(input.ended_at) <= Date.parse(input.started_at)) {
      errors.ended_at = 'End time must be after the start time'
    }
  }
  if (!(input.energy_kwh > 0)) errors.energy_kwh = 'Energy must be greater than 0 kWh'
  if (isPresent(input.cost_cents) && !isNonNegativeInteger(input.cost_cents)) {
    errors.cost_cents = 'Cost must be a whole number of cents, 0 or more'
  }
  if (isPresent(input.currency) && !CURRENCY_PATTERN.test(input.currency)) {
    errors.currency = 'Currency must be a three-letter ISO 4217 code, e.g. AUD'
  }
  if (isPresent(input.location_name) && input.location_name.length > 200) {
    errors.location_name = 'Location must be at most 200 characters'
  }
  if (isPresent(input.start_soc_pct) && !isPercentage(input.start_soc_pct)) {
    errors.start_soc_pct = 'Start charge must be a whole percentage, 0-100'
  }
  if (isPresent(input.end_soc_pct)) {
    if (!isPercentage(input.end_soc_pct)) {
      errors.end_soc_pct = 'End charge must be a whole percentage, 0-100'
    } else if (isPresent(input.start_soc_pct) && input.end_soc_pct < input.start_soc_pct) {
      errors.end_soc_pct = 'End charge cannot be below the start charge'
    }
  }
  if (isPresent(input.odometer_km) && !isNonNegativeInteger(input.odometer_km)) {
    errors.odometer_km = 'Odometer must be a whole number of km, 0 or more'
  }
  return errors
}

export function validateRangeObservation(
  input: RangeObservationInsert,
): ValidationErrors<RangeObservationInsert> {
  const errors: ValidationErrors<RangeObservationInsert> = {}
  if (isPresent(input.observed_at) && !isTimestamp(input.observed_at)) {
    errors.observed_at = 'Observation time is not a valid date/time'
  }
  if (!isPercentage(input.soc_pct)) errors.soc_pct = 'Charge must be a whole percentage, 0-100'
  if (!isNonNegativeInteger(input.displayed_range_km)) {
    errors.displayed_range_km = 'Displayed range must be a whole number of km, 0 or more'
  }
  if (isPresent(input.odometer_km) && !isNonNegativeInteger(input.odometer_km)) {
    errors.odometer_km = 'Odometer must be a whole number of km, 0 or more'
  }
  if (
    isPresent(input.outside_temp_c) &&
    !(input.outside_temp_c >= -50 && input.outside_temp_c <= 60)
  ) {
    errors.outside_temp_c = 'Outside temperature must be between -50 and 60 °C'
  }
  if (isPresent(input.latitude) && !(input.latitude >= -90 && input.latitude <= 90)) {
    errors.latitude = 'Latitude must be between -90 and 90'
  }
  if (isPresent(input.longitude) && !(input.longitude >= -180 && input.longitude <= 180)) {
    errors.longitude = 'Longitude must be between -180 and 180'
  }
  // The database's CHECK says the same: both or neither, and only on a triggered reading.
  if (isPresent(input.latitude) && !isPresent(input.longitude)) errors.longitude ??= 'A position needs a longitude'
  if (isPresent(input.longitude) && !isPresent(input.latitude)) errors.latitude ??= 'A position needs a latitude'
  if ((isPresent(input.latitude) || isPresent(input.longitude)) && !isPresent(input.trigger_event)) {
    errors.latitude ??= 'Only a triggered reading carries a position'
  }
  // A charge run (atto/8) never reads the car's position, so one that arrives with it is refused.
  if (
    (isPresent(input.latitude) || isPresent(input.longitude)) &&
    typeof input.trigger_event === 'string' &&
    input.trigger_event.startsWith('charge_')
  ) {
    errors.latitude ??= 'A charge reading carries no position'
  }
  return errors
}

export function validateVehicleFeature(
  input: VehicleFeatureInsert,
): ValidationErrors<VehicleFeatureInsert> {
  const errors: ValidationErrors<VehicleFeatureInsert> = {}
  const nameError = textLengthError(input.name, 'Name', 120)
  if (nameError) errors.name = nameError
  const valueError = textLengthError(input.value, 'Value', 500)
  if (valueError) errors.value = valueError
  if (isPresent(input.unit) && input.unit.length > 20) {
    errors.unit = 'Unit must be at most 20 characters'
  }
  if (isPresent(input.manual_reference) && input.manual_reference.length > 200) {
    errors.manual_reference = 'Manual reference must be at most 200 characters'
  }
  return errors
}

export function validateMaintenanceRecord(
  input: MaintenanceRecordInsert,
): ValidationErrors<MaintenanceRecordInsert> {
  const errors: ValidationErrors<MaintenanceRecordInsert> = {}
  const performedValid = isDate(input.performed_on)
  if (!performedValid) errors.performed_on = 'Date must be YYYY-MM-DD'
  const titleError = textLengthError(input.title, 'Title', 200)
  if (titleError) errors.title = titleError
  if (isPresent(input.provider) && input.provider.length > 200) {
    errors.provider = 'Provider must be at most 200 characters'
  }
  if (isPresent(input.odometer_km) && !isNonNegativeInteger(input.odometer_km)) {
    errors.odometer_km = 'Odometer must be a whole number of km, 0 or more'
  }
  if (isPresent(input.cost_cents) && !isNonNegativeInteger(input.cost_cents)) {
    errors.cost_cents = 'Cost must be a whole number of cents, 0 or more'
  }
  if (isPresent(input.currency) && !CURRENCY_PATTERN.test(input.currency)) {
    errors.currency = 'Currency must be a three-letter ISO 4217 code, e.g. AUD'
  }
  if (isPresent(input.next_due_on)) {
    if (!isDate(input.next_due_on)) {
      errors.next_due_on = 'Next due date must be YYYY-MM-DD'
    } else if (performedValid && input.next_due_on < input.performed_on) {
      // ISO dates compare correctly as strings.
      errors.next_due_on = 'Next due date cannot be before the work was performed'
    }
  }
  if (isPresent(input.next_due_km)) {
    if (!isNonNegativeInteger(input.next_due_km)) {
      errors.next_due_km = 'Next due odometer must be a whole number of km, 0 or more'
    } else if (isPresent(input.odometer_km) && input.next_due_km < input.odometer_km) {
      errors.next_due_km = 'Next due odometer cannot be below the current reading'
    }
  }
  return errors
}

export function validateNote(input: NoteInsert): ValidationErrors<NoteInsert> {
  const errors: ValidationErrors<NoteInsert> = {}
  const titleError = textLengthError(input.title, 'Title', 200)
  if (titleError) errors.title = titleError
  if (isPresent(input.tags) && input.tags.some((tag) => isBlank(tag))) {
    errors.tags = 'Tags cannot be blank'
  }
  return errors
}
