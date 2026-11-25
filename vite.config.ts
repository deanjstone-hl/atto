import path from 'path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  fixtureFeatures,
  fixtureObservations,
  fixtureSessions,
  fixtureTripReadings,
  fixtureVehicle,
} from './src/lib/dashboard/fixtures'

// `vite dev` has no Worker, no D1 and no Cloudflare Access, so it answers the API itself
// from the dashboard fixtures. Dev server only (`apply: 'serve'`): the build and the
// deployed Worker never contain it, and it cannot stand in for the Worker's Access check.
function devApi(): Plugin {
  const routes: Record<string, unknown> = {
    '/api/me': { subject: 'dev-user', email: 'dev@example.com' },
    '/api/dashboard': {
      kind: 'ready',
      data: {
        vehicle: fixtureVehicle,
        sessions: fixtureSessions.slice(0, 5),
        observations: fixtureObservations,
        features: fixtureFeatures,
        tripReadings: fixtureTripReadings,
        chargeInProgress: null,
      },
    },
  }
  return {
    name: 'atto1-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]
        // The fixtures cannot save anything; say so rather than pretend a write landed.
        if (request.method === 'POST' && path.startsWith('/api/')) {
          response.statusCode = 501
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ error: 'dev_server_cannot_save' }))
          return
        }
        const body = routes[path]
        if (body === undefined) return next()
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(body))
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devApi(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
