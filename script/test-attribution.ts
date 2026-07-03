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

console.log(`attribution (T1): ${pass} checks passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
console.log("ALL ATTRIBUTION CHECKS PASS ✓");
