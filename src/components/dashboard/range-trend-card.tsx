import { Minus, TrendingDown, TrendingUp, Waypoints } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { RangeTrend, RangeTrendPoint } from '@/lib/dashboard/shape'
import { formatDate, formatKm } from './format'
import { SectionEmpty } from './section-empty'

type RangeTrendCardProps = {
  trend: RangeTrend
}

const WIDTH = 600
const HEIGHT = 160
const PADDING = 12

const directionIcons = { up: TrendingUp, down: TrendingDown, flat: Minus }
// The word and the icon carry the state; the colour only reinforces it.
const directionWords = { up: 'Rising', down: 'Falling', flat: 'Steady' }
const directionColours = { up: 'text-success', down: 'text-warning', flat: 'text-muted-foreground' }

function plot(points: RangeTrendPoint[], minKm: number, maxKm: number) {
  // Pad the y-axis so a flat series does not sit on the edge.
  const spread = Math.max(maxKm - minKm, 10)
  const floor = minKm - spread * 0.2
  const ceiling = maxKm + spread * 0.2
  const step = points.length > 1 ? (WIDTH - PADDING * 2) / (points.length - 1) : 0

  return points.map((point, index) => ({
    x: points.length > 1 ? PADDING + index * step : WIDTH / 2,
    y:
      PADDING +
      (1 - (point.projectedFullRangeKm - floor) / (ceiling - floor)) * (HEIGHT - PADDING * 2),
    point,
  }))
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  )
}

export function RangeTrendCard({ trend }: RangeTrendCardProps) {
  const header = (
    <CardHeader>
      <CardTitle>Range trend</CardTitle>
      <CardDescription>Displayed range scaled to a full charge</CardDescription>
    </CardHeader>
  )

  if (trend.points.length === 0 || trend.minKm === null || trend.maxKm === null) {
    return (
      <Card>
        {header}
        <CardContent>
          <SectionEmpty
            icon={Waypoints}
            title="No range readings yet"
            description="Readings taken at 20% charge or more build the full-charge range trend."
          />
        </CardContent>
      </Card>
    )
  }

  const coordinates = plot(trend.points, trend.minKm, trend.maxKm)
  const first = trend.points[0]
  const last = trend.points[trend.points.length - 1]
  const DirectionIcon = trend.direction ? directionIcons[trend.direction] : null

  return (
    <Card>
      {header}
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-3 gap-4">
          <Summary label="Latest" value={trend.latestKm === null ? '—' : formatKm(trend.latestKm)} />
          <Summary label="Average" value={trend.averageKm === null ? '—' : formatKm(trend.averageKm)} />
          <div className="flex flex-col gap-1">
            <dt className="text-2xs text-muted-foreground">Change</dt>
            <dd className="flex flex-wrap items-center gap-x-1 text-base font-medium tabular-nums">
              {trend.changeKm === null
                ? '—'
                : `${trend.changeKm > 0 ? '+' : ''}${formatKm(trend.changeKm)}`}
              {trend.direction && DirectionIcon && (
                <span className={`flex items-center gap-1 text-sm ${directionColours[trend.direction]}`}>
                  <DirectionIcon className="size-4" aria-hidden="true" />
                  {directionWords[trend.direction]}
                </span>
              )}
            </dd>
          </div>
        </dl>
        <figure className="flex flex-col gap-1">
          <div className="relative h-40">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="absolute inset-0 size-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Full-charge range from ${formatKm(first.projectedFullRangeKm)} on ${formatDate(
                first.observedAt,
              )} to ${formatKm(last.projectedFullRangeKm)} on ${formatDate(last.observedAt)}`}
            >
              <line
                x1={0}
                x2={WIDTH}
                y1={HEIGHT - 1}
                y2={HEIGHT - 1}
                className="stroke-border"
                vectorEffect="non-scaling-stroke"
              />
              {coordinates.length > 1 && (
                <polyline
                  points={coordinates.map(({ x, y }) => `${x},${y}`).join(' ')}
                  fill="none"
                  className="stroke-chart-1"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {/* Dots sit outside the stretched SVG so they stay round. */}
            {coordinates.map(({ x, y, point }) => (
              <span
                key={point.observedAt}
                className="absolute size-2 -translate-1/2 rounded-full bg-chart-1 ring-2 ring-card"
                style={{ left: `${(x / WIDTH) * 100}%`, top: `${(y / HEIGHT) * 100}%` }}
                title={`${formatDate(point.observedAt)}: ${formatKm(point.projectedFullRangeKm)} (${point.displayedRangeKm} km at ${point.socPct}%)`}
              />
            ))}
          </div>
          <figcaption className="flex justify-between text-2xs text-muted-foreground">
            <span>{formatDate(first.observedAt)}</span>
            <span>
              {trend.points.length} reading{trend.points.length === 1 ? '' : 's'} · {formatKm(trend.minKm)}–
              {formatKm(trend.maxKm)}
            </span>
            <span>{formatDate(last.observedAt)}</span>
          </figcaption>
        </figure>
      </CardContent>
    </Card>
  )
}
