// The slice of Cloudflare's D1Database the Worker uses. D1Database satisfies it
// structurally, so the Worker needs no @cloudflare/workers-types, and tests can
// back it with an in-process SQLite (worker/test-support/sqlite-d1.ts).

export type D1Statement = {
  bind(...values: unknown[]): D1Statement
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>
  first<Row = Record<string, unknown>>(): Promise<Row | null>
}

export type D1Like = {
  prepare(query: string): D1Statement
}
