# AttributionOS — internal reference

First-party, Hyros-grade attribution built into ClubOS for all 6 brands. This is the
"where did every sale come from" system: a visitor/touchpoint event spine with
**server-set** cookies, a persons + identities layer (PostHog merge rules), a short-link /
QR layer (Dub mechanics), UTM-instrumented email, Meta ad-level joins (`url_tags` →
`ad.id` → spend sync), and an admin **Attribution** dashboard with journey timelines.

**The one sentence that governs everything:** Postgres conversions (registrations /
payments) are the revenue truth; attribution models are computed at *query time* over the
touchpoint log. Browser pixels only feed Meta's optimiser — they never define revenue.

- Master build plan: `plans/2026-07-03-attribution-os-build.md`
- Research base: `outputs/deep-research/2026-07-03-attribution-gold-standard/synthesis.md`
- Build contract + per-task engineering notes: `AGENTS.md`
- Backlog + status: `PLAN.md`
- **Post-deploy manual verification: `ATTRIBUTION-QA.md`**

> Status when this doc was written: the loop build (T1–T21) is complete and lives on branch
> `loop/attribution`. Nothing is deployed and **no migrations have been applied** — that is a
> human-gated step (see "Going live" at the bottom).

---

## 1. Architecture (text diagram)

```
 MARKETING SITES                    CLUBOS (Express + React, one app, all brands)
 minifootball.co.nz         ┌──────────────────────────────────────────────────────────┐
 christchurchunited.co.nz   │                                                            │
 cicyouth.com  … etc.       │  GET /t.js  ──────────────► tiny ES5 tracker (per brand)   │
        │  loads /t.js from  │      • POST /api/public/analytics/hello → Set-Cookie       │
        │  its OWN root      │        usg_vid scoped to brand ROOT (first-party)          │
        │                    │      • decorates outbound links to OUR OTHER roots with    │
        ▼                    │        ?vi=<visitor>&ci=<click>                            │
 ┌───────────────┐           │                                                            │
 │ analytics.js  │──events──►│  POST /api/public/analytics/event  +  /batch               │
 │ (funnel pages)│           │      shapeAnalyticsEvent() → classifyTouch() → store       │
 └───────────────┘           │      into analytics_events (channel, channel_raw, ids,     │
                             │      is_bot, landing_url, person_id)                        │
 QR / poster / WhatsApp ────►│  GET /l/:key  (short-link redirect)                        │
 email CTA ────────────────►│      mint click_id → link_clicks → Set-Cookie usg_cid       │
                             │      → 302 to allow-listed destination + ?ci + utm          │
                             │                                                            │
 COOKIE MIDDLEWARE (server/attribution-cookies.ts) runs before every non-/api GET page:   │
      ensures usg_vid (2y) + usg_cid (90d); adopts ?vi= / ?ci=; records cross-root alias;  │
      binds email ?ci=emc… tokens to the person.                                          │
                             │                                                            │
 CONVERSION (register / book / enrol / checkout / waitlist / apply / contact):            │
      buildConversionAttribution(req, {email,…})  (server/attribution-stamp.ts)           │
        reads cookies → body fallback → classifyTouch → getOrCreatePersonByEmail →         │
        bindVisitorToPerson → stitchVisitorHistory                                        │
      stamps visitor_id/click_id/fbp/fbc/meta_*/attribution_channel onto the row          │
      (ALL swallowed — a failure here NEVER blocks the checkout)                          │
                             │                                                            │
 IDENTITY (server/identity.ts + shared/identity.ts): persons + person_identities +         │
      person_merges. anon→identified merges freely; two identified persons NEVER          │
      auto-merge; retroactive stitch of past anonymous events.                            │
                             │                                                            │
 META TRUTH LOOP:                                                                          │
      browser Purchase pixel + server CAPI share ONE id  purchase_<registrationId>        │
      server/ad-spend-cron.ts → Meta Insights (level=ad, publisher_platform +             │
      platform_position breakdowns) → ad_spend_daily + ad_entities (names)                 │
                             │                                                            │
 REPORTING (server/attribution-reports.ts + shared/attribution-models.ts):                │
      models computed at query time over the touchpoint log →                             │
      /api/admin/attribution/*  →  Attribution dashboard tab                              │
                             │                                                            │
 MAINTENANCE (server/attribution-maintenance-cron.ts, nightly):                            │
      prune old page_view/scroll · bot-flag backstop · repair short-link counters         │
      └──────────────────────────────────────────────────────────────────────────────────┘
```

