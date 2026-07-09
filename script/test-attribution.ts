// Standalone proof of the AttributionOS classifier + waterfall (T1). No DB / network.
//   npx tsx script/test-attribution.ts
//
// Covers the pinned design decisions from AGENTS.md:
//   - synonym normalisation (fb→facebook, ig→instagram, …)
//   - classifier precedence: referral → paid → utm_source → fbclid-only → referrer → direct
//   - fbclid-only is meta_unattributed and NEVER paid
//   - literal {{ad.id}} macros are nulled and never count as ad params
//   - known-referrer table hits (l.facebook.com, l.instagram.com, google.com, …)
//   - conversion waterfall order (referral > tracked > self-reported > unattributed)
//   - illegal external ids rejected

import {
  normalizeSource,
  classifyTouch,
  classifyReferrer,
  cleanMacroValue,
  isValidExternalId,
  validExternalId,
  resolveConversionAttribution,
  mapHdyhauToChannel,
  isBotUserAgent,
  detectBot,
  shapeAnalyticsEvent,
  shapeAnalyticsEvents,
  CANONICAL_CHANNELS,
  META_UNATTRIBUTED,
  type ClassifiedTouch,
} from "../shared/attribution";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    if (fails.length < 40) fails.push(msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── normalizeSource / synonyms ──────────────────────────────────────────────
eq(normalizeSource("fb"), "facebook", "fb → facebook");
eq(normalizeSource("FB"), "facebook", "FB → facebook (case-insensitive)");
eq(normalizeSource("facebook.com"), "facebook", "facebook.com → facebook");
eq(normalizeSource("ig"), "instagram", "ig → instagram");
eq(normalizeSource("insta"), "instagram", "insta → instagram");
eq(normalizeSource("google-ads"), "google", "google-ads → google");
eq(normalizeSource("newsletter"), "email", "newsletter → email");
eq(normalizeSource("wa"), "whatsapp", "wa → whatsapp");
eq(normalizeSource("msg"), "messenger", "msg → messenger");
eq(normalizeSource("an"), "audience_network", "an → audience_network");
eq(normalizeSource("facebook"), "facebook", "canonical passthrough");
eq(normalizeSource("tiktok"), "other", "unknown non-empty → other");
eq(normalizeSource(""), null, "empty → null");
eq(normalizeSource(null), null, "null → null");
eq(normalizeSource("  Instagram  "), "instagram", "trim + case");
eq(normalizeSource("{{campaign.source}}"), null, "macro source → null");
eq(normalizeSource("https://www.google.com/"), "google", "url-ish source normalised");

// ── cleanMacroValue ─────────────────────────────────────────────────────────
eq(cleanMacroValue("{{ad.id}}"), null, "literal {{ad.id}} → null");
eq(cleanMacroValue("120000123456"), "120000123456", "real ad id passes through");
eq(cleanMacroValue(" 987 "), "987", "trims");
eq(cleanMacroValue(""), null, "empty → null");
eq(cleanMacroValue(null), null, "null → null");
eq(cleanMacroValue(undefined), null, "undefined → null");
eq(cleanMacroValue("%7B%7Bad.id%7D%7D"), null, "url-encoded macro → null");
eq(cleanMacroValue("has}}brace"), null, "trailing macro brace → null");

// ── isValidExternalId / validExternalId ─────────────────────────────────────
check(isValidExternalId("abc123"), "valid id accepted");
check(!isValidExternalId("undefined"), "'undefined' rejected");
check(!isValidExternalId("null"), "'null' rejected");
check(!isValidExternalId("None"), "'None' rejected (case-insensitive)");
check(!isValidExternalId("[object Object]"), "'[object Object]' rejected");
check(!isValidExternalId("NaN"), "'NaN' rejected");
check(!isValidExternalId("anonymous"), "'anonymous' rejected");
check(!isValidExternalId("guest"), "'guest' rejected");
check(!isValidExternalId(""), "empty rejected");
check(!isValidExternalId("   "), "whitespace rejected");
check(!isValidExternalId("{{ad.id}}"), "macro rejected");
check(!isValidExternalId(42 as unknown as string), "non-string rejected");
eq(validExternalId("  keep-me  "), "keep-me", "validExternalId trims + returns");
eq(validExternalId("{{x}}"), null, "validExternalId nulls macro");
eq(validExternalId("undefined"), null, "validExternalId nulls illegal");

// ── classifyReferrer (known-referrer table) ─────────────────────────────────
eq(classifyReferrer("https://l.facebook.com/l.php?u=x")?.channel, "facebook", "l.facebook.com → facebook");
eq(classifyReferrer("https://lm.facebook.com/")?.channel, "facebook", "lm.facebook.com → facebook");
eq(classifyReferrer("https://l.instagram.com/")?.channel, "instagram", "l.instagram.com → instagram");
eq(classifyReferrer("android-app://com.instagram.android")?.channel, "instagram", "instagram app → instagram");
eq(classifyReferrer("android-app://com.facebook.katana")?.channel, "facebook", "facebook app → facebook");
eq(classifyReferrer("https://t.co/abc")?.channel, "other", "t.co → other");
eq(classifyReferrer("https://www.google.com/")?.channel, "google", "google.com → google");
eq(classifyReferrer("https://www.google.co.nz/search")?.channel, "google", "google.co.nz → google");
eq(classifyReferrer("https://duckduckgo.com/")?.channel, "organic", "duckduckgo → organic");
eq(classifyReferrer("https://example.com/blog"), null, "unknown referrer → null (falls to direct)");
eq(classifyReferrer(""), null, "empty referrer → null");

// ── classifyTouch precedence ────────────────────────────────────────────────
// referral code wins over everything
{
  const t = classifyTouch({ referralCode: "MATE10", utmSource: "fb", utmMedium: "paid", fbclid: "x" });
  eq(t.channel, "referral", "referral code wins");
  eq(t.matchedBy, "referral_code", "matchedBy referral_code");
  eq(t.isPaid, false, "referral not marked paid");
}
// paid via utm_medium
{
  const t = classifyTouch({ utmSource: "fb", utmMedium: "paid_social" });
  eq(t.channel, "facebook", "paid facebook channel");
  eq(t.isPaid, true, "paid_social → isPaid");
  eq(t.matchedBy, "paid_meta", "matchedBy paid_meta");
}
// paid via meta ad params (no utm)
{
  const t = classifyTouch({ metaAdId: "120000999", metaPlatform: "instagram" });
  eq(t.channel, "instagram", "meta ad + platform=instagram → instagram");
  eq(t.isPaid, true, "meta ad → paid");
  eq(t.matchedBy, "paid_meta", "matchedBy paid_meta (ad params)");
}
// gclid → paid google
{
  const t = classifyTouch({ gclid: "Cj0KCQ" });
  eq(t.channel, "google", "gclid → google");
  eq(t.isPaid, true, "gclid → paid");
  eq(t.matchedBy, "paid_google", "matchedBy paid_google");
}
// LITERAL {{ad.id}} macro must NOT count as a paid ad param
{
  const t = classifyTouch({ metaAdId: "{{ad.id}}", utmSource: "instagram", utmMedium: "social" });
  eq(t.isPaid, false, "literal {{ad.id}} does not trigger paid");
  eq(t.channel, "instagram", "falls through to utm_source instagram");
  eq(t.matchedBy, "utm_source", "matchedBy utm_source (macro ignored)");
}
// organic-tagged utm_source (non-paid medium)
{
  const t = classifyTouch({ utmSource: "email", utmMedium: "broadcast" });
  eq(t.channel, "email", "email broadcast → email");
  eq(t.isPaid, false, "broadcast not paid");
  eq(t.matchedBy, "utm_source", "matchedBy utm_source");
}
// fbclid-only → meta_unattributed, NEVER paid
{
  const t = classifyTouch({ fbclid: "IwAR123" });
  eq(t.channel, META_UNATTRIBUTED, "fbclid-only → meta_unattributed");
  eq(t.isPaid, false, "fbclid-only NEVER paid");
  eq(t.matchedBy, "fbclid_organic", "matchedBy fbclid_organic");
}
// fbclid PLUS paid utm still paid (utm precedence over fbclid-only)
{
  const t = classifyTouch({ fbclid: "IwAR", utmSource: "fb", utmMedium: "cpc" });
  eq(t.channel, "facebook", "fbclid+paid utm → facebook");
  eq(t.isPaid, true, "fbclid + paid medium → paid");
}
// referrer table hit (no utm)
{
  const t = classifyTouch({ referrer: "https://l.facebook.com/l.php" });
  eq(t.channel, "facebook", "referrer l.facebook.com → facebook");
  eq(t.matchedBy, "referrer", "matchedBy referrer");
  eq(t.isPaid, false, "organic referrer not paid");
}
// direct fallback
{
  const t = classifyTouch({});
  eq(t.channel, "direct", "no signals → direct");
  eq(t.matchedBy, "direct", "matchedBy direct");
}
// ?ci= sets tracked flag (channel still from utm)
{
  const t = classifyTouch({ clickId: "abc123def456", utmSource: "whatsapp", utmMedium: "referral" });
  eq(t.tracked, true, "clickId → tracked");
  eq(t.channel, "whatsapp", "channel from utm alongside ci");
}
{
  const t = classifyTouch({ clickId: "undefined", utmSource: "fb" });
  eq(t.tracked, false, "illegal clickId not tracked");
}

// ── channelRaw always preserved ─────────────────────────────────────────────
{
  const t = classifyTouch({ utmSource: "TikTok" });
  eq(t.channel, "other", "tiktok → other channel");
  eq(t.channelRaw, "TikTok", "raw source preserved verbatim");
}

// ── mapHdyhauToChannel ──────────────────────────────────────────────────────
eq(mapHdyhauToChannel("A friend told me"), "referral", "friend → referral");
eq(mapHdyhauToChannel("Instagram"), "instagram", "instagram → instagram");
eq(mapHdyhauToChannel("Facebook ad"), "facebook", "facebook → facebook");
eq(mapHdyhauToChannel("Google search"), "google", "google → google");
eq(mapHdyhauToChannel("Poster at the club"), "qr", "poster → qr");
eq(mapHdyhauToChannel("Something else"), "other", "unknown → other");

// ── resolveConversionAttribution waterfall order ────────────────────────────
const paidTouch: ClassifiedTouch = {
  channel: "facebook",
  channelRaw: "fb",
  isPaid: true,
  tracked: true,
  matchedBy: "paid_meta",
};
// referral code beats a tracked touch, a click id, and self-report
{
  const r = resolveConversionAttribution({ referralCode: "MATE10", clickId: "cid", touch: paidTouch, hdyhau: "Instagram" });
  eq(r.method, "referral", "waterfall: referral wins");
  eq(r.channel, "referral", "waterfall: referral channel");
  eq(r.detail, "MATE10", "waterfall: referral detail = code");
}
// tracked beats self-report + unattributed
{
  const r = resolveConversionAttribution({ touch: paidTouch, hdyhau: "Instagram" });
  eq(r.method, "tracked", "waterfall: tracked over self-report");
  eq(r.channel, "facebook", "waterfall: tracked channel from touch");
}
// click id alone → tracked
{
  const r = resolveConversionAttribution({ clickId: "abc123" });
  eq(r.method, "tracked", "waterfall: click id alone → tracked");
}
// a pure-direct touch is NOT tracked → falls to self-report
{
  const directTouch: ClassifiedTouch = { channel: "direct", channelRaw: null, isPaid: false, tracked: false, matchedBy: "direct" };
  const r = resolveConversionAttribution({ touch: directTouch, hdyhau: "A friend" });
  eq(r.method, "self_reported", "waterfall: direct touch → self-report");
  eq(r.channel, "referral", "waterfall: self-report channel mapped");
  eq(r.detail, "A friend", "waterfall: self-report detail");
}
// nothing → unattributed
{
  const r = resolveConversionAttribution({});
  eq(r.method, "unattributed", "waterfall: nothing → unattributed");
  eq(r.channel, "direct", "waterfall: unattributed channel = direct");
}
// illegal referral code is ignored, falls through
{
  const r = resolveConversionAttribution({ referralCode: "undefined", clickId: "realid123" });
  eq(r.method, "tracked", "waterfall: illegal referral code ignored → tracked");
}

// ── vocabulary sanity ───────────────────────────────────────────────────────
check(CANONICAL_CHANNELS.includes("facebook"), "canonical includes facebook");
check(CANONICAL_CHANNELS.includes("direct"), "canonical includes direct");
check(CANONICAL_CHANNELS.length === 11, "11 canonical channels");

// ─────────────────────────────────────────────────────────────────────────────
// T6 — collector ingest: bot detection + row shaping
// ─────────────────────────────────────────────────────────────────────────────

// Real browser UAs must NOT be flagged as bots.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const CUBOT_UA =
  "Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";

check(!isBotUserAgent(CHROME_UA), "real Chrome UA → not a bot");
check(!isBotUserAgent(SAFARI_IOS_UA), "real iOS Safari UA → not a bot");
check(!isBotUserAgent(CUBOT_UA), "CUBOT device UA → not a bot (no bare-'bot' false positive)");
check(isBotUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)"), "Googlebot → bot");
check(isBotUserAgent("facebookexternalhit/1.1"), "facebookexternalhit → bot");
check(isBotUserAgent("WhatsApp/2.23.20.0"), "WhatsApp link preview → bot");
check(isBotUserAgent("curl/7.79.1"), "curl → bot");
check(isBotUserAgent("python-requests/2.31.0"), "python-requests → bot");
check(isBotUserAgent("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36"), "HeadlessChrome → bot");
check(isBotUserAgent(""), "empty UA → bot");
check(isBotUserAgent(undefined), "missing UA → bot");

// detectBot: webdriver hint ORs with the UA blocklist.
check(detectBot({ userAgent: CHROME_UA, webdriver: true }), "webdriver=true → bot even with real UA");
check(detectBot({ userAgent: CHROME_UA, webdriver: "true" }), "webdriver='true' string → bot");
check(!detectBot({ userAgent: CHROME_UA, webdriver: false }), "webdriver=false + real UA → not a bot");
check(!detectBot({ userAgent: CHROME_UA }), "no webdriver + real UA → not a bot");
check(detectBot({ userAgent: "Googlebot/2.1", webdriver: false }), "bot UA still flagged when webdriver false");

// shapeAnalyticsEvent — malformed rows dropped.
eq(shapeAnalyticsEvent(null), null, "null payload → dropped");
eq(shapeAnalyticsEvent("nope"), null, "non-object payload → dropped");
eq(shapeAnalyticsEvent({ sessionId: "s1", eventType: "page_view" }), null, "missing visitorId → dropped");
eq(shapeAnalyticsEvent({ visitorId: "v1", eventType: "page_view" }), null, "missing sessionId → dropped");
eq(shapeAnalyticsEvent({ visitorId: "v1", sessionId: "s1" }), null, "missing eventType → dropped");
eq(shapeAnalyticsEvent({ visitorId: "undefined", sessionId: "s1", eventType: "page_view" }), null, "illegal visitorId → dropped");

// session_start classifies the touch (facebook paid) and is not a bot with a real UA.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "session_start", utmSource: "fb", utmMedium: "paid_social" },
    { userAgent: CHROME_UA },
  );
  check(s !== null, "valid session_start shapes");
  eq(s!.channel, "facebook", "session_start classified → facebook");
  eq(s!.channelRaw, "fb", "channelRaw preserved");
  eq(s!.isBot, false, "real UA → not flagged bot");
}

