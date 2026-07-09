# AttributionOS — post-deploy QA checklist

Run this **after** the migrations are applied and ClubOS is deployed (see
`ATTRIBUTION.md` → "Going live"). Everything below is a *live* check against the deployed
site — the loop's build tests already cover the pure logic; this proves it works end-to-end
on real prod. Tick each box; if one fails, fix before calling attribution live.

**Do not run this against local dev with the prod DATABASE_URL, and never `db:push`.**

Conventions used below:
- **DevTools → Application → Cookies** to inspect `usg_vid` / `usg_cid`.
- **DevTools → Network** to inspect requests/redirects (keep "Preserve log" on).
- **DB**: read-only SQL against prod (Supabase SQL editor). Queries are all `SELECT`.

---

## 0. Pre-flight (schema + cron are actually there)

- [ ] All four migrations applied: `persons`, `person_identities`, `person_merges`,
      `short_links`, `link_clicks`, `ad_spend_daily`, `ad_entities`, `email_click_tokens`
      exist; `analytics_events` has `channel`, `channel_raw`, `click_id`, `fbclid`, `gclid`,
      `fbp`, `fbc`, `person_id`, `landing_url`, `is_bot`.
- [ ] The three composite indexes exist on `analytics_events`
      (`(visitor_id,timestamp)`, `(person_id,timestamp)`, `(channel,timestamp)`).
- [ ] The 8 conversion tables each have the 10 attribution columns (spot-check
      `registrations` and `booking_requests`).
- [ ] App boots clean; server logs show the ad-spend + maintenance crons registered (and a
      graceful no-op line if `META_ACCESS_TOKEN` isn't set yet).

## 1. Cookie spine (server-set, first-party)

- [ ] Load a funnel page fresh (incognito). A `usg_vid` cookie is present, **~2-year** expiry,
      `SameSite=Lax`, `Secure`, **not** HttpOnly, set via a **response `Set-Cookie` header**
      (not JS).
- [ ] `usg_cid` appears/refreshes with a **~90-day** expiry.
- [ ] Reload → the **same** `usg_vid` persists (sliding, not regenerated).
- [ ] Landing with `?ci=TESTCID123` sets `usg_cid=TESTCID123`.
- [ ] The cookie is NOT set on `/api/*` requests or static asset fetches — only real HTML
      page GETs.

## 2. Ad-macro / classifier check (the {{ }} guard)

- [ ] Visit a funnel page with a **fully-formed** paid URL, e.g.
      `?utm_source=facebook&utm_medium=paid&utm_campaign=123&utm_content=456&utm_term=789`.
      In `analytics_events` the newest row for that visitor has `channel='facebook'`,
      `channel_raw='facebook'`, and is treated as paid.
- [ ] Visit with a **broken macro** URL, e.g. `?utm_content={{ad.id}}&utm_campaign={{campaign.id}}`.
      The stored row has those macro values **nulled** (no literal `{{…}}` anywhere in the
      row), and the touch is NOT credited to a bogus ad id.
- [ ] Visit with **fbclid only** (`?fbclid=abc123`, no utm). Channel is
      **`meta_unattributed`**, NOT paid, NOT `facebook`.
- [ ] Visit with a real Google Ads click (`?gclid=xyz`). Channel is `google`, paid.
- [ ] Directly loading the page with no params on a later visit → `channel='direct'`.

## 3. Short link + QR → classified touch

- [ ] In **Links & QR**, create a link: destination = a real funnel page, channel = `qr`,
      campaign = `qa-test`. It saves and returns a `/l/<key>`.
- [ ] Try to create a link to a **non-our-domain** (e.g. `https://example.com`) → rejected
      (open-redirect guard). Confirm you cannot save it.
- [ ] Open `/l/<key>` in a browser: it **302-redirects** to the destination with `?ci=<id>`
      + the link's utm params appended (existing destination params preserved), and sets
      `usg_cid` to that click id.
- [ ] A `link_clicks` row exists with a `click_id`, an `ip_hash` (hashed — **no raw IP**),
      `is_qr=false`; the `short_links.clicks` counter incremented by 1.
- [ ] Open the **same** link again within an hour from the same browser → **no** new
      `link_clicks` row, counter does **not** double-count (1h dedupe).
- [ ] Open `/l/<key>?qr=1` → the click row has `is_qr=true`. Generate the QR from the tab,
      scan it with a phone → lands on the destination, and a QR-flagged click is recorded.
- [ ] Open an unknown key `/l/definitely-not-real` → redirects to the brand's main site (no
      error page).