**Data flow in one line:** touch (ad/email/QR/organic) → cookie'd visitor → event row →
convert → visitor+click stamped on the conversion → person stitched → dashboard joins it all
back to channel/campaign/ad and against ad spend.

**Where the code lives:**

| Concern | Pure logic (client-safe, unit-tested) | Server / DB glue |
|---|---|---|
| Vocabulary + classifier + waterfall | `shared/attribution.ts` | — |
| Cookie decisions | `server/attribution-cookies.ts` (DB-free) | mounted in `server/index.ts`; alias write `server/attribution-alias.ts` |
| Identity | `shared/identity.ts` | `server/identity.ts` |
| Conversion stamping | `readAttributionStamp` in `server/attribution-stamp.ts` | `buildConversionAttribution` (same file) |
| Short links | `shared/short-links.ts` | `/l/:key` + `/api/admin/links*` in `server/routes.ts`, `server/storage.ts` |
| Cross-site tracker | `shared/tracker-script.ts` | `GET /t.js` + `/api/public/analytics/hello` in `server/routes.ts` |
| Email | `shared/email-attribution.ts` | `server/email-token.ts`, `server/email.ts` |
| Meta spend sync | `shared/meta-insights.ts` | `server/ad-spend-cron.ts`, `server/meta-capi.ts` |
| Purchase dedup ids | `shared/meta-events.ts` | (used by browser pixels + `server/meta-capi.ts`) |
| Reporting | `shared/attribution-models.ts` | `server/attribution-reports.ts`, `/api/admin/attribution/*` |
| Maintenance | — | `server/attribution-maintenance-cron.ts` |
| Client analytics collector | `client/public/analytics.js` (ES5, static) | — |
| Dashboard / Links UI | `client/src/pages/attribution.tsx`, `client/src/pages/links.tsx`, `client/src/components/hdyhau-card.tsx` | — |

---

## 2. The 15 load-bearing design decisions

These are pinned. Do not re-litigate them without going back to the synthesis doc.

1. **Server-set cookies only.** Every attribution cookie is an HTTP `Set-Cookie` from our
   own Express server (ITP-exempt, durable ~2y). Script-set cookies die in 7 days / 24h on
   Safari. This is the structural edge SaaS tools can't have. `usg_vid` (visitor, 2y),
   `usg_cid` (click, 90d), both `SameSite=Lax`, `Secure` in prod, **not** `HttpOnly`
   (analytics.js reads them). JS never writes them.
2. **One canonical channel vocabulary** + a synonym map at ingest (`fb→facebook`,
   `ig→instagram`). Raw value is ALWAYS stored alongside the normalised one (`*_raw`).
3. **Meta ads carry `url_tags`:**
   `utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}&placement={{placement}}`
   — we join on `ad.id` and resolve names via the Marketing API at query time. *(url_tags
   enforcement on live ads is an AdsOS/human step, not in the loop build.)*
4. **Macro outputs are open sets.** Store raw, map known values, bucket unknowns visibly,
   and **null any value containing `{{`** (unreplaced-macro bug hits 10–20% of clicks).
5. **Purchase dedup fixed.** ONE deterministic event id `purchase_<registrationId>` shared
   by the browser pixel AND server CAPI; venue bookings now have server CAPI; Graph API
   bumped off v19.0 to a single `META_API_VERSION` const (currently `v23.0`).
6. **Conversions are server truth.** Postgres registrations/payments joined by
   email/click-id are the revenue record; browser pixels only feed Meta's optimiser.
7. **Identity = persons + person_identities**, PostHog merge rules verbatim: anonymous→
   identified merges freely; two identified persons NEVER auto-merge (family-iPad
   protection); illegal-id blocklist; every merge writes a `person_merges` audit row.
   **The person is the parent/payer — never the child.**
8. **Retroactive stitching:** when a visitor identifies, their past anonymous sessions bind
   to the person (`UPDATE analytics_events SET person_id … WHERE person_id IS NULL`).
   Owned-channel links carry an identity token (`?ci=`).
9. **Short-link layer on Dub's mechanics:** `/l/:key` mints an opaque click_id → server-set
   cookie + `?ci=` passthrough → the click_id lands on the conversion row. `?qr=1` marks QR.
   Bots flagged but kept. 1h click dedupe per (link, ip+ua hash).
