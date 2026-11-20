// The collect-trigger endpoints (atto/6). The phone files a trigger when it connects to or
// leaves CarPlay; a homelab timer reads what is pending, runs the collector once and
// acknowledges it. Everything is insert-only: a trigger is a row, an acknowledged trigger
// is a row in collect_acks, and nothing is updated or deleted.
//
//   POST /api/collect/trigger  (the phone's service token)      file a trigger, 202
//   GET  /api/collect/pending  (the collector's service token)  the unacknowledged triggers
//   POST /api/collect/ack      (the collector's service token)  acknowledge triggers
//
// Which token reaches which path is decided in index.ts; every row belongs to the Access
// subject the Worker was configured with, never to a value in the body.

import { databaseFailure, failed, readObject, type Fields } from './writes'
import type { D1Like } from './d1'
import { json } from './json'
import { isTriggerEvent, TRIGGER_EVENTS } from './trigger-events'

// A pending trigger older than this is not returned: a reading taken now says nothing about
// where the car was half an hour ago, so tagging it with the old event would mislead.
const PENDING_MAX_AGE_MINUTES = 30
const PENDING_LIMIT = 50
const MAX_ACK_IDS = 50
const MAX_ID_LENGTH = 64

export async function fileTrigger(request: Request, db: D1Like, ownerId: string): Promise<Response> {
  const body = await readObject(request)
  if (body instanceof Response) return body

  const errors: Fields = {}
  for (const key of Object.keys(body)) {
    if (key !== 'event') errors[key] = `${key} is not a field`
  }
  if (!isTriggerEvent(body.event)) errors.event = `Must be one of: ${TRIGGER_EVENTS.join(', ')}`
  if (Object.keys(errors).length > 0) return failed(errors)

  try {
    const row = await db
      .prepare('insert into collect_triggers (user_id, event) values (?1, ?2) returning id, event')
      .bind(ownerId, body.event)
      .first<{ id: string; event: string }>()
    return json({ id: row?.id, event: row?.event }, 202)
  } catch (error) {
    return databaseFailure(error)
  }
}

export async function listPending(db: D1Like, ownerId: string): Promise<Response> {
  try {
    const { results } = await db
      .prepare(
        `select t.id, t.event, t.requested_at from collect_triggers t
         where t.user_id = ?1
           and t.requested_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?2 || ' minutes')
           and not exists (select 1 from collect_acks a where a.trigger_id = t.id)
         order by t.requested_at asc, t.rowid asc
         limit ?3`,
      )
      .bind(ownerId, PENDING_MAX_AGE_MINUTES, PENDING_LIMIT)
      .all<{ id: string; event: string; requested_at: string }>()
    return json({ triggers: results })
  } catch (error) {
    return databaseFailure(error)
  }
}

export async function acknowledgeTriggers(request: Request, db: D1Like, ownerId: string): Promise<Response> {
  const body = await readObject(request)
  if (body instanceof Response) return body

  const errors: Fields = {}
  for (const key of Object.keys(body)) {
    if (key !== 'trigger_ids') errors[key] = `${key} is not a field`
  }
  const ids = body.trigger_ids
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_ACK_IDS ||
    !ids.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)
  ) {
    errors.trigger_ids = `Must be a list of 1 to ${MAX_ACK_IDS} trigger ids`
  }
  if (Object.keys(errors).length > 0) return failed(errors)

  try {
    let acked = 0
    for (const id of ids as string[]) {
      // Only the caller's own trigger, and only if it has no ack yet.
      const row = await db
        .prepare(
          `insert into collect_acks (trigger_id, user_id)
           select id, user_id from collect_triggers t
           where t.id = ?1 and t.user_id = ?2
             and not exists (select 1 from collect_acks a where a.trigger_id = t.id)
           returning trigger_id`,
        )
        .bind(id, ownerId)
        .first<{ trigger_id: string }>()
      if (row) acked += 1
    }
    return json({ acked })
  } catch (error) {
    return databaseFailure(error)
  }
}
