// Server-side helpers for the shared rule in @shared/registrations — the SQL
// shapes that decide whether a PERSON is visible to staff.
//
// The online checkout creates the parent and child contacts BEFORE the card is
// charged (it has to: the registration row needs someone to point at). When
// the parent never finishes, those contacts are left behind with nothing but a
// pending registration attached. Staff should never meet them: a parent who
// hasn't paid is not a parent of a registered player. The proper end-state is
// to create people only when payment succeeds; until then this is the read-side
// rule, and it is the ONLY place it is written.
import { sql } from "drizzle-orm";
import { db } from "./db";
import { REAL_REGISTRATION_STATUS_SQL } from "@shared/registrations";

export const REAL_STATUS_SQL = sql.raw(REAL_REGISTRATION_STATUS_SQL);

/**
 * A `contacts` row (aliased `c`) is hidden when its ONLY tie to the club is an
 * unfinished checkout: it carries a pending registration (as the player or as
 * the guardian), no real one on either side, and did not come from the
 * Friendly Manager import (those families have ten years of history behind
 * them regardless of what they did online last week).
 */
export const contactHiddenSql = (c = "c") => sql`(
  EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = ${sql.raw(c)}.id OR r.guardian_id = ${sql.raw(c)}.id) AND r.status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = ${sql.raw(c)}.id OR r.guardian_id = ${sql.raw(c)}.id) AND r.status IN ${REAL_STATUS_SQL})
  AND ${sql.raw(c)}.friendly_manager_id IS NULL
)`;

/** A camp `children` row (aliased `ch`) whose every booking line belongs to a pending checkout. */
export const childHiddenSql = (ch = "ch") => sql`(
  EXISTS (SELECT 1 FROM registration_items ri JOIN registrations r ON r.id = ri.registration_id WHERE ri.child_id = ${sql.raw(ch)}.id AND r.status = 'pending')
  AND NOT EXISTS (SELECT 1 FROM registration_items ri JOIN registrations r ON r.id = ri.registration_id WHERE ri.child_id = ${sql.raw(ch)}.id AND r.status IN ${REAL_STATUS_SQL})
)`;

export async function hiddenContactIds(): Promise<Set<number>> {
  const r = await db.execute(sql`SELECT c.id FROM contacts c WHERE ${contactHiddenSql("c")}`);
  return new Set((r.rows as any[]).map((x) => Number(x.id)));
}

export async function hiddenChildIds(): Promise<Set<number>> {
  const r = await db.execute(sql`SELECT ch.id FROM children ch WHERE ${childHiddenSql("ch")}`);
  return new Set((r.rows as any[]).map((x) => Number(x.id)));
}