10. **Touchpoint log, models at query time.** v1 models: **first-touch, last-non-direct,
    lifetime-first-touch** only. No U-shaped / time-decay / fractional. Lookback window is a
    query parameter (default 90d). Stock Postgres suffices.
11. **Channel classifier = GA4 rule precedence, pinned + extended** (adds qr, whatsapp,
    referral, and `meta_unattributed` for fbclid-with-no-utm — **never** classified paid).
12. **Conflict waterfall on conversions:** referral code → click-id/UTM tracked →
    self-reported (HDYHAU) → unattributed. Deterministic, never averaged/blended.
13. **"How did you hear about us?"** on every confirmation screen + a three-column
    reconciliation report (platform-reported vs tracked vs self-reported — *divergence is
    information, not error*).
14. **Cross-domain via link decoration** on our own site→funnel links + a backend email
    join. Marketing sites post to their same-root ClubOS domain
    (`minifootball.co.nz → join.minifootball.co.nz`) so cookies stay first-party per brand.
15. **NZ compliance is notice-shaped:** privacy statements ship WITH the tracking (name
    Meta/Google, state the attribution purpose — cures IPP3/IPP3A); UEMA consent evidence +
    unsubscribe ≤5 working days; **no child data to ad platforms, ever**; get a legal read
    before Custom Audiences.

---

## 3. Canonical vocabulary + how to add a channel

**Canonical channels** (`CANONICAL_CHANNELS` in `shared/attribution.ts`):
`facebook · instagram · google · email · whatsapp · sms · qr · referral · organic · direct · other`

**Extended tokens** (roll up under Meta in reporting; not "canonical" but valid outputs):
`messenger · audience_network · meta_unattributed`

- `meta_unattributed` = an fbclid with NO utm/ad params. Facebook organic clicks carry
  fbclid too, so this can **never** be counted as paid.
- `other` = a non-empty utm_source we don't recognise (raw kept in `channel_raw`).

**Synonym map** (`SYNONYM_MAP`) normalises raw `utm_source` at ingest, e.g.
`fb / fb.com / facebook.com / meta / facebook-ads / fbads → facebook`,
`ig / insta / instagram.com / ig-ads → instagram`, `msg → messenger`,
`an → audience_network`, `google-ads → google`. The raw token is always preserved in the
`_raw` column.

**Paid mediums** (`PAID_MEDIUMS`, force `isPaid=true`): `paid, cpc, ppc, paid_social
(+ hyphen/underscore variants), paid_search, cpm, display`. Presence of Meta ad params also
forces paid — **except** a bare fbclid (decision 11).

**Classifier precedence** (`classifyTouch`, pinned — GA4-style):

```
1. referral-code param present          → tracked (referral)
2. our click id (?ci=)                  → tracked (channel comes from the link's stored utm)
3. paid: utm_medium ∈ PAID_MEDIUMS OR valid meta ad params present   → paid channel
        (fbclid ALONE is NOT paid → meta_unattributed)
4. utm_source (via SYNONYM_MAP)         → mapped channel, else `other` (+ raw)
5. known-referrer table (l.facebook.com, lm.facebook.com, l.instagram.com,
        android-app://com.instagram.android, t.co, google organic domains)  → channel
6. nothing                              → direct
```

Every external id (ad id, click id, visitor id) is hygiene-checked with `validExternalId`
BEFORE it counts, so a literal `{{ad.id}}` macro or an illegal id (`undefined`, `null`,
`None`, `[object Object]`, `NaN`, `anonymous`, `guest`, `''`) never registers.

### How to add a new channel

1. **Add the token** to `CANONICAL_CHANNELS` (or `EXTENDED_CHANNELS` if it should roll up
   under a parent like Meta) in `shared/attribution.ts`.
2. **Add synonyms** to `SYNONYM_MAP` (every raw `utm_source` spelling → the canonical token).
3. If it's a **paid** medium, add the medium string to `PAID_MEDIUMS`.
4. If it should be recognised from a **referrer domain**, extend the known-referrer table in
   `classifyReferrer`.
5. If staff should be able to **build links** for it, it appears automatically in the Links
   builder dropdown (it reads `CANONICAL_CHANNELS`).
