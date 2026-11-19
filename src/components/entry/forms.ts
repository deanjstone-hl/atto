// What each entry form asks for, and how its text becomes the API's input. The rules
// themselves are not here: they come from src/lib/data-model/validation.ts, the same
// validators the Worker runs, so a form reports a problem before the round trip and
// the Worker still has the last word.

import type { ApiClient } from '@/lib/api'
import type {
  ChargingSessionInsert,
  ChargerType,
  FeatureCategory,
  RangeObservationInsert,
  VehicleFeatureInsert,
  VehicleInsert,
} from '@/lib/data-model/types'
import {
  validateChargingSession,
  validateRangeObservation,
  validateVehicle,
  validateVehicleFeature,
  type ValidationErrors,
} from '@/lib/data-model/validation'

export type FormValues = Record<string, string>
export type FieldErrors = Record<string, string>

export type FieldDef = {
  name: string
  label: string
  control: 'text' | 'number' | 'datetime-local' | 'date' | 'select'
  options?: readonly { value: string; label: string }[]
  hint?: string
  step?: string
  required?: boolean
}

export type FormSpec<Input> = {
  title: string
  description: string
  submitLabel: string
  fields: readonly FieldDef[]
  initial: FormValues
  // The form field a server or validator field name is shown against.
  errorField: (name: string) => string
  toInput: (values: FormValues, vehicleId?: string) => { input: Input } | { errors: FieldErrors }
  submit: (api: ApiClient, input: Input) => Promise<unknown>
}

const CHARGER_OPTIONS: readonly { value: ChargerType; label: string }[] = [
  { value: 'ac_home', label: 'Home AC' },
  { value: 'ac_public', label: 'Public AC' },
  { value: 'dc_fast', label: 'DC fast' },
]

const FEATURE_OPTIONS: readonly { value: FeatureCategory; label: string }[] = [
  { value: 'battery', label: 'Battery' },
  { value: 'charging', label: 'Charging' },
  { value: 'performance', label: 'Performance' },
  { value: 'dimensions', label: 'Dimensions' },
  { value: 'safety', label: 'Safety' },
  { value: 'driver_assistance', label: 'Driver assistance' },
  { value: 'infotainment', label: 'Infotainment' },
  { value: 'comfort', label: 'Comfort' },
  { value: 'other', label: 'Other' },
]

// Collects what a field's text could not be turned into, so every problem shows at once.
class Reader {
  readonly errors: FieldErrors = {}
  private readonly values: FormValues

  constructor(values: FormValues) {
    this.values = values
  }

  text(name: string): string | null {
    const value = (this.values[name] ?? '').trim()
    return value === '' ? null : value
  }

  required(name: string): string {
    const value = this.text(name)
    if (value === null) this.errors[name] = 'Required'
    return value ?? ''
  }

  number(name: string): number | null {
    const value = this.text(name)
    if (value === null) return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      this.errors[name] = 'Enter a number'
      return null
    }
    return parsed
  }

  requiredNumber(name: string): number {
    const parsed = this.number(name)
    if (parsed === null && this.errors[name] === undefined) this.errors[name] = 'Required'
    return parsed ?? 0
  }

  // A datetime-local value is the browser's local time; the API takes an instant.
  instant(name: string): string | null {
    const value = this.text(name)
    if (value === null) return null
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      this.errors[name] = 'Enter a date and time'
      return null
    }
    return parsed.toISOString()
  }

  requiredInstant(name: string): string {
    const parsed = this.instant(name)
    if (parsed === null && this.errors[name] === undefined) this.errors[name] = 'Required'
    return parsed ?? ''
  }
}

// Reader errors come first; the shared rules run only on a complete, typed input.
function finish<Input>(
  reader: Reader,
  input: Input,
  validate: (input: Input) => ValidationErrors<Input>,
  errorField: (name: string) => string,
): { input: Input } | { errors: FieldErrors } {
  if (Object.keys(reader.errors).length > 0) return { errors: reader.errors }
  const errors: FieldErrors = {}
  for (const [name, message] of Object.entries<string | undefined>(validate(input))) {
    if (message !== undefined) errors[errorField(name)] = message
  }
  return Object.keys(errors).length > 0 ? { errors } : { input }
}

