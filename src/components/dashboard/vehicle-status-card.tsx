import { Car, Gauge } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import type { VehicleStatus } from '@/lib/dashboard/shape'
import { formatDateTime, formatKm } from './format'
import { SectionEmpty } from './section-empty'

type VehicleStatusCardProps = {
  status: VehicleStatus | null
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  )
}

export function VehicleStatusCard({ status }: VehicleStatusCardProps) {
  if (status === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Vehicle status</CardTitle>
        </CardHeader>
        <CardContent>
          <SectionEmpty
            icon={Car}
            title="No vehicle yet"
            description="Add your ATTO1 to see its charge, range and odometer here."
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{status.nickname}</CardTitle>
        <CardDescription>
          {status.observedAt ? `Last reading ${formatDateTime(status.observedAt)}` : 'No readings yet'}
        </CardDescription>
        {status.description && (
          <CardAction>
            <Badge variant="secondary">{status.description}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {status.socPct === null ? (
          <SectionEmpty
            icon={Gauge}
            title="No range readings yet"
            description="Log a charge level and displayed range to see the battery status."
          />
        ) : (
          <Progress value={status.socPct}>
            <ProgressLabel>State of charge</ProgressLabel>
            <ProgressValue />
          </Progress>
        )}
        <dl className="grid grid-cols-2 gap-4">
          <Stat
            label="Displayed range"
            value={status.displayedRangeKm === null ? '—' : formatKm(status.displayedRangeKm)}
          />
          <Stat
            label="Full-charge estimate"
            value={status.projectedFullRangeKm === null ? '—' : formatKm(status.projectedFullRangeKm)}
          />
          <Stat
            label="Odometer"
            value={status.odometerKm === null ? '—' : formatKm(status.odometerKm)}
          />
          <Stat
            label="Last charged"
            value={status.lastChargedAt === null ? '—' : formatDateTime(status.lastChargedAt)}
          />
        </dl>
      </CardContent>
    </Card>
  )
}
