import { describe, expect, it } from 'vitest'
import type {
  ChargingSessionInsert,
  MaintenanceRecordInsert,
  NoteInsert,
  RangeObservationInsert,
  VehicleFeatureInsert,
  VehicleInsert,
} from './types'
import {
  isValid,
  validateChargingSession,
  validateMaintenanceRecord,
  validateNote,
  validateRangeObservation,
  validateVehicle,
  validateVehicleFeature,
} from './validation'

const vehicleId = '00000000-0000-4000-8000-000000000001'

describe('validateVehicle', () => {
  const valid: VehicleInsert = {
    nickname: 'Atto',
    vin: 'LGXCE4CB0R0000001',
    model_year: 2025,
    battery_capacity_kwh: 43.2,
  }

  it('accepts a complete vehicle', () => {
    expect(validateVehicle(valid)).toEqual({})
  })

  it('requires a non-blank nickname', () => {
    expect(validateVehicle({ ...valid, nickname: '   ' })).toHaveProperty('nickname')
  })

  it('rejects a malformed VIN', () => {
    expect(validateVehicle({ ...valid, vin: 'TOO-SHORT' })).toHaveProperty('vin')
    // I, O and Q are never valid VIN characters
    expect(validateVehicle({ ...valid, vin: 'LGXCE4CB0R000000O' })).toHaveProperty('vin')
  })

  it('rejects a non-positive battery capacity', () => {
    expect(validateVehicle({ ...valid, battery_capacity_kwh: 0 })).toHaveProperty(
      'battery_capacity_kwh',
    )
  })

  it('rejects an implausible model year', () => {
    expect(validateVehicle({ ...valid, model_year: 1999 })).toHaveProperty('model_year')
  })

  it('rejects a purchase date that does not exist, as the database date() check does', () => {
    expect(validateVehicle({ ...valid, purchased_on: '2025-02-30' })).toHaveProperty('purchased_on')
    expect(validateVehicle({ ...valid, purchased_on: '2025-13-01' })).toHaveProperty('purchased_on')
    expect(validateVehicle({ ...valid, purchased_on: '2024-02-29' })).toEqual({})
  })
})

describe('validateChargingSession', () => {
  const valid: ChargingSessionInsert = {
    vehicle_id: vehicleId,
    started_at: '2026-10-07T01:00:00Z',
    ended_at: '2026-10-07T03:00:00Z',
    energy_kwh: 21.4,
    cost_cents: 642,
    currency: 'AUD',
    charger_type: 'ac_home',
    start_soc_pct: 30,
    end_soc_pct: 80,
  }

  it('accepts a complete session', () => {
    expect(validateChargingSession(valid)).toEqual({})
  })

  it('accepts an in-progress session with no end time', () => {
    expect(validateChargingSession({ ...valid, ended_at: null })).toEqual({})
  })

  it('rejects an end time at or before the start', () => {
    expect(
      validateChargingSession({ ...valid, ended_at: '2026-10-07T01:00:00Z' }),
    ).toHaveProperty('ended_at')
  })

  it('rejects an unparseable start time', () => {
    expect(validateChargingSession({ ...valid, started_at: 'yesterday' })).toHaveProperty(
      'started_at',
    )
  })

  it('requires positive energy', () => {
    expect(validateChargingSession({ ...valid, energy_kwh: 0 })).toHaveProperty('energy_kwh')
  })

  it('rejects negative or fractional cost', () => {
    expect(validateChargingSession({ ...valid, cost_cents: -1 })).toHaveProperty('cost_cents')
    expect(validateChargingSession({ ...valid, cost_cents: 1.5 })).toHaveProperty('cost_cents')
  })

  it('rejects a currency that is not an ISO 4217 code', () => {
    expect(validateChargingSession({ ...valid, currency: 'aud' })).toHaveProperty('currency')
  })

  it('rejects state of charge outside 0-100', () => {
    expect(validateChargingSession({ ...valid, end_soc_pct: 101 })).toHaveProperty('end_soc_pct')
  })

  it('rejects an end state of charge below the start', () => {
    expect(
      validateChargingSession({ ...valid, start_soc_pct: 80, end_soc_pct: 30 }),
    ).toHaveProperty('end_soc_pct')
  })
})

