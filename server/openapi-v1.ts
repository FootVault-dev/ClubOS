// OpenAPI 3.0 spec for the external /api/v1 surface. Served at
// GET /api/v1/openapi.json (any valid API key). This is the "OpenAPI/Swagger
// specification of our endpoints" promised to Sporty in the CUFC integration
// brief (30 Jun 2026) — their scoping team reads this to see exactly what the
// registration export exposes.
//
// Keep in sync with the /api/v1 routes in routes.ts. Field-level rule: nothing
// medical, no payment identifiers, no marketing attribution ever appears here.

const bearerAuth = [{ bearerAuth: [] }];

const errorResponses = {
  "401": { description: "Missing, invalid or expired API key" },
  "403": { description: "Key lacks the required scope or workspace access" },
  "429": { description: "Rate limit exceeded (240 requests/minute per key)" },
};

export const OPENAPI_V1_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "ClubOS External API",
    version: "1.3.0",
    description:
      "Read-only external API for Christchurch United FC's club platform (ClubOS). " +
      "Every endpoint requires a scoped API key (Authorization: Bearer clubos_...). " +
      "Keys are bound to named scopes and specific workspaces; requests outside a key's " +
      "grant return 403. A key may additionally be limited to particular programmes within " +
      "its workspaces — where it is, programme-scoped endpoints (camps, registrations, " +
      "revenue, analytics, order timing, customers) return only those programmes and their " +
      "data, and totals are computed over that subset. This is invisible in the responses: " +
      "there is no error, the excluded programmes simply are not present. " +
      "All requests are audit-logged and rate-limited (240/min/key); " +
      "repeated invalid keys from one IP are blocked (brute-force protection). " +
      "No endpoint exposes medical information, payment identifiers, or player ID documents. " +
      "Versioning policy: /api/v1 is stable — fields are only ever ADDED, never renamed or " +
      "removed. Breaking changes ship as /api/v2 with both versions running in parallel for " +
      "at least 6 months and direct notice to every key holder. Keys support zero-downtime " +
      "rotation (the replaced key keeps working for a grace window).",
    contact: { name: "Daniel Meyn — Christchurch United FC", email: "daniel@cufc.co.nz" },
  },
  servers: [{ url: "https://app.usg.co.nz", description: "Production" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "API key issued by CUFC (format: clubos_<64 hex>)" },
    },
    schemas: {
      SportyRegistration: {
        type: "object",
        description:
          "One registrant (player) on one registration — the NZF-compliance field set " +
          "from the CUFC × Sporty integration brief, Integration 1. A registration by a " +
          "guardian covering multiple children yields one row per child.",
        properties: {
          registrationId: { type: "integer" },
          registrantType: { type: "string", enum: ["child", "adult"] },
          player: {
            type: "object",
            properties: {
              firstName: { type: "string" },
              lastName: { type: "string" },
              dateOfBirth: { type: "string", format: "date", nullable: true },
              gender: { type: "string", nullable: true },
            },
          },
          guardian: {
            type: "object",
            nullable: true,
            description: "Present for child registrants only",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              phone: { type: "string", nullable: true },
              address: { type: "string", nullable: true },
            },
          },
          contact: {
            type: "object",
            nullable: true,
            description: "Present for adult registrants only",
            properties: {
              email: { type: "string" },
              phone: { type: "string", nullable: true },
              address: { type: "string", nullable: true },
            },
          },
          emergency: {
            type: "object",
            nullable: true,
            properties: { name: { type: "string", nullable: true }, phone: { type: "string", nullable: true } },
          },
          registration: {
            type: "object",
            properties: {
              program: { type: "string" },
              programType: { type: "string", enum: ["academy", "holiday_camp", "league_team"] },
              ageMin: { type: "integer", nullable: true },
              ageMax: { type: "integer", nullable: true },
              seasonStart: { type: "string", format: "date", nullable: true },
              seasonEnd: { type: "string", format: "date", nullable: true },
              registeredAt: { type: "string", format: "date-time" },
            },
          },
          financial: {
            type: "object",
            description: "Paid / outstanding flag for NZF un-financial red-flagging. Never card or Stripe data.",
            properties: {
              paid: { type: "boolean" },
              status: { type: "string", enum: ["confirmed", "pending"] },
            },
          },
        },
      },
    },
  },
  security: bearerAuth,
  paths: {
    "/api/v1/overview": {
      get: {
        summary: "Revenue + registration + web analytics rollup",
        description: "Scope: overview:read. Aggregates only — no personal data.",
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: { "200": { description: "Rollup for the key's workspace" }, ...errorResponses },
      },
    },
    "/api/v1/revenue": {
      get: {
        summary: "Revenue time series",
        description: "Scope: overview:read.",
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: { "200": { description: "Daily revenue" }, ...errorResponses },
      },
    },
    "/api/v1/analytics": {
      get: {
        summary: "Website analytics aggregates",
        description: "Scope: analytics:read.",
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: { "200": { description: "Analytics aggregates" }, ...errorResponses },
      },
    },
    "/api/v1/customers": {
      get: {
        summary: "Customer summaries (name, email, totals)",
        description: "Scope: customers:read.",
        responses: { "200": { description: "Customer list" }, ...errorResponses },
      },
    },
    "/api/v1/camps": {
      get: {
        summary: "Camps/programmes with occupancy + revenue",
        description: "Scope: camps:read. No personal data.",
        responses: { "200": { description: "Programme list" }, ...errorResponses },
      },
    },
    "/api/v1/split-tests": {
      get: {
        summary: "Split-test results",
        description: "Scope: analytics:read.",
        responses: { "200": { description: "Split tests with variants" }, ...errorResponses },
      },
    },
    "/api/v1/registrations": {
      get: {
        summary: "Registration records (status, amount, contact name + email)",
        description: "Scope: registrations:read.",
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 30 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Registrations page" }, ...errorResponses },
      },
    },
    "/api/v1/order-timing": {
      get: {
        summary: "Order timing heatmap (day × hour)",
        description: "Scope: overview:read.",
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: { "200": { description: "Heatmap" }, ...errorResponses },
      },
    },
    "/api/v1/league/summary": {
      get: {
        summary: "League competitions with team + payment-status counts",
        description: "Scope: league:read. Restricted to league workspaces in the key's grant.",
        parameters: [{ name: "org", in: "query", schema: { type: "string" }, description: "Workspace slug filter" }],
        responses: { "200": { description: "Competitions" }, ...errorResponses },
      },
    },
    "/api/v1/league/teams": {
      get: {
        summary: "League teams with captain contact + payment status",
        description: "Scope: league:read. Archived competitions excluded unless include_archived=1.",
        parameters: [
          { name: "competition_id", in: "query", schema: { type: "integer" } },
          { name: "include_archived", in: "query", schema: { type: "string", enum: ["1"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Teams" }, ...errorResponses },
      },
    },
    "/api/v1/league/games": {
      get: {
        summary: "League fixtures + results",
        description: "Scope: league:read. Window: ±days around today.",
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 14, maximum: 120 } },
          { name: "competition_id", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Games" }, ...errorResponses },
      },
    },
    "/api/v1/tournament/summary": {
      get: {
        summary: "Tournaments with team + game counts",
        description: "Scope: tournament:read. Restricted to tournament workspaces in the key's grant.",
        responses: { "200": { description: "Tournaments" }, ...errorResponses },
      },
    },
    "/api/v1/tournament/teams": {
      get: {
        summary: "Tournament teams with manager contact, roster + payment status",
        description: "Scope: tournament:read. Never exposes player squads, DOBs or ID documents. Archived tournaments excluded unless include_archived=1.",
        parameters: [
          { name: "tournament_id", in: "query", schema: { type: "integer" } },
          { name: "include_archived", in: "query", schema: { type: "string", enum: ["1"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Teams" }, ...errorResponses },
      },
    },
    "/api/v1/tournament/fixtures": {
      get: {
        summary: "Tournament fixtures + results",
        description: "Scope: tournament:read. Archived tournaments excluded unless include_archived=1.",
        parameters: [
          { name: "tournament_id", in: "query", schema: { type: "integer" } },
          { name: "include_archived", in: "query", schema: { type: "string", enum: ["1"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Fixtures" }, ...errorResponses },
      },
    },
    "/api/v1/tournament/skills": {
      get: {
        summary: "Skills challenge entries + scores",
        description: "Scope: tournament:read.",
        parameters: [
          { name: "age_group", in: "query", schema: { type: "string", example: "U10" } },
          { name: "challenge", in: "query", schema: { type: "string", enum: ["juggling", "dribble_pass_finish"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Entries" }, ...errorResponses },
      },
    },
    "/api/v1/cic7s/registrations": {
      get: {
        summary: "CIC Summer 7s register-interest submissions",
        description: "Scope: cic7s:read.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["new", "contacted", "confirmed", "archived"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Registrations" }, ...errorResponses },
      },
    },
    "/api/v1/ethnic-cup/registrations": {
      get: {
        summary: "Christchurch Ethnic Cup register-interest submissions",
        description:
          "Scope: ethnic-cup:read. Name, contact, the community the person is entering for, " +
          "grade, their message and current status. Excluded by design: the staff notes " +
          "written about a registrant while triaging them.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["new", "contacted", "entered", "declined", "archived"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 2000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Registrations" }, ...errorResponses },
      },
    },
    "/api/v1/sporty/registrations": {
      get: {
        summary: "NZF-compliance registration export (Sporty Integration 1)",
        description:
          "Scope: sporty:read. Exactly the field set in the CUFC × Sporty brief: identity, " +
          "contact, guardian + emergency (minors), registration details, paid/outstanding flag. " +
          "Excluded by design: medical data, school details, payment identifiers, marketing attribution. " +
          "Supports incremental sync via updated_since.",
        parameters: [
          { name: "program_type", in: "query", schema: { type: "string", enum: ["academy", "holiday_camp", "league_team", "all"], default: "academy" } },
          { name: "updated_since", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Registrant page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    registrations: { type: "array", items: { $ref: "#/components/schemas/SportyRegistration" } },
                    total: { type: "integer" },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
  },
} as const;
