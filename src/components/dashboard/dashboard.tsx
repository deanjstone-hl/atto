import { DatabaseZap, Plus, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyPage } from '@/components/empty-page'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboard } from '@/hooks/use-dashboard'
import type { ApiClient } from '@/lib/api'
import type { Entry } from '@/components/entry/entry'
import type { DashboardData } from '@/lib/dashboard/types'
import { buildKeySpecs, buildRangeTrend, buildVehicleStatus, summariseSessions } from '@/lib/dashboard/shape'
import { KeySpecsCard } from './key-specs-card'
import { RangeTrendCard } from './range-trend-card'
import { RecentSessionsCard } from './recent-sessions-card'
import { VehicleStatusCard } from './vehicle-status-card'

function DashboardSections({ data }: { data: DashboardData }) {
  const { vehicle, sessions, observations, features } = data
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <VehicleStatusCard status={vehicle ? buildVehicleStatus(vehicle, observations, sessions) : null} />
      <div className="lg:col-span-2">
        <RangeTrendCard trend={buildRangeTrend(observations)} />
      </div>
      <div className="lg:col-span-2">
        <RecentSessionsCard sessions={summariseSessions(sessions)} />
      </div>
      <KeySpecsCard specs={vehicle ? buildKeySpecs(vehicle, features) : []} />
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3" aria-busy="true" aria-label="Loading dashboard">
      {['', 'lg:col-span-2', 'lg:col-span-2', ''].map((span, index) => (
        <Card key={index} className={span}>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// The entries the owner can add. A vehicle comes first; everything else belongs to the
// vehicle shown, so those wait until there is one.
function EntryActions({ result, onAdd }: { result: DashboardData; onAdd: (entry: Entry) => void }) {
  if (result.vehicle === null) {
    return (
      <Button onClick={() => onAdd({ kind: 'vehicle' })}>
        <Plus data-icon="inline-start" />
        Add vehicle
      </Button>
    )
  }
  const vehicleId = result.vehicle.id
  return (
    <>
      <Button onClick={() => onAdd({ kind: 'charging-session', vehicleId })}>
        <Plus data-icon="inline-start" />
        Log charge
      </Button>
      <Button variant="outline" onClick={() => onAdd({ kind: 'range-observation', vehicleId })}>
        Log range
      </Button>
      <Button variant="outline" onClick={() => onAdd({ kind: 'vehicle-feature', vehicleId })}>
        Add feature
      </Button>
    </>
  )
}

export function Dashboard({
  api,
  headerAction,
  onAdd,
}: {
  api: ApiClient
  headerAction?: ReactNode
  onAdd: (entry: Entry) => void
}) {
  const state = useDashboard(api)
  const entryActions =
    state.status === 'ready' && state.result.kind === 'ready' ? (
      <EntryActions result={state.result.data} onAdd={onAdd} />
    ) : null

  return (
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title="ATTO1 dashboard"
        description="Charge, range and charging history at a glance."
        actions={
          <>
            {entryActions}
            {headerAction}
          </>
        }
      />

      {state.status === 'loading' && <DashboardSkeleton />}

      {state.status === 'error' && (
        <EmptyPage icon={<TriangleAlert />} title="Couldn't load the dashboard" description={state.message} />
      )}

      {state.status === 'ready' && state.result.kind === 'schema-missing' && (
        <EmptyPage
          icon={<DatabaseZap />}
          title="Database not set up yet"
          description="The atto1 tables haven't been created, so there's nothing to show. Everything will appear here once the database is set up."
        />
      )}

      {state.status === 'ready' && state.result.kind === 'ready' && <DashboardSections data={state.result.data} />}
    </main>
  )
}
