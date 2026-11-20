// The events a collect trigger may carry, and so the tag a reading may carry (atto/6).
// The list lives in code and not in a CHECK in the migration (SQLite cannot widen a CHECK
// without rebuilding the table), so a new event is a code change. atto/8 adds
// `charge_start` and `charge_stop`: they are reserved and refused until it does.
// No imports, so writes.ts and collect.ts can both read it without a cycle.

export const TRIGGER_EVENTS = ['carplay_connect', 'carplay_disconnect'] as const
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]

export function isTriggerEvent(value: unknown): value is TriggerEvent {
  return typeof value === 'string' && (TRIGGER_EVENTS as readonly string[]).includes(value)
}
