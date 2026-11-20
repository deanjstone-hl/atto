// The atto1 Worker (ADR-005): the API over D1, and the host of the built app.
//
// Every request, assets included, passes through verifyAccess first. Access in front
// of the hostname is the real sign-in; this check means a request that reaches the
// Worker some other way (a misconfigured route, a stray workers.dev URL) is refused
// rather than served.

import {
  AccessDenied,
  AccessNotConfigured,
  verifyAccess,
  type AccessDeps,
  type AccessEnv,
  type ServiceTokenRole,
} from './access'
import { acknowledgeTriggers, fileTrigger, listPending } from './collect'
import { loadDashboard } from './dashboard'
import type { D1Like } from './d1'
import { ingestByd } from './ingest'
import { json } from './json'
import { createRecord, isEntityName } from './writes'

export type Env = AccessEnv & {
  DB: D1Like
  ASSETS: { fetch(request: Request): Promise<Response> }
}

type ServicePath = {
  role: ServiceTokenRole
  method: 'GET' | 'POST'
  run: (request: Request, db: D1Like, ownerId: string) => Promise<Response>
}

const SERVICE_PATHS: Record<string, ServicePath> = {
  '/api/ingest/byd': { role: 'ingest', method: 'POST', run: ingestByd },
  '/api/collect/pending': { role: 'ingest', method: 'GET', run: (_request, db, ownerId) => listPending(db, ownerId) },
  '/api/collect/ack': { role: 'ingest', method: 'POST', run: acknowledgeTriggers },
  '/api/collect/trigger': { role: 'trigger', method: 'POST', run: fileTrigger },
}

export async function handle(request: Request, env: Env, deps: AccessDeps = {}): Promise<Response> {
  let identity
  try {
    identity = await verifyAccess(request, env, deps)
  } catch (error) {
    if (error instanceof AccessNotConfigured) {
      console.error(`atto1: Access is not configured: ${error.message}`)
      return json({ error: 'access_not_configured' }, 503)
    }
    if (error instanceof AccessDenied) {
      // The reason stays in the log; the caller learns only that it was refused.
      console.warn(`atto1: Access refused a request: ${error.message}`)
      return json({ error: 'unauthorized' }, 401)
    }
    throw error
  }

  const { pathname } = new URL(request.url)

  // A service token is not a person: each reaches its own paths and nothing else (ADR-006),
  // and a signed-in person uses none of them. The collector's token ingests and reads and
  // acknowledges the pending triggers; the phone's token files a trigger (atto/6).
  const servicePath = SERVICE_PATHS[pathname]
  if (servicePath !== undefined) {
    if (identity.serviceToken !== servicePath.role) return json({ error: 'forbidden' }, 403)
    if (request.method !== servicePath.method) {
      return json({ error: 'method_not_allowed' }, 405, { allow: servicePath.method })
    }
    return servicePath.run(request, env.DB, identity.subject)
  }
  if (identity.serviceToken) return json({ error: 'forbidden' }, 403)

  if (pathname !== '/api' && !pathname.startsWith('/api/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    return env.ASSETS.fetch(request)
  }

  // POST /api/<table> adds a row for the caller; every other API route is a read.
  const writeTarget = pathname.slice('/api/'.length)
  if (isEntityName(writeTarget)) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
    return createRecord(request, env.DB, identity.subject, writeTarget)
  }

  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  }

  if (pathname === '/api/me') {
    return json({ subject: identity.subject, email: identity.email })
  }
  if (pathname === '/api/dashboard') {
    try {
      return json(await loadDashboard(env.DB, identity.subject))
    } catch (error) {
      console.error('atto1: dashboard load failed', error)
      return json({ error: 'dashboard_unavailable' }, 500)
    }
  }
  return json({ error: 'not_found' }, 404)
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
} satisfies { fetch: (request: Request, env: Env) => Promise<Response> }