6. If it should be a **HDYHAU** answer, add an entry to `HDYHAU_OPTIONS` (`{id,label,channel}`).
7. **Add test cases** to `script/test-attribution.ts` and run `npx tsx script/test-attribution.ts`.
8. Reporting needs no change — it aggregates whatever `channel` values it finds.

---

## 4. Event & table dictionary

All money is in **cents**. All timestamps are `timestamp` (UTC stored; NZ-local formatting
happens in queries via `AT TIME ZONE 'Pacific/Auckland'` — never `toISOString()` for NZ
dates). New tables/columns are additive; migrations live in `migrations/2026-07-04_attribution_*.sql`
and are mirrored in `shared/schema.ts`. **None are applied yet.**

### Event spine

**`analytics_events`** (existing table, extended). New columns: `fbclid, gclid, click_id,
fbp, fbc, person_id (plain integer, no FK), channel, channel_raw, landing_url, is_bot
(bool default false)`. New composite indexes (migration file 3): `(visitor_id, timestamp)`,
`(person_id, timestamp)`, `(channel, timestamp)`.
- `channel` is set only on **touch** rows (`session_start`, `page_view`) — those are the
  only events carrying the full fbclid/gclid/click_id bundle. Other event types
  (click/scroll/exit) have `channel = null`; reporting joins channel by visitor/session.
- `event_type = 'alias'` rows are cross-root link records (`metadata.aliasVisitorId`), NOT
  page views. **The prune job must never delete them** (it only targets page_view/scroll).
- `utmContent`/`utmTerm` and the stitch signal `legacyVid` live in the `metadata` jsonb
  (there are no discrete columns for them on this table).

### Identity

| Table | Key columns | Notes |
|---|---|---|
| `persons` | `id, primary_email, primary_phone, first_name, last_name, created_at` | All identity fields nullable — a person can exist before it's identified. The person is the **payer/parent**. |
| `person_identities` | `person_id (FK), kind (email\|phone\|visitor), value, created_at` | Two unique indexes: `(kind,value)` global + `(person_id,kind,value)`. `linkIdentity` uses `onConflictDoNothing` so it never steals an existing handle. |
| `person_merges` | `winner_id, loser_id, reason, created_at` | Audit only. winner/loser are **plain integers, not FKs** (a losing person may later be deleted). A blocked two-identified merge writes `reason='blocked_auto_merge'` and keeps BOTH persons. |

### Short links

| Table | Key columns | Notes |
|---|---|---|
| `short_links` | `org_id, key (unique), destination, channel, campaign, medium, content, brand, note, qr_default, clicks, leads, sales, sale_amount_cents, active, created_by, created_at` | `destination` must be allow-listed at create time. Counters are cached; **only `clicks` is bumped live** (by `/l/:key`) — leads/sales/sale_amount_cents are materialised by the nightly repair job. |
| `link_clicks` | `link_id, click_id (unique), visitor_id, ip_hash, ua, referrer, is_qr, is_bot, created_at` | `ip_hash = SHA256(ip + ua)` — **no raw IP stored**. 1h dedupe per (link, ip_hash, non-bot). |

### Meta spend

| Table | Key columns | Notes |
|---|---|---|
| `ad_spend_daily` | `date, ad_id, adset_id, campaign_id, publisher_platform, platform_position, spend_cents, impressions, clicks` | Unique key `(date, ad_id, publisher_platform, platform_position)`. Breakdown cols default `''` (never NULL) so the upsert key is stable. Meta returns decimal **dollars** → we store `Math.round(×100)` cents. |
| `ad_entities` | `ad_id (unique), adset_id, campaign_id, ad_name, adset_name, campaign_name, account_id, refreshed_at` | Name cache. Names for spent ads ride the Insights rows (no extra fetch); names for ads seen only on conversions are fetched by node lookup (≤100/run). |

### Email

**`email_click_tokens`** — `token (emc… , unique), email, org_id, campaign_id, created_at`.
Deterministic HMAC token per (org, campaign, email); resolves a click back to the recipient
for identity binding.

### Conversion tables (the revenue truth)

Eight tables gained the same 10 attribution columns — `visitor_id, click_id, person_id, fbp,
fbc, meta_ad_id, meta_adset_id, meta_campaign_id, meta_platform, attribution_channel`:

`registrations · cugc_registrations · cugc_free_sessions · league_waitlist ·
cic7s_registrations · football_institute_applications · print_orders · booking_requests`

