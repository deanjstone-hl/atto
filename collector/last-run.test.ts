import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileLastRun } from './last-run.ts'

const pathIn = () => join(mkdtempSync(join(tmpdir(), 'atto1-last-run-')), 'last-run.json')

describe('fileLastRun', () => {
  it('starts with no run, then returns the last time it was given', async () => {
    const store = fileLastRun(pathIn())
    expect(await store.load()).toBeNull()
    await store.save(new Date('2026-11-21T01:02:03.000Z'))
    expect((await store.load())?.toISOString()).toBe('2026-11-21T01:02:03.000Z')
  })

  it('keeps nothing but the time in the file', async () => {
    const path = pathIn()
    await fileLastRun(path).save(new Date('2026-11-21T01:02:03.000Z'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ at: '2026-11-21T01:02:03.000Z' })
  })

  it('treats a file it cannot read as no run: the debounce is a courtesy, not a reason to stop', async () => {
    const path = pathIn()
    writeFileSync(path, '{not json')
    expect(await fileLastRun(path).load()).toBeNull()
    writeFileSync(path, JSON.stringify({ at: 'yesterday' }))
    expect(await fileLastRun(path).load()).toBeNull()
  })
})
