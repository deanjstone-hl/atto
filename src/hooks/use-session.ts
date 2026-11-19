import { useEffect, useState } from 'react'
import { SessionEndedError, type ApiClient, type Identity } from '@/lib/api'

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; identity: Identity }
  | { status: 'ended' }
  | { status: 'error'; message: string }

// Asks the Worker who is signed in. Cloudflare Access has already signed the user in
// before the app loads, so this only answers "who", and notices when the Access session
// ends while the page is open.
export function useSession(api: ApiClient): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const identity = await api.me()
        if (!cancelled) setState({ status: 'signed-in', identity })
      } catch (error) {
        if (cancelled) return
        if (error instanceof SessionEndedError) setState({ status: 'ended' })
        else setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [api])

  return state
}