const sameField = (name: string) => name

export const vehicleForm: FormSpec<VehicleInsert> = {
  title: 'Add your vehicle',
  description: 'Start with a nickname. Everything else can be left blank.',
  submitLabel: 'Save vehicle',
  fields: [
    { name: 'nickname', label: 'Nickname', control: 'text', required: true },
    { name: 'vin', label: 'VIN', control: 'text', hint: '17 characters, letters and digits (no I, O or Q)' },
    { name: 'model_year', label: 'Model year', control: 'number', step: '1' },
    { name: 'variant', label: 'Variant', control: 'text' },
    { name: 'battery_capacity_kwh', label: 'Battery capacity (kWh)', control: 'number', step: 'any' },
    { name: 'purchased_on', label: 'Purchased on', control: 'date' },
  ],
  initial: { nickname: '', vin: '', model_year: '', variant: '', battery_capacity_kwh: '', purchased_on: '' },
  errorField: sameField,
  toInput(values) {
    const read = new Reader(values)
    const input: VehicleInsert = {
      nickname: read.required('nickname'),
      vin: read.text('vin')?.toUpperCase() ?? null,
      model_year: read.number('model_year'),
      variant: read.text('variant'),
      battery_capacity_kwh: read.number('battery_capacity_kwh'),
      purchased_on: read.text('purchased_on'),
    }
    return finish(read, input, validateVehicle, sameField)
  },
  submit: (api, input) => api.createVehicle(input),
}

const chargingErrorField = (name: string) => (name === 'cost_cents' ? 'cost' : name)

export const chargingSessionForm: FormSpec<ChargingSessionInsert> = {
  title: 'Log a charging session',
  description: 'Record what went into the battery, and what it cost.',
  submitLabel: 'Save session',
  fields: [
    { name: 'started_at', label: 'Started', control: 'datetime-local', required: true },
    { name: 'ended_at', label: 'Ended', control: 'datetime-local' },
    { name: 'energy_kwh', label: 'Energy added (kWh)', control: 'number', step: 'any', required: true },
    { name: 'charger_type', label: 'Charger type', control: 'select', options: CHARGER_OPTIONS, required: true },
    { name: 'cost', label: 'Cost', control: 'number', step: '0.01', hint: 'In the currency below, e.g. 12.50' },
    { name: 'currency', label: 'Currency', control: 'text', hint: 'Three-letter code' },
    { name: 'location_name', label: 'Location', control: 'text' },
    { name: 'start_soc_pct', label: 'Charge at start (%)', control: 'number', step: '1' },
    { name: 'end_soc_pct', label: 'Charge at end (%)', control: 'number', step: '1' },
    { name: 'odometer_km', label: 'Odometer (km)', control: 'number', step: '1' },
    { name: 'notes', label: 'Notes', control: 'text' },
  ],
  initial: {
    started_at: '',
    ended_at: '',
    energy_kwh: '',
    charger_type: 'ac_home',
    cost: '',
    currency: 'AUD',
    location_name: '',
    start_soc_pct: '',
    end_soc_pct: '',
    odometer_km: '',
    notes: '',
  },
  errorField: chargingErrorField,
  toInput(values, vehicleId = '') {
    const read = new Reader(values)
    const dollars = read.number('cost')
    // Math.round on the cents: 0.29 * 100 is 28.999999999999996.
    const cost = dollars === null ? null : Math.round(dollars * 100)
    if (dollars !== null && dollars < 0) read.errors.cost = 'Cost cannot be negative'
    const currency = read.text('currency')?.toUpperCase()
    const input: ChargingSessionInsert = {
      vehicle_id: vehicleId,
      started_at: read.requiredInstant('started_at'),
      ended_at: read.instant('ended_at'),
      energy_kwh: read.requiredNumber('energy_kwh'),
      cost_cents: cost,
      currency,
      charger_type: (read.text('charger_type') ?? 'ac_home') as ChargerType,
      location_name: read.text('location_name'),
      start_soc_pct: read.number('start_soc_pct'),
      end_soc_pct: read.number('end_soc_pct'),
      odometer_km: read.number('odometer_km'),
      notes: read.text('notes'),
    }
    return finish(read, input, validateChargingSession, chargingErrorField)
  },
  submit: (api, input) => api.createChargingSession(input),
}

