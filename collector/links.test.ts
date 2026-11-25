import { describe, expect, it } from 'vitest'
import { workerUrl } from './links.ts'

describe('workerUrl', () => {
  it('is the atto1 root from the links registry when ATTO1_URL is not set', () => {
    expect(workerUrl({})).toBe('https://atto1.myargus.cc/')
  })

  it('swaps only the origin when ATTO1_URL is set, for a local or preview run', () => {
    expect(workerUrl({ ATTO1_URL: 'http://localhost:8787' })).toBe('http://localhost:8787/')
    expect(workerUrl({ ATTO1_URL: 'https://atto1-preview.example.org/' })).toBe('https://atto1-preview.example.org/')
  })

  it('refuses an ATTO1_URL that carries a path, since the env var may override an origin only', () => {
    expect(() => workerUrl({ ATTO1_URL: 'https://atto1.example.org/api' })).toThrow(/no path/)
  })

  it('refuses an ATTO1_URL that is not a URL, rather than falling back to a host', () => {
    expect(() => workerUrl({ ATTO1_URL: 'not a url' })).toThrow(/not a URL/)
    expect(() => workerUrl({ ATTO1_URL: '' })).toThrow(/not a URL/)
  })
})
