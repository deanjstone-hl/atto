// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureObservations } from '@/lib/dashboard/fixtures'
import { buildRangeTrend } from '@/lib/dashboard/shape'
import { RangeTrendCard } from './range-trend-card'

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

async function render() {
  const trend = buildRangeTrend(fixtureObservations)
  await act(async () => root.render(<RangeTrendCard trend={trend} />))
  return trend
}

describe('RangeTrendCard', () => {
  it('names the direction of the change in words, not by colour or an icon alone', async () => {
    const trend = await render()
    const words = { up: 'Rising', down: 'Falling', flat: 'Steady' } as const
    expect(trend.direction).not.toBeNull()
    expect(container.textContent).toContain(words[trend.direction ?? 'flat'])
  })

  it('draws the series from a design-system token, not a raw emerald', async () => {
    await render()
    const marks = [...container.querySelectorAll('polyline, span[title]')]
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) {
      expect(mark.getAttribute('class')).not.toMatch(/chart-2/)
    }
  })
})
