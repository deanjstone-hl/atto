import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileAttempts } from './attempts.ts'

const pathIn = () => join(mkdtempSync(join(tmpdir(), 'atto1-attempts-')), 'trigger-attempts.json')

describe('fileAttempts', () => {
  it('starts empty, then returns the counts it was given', async () => {
    const store = fileAttempts(pathIn())
    expect(await store.load()).toEqual({})
    await store.save({ t1: 2 })
    expect(await store.load()).toEqual({ t1: 2 })
  })

  it('keeps only trigger ids and counts in the file', async () => {
    const path = pathIn()
    await fileAttempts(path).save({ t1: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ t1: 1 })
  })

  it('treats a damaged file as no attempts: the retry bound is a courtesy, not a reason to stop', async () => {
    const path = pathIn()
    writeFileSync(path, '{not json')
    expect(await fileAttempts(path).load()).toEqual({})
    writeFileSync(path, JSON.stringify({ t1: 'many', t2: 2, t3: -1 }))
    expect(await fileAttempts(path).load()).toEqual({ t2: 2 })
  })
})