describe('validateRangeObservation', () => {
  const valid: RangeObservationInsert = {
    vehicle_id: vehicleId,
    observed_at: '2026-10-07T01:00:00Z',
    soc_pct: 75,
    displayed_range_km: 229,
    odometer_km: 4120,
    outside_temp_c: 18.5,
  }

  it('accepts a complete observation', () => {
    expect(validateRangeObservation(valid)).toEqual({})
  })

  describe('tag and location (atto/6)', () => {
    const tagged = { ...valid, trigger_event: 'carplay_connect', latitude: 0, longitude: 0 }

    it('accepts a tagged observation, with or without a position', () => {
      expect(validateRangeObservation(tagged)).toEqual({})
      expect(validateRangeObservation({ ...valid, trigger_event: 'carplay_disconnect' })).toEqual({})
    })

    it('rejects a position on an observation with no tag: only a triggered reading may carry one', () => {
      expect(validateRangeObservation({ ...valid, latitude: 0, longitude: 0 })).toHaveProperty('latitude')
    })

    it('rejects a latitude without a longitude and the other way round', () => {
      expect(validateRangeObservation({ ...tagged, longitude: null })).toHaveProperty('longitude')
      expect(validateRangeObservation({ ...tagged, latitude: null })).toHaveProperty('latitude')
    })

    it.each([
      ['latitude', 90.5],
      ['latitude', -91],
      ['longitude', 180.5],
      ['longitude', -181],
    ])('rejects a %s of %s', (field, value) => {
      expect(validateRangeObservation({ ...tagged, [field]: value })).toHaveProperty(field)
    })
  })

  it('rejects a negative displayed range', () => {
    expect(validateRangeObservation({ ...valid, displayed_range_km: -1 })).toHaveProperty(
      'displayed_range_km',
    )
  })

  it('rejects an implausible outside temperature', () => {
    expect(validateRangeObservation({ ...valid, outside_temp_c: 75 })).toHaveProperty(
      'outside_temp_c',
    )
  })

  it('rejects a fractional odometer reading', () => {
    expect(validateRangeObservation({ ...valid, odometer_km: 4120.5 })).toHaveProperty(
      'odometer_km',
    )
  })
})

describe('validateVehicleFeature', () => {
  const valid: VehicleFeatureInsert = {
    vehicle_id: vehicleId,
    category: 'battery',
    name: 'Usable capacity',
    value: '43.2',
    unit: 'kWh',
  }

  it('accepts a complete feature', () => {
    expect(validateVehicleFeature(valid)).toEqual({})
  })

  it('requires a name and a value', () => {
    const errors = validateVehicleFeature({ ...valid, name: '', value: ' ' })
    expect(errors).toHaveProperty('name')
    expect(errors).toHaveProperty('value')
  })
})

describe('validateMaintenanceRecord', () => {
  const valid: MaintenanceRecordInsert = {
    vehicle_id: vehicleId,
    performed_on: '2026-10-01',
    category: 'scheduled_service',
    title: '12-month service',
    odometer_km: 15000,
    next_due_on: '2027-10-01',
    next_due_km: 30000,
  }

  it('accepts a complete record', () => {
    expect(validateMaintenanceRecord(valid)).toEqual({})
  })

  it('rejects a malformed date', () => {
    expect(validateMaintenanceRecord({ ...valid, performed_on: '01/10/2026' })).toHaveProperty(
      'performed_on',
    )
  })

  it('rejects a next-due date before the work was performed', () => {
    expect(validateMaintenanceRecord({ ...valid, next_due_on: '2026-09-01' })).toHaveProperty(
      'next_due_on',
    )
  })

  it('rejects a next-due odometer below the current reading', () => {
    expect(validateMaintenanceRecord({ ...valid, next_due_km: 10000 })).toHaveProperty(
      'next_due_km',
    )
  })
})

describe('validateNote', () => {
  it('accepts a note without a vehicle', () => {
    const note: NoteInsert = { title: 'Tyre pressures', body: '250 kPa cold', tags: ['tyres'] }
    expect(validateNote(note)).toEqual({})
  })

  it('requires a title', () => {
    expect(validateNote({ title: '' })).toHaveProperty('title')
  })

  it('rejects blank tags', () => {
    expect(validateNote({ title: 'x', tags: ['ok', ' '] })).toHaveProperty('tags')
  })
})

describe('isValid', () => {
  it('is true only for an empty error map', () => {
    expect(isValid({})).toBe(true)
    expect(isValid({ title: 'Required' })).toBe(false)
  })
})