## 4. WhatsApp link → touch

- [ ] Use the WhatsApp helper to build a `wa.me/<number>?text=<code>` link (confirm it is NOT
      stored as a short link — it's a direct-share generator).
- [ ] For a *tracked* WhatsApp click, create a normal `/l/` link with channel = `whatsapp`,
      paste it into a WhatsApp message, tap it → lands on the funnel, `usg_cid` set, and the
      resulting session's touch classifies as `whatsapp` (via the link's utm).

## 5. Email click → identity bind

- [ ] Send yourself a **broadcast** test (MFL or CIC mailer) to a known email. View source:
      CTA links to our domains carry `utm_source=email&utm_medium=broadcast&utm_campaign=<id>`
      and a `?ci=emc…` token. Non-our-domain links are untouched.
- [ ] An `email_click_tokens` row exists mapping that `emc…` token → your email.
- [ ] Click the CTA from the email (fresh browser). On landing, the `emc…` token is resolved
      and your visitor is **bound to the person** for that email — verify a `person` exists
      for the email and that your `usg_vid` appears in `person_identities` (kind `visitor`)
      or your recent `analytics_events` rows now carry that `person_id`.
- [ ] Send the **same** broadcast again → the CTA reuses the **same** `emc…` token (idempotent,
      deterministic), no duplicate token rows.
- [ ] A **transactional** confirmation (e.g. MFL league confirmation) has
      `utm_medium=transactional` on its CTA and **no** `?ci=` token.

## 6. Conversion stamping (visitor → sale)

- [ ] Do a full test registration/booking on one funnel (use a disposable email). The new
      conversion row has `visitor_id`, `click_id` (if you arrived via `/l/` or `?ci=`),
      `attribution_channel`, and `person_id` populated.
- [ ] A `persons` row exists for the payer email; if you provided a phone, a `person_identities`
      row of kind `phone` was auto-linked.
- [ ] **Retroactive stitch:** earlier anonymous `analytics_events` for that same `visitor_id`
      now have `person_id` set (were NULL before you identified).
- [ ] **Failure never blocks checkout:** the conversion succeeds and the customer sees success
      even if attribution had nothing to stamp (e.g. cookies blocked). Confirm a
      cookie-blocked booking still completes.

## 7. Identity merge rules

- [ ] Two identities on one browser (register with email A, then later email B on the same
      `usg_vid`) do **NOT** silently merge into one person — a `person_merges` row with
      `reason='blocked_auto_merge'` is written and **both** persons still exist
      (family-iPad protection).
