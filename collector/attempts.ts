// How many times a pending trigger has had a run that failed (atto/16). The trigger pick-up
// leaves a trigger pending after a failed run so a later tick can try again; this count is
// what ends the retries. A plain file in the collector's state directory holding only
// trigger ids and counts; the Worker already stops listing a trigger after 30 minutes, so
// the file never grows past what is pending.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Attempts = Record<string, number>

export function fileAttempts(path: string) {
  return {
    async load(): Promise<Attempts> {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      }
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null) return {}
        const attempts: Attempts = {}
        for (const [id, count] of Object.entries(parsed)) {
          if (typeof count === 'number' && Number.isInteger(count) && count > 0) attempts[id] = count
        }
        return attempts
      } catch {
        // The bound is a courtesy: a damaged file must not stop a trip being recorded.
        return {}
      }
    },
    async save(attempts: Attempts): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify(attempts))
      await rename(temporary, path)
    },
  }
}
