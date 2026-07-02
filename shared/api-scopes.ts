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
