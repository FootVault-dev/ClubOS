// AttributionOS — identity service (T7).
//
// The thin DB layer over the pure decision logic in `shared/identity.ts`. It maps a
// converting parent/payer (Hard Rule 4: never a child) onto a durable `persons` row,
// records every handle we learn (email / phone / visitor id) in `person_identities`,
// and retroactively stitches their anonymous analytics history onto the person.
//
// EVERY function here is defensive: attribution must never block a checkout. Callers
// (T8 conversion stamping) wrap these in try/catch, and these functions themselves
// return null / no-op on bad input rather than throwing where reasonable.
//
// Merge rules live in shared/identity.ts (decideVisitorBind) — see that file / AGENTS.md.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  persons,
  personIdentities,
  personMerges,
  analyticsEvents,
  type Person,
} from "@shared/schema";
import {
  normalizeEmail,
  normalizePhone,
  normalizeIdentityValue,
  decideVisitorBind,
  type IdentityKind,
  type VisitorBindDecision,
} from "@shared/identity";
import { validExternalId } from "@shared/attribution";

export interface PersonDetails {
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Look up the person a given (kind,value) identity currently points at, if any. */
async function findPersonIdByIdentity(kind: IdentityKind, value: string): Promise<number | null> {
  const [row] = await db
    .select({ personId: personIdentities.personId })
    .from(personIdentities)
    .where(and(eq(personIdentities.kind, kind), eq(personIdentities.value, value)))
    .limit(1);
  return row?.personId ?? null;
}

/**
 * Find or create the person for an email (the payer). Normalises the email to its
 * canonical lowercase form, validates it, and:
 *   - returns the existing person if the email is already a known identity (enriching
 *     any missing name/phone fields we now have), or
 *   - creates a new person + email identity (and a phone identity when supplied).
 *
 * Returns null when the email is missing/invalid (caller continues without a person).
 */
export async function getOrCreatePersonByEmail(
  email: unknown,
  details: PersonDetails = {},
): Promise<Person | null> {
  const normEmail = normalizeEmail(email);
  if (!normEmail) return null;

  const phone = normalizePhone(details.phone);
  const firstName = cleanName(details.firstName);
  const lastName = cleanName(details.lastName);

  // Existing person for this email?
  const existingPersonId = await findPersonIdByIdentity("email", normEmail);
  if (existingPersonId !== null) {
    const [existing] = await db.select().from(persons).where(eq(persons.id, existingPersonId)).limit(1);
    if (existing) {
      await enrichPerson(existing, { phone, firstName, lastName });
      // opportunistically record a phone identity we didn't have before
      if (phone) await linkIdentity(existing.id, "phone", phone);
      return existing;
    }
  }

  // Create a fresh identified person.
  const [created] = await db
    .insert(persons)
    .values({
      primaryEmail: normEmail,
      primaryPhone: phone ?? null,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
    })
    .returning();

  await linkIdentity(created.id, "email", normEmail);
  if (phone) await linkIdentity(created.id, "phone", phone);

  return created;
}

/** Fill in person fields we now know but were previously null (never overwrites). */
async function enrichPerson(person: Person, extra: PersonDetails): Promise<void> {
  const patch: Partial<typeof persons.$inferInsert> = {};
  if (!person.primaryPhone && extra.phone) patch.primaryPhone = extra.phone;
  if (!person.firstName && extra.firstName) patch.firstName = extra.firstName;
  if (!person.lastName && extra.lastName) patch.lastName = extra.lastName;
  if (Object.keys(patch).length === 0) return;
  await db.update(persons).set(patch).where(eq(persons.id, person.id));
  // keep the in-memory copy consistent for the caller
  Object.assign(person, patch);
}

/**
 * Record a handle (email/phone/visitor) for a person. Idempotent: the unique
 * (kind,value) index means a repeat is a no-op, and if the handle already points at
 * a DIFFERENT person we do NOT steal it (onConflictDoNothing) — that collision is
 * resolved by the merge rules in bindVisitorToPerson, not here.
 */
export async function linkIdentity(
  personId: number,
  kind: IdentityKind,
  value: unknown,
): Promise<void> {
  if (!Number.isInteger(personId) || personId <= 0) return;
  const normValue = normalizeIdentityValue(kind, value);
  if (!normValue) return;
  await db
    .insert(personIdentities)
    .values({ personId, kind, value: normValue })
    .onConflictDoNothing({ target: [personIdentities.kind, personIdentities.value] });
}

/**
 * Bind a visitor id (anonymous cookie) to an identified person, applying the PostHog
 * merge rules via decideVisitorBind:
 *   - anonymous visitor → bind + stitch their history.
 *   - already bound to the same person → no-op.
 *   - bound to a different identified person → blocked_auto_merge: keep both persons,
 *     write a person_merges audit row, do not re-bind or stitch.
 *
 * Returns the decision (handy for logging by the caller). Never throws on bad input.
 */
export async function bindVisitorToPerson(
  visitorId: unknown,
  personId: number,
): Promise<VisitorBindDecision> {
  const normVisitor = validExternalId(visitorId);
  if (!normVisitor) {
    return { action: "invalid", reason: "invalid_visitor_id", audit: false };
  }

  const existingPersonId = await findPersonIdByIdentity("visitor", normVisitor);
  const decision = decideVisitorBind({ existingPersonId, targetPersonId: personId });

  switch (decision.action) {
    case "bind":
      await linkIdentity(personId, "visitor", normVisitor);
      await stitchVisitorHistory(normVisitor, personId);
      break;
    case "blocked_auto_merge":
      // keep both — the existing owner (existingPersonId) wins the visitor.
      await db.insert(personMerges).values({
        winnerId: existingPersonId as number,
        loserId: personId,
        reason: decision.reason,
      });
      break;
    case "noop":
    case "invalid":
    default:
      break;
  }

  return decision;
}

/**
 * Retroactively attach a visitor's anonymous analytics history to a person:
 *   UPDATE analytics_events SET person_id = <person> WHERE visitor_id = <visitor>
 *   AND person_id IS NULL.
 *
 * Also bridges other visitor ids that are the same human:
 *   - the legacy id: analytics.js (T5) ships the pre-migration `_cufc_vid` once as
 *     `metadata->>'legacyVid'` (T6 note (a));
 *   - cross-root aliases (T13): when the visitor crossed between two brand roots, the
 *     cookie middleware recorded an `alias` event linking the two spines — we follow
 *     it in BOTH directions (this visitor may be the kept id OR the aliased one).
 *
 * Each bridged id's still-anonymous rows are stitched too. Returns the total number of
 * rows stitched. Never throws.
 */
export async function stitchVisitorHistory(visitorId: unknown, personId: number): Promise<number> {
  const normVisitor = validExternalId(visitorId);
  if (!normVisitor || !Number.isInteger(personId) || personId <= 0) return 0;

  let stitched = 0;
  try {
    const updated = await db
      .update(analyticsEvents)
      .set({ personId })
      .where(and(eq(analyticsEvents.visitorId, normVisitor), isNull(analyticsEvents.personId)))
      .returning({ id: analyticsEvents.id });
    stitched += updated.length;

    // Collect every OTHER visitor id that is the same human: legacy ids this visitor
    // reported, plus cross-root aliases (either side of the link). One grouped query;
    // then stitch each bridged id's remaining anonymous rows.
    const bridgeRes = await db.execute(sql`
      SELECT DISTINCT other FROM (
        SELECT metadata->>'legacyVid' AS other
          FROM analytics_events
          WHERE visitor_id = ${normVisitor}
            AND metadata->>'legacyVid' IS NOT NULL
        UNION
        SELECT metadata->>'aliasVisitorId' AS other
          FROM analytics_events
          WHERE event_type = 'alias' AND visitor_id = ${normVisitor}
            AND metadata->>'aliasVisitorId' IS NOT NULL
        UNION
        SELECT visitor_id AS other
          FROM analytics_events
          WHERE event_type = 'alias' AND metadata->>'aliasVisitorId' = ${normVisitor}
      ) t
      WHERE other IS NOT NULL
    `);
    for (const r of bridgeRes.rows as Array<{ other: string | null }>) {
      const other = validExternalId(r.other);
      if (!other || other === normVisitor) continue;
      const otherUpdated = await db
        .update(analyticsEvents)
        .set({ personId })
        .where(and(eq(analyticsEvents.visitorId, other), isNull(analyticsEvents.personId)))
        .returning({ id: analyticsEvents.id });
      stitched += otherUpdated.length;
    }
  } catch {
    // attribution stitching must never block or bubble — swallow and report what we got
  }
  return stitched;
}

/** Trim a supplied name to a stored form, or null when empty/unusable. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 200) return null;
  return s;
}
