# AGENTS.md — AttributionOS build contract (loop/attribution)

Background reading (once, if unsure about a design decision):
`/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/deep-research/2026-07-03-attribution-gold-standard/synthesis.md`
Master plan: `/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/plans/2026-07-03-attribution-os-build.md`

## What we're building (one paragraph)
First-party attribution for 6 sports brands inside this app: a visitor/touchpoint event
spine with server-set cookies, a persons+identities layer (PostHog merge rules), a
short-link/QR layer (Dub mechanics), UTM-instrumented email, Meta ad-level joins
(url_tags → ad.id → spend sync), and an admin Attribution dashboard with journey
timelines. Conversions in Postgres are the revenue truth; models are computed at query
time (first-touch, last-non-direct, lifetime-first only).

## HARD RULES (violating any of these ruins the run)
1. **NEVER start the server** (`npm run dev`, `tsx server/index.ts`, etc.) — boot against
   the prod DATABASE_URL triggers live crons (league balance charging). Never read or use
   `.env` `DATABASE_URL`. All verification is build + pure-logic tests.
2. **NEVER apply migrations or run `drizzle-kit push`/`db:push`** — prod has schema drift;
   push drops columns. You WRITE migration `.sql` files (additive only: CREATE TABLE IF NOT
   EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) and
   mirror them in `shared/schema.ts`. A human applies them.
3. **NEVER deploy** (`deploy.sh`, `fly`, `vercel`), never `git push`, never call live
   Stripe/Meta/Resend APIs. No network calls in tests.
4. **No child PII in any event or CAPI payload, ever.** The attribution person is the
   PARENT/payer. Do not add child names/DOBs to analytics_events, links, or Meta events.
5. **Additive, non-breaking:** existing funnels must keep working unchanged. New code
   paths are opt-in and defensive (attribution failures must never block a checkout —
   wrap in try/catch, log, continue).

## Design decisions you implement (do not re-litigate)
- **Cookies:** visitor id `usg_vid` (2 years) and click id `usg_cid` (90 days) are set via
  HTTP `Set-Cookie` from Express (SameSite=Lax, Secure, NOT httpOnly — client script reads
  them), never from JS. Server middleware owns them.
- **Canonical channels** (utm_source normalised): facebook, instagram, google, email,
  whatsapp, sms, qr, referral, organic, direct, other. Synonym map at ingest: fb→facebook,
  ig→instagram, msg→messenger, an→audience_network, google-ads→google, etc. ALWAYS keep the
  raw value in a `_raw` column alongside.