- **HDYHAU column:** added as `hdyhau` on 6 of them. `registrations` reuses its existing
  `referral_source`, and `cugc_registrations` reuses `heard_via` (same meaning) — reporting
  `COALESCE`s the existing column for those two.
- `person_id` is a plain `integer` (no FK), matching `analytics_events`.
- Two conversion points have **no** attribution columns by design and get identity-only
  binding: `facilityBookings` (paid venue checkout) and `inbox_messages` (cross-origin
  contact forms). Adding channel columns there is a new migration, not a code change.

### What "sale" vs "lead" means in reporting

Sales = confirmed `registrations` (`total_cents`), paid `cugc_registrations` (`price_cents`),
paid `print_orders` (`paid_cents`). Everything else — waitlist, free sessions, unpaid print,
cic7s interest, institute applications, booking requests — is a **lead**. This split is used
identically in `attribution-reports.ts` and the counter-repair job.

---

## 5. How each attribution model computes

Models run at query time (`shared/attribution-models.ts` → `selectAttributedTouch` /
`attributeConversion`) over a person's ordered touch log, within the lookback **window**
(default 90d, a query param). `analytics_events` has no ad columns, so ad_id/platform for the
attributed touch are taken from the **conversion stamp** (the meta_* columns on the row).

- **first_touch** — credit the *earliest* touch in the window. "What first brought them in."
- **last_non_direct** — credit the *most recent* touch that is not `direct`. The opinionated
  default in the dashboard. "What actually closed them," ignoring the final bare visit.
- **lifetime_first** — credit the person's *ever-first* touch, ignoring the window. "Original
  source of this customer," for LTV thinking.

If no eligible touch exists, the conversion falls through the **waterfall**: stamped
click/UTM → self-reported HDYHAU → unattributed. Deterministic, never blended.

Other reporting primitives in the same module: `rollupConversions` (by channel / campaign /
ad / platform, split new-vs-returning, leads vs sales), `rollupAdPlatformSplit` (Facebook vs
Instagram via `meta_platform`), `computeRoas` / `computeCac` + `attachSpendMetrics` (join
`ad_spend_daily`, spend_cents ÷ 100), `sessionize` (30-min inactivity gap),
`buildReconciliation` (tracked vs platform-reported vs HDYHAU), `tagNewVsReturning`.

**New vs returning** is a first-class split: a person is "new" if the conversion is their
first, "returning" otherwise.

---

## 6. Staff guide — links, QR & email

### Trackable links (the **Links** admin tab)

Every workspace has a **Links & QR** tab. Use a tracked link *anywhere you control the
placement* — a poster, a WhatsApp message, an Instagram bio, an SMS, a printed flyer — so the
sale traces back to it.

1. Open **Links & QR** → fill the builder:
   - **Destination** — the page you want people to land on. Must be one of *our* sites
     (minifootball.co.nz, christchurchunited.co.nz, cicyouth.com, unitedprints.co.nz,
     southislandunited.com, footballinstitute.co.nz, cugc.co.nz, cufc.co.nz, usg.co.nz).
     Anything else is rejected (open-redirect guard).
   - **Channel** — pick from the locked dropdown (facebook, instagram, whatsapp, qr, sms,
     referral, …). This is what the dashboard will credit.
   - **Campaign** — a short label, e.g. `term3-launch`. Free text, auto-slugged.
   - **Medium / Content / Custom key** — optional. Leave the key blank for an auto short key.
2. **Copy** the `/l/<key>` link and use it. For a poster, hit **QR** → download the PNG or SVG
   (generated in-browser, no external service) and drop it into Canva/print.
3. **Counters:** `clicks` update as people click. **Leads / sales / revenue populate
   overnight** (a nightly job matches conversions back to the link) — they show 0 until then.
   Archived links keep their history.

**WhatsApp helper:** the tab has a standalone `wa.me/<number>?text=<message>` generator (copy
+ QR). `wa.me` isn't one of our domains, so it can't be a stored short link — it's a
direct-share link, not tracked through `/l/`.

### QR codes

Any tracked link → **QR** button → download. A scan hits `/l/:key?qr=1`, which flags the
click as QR, sets the cookie, and forwards to the destination. On the confirmation screen the
person can also self-report "Poster or QR code" (HDYHAU), giving a second signal.

### Email campaigns

