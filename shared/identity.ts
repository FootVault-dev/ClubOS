// AttributionOS — identity decision logic (T7, pure / no DB).
//
// The rules that decide how a visitor id binds to a person live here so they can be
// unit-tested with zero DB / network (see `script/test-attribution-identity.ts`).
// `server/identity.ts` is the thin DB layer that applies these decisions.
//
// Merge rules (PostHog verbatim, pinned in AGENTS.md — do not re-litigate):
//   - anonymous → identified merges FREELY (a visitor with no person yet binds).
//   - two already-identified persons are NEVER auto-merged: the collision is logged
//     to person_merges as `blocked_auto_merge` and BOTH persons are kept.
//   - illegal ids (undefined/null/None/[object Object]/NaN/anonymous/guest/'') never
//     count as identities (enforced via the shared ILLEGAL_IDS blocklist).

import { isValidExternalId, validExternalId } from "./attribution";

// ─────────────────────────────────────────────────────────────────────────────
// Value normalisation
// ─────────────────────────────────────────────────────────────────────────────

// Deliberately permissive: we are guarding an identity key, not doing RFC-5322
// validation. Requires a single @, a non-empty local part, and a dot in the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise an email to its canonical identity form: trimmed + lowercased. Returns
 * null when the value is missing, an illegal id, an unreplaced macro, or does not
 * look like an email at all. The person's primary_email and any `kind='email'`
 * identity are always stored in this form so lookups are deterministic.
 */
export function normalizeEmail(raw: unknown): string | null {
  const cleaned = validExternalId(raw); // strips macros + rejects illegal/oversized ids
  if (cleaned === null) return null;
  const email = cleaned.toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Normalise a phone to an identity key: trim, then keep only `+` and digits (drops
 * spaces, dashes, brackets). Returns null when nothing usable remains or the value
 * is an illegal id / macro. Not locale-aware — we only need a stable dedupe key.
 */
export function normalizePhone(raw: unknown): string | null {
  const cleaned = validExternalId(raw);
  if (cleaned === null) return null;
  const compact = cleaned.replace(/[^\d+]/g, "");
  const digits = compact.replace(/\+/g, "");
  if (digits.length < 5) return null; // too short to be a real phone number
  return compact;
}

export type IdentityKind = "email" | "phone" | "visitor";

/**
 * Normalise an identity value for its kind, returning the canonical key or null when
 * the value is unusable. `email` → lowercased/validated, `phone` → digits+`+`,
 * `visitor` → macro/illegal-id guarded url-safe id. One entry point so every writer
 * keys person_identities the same way.
 */
export function normalizeIdentityValue(kind: IdentityKind, value: unknown): string | null {
  switch (kind) {
    case "email":
      return normalizeEmail(value);
    case "phone":
      return normalizePhone(value);
    case "visitor":
      return validExternalId(value);
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor → person bind decision
// ─────────────────────────────────────────────────────────────────────────────

export type VisitorBindAction = "bind" | "noop" | "blocked_auto_merge" | "invalid";

export interface VisitorBindDecision {
  /** what the DB layer should do */
  action: VisitorBindAction;
  /** person_merges.reason when an audit row is written (bind / blocked cases) */
  reason: string;
  /** whether the DB layer should write a person_merges audit row */
  audit: boolean;
}

export interface VisitorBindInput {
  /** the person this visitor is CURRENTLY bound to (null = anonymous, never seen) */
  existingPersonId: number | null;
  /** the identified person we now want to bind the visitor to */
  targetPersonId: number;
}

/**
 * Decide how to bind a visitor id to a person, applying the PostHog merge rules.
 *   - visitor is anonymous (no existing binding)        → `bind` (free).
 *   - visitor already bound to the SAME person          → `noop`.
 *   - visitor bound to a DIFFERENT identified person     → `blocked_auto_merge`
 *     (keep both persons, write an audit row, do NOT re-bind).
 *   - target person id is not a positive integer         → `invalid` (guard).
 *
 * Pure: no side effects, so the full matrix is exhaustively unit-tested.
 */
export function decideVisitorBind(input: VisitorBindInput): VisitorBindDecision {
  const { existingPersonId, targetPersonId } = input;

  if (!Number.isInteger(targetPersonId) || targetPersonId <= 0) {
    return { action: "invalid", reason: "invalid_target_person", audit: false };
  }

  if (existingPersonId === null || existingPersonId === undefined) {
    // anonymous visitor → identified person: merge freely.
    return { action: "bind", reason: "anon_to_identified", audit: false };
  }

  if (existingPersonId === targetPersonId) {
    return { action: "noop", reason: "already_bound", audit: false };
  }

  // Two already-identified persons collide on one visitor id. Never auto-merge —
  // record the collision and keep both. The existing owner wins the visitor.
  return { action: "blocked_auto_merge", reason: "blocked_auto_merge", audit: true };
}

/** True when a value is a usable external identity key (blocklist + macro guarded). */
export function isUsableIdentity(value: unknown): boolean {
  return isValidExternalId(value);
}
