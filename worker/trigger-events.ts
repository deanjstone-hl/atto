// The events a reading may be tagged with (atto/6, atto/8). The list lives in code and not
// in a CHECK in the migration (SQLite cannot widen a CHECK without rebuilding the table), so
// a new event is a code change. No imports, so writes.ts and collect.ts can both read it
// without a cycle.
//
// Two kinds, because two things start a collector run:
//   - a CarPlay event is filed by the phone as a trigger (`POST /api/collect/trigger`), is
//     picked up by the homelab timer, and its run also reads the car's position;
//   - a charge event is seen by the BYD push listener on the homelab (atto/8), which runs the
//     collector itself. The phone never files one and a charge run never reads a position.

export const TRIGGER_EVENTS = ['carplay_connect', 'carplay_disconnect'] as const
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]

export const CHARGE_EVENTS = ['charge_start', 'charge_stop'] as const
export type ChargeEvent = (typeof CHARGE_EVENTS)[number]

// Every tag a reading may carry; the ingest accepts exactly these.
export const READING_EVENTS = [...TRIGGER_EVENTS, ...CHARGE_EVENTS] as const
export type ReadingEvent = (typeof READING_EVENTS)[number]

// What the phone may file as a trigger, and so what the pending queue holds.
export function isTriggerEvent(value: unknown): value is TriggerEvent {
  return typeof value === 'string' && (TRIGGER_EVENTS as readonly string[]).includes(value)
}

export function isChargeEvent(value: unknown): value is ChargeEvent {
  return typeof value === 'string' && (CHARGE_EVENTS as readonly string[]).includes(value)
}
