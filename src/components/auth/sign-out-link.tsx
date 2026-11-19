import { LogOut } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Cloudflare Access serves this path itself, at the edge: it clears the Access
// session cookie and returns to the login page. The Worker never sees the request.
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout'

export function SignOutLink() {
  return (
    <a href={ACCESS_LOGOUT_PATH} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
      <LogOut data-icon="inline-start" aria-hidden="true" />
      Sign out
    </a>
  )
}
