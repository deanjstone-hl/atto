import type { ChargerType } from '@/lib/data-model/types'
import { centsToDollars } from '@/lib/data-model/units'

const LOCALE = 'en-AU'

const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const decimalFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export const chargerLabels: Record<ChargerType, string> = {
  ac_home: 'Home AC',
  ac_public: 'Public AC',
  dc_fast: 'DC fast',
}

export function formatDate(timestamp: string): string {
  return dateFormat.format(new Date(timestamp))
}

export function formatDateTime(timestamp: string): string {
  return dateTimeFormat.format(new Date(timestamp))
}

export function formatKm(km: number): string {
  return `${integerFormat.format(km)} km`
}

export function formatKwh(kwh: number): string {
  return `${decimalFormat.format(kwh)} kWh`
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(
    centsToDollars(cents),
  )
}

export function formatCentsPerKwh(cents: number): string {
  return `${decimalFormat.format(cents)}¢/kWh`
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export function formatCoordinates({ latitude, longitude }: { latitude: number; longitude: number }): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
}

// A link the owner opens themselves: nothing here calls a map or geocoding service, so a
// position leaves the browser only when it is clicked (atto/6).
export function mapUrl({ latitude, longitude }: { latitude: number; longitude: number }): string {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`
}
