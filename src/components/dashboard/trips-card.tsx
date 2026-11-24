import { Route } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Position, Trip } from '@/lib/dashboard/trips'
import { formatCoordinates, formatDateTime, formatDuration, formatKm, formatKwh, mapUrl } from './format'
import { SectionEmpty } from './section-empty'

type TripsCardProps = {
  trips: Trip[]
}

const SHOWN_TRIPS = 10

function tripDetails(trip: Trip): string {
  if (trip.inProgress) return 'Started'
  return [
    trip.distanceKm === null ? null : formatKm(trip.distanceKm),
    trip.socUsedPct === null ? null : `${trip.socUsedPct}%`,
    trip.energyKwh === null ? null : formatKwh(trip.energyKwh),
    trip.rangeUsedKm === null ? null : `${formatKm(trip.rangeUsedKm)} range`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

function Point({ label, position }: { label: string; position: Position | null }) {
  if (position === null) return <span>{label}: unknown</span>
  return (
    <span>
      {label}:{' '}
      <a
        className="underline underline-offset-2"
        href={mapUrl(position)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {formatCoordinates(position)}
      </a>
    </span>
  )
}

export function TripsCard({ trips }: TripsCardProps) {
  const shown = trips.slice(0, SHOWN_TRIPS)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trips</CardTitle>
        <CardDescription>CarPlay connect to disconnect, newest first</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <SectionEmpty
            icon={Route}
            title="No trips yet"
            description="A trip appears once your phone has connected to and left CarPlay, with the Shortcut set up as described in docs/carplay-shortcut.md."
          />
        ) : (
          <ul className="divide-y">
            {shown.map((trip) => (
              <li key={trip.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDateTime(trip.startedAt)}</span>
                  {trip.inProgress ? (
                    <Badge variant="outline">In progress</Badge>
                  ) : (
                    trip.durationMinutes !== null && <Badge variant="outline">{formatDuration(trip.durationMinutes)}</Badge>
                  )}
                </div>
                <span className="text-muted-foreground tabular-nums">{tripDetails(trip)}</span>
                <span className="flex flex-wrap gap-x-4 text-muted-foreground">
                  <Point label="Start" position={trip.start} />
                  {!trip.inProgress && <Point label="End" position={trip.end} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