// page_view with fbclid only → meta_unattributed.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view", fbclid: "IwAR123" },
    { userAgent: CHROME_UA },
  );
  eq(s!.channel, META_UNATTRIBUTED, "fbclid-only page_view → meta_unattributed");
}

// non-touch event (click) is NOT classified — channel stays null.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "click", utmSource: "fb", utmMedium: "paid" },
    { userAgent: CHROME_UA },
  );
  eq(s!.channel, null, "non-touch event → channel null");
  eq(s!.channelRaw, null, "non-touch event → channelRaw null");
}

// literal {{ad.id}} macro on clickId is nulled, not persisted.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view", clickId: "{{ad.id}}" },
    { userAgent: CHROME_UA },
  );
  eq(s!.clickId, null, "macro clickId nulled");
}

// macro utm_campaign is nulled.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view", utmCampaign: "{{campaign.name}}" },
    { userAgent: CHROME_UA },
  );
  eq(s!.utmCampaign, null, "macro utm_campaign nulled");
}

// metadata preserved verbatim + legacyVid / utmContent / utmTerm stashed into it.
{
  const s = shapeAnalyticsEvent(
    {
      visitorId: "v1",
      sessionId: "s1",
      eventType: "session_start",
      utmContent: "ad-abc",
      utmTerm: "term-xyz",
      legacyVid: "old-vid-123",
      metadata: { trafficSource: "Meta Ads", isNewVisitor: true },
    },
    { userAgent: CHROME_UA },
  );
  eq(s!.metadata!.trafficSource, "Meta Ads", "existing metadata preserved");
  eq(s!.metadata!.isNewVisitor, true, "isNewVisitor preserved");
  eq(s!.metadata!.legacyVid, "old-vid-123", "legacyVid stashed into metadata");
  eq(s!.metadata!.utmContent, "ad-abc", "utmContent stashed into metadata");
  eq(s!.metadata!.utmTerm, "term-xyz", "utmTerm stashed into metadata");
}

