import { describe, expect, it } from 'vitest'
import { advance, emptyState, type Sample, type SessionState } from './sessions.ts'

const options: { batteryKwh: number | null } = { batteryKwh: 30 }
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 0, 0) + minutes * 60_000).toISOString()
const sample = (minutes: number, soc: number, charging: boolean, odometerKm: number | null = 3447): Sample => ({
  at: at(minutes),
  soc,
  charging,
  odometerKm,
})

function feed(samples: Sample[], opts = options) {
  let state: SessionState = emptyState()
  const sessions = []
  for (const next of samples) {
    const result = advance(state, next, opts)
    state = result.state
    if (result.session) sessions.push(result.session)
  }
  return { state, sessions }
}

describe('charging sessions from polls', () => {
  it('emits nothing while the car is not charging', () => {
    expect(feed([sample(0, 50, false), sample(30, 50, false)]).sessions).toEqual([])
  })

  it('opens on the first charging poll and closes on the first poll that is not', () => {
    const { sessions, state } = feed([
      sample(0, 50, false),
      sample(30, 52, true),
      sample(60, 60, true),
      sample(240, 80, true),
      sample(270, 80, false),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      started_at: at(30),
      ended_at: at(270),
      start_soc_pct: 52,
      end_soc_pct: 80,
      odometer_km: 3447,
    })
    expect(state.open).toBeNull()
  })

  it('works energy out from the charge gained and the battery capacity', () => {
    const { sessions } = feed([sample(0, 20, true), sample(60, 50, false)])
    expect(sessions[0].energy_kwh).toBe(9)
  })

  it('calls a slow charge AC and a fast one DC, from the average power', () => {
    const slow = feed([sample(0, 20, true), sample(180, 70, false)]).sessions[0]
    expect(slow.charger_type).toBe('ac_home')
    const fast = feed([sample(0, 20, true), sample(30, 70, false)]).sessions[0]
    expect(fast.charger_type).toBe('dc_fast')
  })

  it('says in the notes where the figures came from', () => {
    const { sessions } = feed([sample(0, 20, true), sample(60, 50, false)])
    expect(sessions[0].notes).toMatch(/BYD cloud/)
    expect(sessions[0].notes).toMatch(/inferred/)
  })

  it('keeps an open session in the state between polls', () => {
    const { state, sessions } = feed([sample(0, 20, true), sample(30, 30, true)])
    expect(sessions).toEqual([])
    expect(state.open).toEqual({ startedAt: at(0), startSoc: 20, lastAt: at(30), lastSoc: 30, odometerKm: 3447 })
  })

  it('ignores a poll that is not newer than the last one seen', () => {
    const first = advance(emptyState(), sample(30, 50, true), options)
    const again = advance(first.state, sample(30, 99, false), options)
    const older = advance(first.state, sample(10, 99, false), options)
    expect(again.state).toEqual(first.state)
    expect(older.state).toEqual(first.state)
    expect(again.session).toBeNull()
  })

  it('discards a charge that gained nothing', () => {
    const { sessions, state } = feed([sample(0, 50, true), sample(30, 50, false)])
    expect(sessions).toEqual([])
    expect(state.open).toBeNull()
  })

  it('discards a session when the battery capacity is not configured', () => {
    expect(feed([sample(0, 20, true), sample(60, 50, false)], { batteryKwh: null }).sessions).toEqual([])
  })

  it('closes a session at the last charging poll when the next poll comes much later', () => {
    const { sessions } = feed([sample(0, 20, true), sample(60, 40, true), sample(60 + 12 * 60, 100, false)])
    expect(sessions[0]).toMatchObject({ ended_at: at(60), end_soc_pct: 40 })
  })

  it('opens a new session after a long gap', () => {
    const { sessions, state } = feed([sample(0, 20, true), sample(60, 40, true), sample(60 + 12 * 60, 30, true)])
    expect(sessions).toHaveLength(1)
    expect(state.open).toMatchObject({ startedAt: at(60 + 12 * 60), startSoc: 30 })
  })

  it('leaves the odometer out when the car did not send one', () => {
    const { sessions } = feed([sample(0, 20, true, null), sample(60, 50, false, null)])
    expect(sessions[0]).not.toHaveProperty('odometer_km')
  })
})
