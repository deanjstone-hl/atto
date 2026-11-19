// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import { themeInitScript } from './lib/theme-preference'

function inlineHeadScript() {
  const head = indexHtml.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ''
  return head.match(/<script>([\s\S]*?)<\/script>/)?.[1]
}

function runHeadScript() {
  // oxlint-disable-next-line typescript/no-implied-eval -- the test must execute index.html's inline head script
  new Function(inlineHeadScript() ?? '')()
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.className = ''
})

afterEach(() => localStorage.clear())

describe('index.html theme bootstrap', () => {
  it('inlines the registry themeInitScript in <head>, unchanged', () => {
    expect(inlineHeadScript()).toBe(themeInitScript())
  })

  it('does not hand-force a colour mode on <html>', () => {
    expect(indexHtml).not.toMatch(/<html[^>]*class=/)
  })

  it('applies the stored dark preference before the app mounts', () => {
    localStorage.setItem('ds-theme', 'grove.dark')
    runHeadScript()

    expect(document.documentElement.dataset.theme).toBe('grove')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('falls back to Ocean in light when nothing is stored and the system is light', () => {
    runHeadScript()

    expect(document.documentElement.dataset.theme).toBe('ocean')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
