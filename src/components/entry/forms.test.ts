import { describe, expect, it } from 'vitest'
import { chargingSessionForm, rangeObservationForm, vehicleFeatureForm, vehicleForm } from './forms'

const VEHICLE_ID = 'vehicle-1'

describe('vehicleForm', () => {
  it('turns blank optional fields into null and trims the nickname', () => {
    const result = vehicleForm.toInput({ ...vehicleForm.initial, nickname: '  Atto ' })
    expect(result).toEqual({
      input: {
        nickname: 'Atto',
        vin: null,
        model_year: null,
        variant: null,
        battery_capacity_kwh: null,
        purchased_on: null,
      },
    })
  })

  it('parses numbers and upper-cases the VIN', () => {
    const result = vehicleForm.toInput({
      nickname: 'Atto',
      vin: 'lc0ce4cb5r1234567',
      model_year: '2024',
      variant: 'Dynamic',
      battery_capacity_kwh: '60.48',
      purchased_on: '2024-03-02',
    })
    expect(result).toMatchObject({
      input: { vin: 'LC0CE4CB5R1234567', model_year: 2024, battery_capacity_kwh: 60.48, purchased_on: '2024-03-02' },
    })
  })

  it('reports a missing nickname and a number that is not a number, per field', () => {
    const result = vehicleForm.toInput({ ...vehicleForm.initial, nickname: ' ', model_year: 'abc' })
    expect(result).toEqual({ errors: { nickname: expect.any(String), model_year: expect.any(String) } })
  })

  it('applies the shared validation rules', () => {
    expect(vehicleForm.toInput({ ...vehicleForm.initial, nickname: 'A', vin: 'SHORT' })).toEqual({
      errors: { vin: expect.stringMatching(/17 characters/) },
    })
  })
})

describe('chargingSessionForm', () => {
  const filled = {
    ...chargingSessionForm.initial,
    started_at: '2026-10-07T11:00',
    energy_kwh: '32.5',
  }

  it('sends the vehicle, an ISO instant, cents for the cost, and omits what was left blank', () => {
    const result = chargingSessionForm.toInput({ ...filled, cost: '12.50', ended_at: '2026-10-07T13:30' }, VEHICLE_ID)
    expect(result).toMatchObject({
      input: {
        vehicle_id: VEHICLE_ID,
        started_at: new Date('2026-10-07T11:00').toISOString(),
        ended_at: new Date('2026-10-07T13:30').toISOString(),
        energy_kwh: 32.5,
        cost_cents: 1250,
        currency: 'AUD',
        charger_type: 'ac_home',
        location_name: null,
        start_soc_pct: null,
        end_soc_pct: null,
        odometer_km: null,
        notes: null,
      },
    })
  })

  it('rounds the cost to whole cents without float drift', () => {
    expect(chargingSessionForm.toInput({ ...filled, cost: '0.29' }, VEHICLE_ID)).toMatchObject({
      input: { cost_cents: 29 },
    })
  })

  it('requires a start time and energy', () => {
    const result = chargingSessionForm.toInput({ ...chargingSessionForm.initial }, VEHICLE_ID)
    expect(result).toEqual({ errors: { started_at: expect.any(String), energy_kwh: expect.any(String) } })
  })

  it('names the cost field, not cost_cents, when the cost is negative', () => {
    expect(chargingSessionForm.toInput({ ...filled, cost: '-1' }, VEHICLE_ID)).toEqual({
      errors: { cost: expect.any(String) },
    })
  })

  it('applies the shared rules: end after start, end charge not below start charge', () => {
    const result = chargingSessionForm.toInput(
      { ...filled, ended_at: '2026-10-07T10:00', start_soc_pct: '80', end_soc_pct: '20' },
      VEHICLE_ID,
    )
    expect(result).toEqual({ errors: { ended_at: expect.any(String), end_soc_pct: expect.any(String) } })
  })

  it('maps a server error on cost_cents to the cost field', () => {
    expect(chargingSessionForm.errorField('cost_cents')).toBe('cost')
    expect(chargingSessionForm.errorField('energy_kwh')).toBe('energy_kwh')
  })
})

describe('rangeObservationForm', () => {
  it('leaves the time out when blank so the Worker stamps now', () => {
    const result = rangeObservationForm.toInput({ ...rangeObservationForm.initial, soc_pct: '80', displayed_range_km: '330' }, VEHICLE_ID)
    expect(result).toEqual({
      input: {
        vehicle_id: VEHICLE_ID,
        soc_pct: 80,
        displayed_range_km: 330,
        odometer_km: null,
        outside_temp_c: null,
        climate_on: null,
        notes: null,
      },
    })
  })

  it.each([
    ['on', true],
    ['off', false],
    ['', null],
  ])('maps climate %j to %j', (climate, expected) => {
    const result = rangeObservationForm.toInput(
      { ...rangeObservationForm.initial, soc_pct: '80', displayed_range_km: '330', climate_on: climate },
      VEHICLE_ID,
    )
    expect(result).toMatchObject({ input: { climate_on: expected } })
  })

  it('requires charge and displayed range', () => {
    expect(rangeObservationForm.toInput({ ...rangeObservationForm.initial }, VEHICLE_ID)).toEqual({
      errors: { soc_pct: expect.any(String), displayed_range_km: expect.any(String) },
    })
  })

  it('applies the shared rules', () => {
    const result = rangeObservationForm.toInput(
      { ...rangeObservationForm.initial, soc_pct: '101', displayed_range_km: '330', outside_temp_c: '80' },
      VEHICLE_ID,
    )
    expect(result).toEqual({ errors: { soc_pct: expect.any(String), outside_temp_c: expect.any(String) } })
  })
})

describe('vehicleFeatureForm', () => {
  it('builds a feature and trims the text', () => {
    const result = vehicleFeatureForm.toInput(
      { ...vehicleFeatureForm.initial, category: 'battery', name: ' Capacity ', value: ' 60.48 ', unit: 'kWh' },
      VEHICLE_ID,
    )
    expect(result).toEqual({
      input: {
        vehicle_id: VEHICLE_ID,
        category: 'battery',
        name: 'Capacity',
        value: '60.48',
        unit: 'kWh',
        manual_reference: null,
        notes: null,
      },
    })
  })

  it('requires a name and a value', () => {
    expect(vehicleFeatureForm.toInput({ ...vehicleFeatureForm.initial }, VEHICLE_ID)).toEqual({
      errors: { name: expect.any(String), value: expect.any(String) },
    })
  })
})
