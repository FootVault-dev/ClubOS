# ClubOS External API — key system reference

The keyed, read-only `/api/v1` surface for external systems (staff AIOS
collectors, Sporty/NZF, future partners). Built 2026-07-02, hardened
2026-07-03. This file is the source of truth for how it works and how to
extend it safely.

## Architecture

| Piece | Where |
|---|---|
| Scope definitions | `shared/api-scopes.ts` (9 scopes; UI + server share this) |
| Auth + scope middleware | `server/routes.ts` — `requireApiKey`, `requireScope`, `apiKeyOrgsOfType` |
| Security layer | `server/api-security.ts` — brute-force limiter, DB-backed rate limit, alert emails, headers, retention pruning |
| Key + audit tables | `shared/schema.ts` — `api_keys`, `api_key_request_logs`, `api_auth_failures` |
| Admin endpoints + UI | `/api/admin/api-keys*` (super_admin) · `client/src/pages/admin-settings.tsx` |
| Machine-readable spec | `server/openapi-v1.ts` → served at `GET /api/v1/openapi.json` |
| Conformance test | `scripts/api-fence-test.sh` (run after ANY change here) |

## The guarantees

1. **Scopes gate WHAT, workspace binding gates WHOSE.** Every `/api/v1`
   endpoint names its scope; a key reaches only orgs in its `allowed_org_ids`.
2. **No scope exists** for sponsorship, budget/Xero, inbox, e-sign, split-pay,
   venue bookings, medical fields, child DOBs/ID documents, Stripe identifiers,
   or marketing attribution. Adding one is a deliberate decision, not a default.
3. **Keys are hashed at rest** (SHA-256); raw value shown exactly once.
4. **Every request by a valid key is audit-logged** (`api_key_request_logs`) —
   including its 401/403/429 outcomes. Failed auth attempts land in
   `api_auth_failures`.
5. **Rate limit 240 req/min/key**, counted from the audit log — exact across
   machines and deploys (in-memory fast-path only short-circuits repeat offenders).
6. **Brute-force protection**: 20 invalid keys from one IP in 10 min → that IP
   is blocked for the window and an alert email goes out.
7. **Security alerts** (throttled to one per topic per 6h) email
   `API_SECURITY_ALERT_TO` (default daniel@cufc.co.nz) on: brute force,
   rate-limit hits, and scope probing (15× 403 on one key in an hour).
8. **Retention**: request logs 90 days, auth failures 30 days — pruned nightly
   (`startApiSecurityJobs`, wired in `server/index.ts`).
9. **Rotation without downtime**: `POST /api/admin/api-keys/:id/rotate` mints a
   replacement with identical grants; the old key is renamed "(retiring)" and
   expires after the grace window (default 72h, capped by any existing expiry).
10. **Versioning policy**: `/api/v1` is stable — add fields, never rename or
    remove. Breaking changes = `/api/v2`, both live ≥6 months, key holders
    notified directly. This is stated in the OpenAPI description partners read.

## Scope → endpoint map

| Scope | Endpoints |
|---|---|
| `overview:read` | `/api/v1/overview`, `/revenue`, `/order-timing` |
| `analytics:read` | `/api/v1/analytics`, `/split-tests` |
| `customers:read` | `/api/v1/customers` |
| `camps:read` | `/api/v1/camps` |
| `registrations:read` | `/api/v1/registrations` |
| `league:read` | `/api/v1/league/summary`, `/teams`, `/games` |
| `tournament:read` | `/api/v1/tournament/summary`, `/teams`, `/fixtures`, `/skills` |
| `cic7s:read` | `/api/v1/cic7s/registrations` |
| `sporty:read` | `/api/v1/sporty/registrations` (NZF Integration-1 field set) |
| any valid key | `/api/v1/openapi.json` |

## Adding a new scope/endpoint — the checklist

1. Add the scope to `shared/api-scopes.ts` (label + honest description +
   `personal` flag). The admin UI picks it up automatically.
2. Write the endpoint in `server/routes.ts` under the v1 section:
   `requireApiKey, requireScope("<new>:read")`, org filter via
   `apiKeyOrgsOfType(req, "<workspace type>")`, **explicit SELECT column list**
   (never `SELECT *`), archived filter + `limit`/`offset` on list endpoints.
3. Never expose: medical, child DOB/ID docs, Stripe/payment IDs, marketing
   attribution, secrets. If a partner needs one of these, that's a design
   conversation, not a field addition.
4. Document it in `server/openapi-v1.ts`.
5. Add allow AND deny cases to `scripts/api-fence-test.sh`, run it against prod.
6. Update this file's scope map.

## Operational notes

- Keys live only in the DB — there is no env-var key. Org IDs are DB-specific;
  resolve by slug, never hardcode.
- Migrations for these tables are additive SQL in `migrations/` (prod has
  schema drift — never `db:push`). Run on Supabase BEFORE deploying.
- Do not run a local dev server against the prod DB to test this — server boot
  starts the league-balance cron (charges real cards). Use the fence test
  against prod (all GETs) or validate SQL read-only.
- Staff handoff packs (collector + README per person) live in the AIOS
  workspace: `shares/clubos-aios-access/`.
