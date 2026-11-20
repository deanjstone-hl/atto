import { describe, expect, it, vi } from 'vitest'
import { ackTriggers, COALESCE_MS, fetchPending, pickUp, type PickUpDeps, type PendingTrigger } from './trigger.ts'

// The homelab pick-up (atto/6): every minute, ask the Worker what is pending; when something
// is, run the collector once for the newest event and acknowledge what that run covered.

const NOW = new Date('2026-11-21T10:00:00.000Z')
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

const trigger = (id: string, event: string, minutesAgo: number): PendingTrigger => ({
  id,
  event,
  requested_at: minutesBefore(minutesAgo).toISOString(),
})

function setup(pending: PendingTrigger[], lastRun: Date | null = null, overrides: Partial<PickUpDeps> = {}) {
  const calls: string[] = []
  const deps: PickUpDeps = {
    fetchPending: async () => pending,
    ack: async (ids) => {
      calls.push(`ack ${ids.join(',')}`)
    },
    run: async (event) => {
      calls.push(`run ${event}`)
    },
    loadLastRun: async () => lastRun,
    saveLastRun: async (at) => {
      calls.push(`saved ${at.toISOString()}`)
    },
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  }
  return { deps, calls }
}

describe('pickUp', () => {
  it('does nothing when nothing is pending, and does not touch the car', async () => {
    const { deps, calls } = setup([])
    expect(await pickUp(deps)).toBe('idle')
    expect(calls).toEqual([])
  })

  it('runs once for a pending trigger, then records the run and acknowledges it', async () => {
    const { deps, calls } = setup([trigger('t1', 'carplay_connect', 1)])
    expect(await pickUp(deps)).toBe('ran')
    expect(calls).toEqual(['run carplay_connect', `saved ${NOW.toISOString()}`, 'ack t1'])
  })

  it('coalesces triggers filed close together into one run, tagged with the newest event', async () => {
    const { deps, calls } = setup([trigger('t1', 'carplay_connect', 1.5), trigger('t2', 'carplay_disconnect', 0.5)])
    await pickUp(deps)
    expect(calls.filter((call) => call.startsWith('run'))).toEqual(['run carplay_disconnect'])
    expect(calls).toContain('ack t1,t2')
  })

  it('takes the newest event by request time, whatever order the list came in', async () => {
    const { deps, calls } = setup([trigger('t2', 'carplay_disconnect', 0.5), trigger('t1', 'carplay_connect', 1.5)])
    await pickUp(deps)
    expect(calls).toContain('run carplay_disconnect')
  })

  it('waits, leaving the trigger pending, when the last run was under two minutes ago', async () => {
    const { deps, calls } = setup([trigger('t1', 'carplay_connect', 0.2)], minutesBefore(1.9))
    expect(await pickUp(deps)).toBe('waiting')
    expect(calls).toEqual([])
  })

  it('runs once the last run is two minutes old', async () => {
    expect(COALESCE_MS).toBe(2 * 60_000)
    const { deps, calls } = setup([trigger('t1', 'carplay_connect', 2)], minutesBefore(2))
    expect(await pickUp(deps)).toBe('ran')
    expect(calls).toContain('run carplay_connect')
  })

  it('counts a timer run as the last run: the trigger waits for it, then still gets its own tagged reading', async () => {
    const { deps, calls } = setup([trigger('t1', 'carplay_connect', 1)], minutesBefore(0.5))
    expect(await pickUp(deps)).toBe('waiting')
    expect(calls).toEqual([])
  })

  it('ignores an event it does not know, leaving it pending, and runs for the ones it does', async () => {
    const { deps, calls } = setup([trigger('t1', 'charge_start', 1), trigger('t2', 'carplay_connect', 0.5)])
    await pickUp(deps)
    expect(calls).toEqual(['run carplay_connect', `saved ${NOW.toISOString()}`, 'ack t2'])
  })

  it('stays idle when only unknown events are pending', async () => {
    const { deps, calls } = setup([trigger('t1', 'charge_start', 1)])
    expect(await pickUp(deps)).toBe('idle')
    expect(calls).toEqual([])
  })

  it('still acknowledges, and records the attempt, when the run fails, then reports the failure', async () => {
    const calls: string[] = []
    const { deps } = setup([trigger('t1', 'carplay_connect', 1)], null, {
      run: async () => {
        throw new Error('BYD login failed')
      },
      saveLastRun: async () => {
        calls.push('saved')
      },
      ack: async (ids) => {
        calls.push(`ack ${ids.join(',')}`)
      },
    })
    await expect(pickUp(deps)).rejects.toThrow('BYD login failed')
    expect(calls).toEqual(['saved', 'ack t1'])
  })

  it('does not hide a failed acknowledgement: the trigger stays pending and is retried', async () => {
    const { deps } = setup([trigger('t1', 'carplay_connect', 1)], null, {
      ack: async () => {
        throw new Error('the Worker answered 503 to the acknowledgement')
      },
    })
    await expect(pickUp(deps)).rejects.toThrow(/503/)
  })

  it('logs what it did without any position or credential', async () => {
    const log = vi.fn()
    const { deps } = setup([trigger('t1', 'carplay_connect', 1)], null, { log })
    await pickUp(deps)
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/carplay_connect/)
  })
})

describe('fetchPending and ackTriggers', () => {
  const target = { baseUrl: 'https://atto1.myargus.cc/', clientId: 'id.access', clientSecret: 's3cret' }
  const answer = (status: number, body: unknown = {}) => async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('lists pending triggers with the collector token, without following redirects', async () => {
    const fetcher = vi.fn(answer(200, { triggers: [{ id: 't1', event: 'carplay_connect', requested_at: '2026-11-21T09:59:00.000Z' }] }))
    expect(await fetchPending(target, fetcher)).toEqual([
      { id: 't1', event: 'carplay_connect', requested_at: '2026-11-21T09:59:00.000Z' },
    ])
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://atto1.myargus.cc/api/collect/pending')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    expect(headers.get('cf-access-client-id')).toBe('id.access')
    expect(headers.get('cf-access-client-secret')).toBe('s3cret')
  })

  it.each([302, 401, 403, 500])('treats a %s answer as a failure, not as nothing pending', async (status) => {
    await expect(fetchPending(target, answer(status))).rejects.toThrow(new RegExp(String(status)))
  })

  it('refuses an answer that is not a trigger list', async () => {
    await expect(fetchPending(target, answer(200, { triggers: 'x' }))).rejects.toThrow(/trigger list/)
    await expect(fetchPending(target, answer(200, { triggers: [{ id: 1 }] }))).rejects.toThrow(/trigger list/)
  })

  it('acknowledges the ids with the collector token', async () => {
    const fetcher = vi.fn(answer(200, { acked: 2 }))
    await ackTriggers(target, ['t1', 't2'], fetcher)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://atto1.myargus.cc/api/collect/ack')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.body).toBe(JSON.stringify({ trigger_ids: ['t1', 't2'] }))
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('fails when the acknowledgement is refused', async () => {
    await expect(ackTriggers(target, ['t1'], answer(503))).rejects.toThrow(/503/)
  })
})