- [ ] Anonymous → identified binds freely (section 6 already shows this) with **no**
      `person_merges` row (there's no losing person on a plain anon bind).
- [ ] No illegal id ever creates a person/identity: none of `undefined, null, None,
      [object Object], NaN, anonymous, guest, ''` appears as a `person_identities.value`.

## 8. Cross-domain / cross-root (once /t.js is on the marketing sites)

- [ ] On a marketing site (e.g. `minifootball.co.nz`) `/t.js` loads (200,
      `Content-Type: application/javascript`, cached), and a `usg_vid` cookie is set scoped to
      the **brand root** (`Domain=minifootball.co.nz`) via `/api/public/analytics/hello`.
- [ ] Click a link from the marketing site to the funnel (`join.minifootball.co.nz`) → the
      **same** `usg_vid` carries across (first-party per root); the visitor is continuous.
- [ ] Cross-**root** hop (brand A site → brand B funnel) decorates the link with
      `?vi=&ci=`; on the destination an `event_type='alias'` row links the two visitor ids,
      and stitching bridges them (a person converting on either root gets both spines).

## 9. Meta truth loop

- [ ] A test Purchase fires the browser pixel and server CAPI with the **same** event id
      `purchase_<registrationId>` (check the pixel call in Network + the CAPI payload/log).
      Venue bookings now send a **server** Purchase (`purchase_venue_<groupId>`).
- [ ] Graph calls use the current `META_API_VERSION` (not v19.0).
- [ ] With `META_ACCESS_TOKEN` + account ids set, the ad-spend cron populates `ad_spend_daily`
      (spend stored in **cents** = Meta dollars ×100) and `ad_entities` (names). Without a
      token it no-ops cleanly.
- [ ] **Human task (not automatable here):** confirm Meta's dedup **window** from their docs —
      the code only guarantees matching event ids, not the window behaviour.

## 10. HDYHAU (self-reported)

- [ ] On a success screen (MFL success / waitlist success / camp success / member-booking
      request success) the "How did you hear about us?" card shows the 8 options.
- [ ] One tap submits (no extra button), the card disappears, and it does **not** re-appear on
      reload (localStorage guard, fires once).
- [ ] The answer lands on the right column: `hdyhau` on the table that has it, or the reused
      column (`registrations.referral_source`, `cugc_registrations.heard_via`).
- [ ] Where the existing `/feedback` survey already asks, the card is suppressed (no
      double-ask).

## 11. Dashboard & journeys

- [ ] The **Attribution** tab loads in every workspace. The 4 stat cards render (tracked
      revenue, top channel, paid ROAS, % unattributed) without error.
- [ ] Switching **model** (first / last-non-direct / lifetime) and **window** (7/30/90/365d)
      refetches and changes the numbers (react-query keys carry the controls).
- [ ] The channel table, campaign table, and **Facebook-vs-Instagram** ad split render;
      new-vs-returning toggle works.
- [ ] Click a conversion in the recent list → the **journey drawer** opens with an ordered
      timeline of touches + conversions for that person. Anonymous rows are non-clickable.
- [ ] A person with **zero** in-scope conversions returns **404** on `journey/:personId` (no
      cross-workspace PII leak).
- [ ] On the master (`group`) workspace only, the **Group rollup** checkbox appears and, when
      ticked, aggregates across owned orgs; a brand workspace cannot widen its scope.

## 12. Reconciliation is sane

- [ ] The reconciliation view shows three columns (platform-reported vs tracked vs
      self-reported/HDYHAU) with the amber "these will not match — divergence is information"
      note.
- [ ] The three numbers are in the same **ballpark** (not off by orders of magnitude). Large
      structured gaps = a real signal to investigate, not necessarily a bug.

## 13. Privacy / no child PII (compliance gate — must pass)

- [ ] Inspect every attribution payload — `analytics_events`, short links, conversion stamps,
      and especially **Meta CAPI** payloads. Confirm there is **NO child name, DOB, or child
      identifier** anywhere. The attribution person is always the **parent/payer**.
- [ ] No raw IP is stored anywhere (only `ip_hash` on `link_clicks`).
- [ ] Privacy statements on the brand sites name Meta/Google and state the attribution
      purpose (shipped alongside the `/t.js` snippet).
- [ ] UEMA: broadcast emails carry a working unsubscribe; consent evidence retained.
- [ ] Legal read obtained before any Custom Audience upload.

## 14. Maintenance job

- [ ] Manually invoke / wait for the nightly maintenance cron. Confirm: old
      `page_view`/`scroll` rows (>13mo, not touch-bearing, not converted) are pruned, while
      `session_start` and `event_type='alias'` rows are **kept**.
- [ ] `short_links.leads` / `sales` / `sale_amount_cents` populate to match actual conversions
      joined by `click_id` (they read 0 until this job runs).
- [ ] Bot-flag backstop: a visitor with one confirmed bot event has its other recent rows
      flagged `is_bot=true`.

---

### Sign-off

- [ ] All sections above pass (or every failure has a tracked follow-up).
- [ ] Verified by: _______________  Date: _______________
- [ ] Attribution declared **live** for: ☐ MFL ☐ CUFC ☐ CIC ☐ United Print ☐ SIU ☐ Football Institute ☐ CUGC
