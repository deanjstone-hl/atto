// When the collector last ran, whichever timer started it (atto/6). The trigger pick-up
// reads it so a connect right after a run waits two minutes instead of polling the car
// again at once. A plain file in the collector's state directory holding only a time.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function fileLastRun(path: string) {
  return {
    async load(): Promise<Date | null> {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      try {
        const at = new Date((JSON.parse(text) as { at?: unknown }).at as string)
        return Number.isNaN(at.getTime()) ? null : at
      } catch {
        // The debounce is a courtesy: a damaged file must not stop a trip being recorded.
        return null
      }
    },
    async save(at: Date): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify({ at: at.toISOString() }))
      await rename(temporary, path)
    },
  }
}
