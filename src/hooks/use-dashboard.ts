import { useEffect, useState } from 'react'
import type { ApiClient } from '@/lib/api'
import type { DashboardResult } from '@/lib/dashboard/types'

export type DashboardState =
  | { status: 'loading' }
  | { status: 'ready'; result: DashboardResult }
  | { status: 'error'; message: string }

export function useDashboard(api: ApiClient): DashboardState {
  const [state, setState] = useState<DashboardState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await api.dashboard()
        if (!cancelled) setState({ status: 'ready', result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setState({ status: 'error', message })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [api])

  return state
}
