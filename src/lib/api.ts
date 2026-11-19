// The thin client for the Worker's API (worker/index.ts). The only code that talks to
// the network; hooks and components take an ApiClient so tests can pass a fake.

import type {
  ChargingSession,
  ChargingSessionInsert,
  RangeObservation,
  RangeObservationInsert,
  Vehicle,
  VehicleFeature,
  VehicleFeatureInsert,
  VehicleInsert,
} from './data-model/types'
import type { DashboardResult } from './dashboard/types'

export type Identity = {
  subject: string
  email: string | null
}

export type ApiClient = {
  me(): Promise<Identity>
  dashboard(): Promise<DashboardResult>
  createVehicle(input: VehicleInsert): Promise<Vehicle>
  createChargingSession(input: ChargingSessionInsert): Promise<ChargingSession>
  createRangeObservation(input: RangeObservationInsert): Promise<RangeObservation>
  createVehicleFeature(input: VehicleFeatureInsert): Promise<VehicleFeature>
}

// Cloudflare Access ended the session: the Worker said 401, or Access answered with a
// redirect to its login page. Reloading the page signs in again.
export class SessionEndedError extends Error {
  constructor() {
    super('Your sign-in has ended')
    this.name = 'SessionEndedError'
  }
}

export class ApiError extends Error {
  readonly status: number

  constructor(path: string, status: number) {
    super(`${path} answered ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

// The Worker refused a write because of what was entered. `fields` maps a field name
// to the message to show beside it.
export class ValidationApiError extends ApiError {
  readonly fields: Record<string, string>

  constructor(path: string, fields: Record<string, string>) {
    super(path, 422)
    this.name = 'ValidationApiError'
    this.fields = fields
  }
}

export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiClient {
  async function send(path: string, init: RequestInit): Promise<Response> {
    // `manual`: an Access redirect to the login page surfaces as an opaque redirect
    // instead of a cross-origin fetch that fails with no explanation.
    const response = await fetchImpl(path, { ...init, credentials: 'same-origin', redirect: 'manual' })
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
      throw new SessionEndedError()
    }
    return response
  }

  async function get<Body>(path: string): Promise<Body> {
    const response = await send(path, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new ApiError(path, response.status)
    return (await response.json()) as Body
  }

  async function post<Body>(path: string, input: unknown): Promise<Body> {
    const response = await send(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { fields?: Record<string, string> }
      throw new ValidationApiError(path, body.fields ?? {})
    }
    if (!response.ok) throw new ApiError(path, response.status)
    return (await response.json()) as Body
  }

  return {
    me: () => get<Identity>('/api/me'),
    dashboard: () => get<DashboardResult>('/api/dashboard'),
    createVehicle: (input) => post<Vehicle>('/api/vehicles', input),
    createChargingSession: (input) => post<ChargingSession>('/api/charging-sessions', input),
    createRangeObservation: (input) => post<RangeObservation>('/api/range-observations', input),
    createVehicleFeature: (input) => post<VehicleFeature>('/api/vehicle-features', input),
  }
}
