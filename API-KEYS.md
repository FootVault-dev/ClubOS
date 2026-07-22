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

1. **Scopes gate WHAT, workspace binding gates WHOSE, the programme filter
   gates WHICH.** Every `/api/v1` endpoint names its scope; a key reaches only
   orgs in its `allowed_org_ids`; and inside those orgs it reads only the
   programmes its `program_filter` allows (see "Programme filtering" below).
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
   is blocked for the window and an alert email goes out. The count comes from
   `api_auth_failures` (cross-machine), so splitting attempts across Fly
   machines doesn't evade it — per-machine memory only caches the block.
   Testing it will block YOUR IP for 10 minutes, which is why it's not in
   `api-fence-test.sh`; test manually with ~25 invalid keys, expect 401s
   turning into 429s.
7. **Security alerts** (throttled to one per topic per 6h) email
   `API_SECURITY_ALERT_TO` (default daniel@cufc.co.nz) on: brute force,
   rate-limit hits, and scope probing (15× 403 on one key in an hour).
   Known quirk: the throttle is per machine, so one incident can produce up to
   [machine count] duplicate emails — accepted, not worth a DB round-trip.
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

## Programme filtering — fencing a key to part of a workspace

Scopes are per-domain and workspaces are per-org, so neither can express "the
holiday camps and the U4-U8 programme, but not the rest of the academy" — they
all live in the CUFC workspace and `camps:read` returned the lot. That is what
`api_keys.program_filter` (jsonb, nullable) adds.

```json
{ "types": ["holiday_camp"], "slugs": ["u4-u8"] }
```

A programme matches if **its type is listed OR its slug is listed**. Prefer a
**type** where one fits — `holiday_camp` covers camps created next year with
nobody editing the key. Use a **slug** to pin one programme out of a type that
holds several (every academy programme is `type='academy'`, so U4-U8 has to be
named by slug).

- **`NULL` = unrestricted.** Every key predating this feature is NULL, so the
  migration could not change anyone's access.
- **Present-but-empty = nothing.** The gate **fails closed**: a filter that
  resolves to no usable tokens yields `FALSE`, never an absent clause. Quietly
  widening back to "all programmes" would turn a typo into a data leak. The
  create/patch endpoints reject an empty filter outright rather than store one.
- **Rotation carries the filter across.** `POST /:id/rotate` copies
  `program_filter` onto the replacement — a rotation must never widen access.
- Enforced by `programSqlCondition()` in `server/routes.ts`, which delegates to
  `programFilterSqlCondition()` in `shared/api-scopes.ts`. Applied to **all 14
  programme-derived queries** across `/overview`, `/revenue`, `/analytics`,
  `/customers`, `/camps`, `/split-tests`, `/registrations`, `/order-timing` and
  `/sporty/registrations`. **Add the clause to any new programme query you write.**
- Tokens are validated against `^[a-z0-9_-]+$` twice — once on the way in, once
  again at SQL-build time, because the value is interpolated into `sql.raw()`
  and a row edited straight in the database must not reach the query text.

**Set it on an existing key** (no re-issue — the holder's `.env` keeps working,
and the new fence applies on their next request):

```bash
npx tsx script/set-api-key-program-filter.ts --key "Zach AIOS …" \
    --types holiday_camp --slugs u4-u8            # dry run: shows what it gains/loses
npx tsx script/set-api-key-program-filter.ts --key "Zach AIOS …" \
    --types holiday_camp --slugs u4-u8 --apply
```

Or `PATCH /api/admin/api-keys/:id/program-filter` with
`{"programFilter": {...}}` (send `null` to lift it). The create modal in
Settings → API Keys has Types/Slugs fields with a live plain-English summary.

**Conformance:** `npx tsx script/verify-program-filter.ts` — 29 assertions
covering the fail-closed cases, the injection guard, and the real fenced SQL run
read-only against the live database. Plus the `zach-fence` section of
`scripts/api-fence-test.sh`, which checks response **bodies**, not just status
codes (a 200 on `/camps` is not a pass if the academy is in the list).

## Adding a new scope/endpoint — the checklist

1. Add the scope to `shared/api-scopes.ts` (label + honest description +
   `personal` flag). The admin UI picks it up automatically.
2. Write the endpoint in `server/routes.ts` under the v1 section:
   `requireApiKey, requireScope("<new>:read")`, org filter via
   `apiKeyOrgsOfType(req, "<workspace type>")`, **explicit SELECT column list**
   (never `SELECT *`), archived filter + `limit`/`offset` on list endpoints.
   **If it reads `programs`, append `${programSqlFilter(req)}` to its WHERE** —
   a new endpoint that forgets this silently bypasses every programme fence.
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
