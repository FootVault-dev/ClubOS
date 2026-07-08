# Marketing Suite ("MarketingOS") — server/marketing

The in-house email + SMS engine that replaces both Klaviyo accounts. This folder
is the backend. **Phase A (this commit) ships the data foundation + the profile
ingest ETL.** Phases B–H (send engine, webhook, UI, builder, flows, SMS,
migration) build on these tables.

Spec: `outputs/deep-research/2026-07-09-clubos-marketing-suite/synthesis.md` §(a).
Plan: `plans/2026-07-09-clubos-marketing-suite.md`.

## The data model

The whole suite is an event-stream database with a marketing UI on top. Three
tables are load-bearing (identity + consent + events); everything else — lists,
segments, campaigns, flows, analytics — is a query over them.

```
                      ┌───────────────────────────────┐
   ingest ETL  ─────► │ mkt_profiles                  │  canonical identity,
   (all audience      │  (workspace_id, lower(email))  │  workspace-scoped,
    tables)           │  person_id* / contact_id       │  deduped
                      └───────────────────────────────┘
                          │            │            │
             ┌────────────┘     ┌──────┘        ┌───┘─────────────┐
             ▼                  ▼               ▼                 ▼
      mkt_consent        mkt_events        mkt_list_members   mkt_segment_members
      (email + sms,      (append-only,     mkt_lists          mkt_segments
       2 axes each)       metric registry  (static)           (definition jsonb,
             │             = mkt_metrics)                       materialised cache)
             │
      mkt_suppressions  ◄── 4 scopes (global | brand | category | list); a pre-send
      (never leaks           filter join — a suppressed address can't receive via ANY path
       across brands)

   Send + analytics (Phase B+):  mkt_campaigns → mkt_email_messages → mkt_email_events
   (raw Resend stream) → mkt_email_link_clicks / mkt_conversions.  Automation:
   mkt_flows → mkt_flow_versions (immutable) → mkt_flow_enrollments (pinned) →
   mkt_flow_step_runs.  SMS: mkt_sms_messages / mkt_sms_inbound.

   * person_id has NO FK — the attribution `persons` spine isn't in this branch;
     it's backfilled when attribution lands (D1). contact_id → contacts(id).
```

**Consent = two orthogonal axes per channel** (resolves the NZ-law-vs-Klaviyo
contradiction): `sub_state` (subscribed | unsubscribed | never — the Klaviyo axis)
AND `legal_basis` (express | inferred | deemed | none | opted_out — the UEM Act
axis). A marketing send requires `sub_state='subscribed'` **and** an appropriate
basis; SMS marketing specifically requires `express`.

## Consent seeding rules (conservative, applied by the ingest)

The ingest never invents marketing permission. Existing relationships give
operational consent, not marketing consent, unless a real opt-in was recorded.

| Source signal | Email consent seeded |
|---|---|
| `contacts.newsletterConsent = true` | `subscribed` / `express` — src `clubos:contacts.newsletterConsent` |
| `predictor_entrants.marketingConsent = true` | `subscribed` / `express` |
| `app_users.unsubscribed = false` | `subscribed` / `express` (opted into the app's marketing list) |
| `app_users.unsubscribed = true` | `unsubscribed` / `opted_out` |
| everyone else with an email | `never` / `inferred` (operational mail OK; NO marketing until they opt in) |
| **SMS, every phone** | `never` / `inferred` — **no express SMS consent exists anywhere yet**, so nobody gets marketing SMS until an explicit opt-in flow runs |
| `email_unsubscribes` row | → `mkt_suppressions` (`brand` scope from `organizationId`, else `global`) **and** that profile's email consent set to `unsubscribed` / `opted_out` |

**Never downgrade:** once a profile is `subscribed`/`express`, a later
`never`/`inferred` source can't overwrite it (rank-based) — but an
unsubscribe/suppression (`opted_out`) always wins.

## Ingest sources → workspace

16 audience tables. Workspace = the source row's `organizationId`, except
`contacts` (no org column → CUFC/camps, org 1) and `print_contacts` (nullable →
united-prints, org 8). Sources: contacts · predictor_entrants ·
cic_interest_registrations · cic7s_registrations · cugc_registrations · members ·
app_users · league_teams (captains) · split_members · clubs · tournament_teams
(splits `a@x / b@y`) · tournament_staff · volunteers · cic_vendors ·
sponsorship_prospects · print_contacts. Phones are normalised to E.164 with an
NZ-aware helper (`021…` → `+6421…`); un-parseable numbers are kept raw in `props`.

## How to run the ingest

Idempotent and additive — re-running is safe. **Migrate first, then dry-run,
then the real run.**

```bash
# 1. apply the schema (once, before deploy — never db:push)
npx tsx --env-file=.env script/apply-marketing-schema.ts

# 2. DRY RUN — reports per-source {scanned, created, updated, skippedNoEmail}
#    with no writes (profile-level counts only; consent/suppression not simulated)
npx tsx --env-file=.env server/marketing/ingest.ts --dry-run

# 3. real run (writes profiles + consent + suppressions)
npx tsx --env-file=.env server/marketing/ingest.ts

# scope to one workspace/org
npx tsx --env-file=.env server/marketing/ingest.ts --workspace 5
```

Or call it in code: `import { runMarketingIngest } from "./marketing/ingest";`
→ `await runMarketingIngest({ dryRun: true })`.

## What Phase B builds next

- **`resend-client.ts`** — one shared Resend client (idempotency keys, rate limit,
  RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`, plaintext part).
- **graphile-worker** bootstrap + durable campaign send jobs (survive deploy/crash).
- **`POST /api/webhooks/resend`** — Svix HMAC verify, idempotent on `svix-id`,
  forward-only status, machine/bot tagging, auto-suppress on bounce/complaint →
  writes `mkt_email_events` / `mkt_suppressions`.
- One-click unsubscribe handler + hosted preference centre (per-brand).
- Campaign CRUD + send/schedule under `/api/admin/marketing/*` with
  `requireTab("marketing")` and a real `organizationId` — replacing the four
  copy-paste mailers.
