# VERIFY.md — independent verification criteria for loop/attribution

You are a read-only skeptic reviewing the AttributionOS build on this branch. Check each
criterion against the ACTUAL CODE (not PLAN.md claims). Any failure → NEEDS_REVIEW.md.

## Safety / non-negotiables
1. No migration file contains DROP, ALTER COLUMN TYPE, or non-additive DDL; nothing in the
   diff applies migrations (`db:push`, drizzle-kit push, psql apply) or starts the server.
2. No deploy/push commands introduced anywhere the loop touched (deploy.sh, fly, vercel, git push).
3. No child PII (child names/DOB/medical) written into analytics_events, link_clicks,
   person tables, or any Meta CAPI payload. Persons are parents/payers only.
4. Attribution code paths in conversion endpoints are failure-isolated (try/catch) — a
   thrown attribution error cannot block a registration/payment.
5. `/l/:key` cannot open-redirect: destination hosts restricted to our own domains at
   CREATE time and/or redirect time. `?ci=`/`?vi=` acceptance cannot inject scripts or SQL.
6. All new `/api/admin/*` endpoints requireAuth (and org-scope their queries); no new
   unauthenticated endpoint returns PII (emails/phones) — collector endpoints accept
   writes but never echo stored personal data.

## Correctness
7. Classifier: fbclid-with-no-utm/ad-params yields `meta_unattributed`, never a paid
   channel; synonym map normalises fb→facebook, ig→instagram; values containing `{{` are
   nulled; raw values stored alongside normalised.
8. Identity: two already-identified persons are never auto-merged (code path provably
   blocks it and audits it); illegal-ID blocklist enforced; retroactive stitch only fills
   NULL person_id rows.
9. Purchase events: browser and server use the identical deterministic
   `purchase_<registrationId>` event id for the same purchase (check MFL, camps, venue).
10. Attribution models: first_touch / last_non_direct / lifetime_first implemented as
    specified over the touchpoint log at query time; lookback window is a parameter;
    revenue math uses integer cents with no integer-division truncation; per-model sums
    reconcile with total conversion revenue for the same filter set.
11. Short links: click dedupe is 1h per (link, SHA256(ip+ua)); cached counters can be
    recomputed from link_clicks (repair function exists and matches); QR flag flows from
    `?qr=1` to stored click and into classification as channel `qr`.
12. Mailer rewriting is idempotent (running twice doesn't double-append params) and only
    rewrites links to our own domains; per-recipient tokens are HMAC-signed and the
    resolver validates before binding identity.
13. schema.ts mirrors every migration file exactly (names/types/nullability), and
    `npm run build` passes from a clean checkout of the branch.
14. Every `- [x]` task in PLAN.md has corresponding real code (spot-check all; no stubs,
    no TODO-placeholder implementations).

## Tests
15. Every `script/test-attribution*.ts` referenced in PLAN.md exists, runs green via
    `npx tsx`, and actually asserts the behaviours above (not vacuous).
