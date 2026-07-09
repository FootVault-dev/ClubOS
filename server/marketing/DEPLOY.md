# MarketingOS — Deploy Runbook

The Marketing Suite is BUILT and verified on branch `feat/marketing-suite`. This is the
exact sequence to take it live on app.usg.co.nz. Nothing here runs without Daniel's go.

## Already done (safe, additive — completed 2026-07-09 during the build)

- ✅ Migrations applied to prod: `migrations/2026-07-09_marketing_suite.sql` (21 `mkt_*` tables)
  and `migrations/2026-07-09_marketing_suite_phase_b.sql` (body_html, expires_at, campaign+profile unique).
  Both idempotent — re-running is harmless.
- ✅ Audience ingest run against prod: ~845 profiles across all workspaces, consent seeded
  conservatively (express only where a real opt-in exists), 6 legacy unsubscribes imported
  as suppressions + consent downgraded. Re-runnable any time: `npx tsx --env-file=.env server/marketing/ingest.ts`
  (idempotent; `--dry-run` to preview).

## ⚠️ The branch-lineage decision (Daniel's call, BEFORE deploying)

`feat/marketing-suite` branches off `feat/proposals-tracker-search` (the de-facto trunk —
main is ~121 commits behind). **Deploying this branch also ships everything on that lineage
that is currently NOT deployed**, including at least: the Proposals Tracker + global search
(deliberately undeployed), the staff Feedback board, penalty-shootout, logo-licence v2, and
any other parallel-session work committed to the trunk since the last deploy.

Options:
1. **Ship it all** (simplest — recommended if the trunk features are ready anyway): deploy
   the branch as-is. Check each undeployed feature's memory/README for open gotchas first.
2. **Cherrypick**: rebase the 10 marketing commits onto the currently-deployed commit.
   Clean in principle (marketing code is almost entirely new files + one-line mounts) but
   needs a careful conflict pass on shared/schema.ts, tabs.ts, App.tsx, app-sidebar.tsx, routes.ts.

## Deploy sequence

1. **Env vars on Fly** (secrets): `MARKETING_TOKEN_SECRET` (new random 32+ chars),
   `RESEND_WEBHOOK_SECRET` (from step 3 — can deploy without it; prod webhook route will
   reject events until set, everything else works), optional `MARKETING_PUBLIC_BASE_URL`
   (defaults sensibly), `MARKETING_WORKER_CONCURRENCY` (default fine), `SMS_PROVIDER=dryrun`
   (until a real account exists).
2. **Merge/fast-forward** the chosen branch state → deploy via `./deploy.sh` (the ONLY way — see reference_clubos_deploy).
3. **Resend webhook** (dashboard → Webhooks → Add): url `https://app.usg.co.nz/api/webhooks/resend`,
   select all email.* events, copy the `whsec_...` signing secret → set `RESEND_WEBHOOK_SECRET`
   on Fly → restart. Verify: Settings → webhook health card goes green after the next send.
4. **Smoke test live (tab is super-admin-only = invisible to staff):**
   - /admin/marketing loads in every workspace; Audience shows the ingested profiles
   - Create a campaign to a 1-person test list (Daniel's email) → send → arrives with
     unsubscribe headers → open/click → events appear in campaign analytics
   - Publish the Abandoned-enrolment flow in ONE workspace → create a test pending
     registration → confirm enrolment appears; confirm payment → enrolment exits 'converted'
   - Test SMS campaign with SMS_PROVIDER=dryrun → verify cost preview + quiet-hours behaviour in logs
5. **Flip the tab live** when happy: remove "marketing" from `SUPER_ADMIN_ONLY_TABS` in
   shared/tabs.ts → redeploy. Grant staff per-user via /admin/team tab checkboxes.

## Before the first REAL bulk send (not deploy-blocking)

- **Warm-up**: first sends to small, engaged segments (~50–100), roughly double per clean
  send. Watch bounce (<2–3%) and complaint (<0.1%) on the deliverability row.
- **`news.<brand>` subdomains** (fast-follow): extend `scripts/setup_workspace_domain.mjs`
  to provision marketing subdomains so campaign reputation is isolated from OTP/receipts.
- **SMS live**: Daniel opens TNZ or WebSMS account (see server/marketing/sms/README.md),
  sets provider env vars, resolves the `TODO(verify-live)` list against the real API, and
  a human confirms the exact UEMA s10/s11/s45 wording (legislation.govt.nz) before the
  first bulk marketing SMS. Until then: dryrun provider + zero express SMS consent = nothing sends.

## Klaviyo cutover (Phase G)

1. Keys → root `.env` (`KLAVIYO_CUFC_API_KEY`, `KLAVIYO_SIU_API_KEY`)
2. `python3 scripts/klaviyo_migration/export_klaviyo.py --account all`
3. Import consent/suppressions (importer to be written against the export — small; the
   suite's `mkt_suppressions`/`mkt_consent` are the destination) + spot-verify counts both sides
4. Recreate the 1 draft campaign + any wanted templates in the new builder (4 templates exist, 3 untitled)
5. **Only after count-verified suppression parity: "safe to cancel Klaviyo."**
   Redirect the Klaviyo signup forms (SIU site forms → ClubOS lists) before cancelling.

## Rollback

The suite is additive: worst case, remove the marketing tab entry + route mounts (2 one-line
reverts) and redeploy — mkt_* tables sit inert. No existing mailer/table was modified.
