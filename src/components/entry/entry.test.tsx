// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { ApiError, SessionEndedError, ValidationApiError, type ApiClient } from '@/lib/api'
import { fixtureVehicle } from '@/lib/dashboard/fixtures'
import type { DashboardResult } from '@/lib/dashboard/types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NO_VEHICLE: DashboardResult = {
  kind: 'ready',
  data: { vehicle: null, sessions: [], observations: [], features: [], tripReadings: [], chargeInProgress: null },
}
const WITH_VEHICLE: DashboardResult = {
  kind: 'ready',
  data: { vehicle: fixtureVehicle, sessions: [], observations: [], features: [], tripReadings: [], chargeInProgress: null },
}

function fakeApi(result: DashboardResult = WITH_VEHICLE) {
  const created = async () => ({}) as never
  const api = {
    me: vi.fn(async () => ({ subject: 'user-1', email: 'owner@example.com' })),
    dashboard: vi.fn(async () => result),
    createVehicle: vi.fn<ApiClient['createVehicle']>(created),
    createChargingSession: vi.fn<ApiClient['createChargingSession']>(created),
    createRangeObservation: vi.fn<ApiClient['createRangeObservation']>(created),
    createVehicleFeature: vi.fn<ApiClient['createVehicleFeature']>(created),
  } satisfies ApiClient
  return api
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(api: ApiClient) {
  await act(async () => root.render(<App api={api} />))
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => name.test(candidate.textContent ?? ''))
  if (!found) throw new Error(`no button matching ${name}`)
  return found
}

function maybeButton(name: RegExp) {
  return [...container.querySelectorAll('button')].find((candidate) => name.test(candidate.textContent ?? ''))
}

async function click(name: RegExp) {
  await act(async () => button(name).click())
}

