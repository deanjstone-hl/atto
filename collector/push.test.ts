import { describe, expect, it } from 'vitest'
import { COALESCE_MS, MAX_ATTEMPTS } from './trigger.ts'
import { createPushQueue, nextCharge, parseSignal, seedFromState, type PushDeps } from './push.ts'

// The push listener's supervisor (atto/8): turns the listener's "charging" lines into
// charge_start and charge_stop, and runs the collector once for each, no sooner than two
// minutes after the last run (the same coalescing as the CarPlay pick-up).

const NOW = new Date('2026-11-24T10:00:00.000Z')
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

describe('nextCharge', () => {
  it('takes the first state it sees as the baseline, not as an event', () => {
    expect(nextCharge(null, true)).toEqual({ charging: true, event: null })
    expect(nextCharge(null, false)).toEqual({ charging: false, event: null })
  })

  it('is charge_start when charging begins and charge_stop when it ends', () => {
    expect(nextCharge(false, true)).toEqual({ charging: true, event: 'charge_start' })
    expect(nextCharge(true, false)).toEqual({ charging: false, event: 'charge_stop' })
  })

  it('is no event while the state is unchanged', () => {
    expect(nextCharge(true, true).event).toBeNull()
    expect(nextCharge(false, false).event).toBeNull()
  })
})

describe('parseSignal', () => {
  it.each([
    ['{"charging": true}', true],
    ['{"charging": false}', false],
  ])('reads %s', (line, expected) => {
    expect(parseSignal(line)).toBe(expected)
  })

  it.each(['', 'listening', '{"charging": "yes"}', '{"soc": 50}', '[true]', '{'])('ignores %j', (line) => {
    expect(parseSignal(line)).toBeNull()
  })
})

function setup(lastRun: Date | null = null, overrides: Partial<PushDeps> = {}) {
  const calls: string[] = []
  const deps: PushDeps = {
    run: async (event) => {
      calls.push(`run ${event}`)
    },
    loadLastRun: async () => lastRun,
    now: () => NOW,
    log: (message) => calls.push(`log ${message}`),
    ...overrides,
  }
  return { queue: createPushQueue(deps), calls }
}

const runs = (calls: string[]) => calls.filter((call) => call.startsWith('run '))

describe('the push queue', () => {
  // atto/20: the listener started at 08:03, mid-charge. The first push it heard was the charge
  // stop, which only set the baseline, so no charge_stop fired. The baseline now comes from the
  // collector's state (an open session means charging), not from the first push.
  it('fires charge_stop for a first push of "not charging" when it was seeded as charging', async () => {
    const { queue, calls } = setup()
    queue.seed(true)
    expect(queue.signal(false)).toBe('charge_stop')
    await queue.drain()
    expect(runs(calls)).toEqual(['run charge_stop'])
    expect(calls).toContain('log baseline charging=true')
  })

  it('fires charge_start for a first push of "charging" when it was seeded as not charging', () => {
    const { queue } = setup()
    queue.seed(false)
    expect(queue.signal(true)).toBe('charge_start')
  })

  it('lets the first push set the baseline when it was never seeded', () => {
    const { queue } = setup()
    expect(queue.signal(false)).toBeNull()
  })

  it('does not let a seed replace a state a push already set', () => {
    const { queue } = setup()
    queue.signal(false)
    queue.seed(true)
    expect(queue.signal(true)).toBe('charge_start')
  })

  it('logs a heartbeat with the age of the last push, and says when none has come', () => {
    let now = NOW
    const { queue, calls } = setup(null, { now: () => now })
    queue.heartbeat()
    expect(calls).toContain('log listening, no push yet')
    queue.signal(false)
    now = new Date(NOW.getTime() + 12 * 60_000)
    queue.heartbeat()
    expect(calls).toContain('log listening, last push 12 min ago')
  })

  it('runs nothing for the baseline and nothing while the state holds', async () => {
    const { queue, calls } = setup()
    queue.signal(false)
    queue.signal(false)
    expect(await queue.drain()).toBeNull()
    expect(runs(calls)).toEqual([])
  })

  it('runs the collector once for a charge start', async () => {
    const { queue, calls } = setup()
    queue.signal(false)
    queue.signal(true)
    queue.signal(true)
    expect(await queue.drain()).toBeNull()
    expect(runs(calls)).toEqual(['run charge_start'])
    expect(queue.pending()).toEqual([])
  })

  it('runs when the last run ended exactly two minutes ago, not a second sooner', async () => {
    const early = setup(new Date(NOW.getTime() - COALESCE_MS + 1_000))
    early.queue.signal(false)
    early.queue.signal(true)
    expect(await early.queue.drain()).toBe(1_000)
    expect(runs(early.calls)).toEqual([])
    expect(early.queue.pending()).toEqual(['charge_start'])

    const due = setup(new Date(NOW.getTime() - COALESCE_MS))
    due.queue.signal(false)
    due.queue.signal(true)
    await due.queue.drain()
    expect(runs(due.calls)).toEqual(['run charge_start'])
  })

  it('runs a start and a stop that arrive together as two runs, oldest first, one per drain', async () => {
    const { queue, calls } = setup(minutesBefore(10))
    queue.signal(false)
    queue.signal(true)
    queue.signal(false)
    expect(await queue.drain()).toBe(COALESCE_MS)
    expect(runs(calls)).toEqual(['run charge_start'])
    expect(await queue.drain()).toBeNull()
    expect(runs(calls)).toEqual(['run charge_start', 'run charge_stop'])
  })

  it('keeps the event and retries after two minutes when a run fails', async () => {
    let fail = true
    const { queue, calls } = setup(null, {
      run: async (event) => {
        calls.push(`run ${event}`)
        if (fail) throw new Error('the reader timed out')
      },
    })
    queue.signal(false)
    queue.signal(true)
    expect(await queue.drain()).toBe(COALESCE_MS)
    expect(queue.pending()).toEqual(['charge_start'])
    expect(calls.join('\n')).toContain('the reader timed out')
    fail = false
    expect(await queue.drain()).toBeNull()
    expect(queue.pending()).toEqual([])
  })

  it(`gives up on an event after ${MAX_ATTEMPTS} failed runs and goes on to the next`, async () => {
    const { queue, calls } = setup(null, {
      run: async (event) => {
        calls.push(`run ${event}`)
        if (event === 'charge_start') throw new Error('broken login')
      },
    })
    queue.signal(false)
    queue.signal(true)
    queue.signal(false)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await queue.drain()
    expect(runs(calls)).toEqual(Array(MAX_ATTEMPTS).fill('run charge_start'))
    expect(queue.pending()).toEqual(['charge_stop'])
    expect(calls.join('\n')).toContain(`giving up on charge_start after ${MAX_ATTEMPTS} failed runs`)
    await queue.drain()
    expect(runs(calls).at(-1)).toBe('run charge_stop')
  })
})

describe('seedFromState', () => {
  it('is charging when the collector has a session open, and not when it has none', () => {
    expect(seedFromState({ lastAt: null, open: null })).toBe(false)
    expect(
      seedFromState({
        lastAt: '2026-11-24T09:00:00.000Z',
        open: { startedAt: '2026-11-24T07:00:00.000Z', startSoc: 40, lastAt: '2026-11-24T09:00:00.000Z', lastSoc: 60, odometerKm: 1 },
      }),
    ).toBe(true)
  })
})
