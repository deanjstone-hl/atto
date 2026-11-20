// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureTripReadings } from '@/lib/dashboard/fixtures'
import { buildTrips } from '@/lib/dashboard/trips'
import { mapUrl } from './format'
import { TripsCard } from './trips-card'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

async function render(trips = buildTrips(fixtureTripReadings, 30)) {
  await act(async () => root.render(<TripsCard trips={trips} />))
}

describe('TripsCard', () => {
  it('shows each trip newest first, the one still open as in progress', async () => {
    await render()
    const items = [...container.querySelectorAll('li')]
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('In progress')
    expect(items[1].textContent).not.toContain('In progress')
  })

  it('shows a finished trip\'s duration, distance, charge, energy and range used', async () => {
    await render()
    const text = container.querySelectorAll('li')[1].textContent ?? ''
    expect(text).toContain('40m')
    expect(text).toContain('26 km')
    expect(text).toContain('8%')
    expect(text).toContain('2.4 kWh')
    expect(text).toContain('22 km range')
  })

  it('links the start and end points to a map without calling a geocoder', async () => {
    await render()
    const hrefs = [...container.querySelectorAll('li')[1].querySelectorAll('a')].map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual([mapUrl({ latitude: 0, longitude: 0 }), mapUrl({ latitude: 0.01, longitude: 0.01 })])
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('rel')).toContain('noopener')
      expect(link.getAttribute('rel')).toContain('noreferrer')
    }
  })

  it('says so when a trip has no position, and leaves out what it could not work out', async () => {
    const [open, ...rest] = fixtureTripReadings
    const bare = [{ ...open, latitude: null, longitude: null, odometer_km: null }, ...rest]
    await render(buildTrips(bare, null))
    const first = container.querySelectorAll('li')[0]
    expect(first.querySelectorAll('a')).toHaveLength(0)
    expect(first.textContent).toContain('Start: no position')
    expect(container.querySelectorAll('li')[1].textContent).not.toContain('kWh')
  })

  it('shows an empty state with no trips', async () => {
    await render([])
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(container.textContent).toContain('No trips yet')
  })
})

describe('mapUrl', () => {
  it('is an OpenStreetMap link and puts the coordinates only in the link', () => {
    expect(mapUrl({ latitude: 1.5, longitude: -2.25 })).toBe(
      'https://www.openstreetmap.org/?mlat=1.5&mlon=-2.25#map=16/1.5/-2.25',
    )
  })
})