// illegal legacyVid is not stashed.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view", legacyVid: "null" },
    { userAgent: CHROME_UA },
  );
  eq(s!.metadata, null, "illegal legacyVid not stashed, metadata stays null");
}

// screenWidth string coerced to int; webdriver hint drives is_bot.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view", screenWidth: "375", webdriver: true },
    { userAgent: CHROME_UA },
  );
  eq(s!.screenWidth, 375, "screenWidth string → int");
  eq(s!.isBot, true, "webdriver hint flags bot");
}

// bot UA flags the row.
{
  const s = shapeAnalyticsEvent(
    { visitorId: "v1", sessionId: "s1", eventType: "page_view" },
    { userAgent: "Googlebot/2.1" },
  );
  eq(s!.isBot, true, "bot UA flags the row");
}

// shapeAnalyticsEvents — drops malformed, respects limit, non-array → [].
{
  const batch = shapeAnalyticsEvents(
    [
      { visitorId: "v1", sessionId: "s1", eventType: "page_view" },
      { sessionId: "s1", eventType: "page_view" }, // malformed (no visitorId)
      { visitorId: "v2", sessionId: "s2", eventType: "session_start" },
    ],
    { userAgent: CHROME_UA },
  );
  eq(batch.length, 2, "batch drops the malformed row");
}
{
  const many = [1, 2, 3, 4].map((n) => ({ visitorId: "v" + n, sessionId: "s" + n, eventType: "page_view" }));
  eq(shapeAnalyticsEvents(many, { userAgent: CHROME_UA }, 2).length, 2, "batch respects the limit");
}
eq(shapeAnalyticsEvents(null).length, 0, "non-array batch → empty");
eq(shapeAnalyticsEvents(undefined).length, 0, "undefined batch → empty");

console.log(`attribution (T1+T6): ${pass} checks passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
console.log("ALL ATTRIBUTION CHECKS PASS ✓");
