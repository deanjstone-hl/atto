import { SessionEnded } from '@/components/auth/session-ended'
import { SignOutLink } from '@/components/auth/sign-out-link'
import { Dashboard } from '@/components/dashboard/dashboard'
import { EntryPage } from '@/components/entry/entry-page'
import type { Entry } from '@/components/entry/entry'
import { useSession } from '@/hooks/use-session'
import { useThemePreference } from '@/hooks/use-theme-preference'
import type { ApiClient } from '@/lib/api'
import { COOKIE_DOMAIN } from '@/lib/links'
import { useState } from 'react'

// Cloudflare Access signs the user in before this page is served, and the Worker
// refuses any API call without its token. This gate only asks the Worker who is
// signed in, so the dashboard is not mounted (and loads nothing) until that is known,
// and it replaces the dashboard with a prompt if the Access session ends.
function App({ api }: { api: ApiClient }) {
  const session = useSession(api)
  const [entry, setEntry] = useState<Entry | null>(null)
  // No theme picker yet, so this only keeps a System preference live when the OS
  // flips light/dark. The cookie domain is the links registry's, shared across the myargus apps.
  useThemePreference({ cookieDomain: COOKIE_DOMAIN })

  if (session.status === 'loading') {
    return <main className="min-h-svh" aria-busy="true" aria-label="Checking sign-in" />
  }

  if (session.status === 'ended') return <SessionEnded />

  if (session.status === 'error') {
    return (
      <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center p-4 sm:p-6">
        <p role="alert" className="text-sm text-destructive">
          Couldn't check your sign-in: {session.message}
        </p>
      </main>
    )
  }

  // Leaving an entry page unmounts it and remounts the dashboard, which reloads, so a
  // saved row shows up without any cache to invalidate.
  if (entry !== null) {
    return <EntryPage api={api} entry={entry} onSaved={() => setEntry(null)} onCancel={() => setEntry(null)} />
  }

  return <Dashboard api={api} headerAction={<SignOutLink />} onAdd={setEntry} />
}

export default App
