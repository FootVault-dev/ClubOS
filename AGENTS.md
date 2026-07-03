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
