// The Worker's URL for the collector, built from the links registry (frontend ADR-0004).
//
// The collector runs under plain Node, which cannot resolve the `@/` alias inside the generated
// src/lib/links.ts, so it builds from the same links.json with the shared builders instead.
import registry from '../links.json' with { type: 'json' }
import { createLinks, type LinkRegistry } from '../src/lib/links-core.ts'

const { appUrl } = createLinks(registry as LinkRegistry)

// ATTO1_URL may swap the origin for a local or preview run and nothing else: no path, and no
// hardcoded fallback host (a malformed value throws instead of falling back).
export function workerUrl(env: NodeJS.ProcessEnv): string {
  return appUrl('atto1', { origin: env.ATTO1_URL })
}
