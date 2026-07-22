// ── API key scopes ────────────────────────────────────────────────────────────
// Every /api/v1/* endpoint requires a named scope. A key only reaches the
// endpoints its scopes unlock, and only the organizations in its allowed-org
// list — least privilege for external systems (staff AIOS collectors, Sporty).
//
// Deliberately NO scope exists for: sponsorship prospects/deals, budget/Xero,
// inbox messages, e-sign documents, split-pay payment details, venue bookings,
// contacts' medical fields, or Stripe identifiers. Those never leave ClubOS
// via API key.

export interface ApiScopeDef {
  scope: string;
  label: string;
  description: string;
  /** True when the scope exposes person-level data (names/emails/DOBs). */
  personal: boolean;
}

export const API_SCOPES: ApiScopeDef[] = [
  {
    scope: "overview:read",
    label: "Overview",
    description: "Revenue, registration and order-timing rollups. Aggregates only — no personal data.",
    personal: false,
  },
  {
    scope: "analytics:read",
    label: "Analytics",
    description: "Website analytics and split-test results. Aggregates only.",
    personal: false,
  },
  {
    scope: "customers:read",
    label: "Customers",
    description: "Customer summaries — name, email, lifetime totals.",
    personal: true,
  },
  {
    scope: "camps:read",
    label: "Camps & Programmes",
    description: "Camp/programme list with occupancy and revenue. No personal data.",
    personal: false,
  },
  {
    scope: "registrations:read",
    label: "Registrations",
    description: "Registration records — status, amount, programme, contact name + email only.",
    personal: true,
  },
  {
    scope: "league:read",
    label: "League (MFL)",
    description: "League competitions, divisions, teams (with captain contact + payment status) and fixtures.",
    personal: true,
  },
  {
    scope: "tournament:read",
    label: "Tournament (CIC)",
    description: "Tournaments, teams (with manager contact + payment), fixtures and skills challenge. Never player ID documents.",
    personal: true,
  },
  {
    scope: "cic7s:read",
    label: "CIC Summer 7s",
    description: "CIC 7s register-interest submissions.",
    personal: true,
  },
  {
    scope: "sporty:read",
    label: "Sporty / NZF export",
    description: "NZF-compliance registration export (identity, guardian, registration + paid status). Never medical or payment data.",
    personal: true,
  },
];

export const VALID_API_SCOPES = new Set(API_SCOPES.map((s) => s.scope));

export function isValidApiScope(scope: string): boolean {
  return VALID_API_SCOPES.has(scope);
}

// ── Programme filter ──────────────────────────────────────────────────────────
// Scopes gate WHAT kind of data, allowed_org_ids gates WHOSE workspace. This
// third axis gates WHICH PROGRAMMES within a workspace — so a coordinator who
// runs holiday camps and the U4-U8 programme reads those and nothing else, even
// though the club's academy sits in the same workspace.
//
// A programme matches if its type is listed OR its slug is listed. Listing a
// type ("holiday_camp") is the durable choice — camps created next year are
// covered without anyone editing the key. Listing a slug pins one named
// programme, which is how you isolate a single academy programme from the rest
// (they all share type 'academy').
//
// null           = unrestricted (every existing key — the filter is opt-in)
// {} / all empty = restricted to NOTHING. A filter that resolves to no tokens
//                  must never silently widen back to "everything".

export interface ProgramFilter {
  /** programs.type values, e.g. ["holiday_camp"] */
  types?: string[];
  /** programs.slug values, e.g. ["u4-u8"] */
  slugs?: string[];
}

/** Slugs and types are embedded in SQL, so the character set is deliberately tight. */
const PROGRAM_TOKEN_RE = /^[a-z0-9_-]+$/i;

export function isValidProgramToken(token: string): boolean {
  return typeof token === "string" && token.length > 0 && token.length <= 64 && PROGRAM_TOKEN_RE.test(token);
}

function cleanTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (isValidProgramToken(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Canonicalise whatever arrived (request body, DB jsonb) into either null
 * (unrestricted) or a filter with validated tokens. Anything that is not an
 * object — including a bare array or a string — is treated as unrestricted
 * absence rather than guessed at.
 */
export function normalizeProgramFilter(raw: unknown): ProgramFilter | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  // An object carrying neither key is not a filter anyone authored — treat it
  // as absent rather than as "see nothing", which would break a key silently.
  if (!("types" in source) && !("slugs" in source)) return null;
  return { types: cleanTokens(source.types), slugs: cleanTokens(source.slugs) };
}

/** True when the filter permits nothing at all (present, but empty on both axes). */
export function programFilterIsEmpty(filter: ProgramFilter | null): boolean {
  if (!filter) return false;
  return (filter.types?.length ?? 0) === 0 && (filter.slugs?.length ?? 0) === 0;
}

/**
 * Build the SQL condition that restricts a `programs` query to this filter.
 * Returns null when the key is unrestricted, so callers can omit the clause.
 *
 * Fails CLOSED: a filter that is present but resolves to no usable tokens
 * yields `FALSE`, never an absent clause. Quietly widening back to every
 * programme would turn a typo in an allow-list into a data leak.
 *
 * Tokens are re-validated here even though normalizeProgramFilter already did,
 * because the result is interpolated into a raw SQL string and a row edited
 * directly in the database must never be able to reach the query text.
 */
export function programFilterSqlCondition(filter: ProgramFilter | null, alias = "p"): string | null {
  if (!filter) return null;
  if (programFilterIsEmpty(filter)) return "FALSE";
  const quoted = (tokens: string[] | undefined) =>
    (tokens || []).filter(isValidProgramToken).map((t) => `'${t}'`);
  const types = quoted(filter.types);
  const slugs = quoted(filter.slugs);
  const ors: string[] = [];
  if (types.length) ors.push(`${alias}.type IN (${types.join(", ")})`);
  if (slugs.length) ors.push(`${alias}.slug IN (${slugs.join(", ")})`);
  if (ors.length === 0) return "FALSE";
  return `(${ors.join(" OR ")})`;
}

/** Plain-English summary for the admin UI and the key-detail panel. */
export function describeProgramFilter(filter: ProgramFilter | null): string {
  if (!filter) return "All programmes in the allowed workspaces";
  if (programFilterIsEmpty(filter)) return "No programmes — this key can read no programme data";
  const parts: string[] = [];
  if (filter.types?.length) parts.push(`every ${filter.types.join(", ")} programme`);
  if (filter.slugs?.length) parts.push(`the ${filter.slugs.join(", ")} programme${filter.slugs.length > 1 ? "s" : ""}`);
  return `Only ${parts.join(" and ")}`;
}
