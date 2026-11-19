import { describe, expect, it } from 'vitest'
import {
  fixtureFeatures,
  fixtureObservations,
  fixtureSessions,
  fixtureVehicle,
} from './fixtures'
import {
  buildKeySpecs,
  buildRangeTrend,
  buildVehicleStatus,
  summariseSessions,
} from './shape'

describe('buildVehicleStatus', () => {
  it('takes charge and range from the newest observation', () => {
    const status = buildVehicleStatus(fixtureVehicle, fixtureObservations, fixtureSessions)
    expect(status).toEqual({
      nickname: 'Atto',
      description: '2026 Premium',
      socPct: 64,
      displayedRangeKm: 192,
      projectedFullRangeKm: 300,
      observedAt: '2026-10-07T07:40:00.000Z',
      odometerKm: 4890,
      lastChargedAt: '2026-10-06T01:10:00.000Z',
    })
  })

  it('does not rely on the input order', () => {
    const shuffled = [...fixtureObservations].reverse()
    const sessions = [...fixtureSessions].reverse()
    expect(buildVehicleStatus(fixtureVehicle, shuffled, sessions)).toEqual(
      buildVehicleStatus(fixtureVehicle, fixtureObservations, fixtureSessions),
    )
  })

  it('takes the highest odometer reading across observations and sessions', () => {
    const [newest] = fixtureObservations
    const status = buildVehicleStatus(
      fixtureVehicle,
      [{ ...newest, odometer_km: null }],
      fixtureSessions,
    )
    expect(status.odometerKm).toBe(4812)
  })

  it('falls back to the start time when the latest session has no end', () => {
    const [open] = fixtureSessions.filter((session) => session.ended_at === null)
    const status = buildVehicleStatus(fixtureVehicle, [], [open])
    expect(status.lastChargedAt).toBe(open.started_at)
  })

  it('reports nulls when there are no readings yet', () => {
    const bare = { ...fixtureVehicle, model_year: null, variant: null, battery_capacity_kwh: null }
    expect(buildVehicleStatus(bare, [], [])).toEqual({
      nickname: 'Atto',
      description: null,
      socPct: null,
      displayedRangeKm: null,
      projectedFullRangeKm: null,
      observedAt: null,
      odometerKm: null,
      lastChargedAt: null,
    })
  })
})

describe('summariseSessions', () => {
  it('derives duration, charge gained and unit cost, newest first', () => {
    const [first] = summariseSessions([...fixtureSessions].reverse())
    expect(first).toEqual({
      id: fixtureSessions[0].id,
      startedAt: '2026-10-05T19:30:00.000Z',
      chargerType: 'ac_home',
      locationName: 'Home',
      energyKwh: 26.4,
      startSocPct: 22,
      endSocPct: 80,
      durationMinutes: 340,
      costCents: 554,
      currency: 'AUD',
      costPerKwhCents: 554 / 26.4,
    })
  })

  it('leaves unknowns null rather than guessing', () => {
    const open = summariseSessions(fixtureSessions).at(-1)
    expect(open?.durationMinutes).toBeNull()
    expect(open?.costCents).toBeNull()
    expect(open?.costPerKwhCents).toBeNull()
    expect(open?.startSocPct).toBeNull()
  })

  it('keeps a free session at zero cost', () => {
    const free = summariseSessions(fixtureSessions).find((row) => row.costCents === 0)
    expect(free?.costPerKwhCents).toBe(0)
  })

  it('caps the list at the limit', () => {
    expect(summariseSessions(fixtureSessions, 3)).toHaveLength(3)
    expect(summariseSessions([])).toEqual([])
  })
})

describe('buildKeySpecs', () => {
  it('lists vehicle columns first, then key features in category order', () => {
    expect(buildKeySpecs(fixtureVehicle, fixtureFeatures)).toEqual([
      { label: 'Battery capacity', value: '43.2 kWh', reference: null },
      { label: 'Model year', value: '2026', reference: null },
      { label: 'Variant', value: 'Premium', reference: null },
      { label: 'Chemistry', value: 'LFP Blade', reference: null },
      { label: 'Max AC charge rate', value: '11 kW', reference: null },
      { label: 'Max DC charge rate', value: '85 kW', reference: null },
      { label: 'WLTP range', value: '310 km', reference: 'Owner manual p. 212' },
      { label: 'Length', value: '3990 mm', reference: null },
    ])
  })

  it('leaves out non-key categories', () => {
    const labels = buildKeySpecs(fixtureVehicle, fixtureFeatures).map((spec) => spec.label)
    expect(labels).not.toContain('Screen size')
  })

  it('prefers a feature over the vehicle column it duplicates', () => {
    const [chemistry] = fixtureFeatures.filter((item) => item.name === 'Chemistry')
    const capacity = {
      ...chemistry,
      name: 'battery capacity',
      value: '43.20',
      unit: 'kWh',
      manual_reference: 'Spec sheet',
    }
    const specs = buildKeySpecs(fixtureVehicle, [capacity])
    expect(specs.filter((spec) => spec.label.toLowerCase() === 'battery capacity')).toEqual([
      { label: 'battery capacity', value: '43.20 kWh', reference: 'Spec sheet' },
    ])
  })

  it('is empty for a bare vehicle with no features', () => {
    const bare = { ...fixtureVehicle, model_year: null, variant: null, battery_capacity_kwh: null }
    expect(buildKeySpecs(bare, [])).toEqual([])
  })
})

describe('buildRangeTrend', () => {
  it('projects full-charge range per observation, oldest first', () => {
    const trend = buildRangeTrend(fixtureObservations)
    expect(trend.points.map((point) => point.projectedFullRangeKm)).toEqual([
      320, 315, 313, 310, 306, 305, 300, 295, 300,
    ])
    expect(trend.points[0].observedAt).toBe('2026-09-01T07:00:00.000Z')
  })

  it('drops low-charge readings, where display rounding swamps the projection', () => {
    const trend = buildRangeTrend(fixtureObservations)
    expect(trend.points.map((point) => point.socPct)).not.toContain(18)
  })

  it('summarises latest, average and change', () => {
    expect(buildRangeTrend(fixtureObservations)).toMatchObject({
      latestKm: 300,
      averageKm: 307,
      minKm: 295,
      maxKm: 320,
      changeKm: -20,
      direction: 'down',
    })
  })

  it('calls a change under 1% flat', () => {
    const [newest, second] = fixtureObservations
    const steady = [
      { ...newest, soc_pct: 50, displayed_range_km: 151 },
      { ...second, soc_pct: 50, displayed_range_km: 150 },
    ]
    expect(buildRangeTrend(steady)).toMatchObject({ changeKm: 2, direction: 'flat' })
  })

  it('needs two points for a change', () => {
    const trend = buildRangeTrend(fixtureObservations.slice(0, 1))
    expect(trend).toMatchObject({ latestKm: 300, averageKm: 300, changeKm: null, direction: null })
  })

  it('is empty with no usable observations', () => {
    expect(buildRangeTrend([])).toEqual({
      points: [],
      latestKm: null,
      averageKm: null,
      minKm: null,
      maxKm: null,
      changeKm: null,
      direction: null,
    })
  })
})