Email instrumentation is **automatic** for the wired-up senders — you don't hand-write UTMs.

- **Broadcasts** (MFL league mailer, CIC mailer): every CTA link to one of our domains gets
  `utm_source=email&utm_medium=broadcast&utm_campaign=<campaign id>` plus a per-recipient
  signed `?ci=emc…` token. When that recipient clicks, we bind the click to *them* — so an
  email click shows up in their journey and the sale is credited to email.
- **Transactional confirmations** (e.g. MFL league confirmation / team confirmed / season
  reward / waitlist): CTA links get `utm_medium=transactional`. No per-recipient token (we
  already know who they are from the registration).
- Rewriting is **idempotent** (safe to re-send; won't double-append) and only touches links
  to *our* domains — anything else passes through untouched. A confirmation with no funnel CTA
  (most camp/CUGC confirmations) is simply left alone.

To wire a *new* customer-facing template: add `utm:` to its `sendEmail({...})` call
(`{ medium: "transactional", campaign: "<stable-slug>" }`). See AGENTS.md → "T14 wiring
pattern" for the exact shape. Internal/staff notification emails are never instrumented.

### Meta ads

Put the `url_tags` string (decision 3) on the ad. The nightly `ad-spend-cron` pulls spend +
names and the dashboard shows Facebook-vs-Instagram, campaign, and per-ad ROAS/CAC. The one
manual guard: **never** let child data reach a Custom Audience / CAPI payload.

---

## 7. Operations

**Crons** (registered in `server/index.ts`, guarded, NZ-timezone-aware, all swallow errors):

| Cron | File | Cadence | Does |
|---|---|---|---|
| Ad-spend sync | `server/ad-spend-cron.ts` | daily (first run +5min) | Meta Insights → `ad_spend_daily` + `ad_entities`. No-op without `META_ACCESS_TOKEN` + account ids. |
| Attribution maintenance | `server/attribution-maintenance-cron.ts` | daily (first run +10min) | prune page_view/scroll >13mo (keeps session_start/alias/touch-bearing/converted) · bot-flag backstop · **repair short-link leads/sales/revenue counters**. |

Config (env or `settings` table): `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_IDS`
(`act_… , act_…`), overrides `AD_SPEND_CRON_INTERVAL_MS`,
`ATTR_MAINTENANCE_CRON_INTERVAL_MS`. `META_API_VERSION` is a single const in
`server/meta-capi.ts` — bump it there when Meta deprecates a Graph version.

**Verification / tests** (run any with `npx tsx script/<file>`):
`test-attribution.ts` (classifier/waterfall/ingest, 149) · `test-attribution-spine.ts`
(cookies + vi/ci matrix, 72) · `test-attribution-identity.ts` (merge rules, 46) ·
`test-attribution-links.ts` (869) · `test-attribution-tjs.ts` (48) ·
`test-attribution-email.ts` (53) · `test-attribution-meta.ts` (94) ·
`test-attribution-hdyhau.ts` (14) · `test-attribution-reports.ts` (62). Build gate:
`npm run build` (vite + esbuild, exits 0). `npm run check` (tsc) has ~433 **pre-existing**
errors — not our gate.

---

## 8. Going live (human-gated — the loop never does this)

The loop wrote everything additive and never deployed. To ship, a human:

1. **Apply the migrations to prod** (additive, before deploy — standing rule), in order:
   `2026-07-04_attribution_identity.sql` → `_links_spend.sql` → `_email_tokens.sql` →
   `_indexes.sql`. On large tables run each `CREATE INDEX` as `CONCURRENTLY` (the files ship
   the plain transaction-safe form; see the header notes). **Never `db:push`** — prod has
   schema drift.
2. **Deploy ClubOS** (deploy.sh) and smoke-test the collector + `/l/` on prod.
3. **Add `/t.js` + link decoration** to the 5 marketing sites (start with MFL), verify the
   cross-domain stitch.
4. **AdsOS `url_tags`** on NEW ads first; retrofit the live MFL campaign only after testing
   whether editing live-ad url_tags triggers re-review (test on a paused duplicate).
5. **Privacy statements** updated on brand sites at the same time as the snippets.
6. Run **`ATTRIBUTION-QA.md`** end-to-end and fix anything red before calling it live.

Follow-up project (Daniel's go): kill cic7s Stripe Payment Links → embedded ClubOS checkout
(the worst remaining attribution hole).
