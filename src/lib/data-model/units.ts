// Conversions between the stored units (ADR-003) and display/derived values.

const KM_PER_MILE = 1.609344
const MS_PER_MINUTE = 60_000

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, got ${value}`)
  }
}

export function dollarsToCents(dollars: number): number {
  assertFinite(dollars, 'dollars')
  // toFixed collapses IEEE 754 noise (1.005 * 100 = 100.4999…) before rounding.
  return Math.round(Number((dollars * 100).toFixed(6)))
}

export function centsToDollars(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`cents must be an integer, got ${cents}`)
  }
  return cents / 100
}

export function sessionDurationMinutes(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt)
  assertFinite(elapsedMs, 'session duration')
  if (elapsedMs < 0) {
    throw new RangeError(`session ends (${endedAt}) before it starts (${startedAt})`)
  }
  return Math.round(elapsedMs / MS_PER_MINUTE)
}

export function costPerKwhCents(costCents: number | null, energyKwh: number): number | null {
  if (costCents === null || energyKwh <= 0) return null
  return costCents / energyKwh
}

export function efficiencyKwhPer100Km(energyKwh: number, distanceKm: number): number | null {
  if (distanceKm <= 0) return null
  return (energyKwh * 100) / distanceKm
}

export function projectedFullRangeKm(displayedRangeKm: number, socPct: number): number | null {
  if (socPct <= 0) return null
  return Math.round((displayedRangeKm / socPct) * 100)
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE
}
