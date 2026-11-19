import { describe, expect, it, vi } from 'vitest'
import { ApiError, SessionEndedError, ValidationApiError, createApiClient } from './api'

function respond(body: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), init))
}

describe('createApiClient', () => {
  it('reads the signed-in identity from /api/me with the session cookie', async () => {
    const fetchImpl = respond({ subject: 's', email: 'owner@example.com' })
    await expect(createApiClient(fetchImpl).me()).resolves.toEqual({ subject: 's', email: 'owner@example.com' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'manual',
    })
  })

  it('reads the dashboard from /api/dashboard', async () => {
    const result = { kind: 'schema-missing' }
    const fetchImpl = respond(result)
    await expect(createApiClient(fetchImpl).dashboard()).resolves.toEqual(result)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/dashboard')
  })

  it.each([401, 403])('reports an ended session on a %i', async (status) => {
    await expect(createApiClient(respond({}, { status })).me()).rejects.toBeInstanceOf(SessionEndedError)
  })

  it('reports an ended session when Access redirects to its login page', async () => {
    const redirected = new Response(null, { status: 200 })
    Object.defineProperty(redirected, 'type', { value: 'opaqueredirect' })
    await expect(createApiClient(vi.fn<typeof fetch>(async () => redirected)).dashboard()).rejects.toBeInstanceOf(SessionEndedError)
  })

  it('throws an ApiError naming the path and status for any other failure', async () => {
    const result = createApiClient(respond({}, { status: 500 })).dashboard()
    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toThrow('/api/dashboard answered 500')
  })

  it('lets a network failure through as it is', async () => {
    const client = createApiClient(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(client.me()).rejects.toThrow('Failed to fetch')
  })
})

describe('creating records', () => {
  const created = { id: 'new-id', nickname: 'Atto' }

  it.each([
    ['createVehicle', '/api/vehicles', { nickname: 'Atto' }],
    ['createChargingSession', '/api/charging-sessions', { vehicle_id: 'v', started_at: '2026-10-07T01:00:00.000Z', energy_kwh: 10, charger_type: 'ac_home' }],
    ['createRangeObservation', '/api/range-observations', { vehicle_id: 'v', soc_pct: 50, displayed_range_km: 200 }],
    ['createVehicleFeature', '/api/vehicle-features', { vehicle_id: 'v', category: 'battery', name: 'n', value: 'v' }],
  ] as const)('%s posts JSON to %s and returns the created row', async (method, path, input) => {
    const fetchImpl = respond(created, { status: 201 })
    const client = createApiClient(fetchImpl)

    await expect((client[method] as (input: unknown) => Promise<unknown>)(input)).resolves.toEqual(created)

    expect(fetchImpl).toHaveBeenCalledWith(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(input),
      credentials: 'same-origin',
      redirect: 'manual',
    })
  })

  it('throws a ValidationApiError carrying the Worker\'s field messages on a 422', async () => {
    const client = createApiClient(
      respond({ error: 'validation_failed', fields: { nickname: 'Nickname is required' } }, { status: 422 }),
    )
    const result = client.createVehicle({ nickname: '' })
    await expect(result).rejects.toBeInstanceOf(ValidationApiError)
    await expect(result).rejects.toMatchObject({ fields: { nickname: 'Nickname is required' } })
  })

  it('keeps a 404 for a missing vehicle as an ApiError with its status', async () => {
    const client = createApiClient(respond({ error: 'vehicle_not_found' }, { status: 404 }))
    await expect(client.createChargingSession({} as never)).rejects.toMatchObject({ name: 'ApiError', status: 404 })
  })

  it('keeps a 409 as an ApiError with its status', async () => {
    const client = createApiClient(respond({ error: 'already_exists' }, { status: 409 }))
    await expect(client.createVehicle({ nickname: 'A' })).rejects.toMatchObject({ name: 'ApiError', status: 409 })
  })

  it.each([401, 403])('reports an ended session on a %i', async (status) => {
    await expect(createApiClient(respond({}, { status })).createVehicle({ nickname: 'A' })).rejects.toBeInstanceOf(
      SessionEndedError,
    )
  })
})
