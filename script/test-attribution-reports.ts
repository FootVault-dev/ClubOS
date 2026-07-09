/**
 * T18 — pure attribution-model + aggregation tests (no DB, no network).
 * Run: npx tsx script/test-attribution-reports.ts   (exits non-zero on failure)
 */
import assert from "node:assert";
import {
  ATTRIBUTION_MODELS,
  attachSpendMetrics,
  attributeConversion,
  buildReconciliation,
  coerceAttributionModel,
  computeCac,
  computeRoas,
  isAttributionModel,
  isDirectChannel,
  normalizeMetaPlatform,
  rollupAdPlatformSplit,
  rollupConversions,
  selectAttributedTouch,
  sessionize,
  tagNewVsReturning,
  type ConversionRecord,
  type Touch,
} from "../shared/attribution-models";

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.deepStrictEqual(a, b, msg);
  passed++;
}

const DAY = 86_400_000;
const T0 = 1_700_000_000_000; // fixed epoch base (no Date.now — deterministic)
const t = (channel: string | null, dayOffset: number, extra: Partial<Touch> = {}): Touch => ({
  channel,
  timestamp: T0 + dayOffset * DAY,
  ...extra,
});

// ── Model selection over synthetic touch arrays (the core requirement) ────────
{
  // facebook (d-100) → google/direct (d-40) → email (d-5) → convert d0
  const touches: Touch[] = [
    t("facebook", -100, { campaign: "spring" }),
    t("direct", -40),
    t("email", -5, { campaign: "newsletter" }),
  ];
  const conv = { conversionTime: T0, windowDays: 90 };

  // first_touch inside 90d window = the earliest touch that is still in window (email? no).
  // facebook at d-100 is OUTSIDE the 90d window, so first-in-window is direct@d-40.
  eq(selectAttributedTouch(touches, "first_touch", conv)?.channel, "direct", "first_touch = first IN window");
  // last_non_direct = email (latest non-direct)
  eq(selectAttributedTouch(touches, "last_non_direct", conv)?.channel, "email", "last_non_direct = email");
  // lifetime_first ignores the window = facebook (earliest ever)
  eq(selectAttributedTouch(touches, "lifetime_first", conv)?.channel, "facebook", "lifetime_first = earliest ever");

  // widen the window to 120d → first_touch now reaches facebook
  eq(
    selectAttributedTouch(touches, "first_touch", { conversionTime: T0, windowDays: 120 })?.channel,
    "facebook",
    "first_touch widens with window",
  );
}

{
  // all-direct history → last_non_direct falls back to the last touch (GA4 behaviour)
  const touches = [t("direct", -3), t(null, -1)];
  eq(selectAttributedTouch(touches, "last_non_direct", { conversionTime: T0 })?.timestamp, T0 - 1 * DAY, "last_non_direct all-direct fallback = last touch");
  ok(selectAttributedTouch([], "first_touch", { conversionTime: T0 }) === null, "empty touches → null");
}

{
  // a touch AFTER the conversion must never be selected
  const touches = [t("facebook", -2), t("email", 5)];
  eq(selectAttributedTouch(touches, "last_non_direct", { conversionTime: T0 })?.channel, "facebook", "post-conversion touch excluded");
}

// ── isDirectChannel / normalizeMetaPlatform ──────────────────────────────────
ok(isDirectChannel(null) && isDirectChannel("") && isDirectChannel("direct") && isDirectChannel("unattributed"), "direct set");
ok(!isDirectChannel("facebook") && !isDirectChannel("meta_unattributed"), "non-direct set");
eq(normalizeMetaPlatform("instagram"), "instagram", "platform ig");
eq(normalizeMetaPlatform("facebook"), "facebook", "platform fb");
eq(normalizeMetaPlatform("audience_network"), "audience_network", "platform an");
eq(normalizeMetaPlatform("unknown_place"), "other", "platform other");
eq(normalizeMetaPlatform(null), null, "platform null");