const CLIMATE: Record<string, boolean | null> = { on: true, off: false, '': null }

export const rangeObservationForm: FormSpec<RangeObservationInsert> = {
  title: 'Log a range reading',
  description: 'Note the charge and the range the car shows. Leave the time blank to use now.',
  submitLabel: 'Save reading',
  fields: [
    { name: 'observed_at', label: 'Observed', control: 'datetime-local' },
    { name: 'soc_pct', label: 'Charge (%)', control: 'number', step: '1', required: true },
    { name: 'displayed_range_km', label: 'Displayed range (km)', control: 'number', step: '1', required: true },
    { name: 'odometer_km', label: 'Odometer (km)', control: 'number', step: '1' },
    { name: 'outside_temp_c', label: 'Outside temperature (°C)', control: 'number', step: 'any' },
    {
      name: 'climate_on',
      label: 'Climate control',
      control: 'select',
      options: [
        { value: '', label: 'Not recorded' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
    { name: 'notes', label: 'Notes', control: 'text' },
  ],
  initial: { observed_at: '', soc_pct: '', displayed_range_km: '', odometer_km: '', outside_temp_c: '', climate_on: '', notes: '' },
  errorField: sameField,
  toInput(values, vehicleId = '') {
    const read = new Reader(values)
    const observedAt = read.instant('observed_at')
    const input: RangeObservationInsert = {
      vehicle_id: vehicleId,
      soc_pct: read.requiredNumber('soc_pct'),
      displayed_range_km: read.requiredNumber('displayed_range_km'),
      odometer_km: read.number('odometer_km'),
      outside_temp_c: read.number('outside_temp_c'),
      climate_on: CLIMATE[values.climate_on ?? ''] ?? null,
      notes: read.text('notes'),
    }
    if (observedAt !== null) input.observed_at = observedAt
    return finish(read, input, validateRangeObservation, sameField)
  },
  submit: (api, input) => api.createRangeObservation(input),
}

export const vehicleFeatureForm: FormSpec<VehicleFeatureInsert> = {
  title: 'Add a feature or spec',
  description: 'A fact about the car you want to find again, with where the manual says so.',
  submitLabel: 'Save feature',
  fields: [
    { name: 'category', label: 'Category', control: 'select', options: FEATURE_OPTIONS, required: true },
    { name: 'name', label: 'Name', control: 'text', required: true },
    { name: 'value', label: 'Value', control: 'text', required: true },
    { name: 'unit', label: 'Unit', control: 'text' },
    { name: 'manual_reference', label: 'Manual reference', control: 'text', hint: 'e.g. page 120' },
    { name: 'notes', label: 'Notes', control: 'text' },
  ],
  initial: { category: 'battery', name: '', value: '', unit: '', manual_reference: '', notes: '' },
  errorField: sameField,
  toInput(values, vehicleId = '') {
    const read = new Reader(values)
    const input: VehicleFeatureInsert = {
      vehicle_id: vehicleId,
      category: (read.text('category') ?? 'other') as FeatureCategory,
      name: read.required('name'),
      value: read.required('value'),
      unit: read.text('unit'),
      manual_reference: read.text('manual_reference'),
      notes: read.text('notes'),
    }
    return finish(read, input, validateVehicleFeature, sameField)
  },
  submit: (api, input) => api.createVehicleFeature(input),
}
