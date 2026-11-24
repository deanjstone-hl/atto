import { PlugZap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { SessionSummary } from '@/lib/dashboard/shape'
import {
  chargerLabels,
  formatCentsPerKwh,
  formatDateTime,
  formatDuration,
  formatKwh,
  formatMoney,
} from './format'
import { SectionEmpty } from './section-empty'

type RecentSessionsCardProps = {
  sessions: SessionSummary[]
}

function sessionDetails(session: SessionSummary): string {
  const details: string[] = []
  if (session.startSocPct !== null && session.endSocPct !== null) {
    details.push(`${session.startSocPct}% → ${session.endSocPct}%`)
  }
  if (session.durationMinutes !== null) details.push(formatDuration(session.durationMinutes))
  return details.join(' · ')
}

export function RecentSessionsCard({ sessions }: RecentSessionsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent charging sessions</CardTitle>
        <CardDescription>Newest first</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <SectionEmpty
            icon={PlugZap}
            title="No charging sessions yet"
            description="Sessions you log will appear here with energy, cost and charge gained."
          />
        ) : (
          <ul className="divide-y">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{formatDateTime(session.startedAt)}</span>
                    <Badge variant="outline">{chargerLabels[session.chargerType]}</Badge>
                  </div>
                  <span className="text-muted-foreground [overflow-wrap:anywhere]">
                    {[session.locationName, sessionDetails(session)].filter(Boolean).join(' · ') ||
                      'No details'}
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 tabular-nums">
                  <span className="font-medium">{formatKwh(session.energyKwh)}</span>
                  <span className="text-muted-foreground">
                    {session.costCents === null
                      ? 'Cost not logged'
                      : session.costCents === 0
                        ? 'Free'
                        : `${formatMoney(session.costCents, session.currency)}${
                            session.costPerKwhCents === null
                              ? ''
                              : ` · ${formatCentsPerKwh(session.costPerKwhCents)}`
                          }`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
