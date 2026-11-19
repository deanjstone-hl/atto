// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ApiError, SessionEndedError, type ApiClient, type Identity } from './lib/api'
import type { DashboardResult } from './lib/dashboard/types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const IDENTITY: Identity = { subject: 'user-1', email: 'owner@example.com' }
const EMPTY: DashboardResult = {
  kind: 'ready',
  data: { vehicle: null, sessions: [], observations: [], features: [] },
}

// Stands in for the Worker's API at the network boundary.
function fakeApi(options: { me?: () => Promise<Identity>; dashboard?: () => Promise<DashboardResult> } = {}) {
  const me = vi.fn(options.me ?? (async () => IDENTITY))
  const dashboard = vi.fn(options.dashboard ?? (async () => EMPTY))
  const unused = vi.fn(async () => Promise.reject(new Error('not used by this test')))
  const api = {
    me,
    dashboard,
    createVehicle: unused,
    createChargingSession: unused,
    createRangeObservation: unused,
    createVehicleFeature: unused,
  } satisfies ApiClient
  return { api, me, dashboard }
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

function dashboardHeading() {
  return [...container.querySelectorAll('h1')].find((heading) => heading.textContent === 'ATTO1 dashboard')
}

function signOutLink() {
  return [...container.querySelectorAll('a')].find((link) => /sign out/i.test(link.textContent ?? ''))
}

describe('signed-in gate', () => {
  it('shows nothing, and loads nothing, until the session is known', async () => {
    const fake = fakeApi({ me: () => new Promise(() => undefined) })
    await render(fake.api)

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(dashboardHeading()).toBeUndefined()
    expect(fake.dashboard).not.toHaveBeenCalled()
  })

  it('shows the dashboard once Access identifies the user', async () => {
    const fake = fakeApi()
    await render(fake.api)

    expect(dashboardHeading()).toBeDefined()
    expect(fake.dashboard).toHaveBeenCalledTimes(1)
  })

  it('signs out through the Access logout path', async () => {
    await render(fakeApi().api)

    expect(signOutLink()?.getAttribute('href')).toBe('/cdn-cgi/access/logout')
  })

  it('asks the user to reload when the Access session has ended, and loads nothing', async () => {
    const fake = fakeApi({
      me: async () => {
        throw new SessionEndedError()
      },
    })
    await render(fake.api)

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/sign-in has ended/i)
    expect(container.querySelector('button')?.textContent).toBe('Reload')
    expect(dashboardHeading()).toBeUndefined()
    expect(fake.dashboard).not.toHaveBeenCalled()
  })

  it('reloads the page from the session-ended prompt', async () => {
    const reload = vi.fn()
    // oxlint-disable-next-line typescript/no-misused-spread -- plain-object stand-in for Location with a stubbed reload
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload })
    await render(
      fakeApi({
        me: async () => {
          throw new SessionEndedError()
        },
      }).api,
    )
    await act(async () => container.querySelector('button')?.click())

    expect(reload).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('shows the failure, and loads nothing, when the Worker cannot be asked', async () => {
    const fake = fakeApi({
      me: async () => {
        throw new ApiError('/api/me', 503)
      },
    })
    await render(fake.api)

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('/api/me answered 503')
    expect(dashboardHeading()).toBeUndefined()
    expect(fake.dashboard).not.toHaveBeenCalled()
  })
})

describe('dashboard', () => {
  it('says the database is not set up when the migration has not been applied', async () => {
    await render(fakeApi({ dashboard: async () => ({ kind: 'schema-missing' }) }).api)

    expect(container.textContent).toContain('Database not set up yet')
  })

  it('shows the error when the dashboard cannot be loaded', async () => {
    await render(
      fakeApi({
        dashboard: async () => {
          throw new ApiError('/api/dashboard', 500)
        },
      }).api,
    )

    expect(container.textContent).toContain('Couldn\'t load the dashboard')
    expect(container.textContent).toContain('/api/dashboard answered 500')
  })
})

describe('dashboard page frame', () => {
  it('puts the title, description and Sign out in the page header', async () => {
    await render(fakeApi().api)

    const header = container.querySelector('[data-slot="page-header"]')
    expect(header?.querySelector('h1')?.textContent).toBe('ATTO1 dashboard')
    expect(header?.textContent).toMatch(/charge, range and charging history/i)
    expect(header?.querySelector('[data-slot="page-header-actions"]')?.textContent).toMatch(/sign out/i)
    expect(container.querySelectorAll('h1')).toHaveLength(1)
  })

  it('shows one empty page, not a notice over empty cards, when the database is not set up', async () => {
    await render(fakeApi({ dashboard: async () => ({ kind: 'schema-missing' }) }).api)

    const pages = container.querySelectorAll('[data-slot="empty"]')
    expect(pages).toHaveLength(1)
    expect(pages[0].textContent).toContain('Database not set up yet')
    expect(container.querySelector('[data-slot="page-header"] h1')?.textContent).toBe('ATTO1 dashboard')
  })

  it('shows the load error on an empty page', async () => {
    await render(
      fakeApi({
        dashboard: async () => {
          throw new ApiError('/api/dashboard', 500)
        },
      }).api,
    )

    const pages = container.querySelectorAll('[data-slot="empty"]')
    expect(pages).toHaveLength(1)
    expect(pages[0].textContent).toContain("Couldn't load the dashboard")
    expect(pages[0].textContent).toContain('/api/dashboard answered 500')
  })
})

describe('colour mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  it('follows the system switching to dark while the app is open', async () => {
    const listeners = new Set<(event: { matches: boolean }) => void>()
    const mediaQuery = {
      matches: false,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
        listeners.delete(listener),
    }
    vi.stubGlobal('matchMedia', () => mediaQuery)

    await render(fakeApi().api)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await act(async () => {
      for (const listener of listeners) listener({ matches: true })
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('ocean')
  })
})
