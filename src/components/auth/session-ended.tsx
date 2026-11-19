import { LockKeyhole } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Shown when Cloudflare Access ends the session under an open page. Reloading sends
// the browser back through Access's login.
export function SessionEnded() {
  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-4 p-4 sm:p-6">
      <Card role="alert">
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
              <LockKeyhole className="size-5" aria-hidden="true" />
              Your sign-in has ended
            </h1>
          </CardTitle>
          <CardDescription>Reload the page to sign in again.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </CardContent>
      </Card>
    </main>
  )
}