- **Classifier precedence** (GA4-style, pinned): referral-code param → our click id (?ci=) →
  paid (utm_medium in {paid,cpc,ppc,paid_social} OR meta ad params present) → utm channel →
  known-referrer table (l.facebook.com, lm.facebook.com, l.instagram.com,
  android-app://com.instagram.android, t.co, google organic domains) → direct.
  **fbclid with NO utm/ad params = channel `meta_unattributed`, NEVER paid** (fbclid appears
  on organic clicks too).
- **Meta macros are open sets:** store raw placement/site_source_name; map known values;
  bucket unknowns as `other_<raw>`; any value containing `{{` is nulled (unreplaced-macro bug).
- **Conflict waterfall** on conversions: referral code → click-id/UTM tracked → self-reported
  (HDYHAU) → unattributed. Deterministic. Never blend.
- **Identity merge rules (PostHog verbatim):** anonymous→identified merge freely; NEVER
  auto-merge two already-identified persons; blocklist of illegal ids ('undefined','null',
  'None','[object Object]','NaN','anonymous','guest',''); every merge writes a
  `person_merges` audit row; retroactive stitch = UPDATE analytics_events SET person_id
  WHERE visitor_id = X AND person_id IS NULL.
- **Models at query time** over the touchpoint log: first_touch, last_non_direct,
  lifetime_first. Lookback window is a query param (default 90d). New-vs-returning is a
  first-class split. No fractional/U-shaped/time-decay models.
- **Purchase event dedup:** ONE deterministic event id `purchase_<registrationId>` used by
  BOTH the browser pixel call and server CAPI for the same purchase.

## Codebase conventions (follow the neighbours)
- Server: endpoints in `server/routes.ts` (public: `/api/public/...` with explicit CORS
  where cross-origin; admin: `requireAuth` + tab gating via `requireTab(<slug>)` where used).
  Storage methods on the class in `server/storage.ts` (interface + impl). Crons follow
  `server/league-balance-cron.ts` / `server/print-cron.ts` patterns (registered in
  `server/index.ts`, guarded, NZ timezone-aware).
- Schema: `shared/schema.ts` drizzle + `createInsertSchema(...)` insert schema + type
  exports, matching the existing style. Money in cents. Timestamps `timestamp(...)`.
- Client admin: pages in `client/src/pages/`, tab slugs registered in `shared/tabs.ts` and
  the sidebar (`client/src/components/app-sidebar.tsx`), react-query with exact query keys
  (invalidate with the same key shape you queried), dark premium UI (`premium-input`,
  `rounded-2xl border border-blue-500/10 bg-white/[0.02]` panels), `data-testid` attributes.
- Public funnel pages: per-brand BRAND consts pattern (see `mfl-*.tsx`), wouter routing in
  `client/src/App.tsx` (3-segment routes BEFORE 2-segment `/league/:slug`).
- Shared pure logic in `shared/` (see `shared/league-pricing.ts` + its test
  `script/test-league-pricing.ts` — plain tsx + assert, run with
  `npx tsx script/test-league-pricing.ts`). Copy that testing pattern.
- Dates: NZ local — never `toISOString().slice(0,10)` for NZ dates.

## Verification (what "done" means)
- `npm run build` exits 0 (vite + esbuild). NOTE: `npm run check` (tsc) has ~404
  PRE-EXISTING errors — do NOT try to fix them, do NOT use tsc as your gate; your NEW code
  should still be written type-correctly.
- Pure-logic tasks ship a `script/test-attribution*.ts` runnable with `npx tsx`, exiting
  non-zero on failure, and you RUN it.
- UI tasks: build green + the page/tab wired into routing and sidebar registries.

## Lessons (append below as you learn)
- macOS bash is 3.2 — avoid mapfile/associative arrays in any shell you write.
- `apps/clubos` is its own git repo (nested). Commit here, not the parent.
- Run a pure-logic test with `npx tsx script/test-<name>.ts` (exits non-zero on fail). `npm run build` = vite + esbuild, ~7s, exits 0 clean (chunk-size + `dist/index.cjs 2.1mb ⚠️` warnings are PRE-EXISTING noise, not failures).
- **T1 shipped** `shared/attribution.ts` — the shared vocab/classifier all later tasks build on. Key exported surface to reuse (don't reimplement): `classifyTouch(TouchInput): ClassifiedTouch` (channel/channelRaw/isPaid/tracked/matchedBy), `resolveConversionAttribution(ConversionSignals)`, `normalizeSource`, `classifyReferrer`, `cleanMacroValue`, `isValidExternalId`, `validExternalId` (cleanMacro+isValid combined, returns cleaned-or-null — use this before keying anything on an external id), `mapHdyhauToChannel`, consts `CANONICAL_CHANNELS`/`ALL_CHANNELS`/`SYNONYM_MAP`/`PAID_MEDIUMS`/`ILLEGAL_IDS`/`META_UNATTRIBUTED`.
- Decisions I made where T1's spec was under-specified (kept consistent with GA4, safe to rely on downstream): **gclid ⇒ paid google** (gclid only appears on Google Ads clicks, unlike fbclid); **?ci= sets a `tracked` flag, not a channel** (our redirect always appends the link's utm, so channel comes from those); **unknown external referrers → direct** (only the KNOWN-referrer table classifies, per pinned precedence); **unknown non-empty utm_source → `other`** with the raw value preserved in `channelRaw`.
- `classifyTouch` hygiene-checks every id via `validExternalId` BEFORE it counts, so a literal `{{ad.id}}` macro never registers as a paid ad param. Reuse that pattern at ingest (T6).
- **T2 shipped** `migrations/2026-07-04_attribution_identity.sql` + schema mirror. Identity spine tables now exist in `shared/schema.ts`: `persons` (nullable primaryEmail/Phone/first/last — a person may exist before it's identified), `personIdentities` (kind email|phone|visitor + value; two unique indexes: `(kind,value)` global + `(personId,kind,value)`), `personMerges` (winnerId/loserId/reason audit — winner/loser are plain integers, NOT FKs, because a losing person may be deleted after merge). `analyticsEvents` gained: fbclid, gclid, clickId, fbp, fbc, personId, channel, channelRaw, landingUrl, isBot(bool default false). Reuse these types/tables downstream — don't redefine. T7 identity service writes here.
- Migration SQL convention in this repo: `integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY`, `timestamp NOT NULL DEFAULT now()`, lowercase snake_case, additive verbs only (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`). Header comment says "Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push." Matches `migrations/2026-07-03_league_waitlist.sql`.
- Drizzle table-extra config (indexes/unique) goes in the 3rd arg `(t) => ({ name: uniqueIndex("...").on(t.col) })` — see the `person_identities` def and existing `rewardBuilders`. `boolean(...).notNull().default(false)` mirrors SQL `boolean NOT NULL DEFAULT false`.
- Non-unique drizzle indexes need `index` from `drizzle-orm/pg-core` — it was NOT in schema.ts's import until T3 (only `uniqueIndex`/`unique`). Added it. Use `index("name").on(t.a, t.b)`.
- **T3 shipped** `migrations/2026-07-04_attribution_links_spend.sql` + schema mirror. New tables (reuse, don't redefine): `shortLinks` (org-scoped, `key` unique via `/l/:key`, cached counters clicks/leads/sales/saleAmountCents, `destination` must be allowlisted at create time — T9/T10), `linkClicks` (`clickId` unique, `ipHash`=SHA256(ip+ua) NO raw IP, 1h dedupe key), `adSpendDaily` (unique key `(date,adId,publisherPlatform,platformPosition)` — the two breakdown cols default `''` NOT null so the upsert key never has a NULL; `spendCents` = integer cents, Meta returns decimal dollars so T16 must ×100), `adEntities` (`adId` unique name-lookup). Insert schemas + types exported for all 4.
- **T4 shipped** `server/attribution-cookies.ts` — the first-party cookie spine. Reuse this surface downstream (don't reimplement): `parseCookieHeader(header)` → name→value map (tolerant, never throws), `isValidVisitorId(v)` / `isValidClickId(v)` (url-safe charset guard + `validExternalId` — use these before trusting ANY id read off a cookie or `?ci=`; they block Set-Cookie/header injection), `decideAttributionCookies({cookies, ciParam, mintVisitorId})` → `{visitorId, clickId, setCookies}`, `serializeSetCookie(spec, {secure})`, consts `VID_COOKIE`='usg_vid'/`CID_COOKIE`='usg_cid'/`VID_MAX_AGE_SECONDS`(2y)/`CID_MAX_AGE_SECONDS`(90d). The middleware hangs `req.usgVid`/`req.usgCid` off the request for downstream handlers (T8 conversion stamping reads these).
- **Middleware mounting:** `app.use(attributionCookieMiddleware)` sits in `server/index.ts` AFTER the request-logging middleware, BEFORE the async IIFE that calls `registerRoutes` — so it runs before every route. It only acts on non-`/api`, non-static-asset GET requests (STATIC_ASSET_RE skip list) → Set-Cookie lands on real HTML page loads only, not on JSON/asset fetches. Uses `res.append("Set-Cookie", …)` (not `res.set`) so it never clobbers a session Set-Cookie on the same response.
- **Secure flag:** app has NO `cookie-parser` (express-session parses its own). We parse cookies ourselves from `req.headers.cookie`. Set-Cookie `Secure` is keyed off `req.secure || x-forwarded-proto === 'https'` (session cookie hardcodes `secure:false`), so cookies still stick over local http dev yet get Secure behind Fly's https proxy. SameSite=Lax, NOT HttpOnly (analytics.js reads them). No `Domain` attribute (host-only) — cross-root sharing is T12/T13's job, not T4's.
- T4/T13 both touch the cookie middleware: T13 extends `decideAttributionCookies` for `?vi=` adopt/alias — keep that logic pure and in this same module so its tests live in `script/test-attribution-spine.ts` too.
- **T5 shipped** `client/public/analytics.js` upgraded (plain static file, NOT bundled/typechecked — vite just copies `client/public/` → `dist/public/`, so "build green" is trivially satisfied; validate JS separately with `node --check client/public/analytics.js` and grep for `=>`/`const`/`let`/backticks to keep it ES5-safe). It now emits these NEW fields on `session_start`/`page_view` events (T6 collector ingest must accept them): `visitorId` (now sourced from the `usg_vid` cookie, falling back to legacy `_cufc_vid`), `legacyVid` (the old id, sent ONCE per browser for stitching — guarded by `_cufc_legacy_sent` localStorage flag), `fbclid`, `gclid`, `ci`, `clickId` (=`ci` param || `usg_cid` cookie), `fbp` (`_fbp` cookie), `fbc` (`_fbc` cookie), `utmContent`, `utmTerm`, `landingUrl`. Existing top-level `utmSource/utmMedium/utmCampaign` stay on every event. Attribution fields are attached ONLY to session_start/page_view (via `applyAttribution()`); click/scroll/exit events stay lean — so T6 should classify touch from session_start/page_view rows. Cookies read via a new tolerant `getCookie()`; the client NEVER writes usg_vid/usg_cid (server owns them). `clickId` sends the last-click id even on later organic page views (usg_cid is a 90d sliding cookie) — that's intended last-click behaviour.
- **T6 shipped** collector ingest is now shaping, not a raw passthrough. New pure surface in `shared/attribution.ts` (reuse downstream, don't reimplement): `shapeAnalyticsEvent(raw, ctx?) → ShapedAnalyticsEvent | null` (null = malformed → dropped), `shapeAnalyticsEvents(rawArr, ctx?, limit=50)`, `isBotUserAgent(ua)` (missing/empty UA ⇒ bot; explicit isbot token list — deliberately NO bare `bot` substring so device brand "CUBOT" isn't false-flagged, uses `\bbot\b` for the generic case), `detectBot({userAgent, webdriver})` (webdriver hint ORs with UA), const `TOUCH_EVENT_TYPES` = {session_start, page_view}. Both `/api/public/analytics/event` + `/batch` in routes.ts call these with `{ userAgent: req.headers["user-agent"] }`.
- **T6 gotchas for later tasks:** (a) `analytics_events` has NO metaAdId/utmContent/utmTerm columns (those live on conversion tables per T3) — the shaper stashes `utmContent`/`utmTerm` and the T5 stitch signal `legacyVid` into the `metadata` jsonb instead. **T7 reads `metadata->>'legacyVid'` for the legacy-id stitch.** (b) Touch is classified ONLY on session_start/page_view rows (only they carry the full fbclid/gclid/clickId bundle from analytics.js); other event types get `channel = null` → reporting joins channel by visitor/session, not per-row. (c) Existing analytics overview queries read `metadata->>'trafficSource'|'isNewVisitor'|'seconds'|'maxPercent'` — the shaper preserves client `metadata` verbatim and only ADDS keys, so those keep working. (d) analytics.js now sends `evt.webdriver` on touch events (consumed for bot detection, then discarded — not a column).
- **T7 shipped** the identity service, split pure/DB. **Pure logic in `shared/identity.ts`** (reuse downstream, don't reimplement): `normalizeEmail(raw)` (trim+lowercase, validExternalId guard, requires `x@y.z` shape → the canonical form for persons.primaryEmail AND every `kind='email'` identity — T8 must normalise before lookups), `normalizePhone(raw)` (digits+`+`, ≥5 digits), `normalizeIdentityValue(kind,value)` (one entry point keying person_identities), `decideVisitorBind({existingPersonId,targetPersonId})` → `{action:'bind'|'noop'|'blocked_auto_merge'|'invalid', reason, audit}`, `isUsableIdentity`. **DB layer in `server/identity.ts`** (T8 calls these): `getOrCreatePersonByEmail(email,{phone,firstName,lastName})→Person|null` (null on bad email; enriches missing name/phone but NEVER overwrites; auto-links a phone identity), `linkIdentity(personId,kind,value)` (onConflictDoNothing on the (kind,value) unique — never steals an existing handle), `bindVisitorToPerson(visitorId,personId)→VisitorBindDecision` (bind→also stitches; blocked→writes person_merges `blocked_auto_merge` with winner=existing owner, keeps both), `stitchVisitorHistory(visitorId,personId)→count` (UPDATE analytics_events SET person_id WHERE visitor_id AND person_id IS NULL, THEN bridges each distinct `metadata->>'legacyVid'` and stitches those rows too).
- **T7 gotchas:** (a) `server/*.ts` importing `./db` THROWS at module load without DATABASE_URL (Hard Rule 1) — so any pure logic a test needs MUST live in `shared/` (that's why T7's decisions are in `shared/identity.ts`, mirroring how T4's live in `server/attribution-cookies.ts` which has no db import). Never import a server file that pulls in `./db` from a test. (b) A plain anon→identified bind writes NO person_merges row (there's no losing person); only `blocked_auto_merge` audits. (c) `db.execute(sql\`…\`)` returns `{rows}` (node-postgres) — cast `res.rows as Array<{col}>`; drizzle `.update(t).set().where().returning({id:t.id})` then `.length` gives the affected-row count. (d) `@shared/…` path alias works in server files (see db.ts); tests use a relative `../shared/…` import.
- **T3 conversion columns:** all 8 conversion/lead tables (registrations, cugc_registrations, cugc_free_sessions, league_waitlist, cic7s_registrations, football_institute_applications, print_orders, booking_requests) gained `visitorId/clickId/personId/fbp/fbc/metaAdId/metaAdsetId/metaCampaignId/metaPlatform/attributionChannel` (+ `hdyhau` on 6). **HDYHAU column reuse:** `registrations.referralSource` and `cugc_registrations.heardVia` already hold the self-reported "how heard" value, so no `hdyhau` col was added there — T17/T18 must COALESCE the existing column for those two tables. `personId` is a plain `integer` (no FK) to match `analytics_events.person_id`. cugc tables keep their `attribution` jsonb blob AND now have the discrete columns (discrete cols are what joins/reporting use).