function control(label: string): HTMLInputElement | HTMLSelectElement {
  const labelElement = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim().startsWith(label))
  const target = labelElement?.htmlFor ? container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${CSS.escape(labelElement.htmlFor)}`) : null
  if (!target) throw new Error(`no control labelled ${label}`)
  return target
}

async function fill(label: string, value: string) {
  const element = control(label)
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function submit() {
  await act(async () => container.querySelector('form')?.requestSubmit())
}

function heading() {
  return container.querySelector('[data-slot="page-header"] h1')?.textContent
}

describe('entry points on the dashboard', () => {
  it('offers only "Add vehicle" until there is a vehicle', async () => {
    await render(fakeApi(NO_VEHICLE))
    expect(maybeButton(/add vehicle/i)).toBeDefined()
    expect(maybeButton(/log charge/i)).toBeUndefined()
    expect(maybeButton(/log range/i)).toBeUndefined()
    expect(maybeButton(/add feature/i)).toBeUndefined()
  })

  it('offers the three entries once there is a vehicle, and no second vehicle', async () => {
    await render(fakeApi())
    expect(maybeButton(/log charge/i)).toBeDefined()
    expect(maybeButton(/log range/i)).toBeDefined()
    expect(maybeButton(/add feature/i)).toBeDefined()
    expect(maybeButton(/add vehicle/i)).toBeUndefined()
  })

  it('offers no entry while the dashboard is loading, failed, or the database is not set up', async () => {
    const api = fakeApi()
    api.dashboard.mockResolvedValueOnce({ kind: 'schema-missing' })
    await render(api)
    expect(container.querySelector('[data-slot="page-header-actions"]')?.textContent).not.toMatch(/add|log/i)
  })
})

describe('the form page frame', () => {
  it('uses the page header with one h1, and a Cancel in its actions', async () => {
    await render(fakeApi(NO_VEHICLE))
    await click(/add vehicle/i)

    expect(heading()).toBe('Add your vehicle')
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelector('[data-slot="page-header-actions"]')?.textContent).toMatch(/cancel/i)
  })

  it('goes back to the dashboard on Cancel without saving, and reloads it', async () => {
    const api = fakeApi(NO_VEHICLE)
    await render(api)
    await click(/add vehicle/i)
    await fill('Nickname', 'Atto')
    await click(/cancel/i)

    expect(heading()).toBe('ATTO1 dashboard')
    expect(api.createVehicle).not.toHaveBeenCalled()
  })
})

describe('adding a vehicle', () => {
  it('saves the typed input, then returns to a freshly loaded dashboard', async () => {
    const api = fakeApi(NO_VEHICLE)
    await render(api)
    await click(/add vehicle/i)
    await fill('Nickname', ' Atto ')
    await fill('VIN', 'lc0ce4cb5r1234567')
    await fill('Model year', '2024')
    await submit()

    expect(api.createVehicle).toHaveBeenCalledWith({
      nickname: 'Atto',
      vin: 'LC0CE4CB5R1234567',
      model_year: 2024,
      variant: null,
      battery_capacity_kwh: null,
      purchased_on: null,
    })
    expect(heading()).toBe('ATTO1 dashboard')
    expect(api.dashboard).toHaveBeenCalledTimes(2)
  })

  it('shows client-side problems beside their fields and sends nothing', async () => {
    const api = fakeApi(NO_VEHICLE)
    await render(api)
    await click(/add vehicle/i)
    await fill('VIN', 'SHORT')
    await submit()

    expect(api.createVehicle).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Required')
    expect(container.textContent).toMatch(/17 characters/)
    expect(control('Nickname').getAttribute('aria-invalid')).toBe('true')
    expect(heading()).toBe('Add your vehicle')
  })
})

describe('logging a charging session', () => {
  it('sends the dashboard vehicle with the typed values', async () => {
    const api = fakeApi()
    await render(api)
    await click(/log charge/i)
    expect(heading()).toBe('Log a charging session')

    await fill('Started', '2026-10-07T11:00')
    await fill('Energy added', '32.5')
    await fill('Charger type', 'dc_fast')
    await fill('Cost', '12.50')
    await submit()

    expect(api.createChargingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        vehicle_id: fixtureVehicle.id,
        started_at: new Date('2026-10-07T11:00').toISOString(),
        energy_kwh: 32.5,
        charger_type: 'dc_fast',
        cost_cents: 1250,
        currency: 'AUD',
      }),
    )
    expect(heading()).toBe('ATTO1 dashboard')
  })
})

describe('logging a range reading', () => {
  it('sends charge, range and climate', async () => {
    const api = fakeApi()
    await render(api)
    await click(/log range/i)
    await fill('Charge', '80')
    await fill('Displayed range', '330')
    await fill('Climate control', 'on')
    await submit()

    expect(api.createRangeObservation).toHaveBeenCalledWith({
      vehicle_id: fixtureVehicle.id,
      soc_pct: 80,
      displayed_range_km: 330,
      odometer_km: null,
      outside_temp_c: null,
      climate_on: true,
      notes: null,
    })
  })
})

describe('adding a feature', () => {
  it('sends the category, name and value', async () => {
    const api = fakeApi()
    await render(api)
    await click(/add feature/i)
    await fill('Category', 'charging')
    await fill('Name', 'Max AC rate')
    await fill('Value', '7')
    await fill('Unit', 'kW')
    await submit()

    expect(api.createVehicleFeature).toHaveBeenCalledWith({
      vehicle_id: fixtureVehicle.id,
      category: 'charging',
      name: 'Max AC rate',
      value: '7',
      unit: 'kW',
      manual_reference: null,
      notes: null,
    })
  })
})

describe('when the Worker refuses', () => {
  async function openVehicleForm(api: ApiClient) {
    await render(api)
    await click(/add vehicle/i)
    await fill('Nickname', 'Atto')
  }

  it("shows the Worker's field messages beside the fields and keeps what was typed", async () => {
    const api = fakeApi(NO_VEHICLE)
    api.createVehicle.mockRejectedValueOnce(new ValidationApiError('/api/vehicles', { vin: 'VIN is not valid' }))
    await openVehicleForm(api)
    await submit()

    expect(container.textContent).toContain('VIN is not valid')
    expect(control('VIN').getAttribute('aria-invalid')).toBe('true')
    expect(control('Nickname').value).toBe('Atto')
    expect(heading()).toBe('Add your vehicle')
  })

  it('says a duplicate already exists on a 409, and keeps the form', async () => {
    const api = fakeApi(NO_VEHICLE)
    api.createVehicle.mockRejectedValueOnce(new ApiError('/api/vehicles', 409))
    await openVehicleForm(api)
    await submit()

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/already/i)
    expect(control('Nickname').value).toBe('Atto')
  })

  it('shows the failure on any other error, and lets the owner try again', async () => {
    const api = fakeApi(NO_VEHICLE)
    api.createVehicle.mockRejectedValueOnce(new ApiError('/api/vehicles', 500))
    await openVehicleForm(api)
    await submit()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('/api/vehicles answered 500')
    expect(button(/save vehicle/i).disabled).toBe(false)

    await submit()
    expect(api.createVehicle).toHaveBeenCalledTimes(2)
    expect(heading()).toBe('ATTO1 dashboard')
  })

  it('asks the owner to reload when the sign-in ended mid-save', async () => {
    const api = fakeApi(NO_VEHICLE)
    api.createVehicle.mockRejectedValueOnce(new SessionEndedError())
    await openVehicleForm(api)
    await submit()

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/sign-in has ended/i)
  })

  it('disables Save while a save is in flight, so a double click writes once', async () => {
    const api = fakeApi(NO_VEHICLE)
    let finish: () => void = () => undefined
    api.createVehicle.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({} as never) }))
    await openVehicleForm(api)
    await submit()

    expect(button(/saving/i).disabled).toBe(true)
    await submit()
    expect(api.createVehicle).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    expect(heading()).toBe('ATTO1 dashboard')
  })
})
