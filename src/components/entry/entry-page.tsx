import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import type { ApiClient } from '@/lib/api'
import type { Entry } from './entry'
import { EntryForm } from './entry-form'
import {
  chargingSessionForm,
  rangeObservationForm,
  vehicleFeatureForm,
  vehicleForm,
  type FormSpec,
} from './forms'

function specFor(entry: Entry): FormSpec<unknown> {
  // Each spec is typed to its own input; the form only hands it back what it built.
  switch (entry.kind) {
    case 'vehicle':
      return vehicleForm as FormSpec<unknown>
    case 'charging-session':
      return chargingSessionForm as FormSpec<unknown>
    case 'range-observation':
      return rangeObservationForm as FormSpec<unknown>
    case 'vehicle-feature':
      return vehicleFeatureForm as FormSpec<unknown>
  }
}

// One data-entry page in the v3 page frame: the page header carries the title and
// Cancel, the form below it carries the fields and Save.
export function EntryPage({
  api,
  entry,
  onSaved,
  onCancel,
}: {
  api: ApiClient
  entry: Entry
  onSaved: () => void
  onCancel: () => void
}) {
  const spec = specFor(entry)
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={spec.title}
        description={spec.description}
        actions={
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        }
      />
      <EntryForm
        key={entry.kind}
        api={api}
        spec={spec}
        vehicleId={entry.kind === 'vehicle' ? undefined : entry.vehicleId}
        onSaved={onSaved}
      />
    </main>
  )
}
