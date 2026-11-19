// Pure shaping from data-model rows to what the dashboard renders. No I/O and
// no formatting: the components decide how numbers read.

import type {
  ChargerType,
  ChargingSession,
  FeatureCategory,
  RangeObservation,
  Vehicle,
  VehicleFeature,
} from '../data-model/types'
import { costPerKwhCents, projectedFullRangeKm, sessionDurationMinutes } from '../data-model/units'

export type VehicleStatus = {
  nickname: string
  description: string | null
  socPct: number | null
  displayedRangeKm: number | null
  projectedFullRangeKm: number | null
  observedAt: string | null
  odometerKm: number | null
  lastChargedAt: string | null
}

export type SessionSummary = {
  id: string
  startedAt: string
  chargerType: ChargerType
  locationName: string | null
  energyKwh: number
  startSocPct: number | null
  endSocPct: number | null
  durationMinutes: number | null
  costCents: number | null
  currency: string
  costPerKwhCents: number | null
}

export type KeySpec = {
  label: string
  value: string
  reference: string | null
}

export type RangeTrendPoint = {
  observedAt: string
  socPct: number
  displayedRangeKm: number
  projectedFullRangeKm: number
}

export type RangeTrend = {
  points: RangeTrendPoint[]
  latestKm: number | null
  averageKm: number | null
  minKm: number | null
  maxKm: number | null
  changeKm: number | null
  direction: 'up' | 'down' | 'flat' | null
}

export const RECENT_SESSION_DEFAULT = 5

// Below this charge the displayed range is rounded to so few km that scaling
// it to 100% mostly amplifies the rounding.
const MIN_TREND_SOC_PCT = 20

// A change smaller than this share of the starting range reads as flat.
const FLAT_TREND_RATIO = 0.01

const KEY_SPEC_CATEGORIES: FeatureCategory[] = ['battery', 'charging', 'performance', 'dimensions']

function newestFirst<Row>(rows: Row[], timestamp: (row: Row) => string): Row[] {
  return [...rows].sort((a, b) => Date.parse(timestamp(b)) - Date.parse(timestamp(a)))
}

function maxOrNull(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : Math.max(...present)
}

export function buildVehicleStatus(
  vehicle: Vehicle,
  observations: RangeObservation[],
  sessions: ChargingSession[],
): VehicleStatus {
  const [latestObservation] = newestFirst(observations, (row) => row.observed_at)
  const [latestSession] = newestFirst(sessions, (row) => row.started_at)
  const description = [vehicle.model_year, vehicle.variant].filter((part) => part !== null).join(' ')

  return {
    nickname: vehicle.nickname,
    description: description === '' ? null : description,
    socPct: latestObservation?.soc_pct ?? null,
    displayedRangeKm: latestObservation?.displayed_range_km ?? null,
    projectedFullRangeKm: latestObservation
      ? projectedFullRangeKm(latestObservation.displayed_range_km, latestObservation.soc_pct)
      : null,
    observedAt: latestObservation?.observed_at ?? null,
    odometerKm: maxOrNull([
      latestObservation?.odometer_km ?? null,
      ...sessions.map((session) => session.odometer_km),
    ]),
    lastChargedAt: latestSession ? (latestSession.ended_at ?? latestSession.started_at) : null,
  }
}

export function summariseSessions(
  sessions: ChargingSession[],
  limit = RECENT_SESSION_DEFAULT,
): SessionSummary[] {
  return newestFirst(sessions, (row) => row.started_at)
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      startedAt: session.started_at,
      chargerType: session.charger_type,
      locationName: session.location_name,
      energyKwh: session.energy_kwh,
      startSocPct: session.start_soc_pct,
      endSocPct: session.end_soc_pct,
      durationMinutes: sessionDurationMinutes(session.started_at, session.ended_at),
      costCents: session.cost_cents,
      currency: session.currency,
      costPerKwhCents: costPerKwhCents(session.cost_cents, session.energy_kwh),
    }))
}

function featureValue(feature: VehicleFeature): string {
  return feature.unit ? `${feature.value} ${feature.unit}` : feature.value
}

export function buildKeySpecs(vehicle: Vehicle, features: VehicleFeature[]): KeySpec[] {
  const featureSpecs = features
    .filter((feature) => KEY_SPEC_CATEGORIES.includes(feature.category))
    .sort(
      (a, b) =>
        KEY_SPEC_CATEGORIES.indexOf(a.category) - KEY_SPEC_CATEGORIES.indexOf(b.category) ||
        a.name.localeCompare(b.name),
    )
    .map((feature) => ({
      label: feature.name,
      value: featureValue(feature),
      reference: feature.manual_reference,
    }))

  const featureLabels = new Set(featureSpecs.map((spec) => spec.label.trim().toLowerCase()))
  const vehicleSpecs: KeySpec[] = [
    ['Battery capacity', vehicle.battery_capacity_kwh === null ? null : `${vehicle.battery_capacity_kwh} kWh`],
    ['Model year', vehicle.model_year === null ? null : String(vehicle.model_year)],
    ['Variant', vehicle.variant],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .filter(([label]) => !featureLabels.has(label.toLowerCase()))
    .map(([label, value]) => ({ label, value, reference: null }))

  return [...vehicleSpecs, ...featureSpecs]
}

export function buildRangeTrend(observations: RangeObservation[]): RangeTrend {
  const points = newestFirst(observations, (row) => row.observed_at)
    .reverse()
    .filter((row) => row.soc_pct >= MIN_TREND_SOC_PCT)
    .map((row) => ({
      observedAt: row.observed_at,
      socPct: row.soc_pct,
      displayedRangeKm: row.displayed_range_km,
      projectedFullRangeKm: projectedFullRangeKm(row.displayed_range_km, row.soc_pct) ?? 0,
    }))

  if (points.length === 0) {
    return {
      points,
      latestKm: null,
      averageKm: null,
      minKm: null,
      maxKm: null,
      changeKm: null,
      direction: null,
    }
  }

  const ranges = points.map((point) => point.projectedFullRangeKm)
  const firstKm = ranges[0]
  const latestKm = ranges[ranges.length - 1]
  const changeKm = points.length < 2 ? null : latestKm - firstKm
  const direction =
    changeKm === null
      ? null
      : Math.abs(changeKm) < firstKm * FLAT_TREND_RATIO
        ? 'flat'
        : changeKm > 0
          ? 'up'
          : 'down'

  return {
    points,
    latestKm,
    averageKm: Math.round(ranges.reduce((sum, km) => sum + km, 0) / ranges.length),
    minKm: Math.min(...ranges),
    maxKm: Math.max(...ranges),
    changeKm,
    direction,
  }
}