// ── attributeConversion waterfall + stamped ad merge ─────────────────────────
{
  const base: ConversionRecord = { key: "p:1", timestamp: T0, revenueCents: 5000, isNew: true, isLead: false };

  // touch selected → channel from touch, but ad id from the conversion stamp (touch log has none)
  const a1 = attributeConversion(
    { ...base, stampedAdId: "120210", stampedPlatform: "instagram" },
    [t("facebook", -2)],
    "last_non_direct",
  );
  eq(a1.channel, "facebook", "attr channel from touch");
  eq(a1.adId, "120210", "attr adId from stamp when touch lacks it");
  eq(a1.platform, "instagram", "attr platform from stamp");
  eq(a1.matchedBy, "touch", "matchedBy touch");

  // no touches → stamped channel
  const a2 = attributeConversion({ ...base, stampedChannel: "google" }, [], "last_non_direct");
  eq(a2.channel, "google", "attr falls back to stamped channel");
  eq(a2.matchedBy, "stamped", "matchedBy stamped");

  // no touches, no stamp → hdyhau self-report
  const a3 = attributeConversion({ ...base, hdyhau: "instagram" }, [], "first_touch");
  eq(a3.matchedBy, "self_reported", "matchedBy self_reported");
  ok(typeof a3.channel === "string" && a3.channel.length > 0, "hdyhau maps to a channel");

  // nothing → unattributed
  const a4 = attributeConversion(base, [], "first_touch");
  eq(a4.channel, "unattributed", "attr unattributed");
  eq(a4.matchedBy, "unattributed", "matchedBy unattributed");
}

// ── rollupConversions: channel dim, new/returning, leads/sales ────────────────
{
  const touches = new Map<string, Touch[]>([
    ["p:1", [t("facebook", -2)]],
    ["p:2", [t("email", -1)]],
  ]);
  const convs: ConversionRecord[] = [
    { key: "p:1", timestamp: T0, revenueCents: 10000, isNew: true, isLead: false },
    { key: "p:1", timestamp: T0 + DAY, revenueCents: 5000, isNew: false, isLead: false },
    { key: "p:2", timestamp: T0, revenueCents: 0, isNew: true, isLead: true },
    { key: null, timestamp: T0, revenueCents: 0, isNew: true, isLead: true, stampedChannel: "direct" },
  ];
  const rows = rollupConversions(convs, touches, { model: "last_non_direct", dimension: "channel" });
  const fb = rows.find((r) => r.key === "facebook")!;
  eq(fb.revenueCents, 15000, "facebook revenue summed across both conversions");
  eq(fb.conversions, 2, "facebook 2 conversions");
  eq(fb.newConversions, 1, "facebook 1 new");
  eq(fb.returningConversions, 1, "facebook 1 returning");
  eq(fb.sales, 2, "facebook 2 sales");
  const email = rows.find((r) => r.key === "email")!;
  eq(email.leads, 1, "email 1 lead");
  ok(!!rows.find((r) => r.key === "direct"), "keyless conversion falls to stamped direct");
  // rows sorted by revenue desc → facebook first
  eq(rows[0].key, "facebook", "rows sorted by revenue desc");

  // new-only filter
  const newOnly = rollupConversions(convs, touches, { model: "last_non_direct", dimension: "channel", filter: "new" });
  eq(newOnly.find((r) => r.key === "facebook")!.conversions, 1, "new filter drops returning");
}

// ── rollupAdPlatformSplit: FB vs IG ──────────────────────────────────────────
{
  const convs: ConversionRecord[] = [
    { key: "p:1", timestamp: T0, revenueCents: 8000, isNew: true, isLead: false, stampedAdId: "A", stampedPlatform: "facebook" },
    { key: "p:2", timestamp: T0, revenueCents: 2000, isNew: true, isLead: false, stampedAdId: "A", stampedPlatform: "instagram" },
    { key: "p:3", timestamp: T0, revenueCents: 999, isNew: true, isLead: false }, // no ad → skipped
  ];
  const rows = rollupAdPlatformSplit(convs, new Map(), { model: "last_non_direct" });
  eq(rows.length, 1, "only ad-attributed conversions counted");
  const ad = rows[0];
  eq(ad.adId, "A", "ad id A");
  eq(ad.revenueCents, 10000, "ad total revenue");
  eq(ad.facebookRevenueCents, 8000, "fb split");
  eq(ad.instagramRevenueCents, 2000, "ig split");
  eq(ad.facebookConversions, 1, "fb conv");
  eq(ad.instagramConversions, 1, "ig conv");
}

