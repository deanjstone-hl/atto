import { useId, useRef, useState, type FormEvent } from 'react'
import { SessionEnded } from '@/components/auth/session-ended'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, SessionEndedError, ValidationApiError, type ApiClient } from '@/lib/api'
import type { FieldDef, FieldErrors, FormSpec } from './forms'

const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30'

function describeFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'That looks like a duplicate of something already saved, so nothing was added.'
  }
  if (error instanceof ApiError && error.status === 404) {
    return "Couldn't find your vehicle. Reload the page and try again."
  }
  return error instanceof Error ? error.message : String(error)
}

function Control({
  field,
  id,
  value,
  error,
  onChange,
}: {
  field: FieldDef
  id: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  const shared = {
    id,
    name: field.name,
    value,
    required: field.required,
    'aria-invalid': error !== undefined,
    'aria-describedby': error === undefined ? undefined : `${id}-error`,
  }
  if (field.control === 'select') {
    return (
      <select {...shared} className={SELECT_CLASS} onChange={(event) => onChange(event.target.value)}>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <Input
      {...shared}
      type={field.control}
      step={field.step}
      inputMode={field.control === 'number' ? 'decimal' : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function EntryForm<Input>({
  api,
  spec,
  vehicleId,
  onSaved,
}: {
  api: ApiClient
  spec: FormSpec<Input>
  vehicleId?: string
  onSaved: () => void
}) {
  const prefix = useId()
  const [values, setValues] = useState(spec.initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [ended, setEnded] = useState(false)
  // State is not updated until the next render, so a quick second submit needs this.
  const saving = useRef(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving.current) return

    const result = spec.toInput(values, vehicleId)
    if ('errors' in result) {
      setErrors(result.errors)
      setFailure(null)
      return
    }

    saving.current = true
    setPending(true)
    setErrors({})
    setFailure(null)
    try {
      await spec.submit(api, result.input)
      onSaved()
    } catch (error) {
      saving.current = false
      setPending(false)
      if (error instanceof SessionEndedError) {
        setEnded(true)
      } else if (error instanceof ValidationApiError) {
        const shown: FieldErrors = {}
        const unplaced: string[] = []
        for (const [name, message] of Object.entries(error.fields)) {
          const target = spec.errorField(name)
          if (spec.fields.some((field) => field.name === target)) shown[target] = message
          else unplaced.push(message)
        }
        setErrors(shown)
        if (unplaced.length > 0 || Object.keys(shown).length === 0) {
          setFailure(unplaced.join(' ') || 'The server refused what was entered.')
        }
      } else {
        setFailure(describeFailure(error))
      }
    }
  }

  if (ended) return <SessionEnded />

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {spec.fields.map((field) => {
          const id = `${prefix}-${field.name}`
          const error = errors[field.name]
          return (
            <div key={field.name} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{field.label}</Label>
              <Control
                field={field}
                id={id}
                value={values[field.name] ?? ''}
                error={error}
                onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
              />
              {error !== undefined && (
                <p id={`${id}-error`} className="text-xs text-destructive">
                  {error}
                </p>
              )}
              {field.hint !== undefined && error === undefined && (
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              )}
            </div>
          )
        })}
      </div>

      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : spec.submitLabel}
        </Button>
      </div>
    </form>
  )
}
