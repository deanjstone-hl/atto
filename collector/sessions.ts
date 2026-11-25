// Charging sessions from polls (ADR-006). The BYD cloud reports the car's state, not
// sessions, so one is worked out from consecutive polls: it opens on the first poll that
// sees the car charging and closes on the first that does not.
//
// What that gives is approximate, and the session says so in its notes: the start and end
// are poll times, not plug-in times; energy is state of charge gained times the configured
// battery capacity; the charger type is guessed from average power. The state is a plain
// object the caller keeps between runs.

const MAX_GAP_MS = 6 * 60 * 60_000
// An AC wallbox on the ATTO 1 tops out well below this, a DC charger well above it.
const DC_THRESHOLD_KW = 12
// A closing sample this many points under the last charging poll is a bad read, not the car
// (atto/20: a 0% placeholder after a 15-hour charge). The session ends at the last charging poll.
const IMPLAUSIBLE_DROP_PCT = 5

export type OpenSession = {
  startedAt: string
  startSoc: number
  lastAt: string
  lastSoc: number
  odometerKm: number | null
}

export type SessionState = { lastAt: string | null; open: OpenSession | null }

export type Sample = { at: string; soc: number; charging: boolean; odometerKm: number | null }

export type ChargingSessionInput = {
  started_at: string
  ended_at: string
  energy_kwh: number
  charger_type: 'ac_home' | 'dc_fast'
  start_soc_pct: number
  end_soc_pct: number
  odometer_km?: number
  notes: string
}

// The charge as it stands after the latest poll, sent beside every reading so the dashboard can
// show it before it ends (atto/19). `energy_kwh` is left out when the battery capacity is unknown.
export type OpenChargingSessionInput = {
  started_at: string
  observed_at: string
  start_soc_pct: number
  soc_pct: number
  energy_kwh?: number
}

export const emptyState = (): SessionState => ({ lastAt: null, open: null })

export function openProgress(state: SessionState, batteryKwh: number | null): OpenChargingSessionInput | null {
  const { open } = state
  if (open === null) return null
  const startSoc = Math.round(open.startSoc)
  const soc = Math.max(startSoc, Math.round(open.lastSoc))
  const progress: OpenChargingSessionInput = {
    started_at: open.startedAt,
    observed_at: open.lastAt,
    start_soc_pct: startSoc,
    soc_pct: soc,
  }
  if (batteryKwh !== null) progress.energy_kwh = Math.round(((soc - startSoc) / 100) * batteryKwh * 100) / 100
  return progress
}

const NOTES =
  'From the BYD cloud. Start and end are the first and last polls that saw the charge; ' +
  'energy is state of charge gained times battery capacity; charger type is inferred from average power.'

function close(open: OpenSession, endedAt: string, endSoc: number, batteryKwh: number | null): ChargingSessionInput | null {
  const hours = (Date.parse(endedAt) - Date.parse(open.startedAt)) / 3_600_000
  const startSoc = Math.round(open.startSoc)
  const endSocRounded = Math.round(endSoc)
  if (batteryKwh === null || hours <= 0 || endSocRounded <= startSoc) return null

  const energy = Math.round(((endSocRounded - startSoc) / 100) * batteryKwh * 100) / 100
  const session: ChargingSessionInput = {
    started_at: open.startedAt,
    ended_at: endedAt,
    energy_kwh: energy,
    charger_type: energy / hours > DC_THRESHOLD_KW ? 'dc_fast' : 'ac_home',
    start_soc_pct: startSoc,
    end_soc_pct: endSocRounded,
    notes: NOTES,
  }
  if (open.odometerKm !== null) session.odometer_km = Math.round(open.odometerKm)
  return session
}

// The charge only ever went up while it was seen, so it never ends below the last charging poll;
// a sample far below it is not the car and does not count as the end.
function closeOnSample(open: OpenSession, sample: Sample, batteryKwh: number | null): ChargingSessionInput | null {
  if (sample.soc < open.lastSoc - IMPLAUSIBLE_DROP_PCT) return close(open, open.lastAt, open.lastSoc, batteryKwh)
  return close(open, sample.at, Math.max(open.lastSoc, sample.soc), batteryKwh)
}

const opened = (sample: Sample): OpenSession => ({
  startedAt: sample.at,
  startSoc: sample.soc,
  lastAt: sample.at,
  lastSoc: sample.soc,
  odometerKm: sample.odometerKm,
})

export function advance(
  state: SessionState,
  sample: Sample,
  options: { batteryKwh: number | null },
): { state: SessionState; session: ChargingSessionInput | null } {
  const sampleTime = Date.parse(sample.at)
  if (state.lastAt !== null && sampleTime <= Date.parse(state.lastAt)) return { state, session: null }

  const { open } = state
  const stale = open !== null && sampleTime - Date.parse(open.lastAt) > MAX_GAP_MS

  // The poll after a long silence tells nothing about when the charge ended, so the
  // session ends at the last poll that saw it.
  const session = open === null ? null : stale ? close(open, open.lastAt, open.lastSoc, options.batteryKwh) : null

  if (sample.charging) {
    if (open === null || stale) return { state: { lastAt: sample.at, open: opened(sample) }, session }
    return { state: { lastAt: sample.at, open: { ...open, lastAt: sample.at, lastSoc: sample.soc } }, session: null }
  }

  if (open === null) return { state: { lastAt: sample.at, open: null }, session: null }
  return {
    state: { lastAt: sample.at, open: null },
    session: stale ? session : closeOnSample(open, sample, options.batteryKwh),
  }
}