// ── CAC / ROAS + attachSpendMetrics ──────────────────────────────────────────
eq(computeRoas(30000, 10000), 3, "roas 3x");
eq(computeRoas(100, 0), null, "roas null on zero spend");
eq(computeCac(10000, 4), 2500, "cac cents");
eq(computeCac(10000, 0), null, "cac null on zero conversions");
{
  const rows = [
    { key: "facebook", conversions: 2, leads: 0, sales: 2, revenueCents: 30000, newConversions: 2, returningConversions: 0 },
  ];
  const spend = new Map([["facebook", { spendCents: 10000, impressions: 500, clicks: 40 }]]);
  const withSpend = attachSpendMetrics(rows, spend);
  eq(withSpend[0].roas, 3, "attachSpend roas");
  eq(withSpend[0].cacCents, 5000, "attachSpend cac");
  eq(withSpend[0].spendCents, 10000, "attachSpend spend");
}

// ── sessionize (30-min gap) ──────────────────────────────────────────────────
{
  const mins = (m: number): Touch => ({ channel: "organic", timestamp: T0 + m * 60_000 });
  const sessions = sessionize([mins(0), mins(10), mins(25), mins(70), mins(80)], 30);
  eq(sessions.length, 2, "two sessions split on >30m gap");
  eq(sessions[0].length, 3, "first session 3 touches");
  eq(sessions[1].length, 2, "second session 2 touches");
}

// ── buildReconciliation ──────────────────────────────────────────────────────
{
  const tracked = [
    { key: "facebook", conversions: 5, leads: 1, sales: 4, revenueCents: 40000, newConversions: 5, returningConversions: 0 },
  ];
  const rows = buildReconciliation({
    tracked,
    hdyhauByChannel: new Map([["facebook", 8], ["referral", 3]]),
    platformByChannel: new Map([["facebook", { spendCents: 12000, impressions: 900, clicks: 60 }]]),
  });
  const fb = rows.find((r) => r.channel === "facebook")!;
  eq(fb.trackedConversions, 5, "recon tracked");
  eq(fb.hdyhauCount, 8, "recon hdyhau");
  eq(fb.spendCents, 12000, "recon spend");
  ok(!!rows.find((r) => r.channel === "referral"), "recon includes hdyhau-only channel");
}

// ── tagNewVsReturning ────────────────────────────────────────────────────────
{
  const input = [
    { key: "p:1", timestamp: T0 + 2 * DAY },
    { key: "p:1", timestamp: T0 }, // earlier → this is the "new" one
    { key: "p:2", timestamp: T0 },
    { key: null, timestamp: T0 },
  ];
  const tagged = tagNewVsReturning(input);
  eq(tagged[1].isNew, true, "earliest per key = new");
  eq(tagged[0].isNew, false, "later per key = returning");
  eq(tagged[2].isNew, true, "first for p:2 = new");
  eq(tagged[3].isNew, true, "keyless treated as new");
}

// ── model guards ─────────────────────────────────────────────────────────────
ok(isAttributionModel("first_touch") && !isAttributionModel("u_shaped"), "isAttributionModel");
eq(coerceAttributionModel("garbage"), "last_non_direct", "coerce default");
eq(coerceAttributionModel("lifetime_first"), "lifetime_first", "coerce passthrough");
eq(ATTRIBUTION_MODELS.length, 3, "exactly 3 models");

console.log(`✓ attribution-reports pure tests: ${passed} assertions passed`);
