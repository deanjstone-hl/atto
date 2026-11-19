import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { D1Like, D1Statement } from '../d1'

const migrationsDir = join(import.meta.dirname, '..', '..', 'migrations')

// An in-memory SQLite with every migration applied, in file-name order as
// `wrangler d1 migrations apply` does, and foreign keys on as D1 has them.
// node:sqlite and D1 are both stock SQLite, but this is a stand-in: the owner's
// `wrangler d1 migrations apply --remote` is the first run against real D1.
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('pragma foreign_keys = on')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of files) db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  return db
}

export function d1Over(db: DatabaseSync): D1Like {
  function statement(query: string, values: SQLInputValue[]): D1Statement {
    return {
      bind: (...next) => statement(query, next as SQLInputValue[]),
      all: async <Row>() => ({ results: db.prepare(query).all(...values) as Row[] }),
      first: async <Row>() => (db.prepare(query).get(...values) as Row | undefined) ?? null,
    }
  }
  return { prepare: (query) => statement(query, []) }
}
