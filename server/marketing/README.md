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

## Phase B — send engine + event pipeline (SHIPPED)

Phase B turns the foundation into a working, durable, compliant send engine and
the honest analytics warehouse. New deps (pinned, no `^`): **`graphile-worker`
0.17.3** (durable Postgres job runner) + **`svix` 1.96.1** (webhook verification).

### Architecture

```
  ┌── admin API (requireTab("marketing"), workspace-scoped) ──────────────┐
  │  routes.ts  → lists / segments / campaigns / profiles / dashboard     │
  │  send-now / schedule ─┐                       ▲ analytics             │
  └───────────────────────┼───────────────────────┼──────────────────────┘
                           │ enqueue               │ read
                           ▼                       │
  worker.ts (graphile-worker, survives deploy/crash)
   campaign:send ─► resolveAudience ─► filterSendable (THE gate) ─► snapshot
      mkt_email_messages (queued) ─► fan out campaign:send_batch (50) ─► sendMarketingEmail
      ─► campaign:finalize (roll up counts → status 'sent')
                           │ POST api.resend.com/emails
                           ▼                        Resend  ──Svix──►  webhook.ts
   resend-client.ts (idempotency-key, ~2/s token bucket, 429 back-off,       │
     RFC 8058 List-Unsubscribe headers, from ALWAYS via fromForOrg)          ▼
                                            POST /api/webhooks/resend (Svix HMAC verify)
                                              ─► mkt_email_events (idempotent on svix_id)
                                              ─► forward-only status + machine/bot tagging
                                              ─► complaint/hard-bounce → suppress() global
  public-routes.ts (no auth, opaque HMAC tokens):
    GET  /api/public/marketing/unsubscribe            branded confirm page
    POST /api/public/marketing/unsubscribe            confirm
    POST /api/public/marketing/unsubscribe/oneclick   RFC 8058 (instant, 200, no gate)
    GET/POST /api/public/marketing/preferences        per-brand + category opt-down + pause 30d

  events.ts  trackEvent() → mkt_metrics/mkt_profiles/mkt_events (deduped)
             attributeConversion() → 3-day last-touch NON-bot click → mkt_conversions
```

### The suppression gate (never bypassed)

`suppression.ts → filterSendable(profileIds, {workspaceId, channel, isMarketing, category?, listId?})`
is the ONE gate. **Every** send path (campaign orchestrator, test send, future
flows/SMS) resolves recipients through it. A recipient is sendable only if it has
the channel identifier AND consent (marketing ⇒ `sub_state='subscribed'` AND
`legal_basis='express'`; operational ⇒ basis ∈ {express,inferred} and not
unsubscribed) AND is NOT in `mkt_suppressions` at any applicable scope
(global / brand / category / list), ignoring expired suppressions (pause-30d).
`suppress()` is the write side used by the webhook + unsub handlers (inserts the
row + downgrades consent to `opted_out`).

### New env vars

| Var | Purpose | If missing |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | Svix `whsec_…` signing secret for `POST /api/webhooks/resend` | **prod: endpoint rejects (500).** dev: accepts unverified with a warning |
| `MARKETING_TOKEN_SECRET` | HMAC secret for opaque unsub/preference tokens | falls back to `SESSION_SECRET` → `STRIPE_WEBHOOK_SECRET` → dev default (mirrors `mflUnsubToken`) |
| `MARKETING_PUBLIC_BASE_URL` | Public base for links in emails (default `https://app.usg.co.nz`) | default used |
| `MARKETING_SEND_RATE_PER_SEC` | Resend token-bucket rate (default `2`) | default used |
| `MARKETING_WORKER_CONCURRENCY` | graphile-worker concurrency (default `3`) | default used |
| `MARKETING_WORKER_DISABLED=1` | Kill switch — don't start the worker | worker starts |

`RESEND_API_KEY` (already in `.env`) is reused for sending.

### Deploy-day: register the Resend webhook

1. Apply migrations **before** deploy (never `db:push`):
   `psql "$DATABASE_URL" -f migrations/2026-07-09_marketing_suite.sql` (Phase A, if
   not already applied) then `-f migrations/2026-07-09_marketing_suite_phase_b.sql`.
2. In the Resend dashboard → **Webhooks → Add Endpoint**:
   `https://app.usg.co.nz/api/webhooks/resend`, subscribe to the email events
   (`email.sent/delivered/delivery_delayed/bounced/complained/opened/clicked/failed/suppressed`).
3. Copy the endpoint's **Signing Secret** (`whsec_…`) into `.env` as
   `RESEND_WEBHOOK_SECRET`, and enable **open + click tracking** on the sending domains.

### Worker notes

- **graphile-worker creates and migrates its OWN `graphile_worker` schema on
  start** (additive; not in our migration files). This happens the first time the
  server boots with the worker enabled — expect a one-off schema install.
- The worker starts from `server/index.ts` via `startMarketingWorker()`. It
  **self-guards**: no `DATABASE_URL` or `MARKETING_WORKER_DISABLED=1` → it no-ops,
  and any start error is caught so server boot never fails (only sends won't fire).
- Scheduled sends enqueue `campaign:send` with `runAt = scheduled_at` +
  `jobKey`; **cancel** just flips the campaign status and the orchestrator bails
  when the job fires. The orchestrator is **idempotent** (the
  `(campaign_id, profile_id)` unique index + `ON CONFLICT DO NOTHING`) so a crash
  mid-send resumes cleanly instead of double-mailing.

### Schema appends this phase (additive only)

- `mkt_email_messages` unique index `(campaign_id, profile_id)` — orchestrator idempotency.
- `mkt_campaigns.body_html` — compiled send-ready HTML (Phase D's serializer fills it from `block_tree`).
- `mkt_suppressions.expires_at` — powers the preference-centre "pause 30 days".
