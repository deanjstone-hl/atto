// Fixture rows for dashboard tests, the Playwright check and the dev server's stand-in
// API (vite.config.ts). Shaped as the Worker returns them for the D1 schema; values are
// illustrative, not verified ATTO1 specifications.

import type { ChargingSession, RangeObservation, Vehicle, VehicleFeature } from '../data-model/types'

const USER_ID = '00000000-0000-4000-8000-00000000000a'
const VEHICLE_ID = '00000000-0000-4000-8000-000000000001'
const CREATED_AT = '2026-06-01T00:00:00.000Z'

const owned = { user_id: USER_ID, created_at: CREATED_AT, updated_at: CREATED_AT }

export const fixtureVehicle: Vehicle = {
  ...owned,
  id: VEHICLE_ID,
  nickname: 'Atto',
  vin: null,
  model_year: 2026,
  variant: 'Premium',
  battery_capacity_kwh: 43.2,
  purchased_on: '2026-06-01',
}

function session(
  id: number,
  overrides: Partial<ChargingSession> &
    Pick<ChargingSession, 'started_at' | 'energy_kwh' | 'charger_type'>,
): ChargingSession {
  return {
    ...owned,
    id: `00000000-0000-4000-8000-0000000001${String(id).padStart(2, '0')}`,
    vehicle_id: VEHICLE_ID,
    ended_at: null,
    cost_cents: null,
    currency: 'AUD',
    location_name: null,
    start_soc_pct: null,
    end_soc_pct: null,
    odometer_km: null,
    notes: null,
    ...overrides,
  }
}

// Newest first, as the dashboard query orders them.
export const fixtureSessions: ChargingSession[] = [
  session(6, {
    started_at: '2026-10-05T19:30:00.000Z',
    ended_at: '2026-10-06T01:10:00.000Z',
    energy_kwh: 26.4,
    cost_cents: 554,
    charger_type: 'ac_home',
    location_name: 'Home',
    start_soc_pct: 22,
    end_soc_pct: 80,
    odometer_km: 4812,
  }),
  session(5, {
    started_at: '2026-10-02T03:15:00.000Z',
    ended_at: '2026-10-02T03:47:00.000Z',
    energy_kwh: 21.9,
    cost_cents: 1314,
    charger_type: 'dc_fast',
    location_name: 'Evie Networks, Goulburn',
    start_soc_pct: 18,
    end_soc_pct: 70,
    odometer_km: 4630,
  }),
  session(4, {
    started_at: '2026-09-28T20:00:00.000Z',
    ended_at: '2026-09-29T02:20:00.000Z',
    energy_kwh: 28.1,
    cost_cents: 590,
    charger_type: 'ac_home',
    location_name: 'Home',
    start_soc_pct: 15,
    end_soc_pct: 80,
    odometer_km: 4401,
  }),
  session(3, {
    started_at: '2026-09-24T07:05:00.000Z',
    ended_at: '2026-09-24T08:35:00.000Z',
    energy_kwh: 9.6,
    cost_cents: 0,
    charger_type: 'ac_public',
    location_name: 'Westfield Penrith',
    start_soc_pct: 45,
    end_soc_pct: 67,
    odometer_km: 4236,
  }),
  session(2, {
    started_at: '2026-09-20T19:45:00.000Z',
    ended_at: null,
    energy_kwh: 24.8,
    charger_type: 'ac_home',
    location_name: 'Home',
  }),
]

function observation(
  id: number,
  observedAt: string,
  socPct: number,
  displayedRangeKm: number,
  odometerKm: number | null = null,
  trip: { event: string; latitude?: number; longitude?: number } | null = null,
): RangeObservation {
  return {
    ...owned,
    id: `00000000-0000-4000-8000-0000000002${String(id).padStart(2, '0')}`,
    vehicle_id: VEHICLE_ID,
    observed_at: observedAt,
    soc_pct: socPct,
    displayed_range_km: displayedRangeKm,
    odometer_km: odometerKm,
    outside_temp_c: null,
    climate_on: null,
    notes: null,
    trigger_event: trip?.event ?? null,
    latitude: trip?.latitude ?? null,
    longitude: trip?.longitude ?? null,
  }
}

// Newest first, as the dashboard query orders them.
export const fixtureObservations: RangeObservation[] = [
  observation(10, '2026-10-07T07:40:00.000Z', 64, 192, 4890),
  observation(9, '2026-10-06T01:15:00.000Z', 80, 236, 4812),
  observation(8, '2026-10-02T03:50:00.000Z', 70, 210),
  observation(7, '2026-10-02T03:10:00.000Z', 18, 52),
  observation(6, '2026-09-29T02:25:00.000Z', 80, 244),
  observation(5, '2026-09-24T08:40:00.000Z', 67, 205),
  observation(4, '2026-09-20T07:00:00.000Z', 90, 279),
  observation(3, '2026-09-14T07:00:00.000Z', 85, 266),
  observation(2, '2026-09-08T07:00:00.000Z', 100, 315),
  observation(1, '2026-09-01T07:00:00.000Z', 95, 304),
]

// The readings a CarPlay connect or disconnect triggered (atto/6), newest first. The
// positions are obvious fakes near 0, 0, never a real place.
export const fixtureTripReadings: RangeObservation[] = [
  observation(22, '2026-10-07T07:40:00.000Z', 64, 192, 4890, { event: 'carplay_connect', latitude: 0.02, longitude: 0.02 }),
  observation(21, '2026-10-06T23:10:00.000Z', 72, 214, 4838, { event: 'carplay_disconnect', latitude: 0.01, longitude: 0.01 }),
  observation(20, '2026-10-06T22:30:00.000Z', 80, 236, 4812, { event: 'carplay_connect', latitude: 0.005, longitude: 0.005 }),
]

function feature(
  id: number,
  overrides: Pick<VehicleFeature, 'category' | 'name' | 'value'> & Partial<VehicleFeature>,
): VehicleFeature {
  return {
    ...owned,
    id: `00000000-0000-4000-8000-0000000003${String(id).padStart(2, '0')}`,
    vehicle_id: VEHICLE_ID,
    unit: null,
    manual_reference: null,
    notes: null,
    ...overrides,
  }
}

export const fixtureFeatures: VehicleFeature[] = [
  feature(1, { category: 'charging', name: 'Max DC charge rate', value: '85', unit: 'kW' }),
  feature(2, { category: 'charging', name: 'Max AC charge rate', value: '11', unit: 'kW' }),
  feature(3, { category: 'battery', name: 'Chemistry', value: 'LFP Blade' }),
  feature(4, {
    category: 'performance',
    name: 'WLTP range',
    value: '310',
    unit: 'km',
    manual_reference: 'Owner manual p. 212',
  }),
  feature(5, { category: 'dimensions', name: 'Length', value: '3990', unit: 'mm' }),
  feature(6, { category: 'infotainment', name: 'Screen size', value: '10.1', unit: 'in' }),
]
