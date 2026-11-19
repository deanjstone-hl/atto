import { describe, expect, it } from 'vitest'
import {
  centsToDollars,
  costPerKwhCents,
  dollarsToCents,
  efficiencyKwhPer100Km,
  kmToMiles,
  milesToKm,
  projectedFullRangeKm,
  sessionDurationMinutes,
} from './units'

describe('dollarsToCents', () => {
  it('converts whole and fractional dollars', () => {
    expect(dollarsToCents(12)).toBe(1200)
    expect(dollarsToCents(12.34)).toBe(1234)
    expect(dollarsToCents(0)).toBe(0)
  })

  it('rounds half-cents up despite binary float error', () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE 754
    expect(dollarsToCents(1.005)).toBe(101)
    expect(dollarsToCents(0.1 + 0.2)).toBe(30)
  })

  it('rejects non-finite input', () => {
    expect(() => dollarsToCents(Number.NaN)).toThrow(RangeError)
    expect(() => dollarsToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('centsToDollars', () => {
  it('converts integer cents to dollars', () => {
    expect(centsToDollars(1234)).toBe(12.34)
    expect(centsToDollars(0)).toBe(0)
  })

  it('rejects non-integer cents', () => {
    expect(() => centsToDollars(12.5)).toThrow(RangeError)
  })
})

describe('sessionDurationMinutes', () => {
  it('returns whole minutes between start and end', () => {
    expect(sessionDurationMinutes('2026-10-07T01:00:00Z', '2026-10-07T02:30:00Z')).toBe(90)
  })

  it('rounds to the nearest minute', () => {
    expect(sessionDurationMinutes('2026-10-07T01:00:00Z', '2026-10-07T01:10:40Z')).toBe(11)
  })

  it('returns null while a session is still in progress', () => {
    expect(sessionDurationMinutes('2026-10-07T01:00:00Z', null)).toBeNull()
  })

  it('rejects an end before the start', () => {
    expect(() => sessionDurationMinutes('2026-10-07T02:00:00Z', '2026-10-07T01:00:00Z')).toThrow(
      RangeError,
    )
  })
})

describe('costPerKwhCents', () => {
  it('divides cost by energy', () => {
    expect(costPerKwhCents(1500, 30)).toBe(50)
  })

  it('returns null when cost is unknown or energy is zero', () => {
    expect(costPerKwhCents(null, 30)).toBeNull()
    expect(costPerKwhCents(1500, 0)).toBeNull()
  })
})

describe('efficiencyKwhPer100Km', () => {
  it('normalises energy over distance to kWh/100 km', () => {
    expect(efficiencyKwhPer100Km(14.5, 100)).toBe(14.5)
    expect(efficiencyKwhPer100Km(7.5, 50)).toBe(15)
  })

  it('returns null for zero distance', () => {
    expect(efficiencyKwhPer100Km(5, 0)).toBeNull()
  })
})

describe('projectedFullRangeKm', () => {
  it('scales the displayed range to 100% state of charge', () => {
    expect(projectedFullRangeKm(150, 50)).toBe(300)
    expect(projectedFullRangeKm(229, 75)).toBe(305)
  })

  it('returns null at 0% state of charge', () => {
    expect(projectedFullRangeKm(0, 0)).toBeNull()
  })
})

describe('km/mile conversion', () => {
  it('round-trips within a rounding tolerance', () => {
    expect(kmToMiles(100)).toBeCloseTo(62.137, 3)
    expect(milesToKm(62.137119)).toBeCloseTo(100, 3)
  })
})
