// T16 — Meta ad-spend Insights parsers + URL builders. Pure, no DB, no network.
// Run: npx tsx script/test-attribution-meta.ts  (exits non-zero on failure)
import assert from "node:assert";
import {
  normalizeAdAccountId,
  parseAdAccountIds,
  dollarsToCents,
  toInt,
  nzDateString,
  trailingWindow,
  buildInsightsUrl,
  buildAdEntityUrl,
  parseInsightsPage,
  insightsNextPage,
  parseAdEntity,
  adEntitiesFromSpend,
  META_GRAPH_BASE,
} from "../shared/meta-insights";

let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  assert.ok(cond, msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  n++;
  assert.strictEqual(a, b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── normalizeAdAccountId ─────────────────────────────────────────────────────
eq(normalizeAdAccountId("123"), "act_123", "bare digits get act_ prefix");
eq(normalizeAdAccountId("act_123"), "act_123", "already prefixed passes through");
eq(normalizeAdAccountId("  act_456 "), "act_456", "whitespace trimmed");
eq(normalizeAdAccountId("ACT_789"), "act_789", "prefix case-insensitive");
eq(normalizeAdAccountId("abc"), null, "non-numeric → null");
eq(normalizeAdAccountId(""), null, "empty → null");
eq(normalizeAdAccountId(null), null, "null → null");
eq(normalizeAdAccountId("act_"), null, "prefix-only → null (no digits)");
eq(normalizeAdAccountId("act_12ab"), null, "digits+letters → null");

// ── parseAdAccountIds ────────────────────────────────────────────────────────
assert.deepStrictEqual(parseAdAccountIds("act_1, act_2 3"), ["act_1", "act_2", "act_3"], "mixed separators"); n++;
assert.deepStrictEqual(parseAdAccountIds("1,1,act_1"), ["act_1"], "dedupes"); n++;
assert.deepStrictEqual(parseAdAccountIds("act_9;10\n11"), ["act_9", "act_10", "act_11"], "semicolon+newline"); n++;
assert.deepStrictEqual(parseAdAccountIds(""), [], "empty → []"); n++;
assert.deepStrictEqual(parseAdAccountIds(null), [], "null → []"); n++;
assert.deepStrictEqual(parseAdAccountIds("x, , act_5"), ["act_5"], "invalid entries dropped"); n++;

// ── dollarsToCents (Meta gives decimal dollars; we store cents) ──────────────
eq(dollarsToCents("12.34"), 1234, "12.34 dollars → 1234 cents");
eq(dollarsToCents("0"), 0, "0 → 0");
eq(dollarsToCents(5), 500, "numeric 5 → 500");
eq(dollarsToCents("100"), 10000, "100 → 10000");
eq(dollarsToCents("0.1"), 10, "0.1 → 10 (float-safe round)");
eq(dollarsToCents("1,234.50"), 123450, "thousands comma stripped");
eq(dollarsToCents(null), 0, "null → 0");
eq(dollarsToCents("abc"), 0, "non-numeric → 0");
eq(dollarsToCents(undefined), 0, "undefined → 0");

// ── toInt ────────────────────────────────────────────────────────────────────
eq(toInt("1000"), 1000, "string int");
eq(toInt(50), 50, "number int");
eq(toInt(null), 0, "null → 0");
eq(toInt("-5"), 0, "negative → 0");
eq(toInt("abc"), 0, "non-numeric → 0");
eq(toInt("1,234"), 1234, "comma stripped");

// ── nzDateString (Pacific/Auckland — NOT toISOString) ────────────────────────
// July = NZST (UTC+12).
eq(nzDateString(new Date("2026-07-04T00:00:00Z")), "2026-07-04", "NZST noon same day");
eq(nzDateString(new Date("2026-07-03T13:00:00Z")), "2026-07-04", "NZST rolls to next NZ day while UTC is prior day");
// January = NZDT (UTC+13) — proves DST offset, not a fixed +12.
eq(nzDateString(new Date("2026-01-14T11:30:00Z")), "2026-01-15", "NZDT (+13) rolls forward where +12 would not");
eq(nzDateString(new Date("2026-01-15T00:00:00Z")), "2026-01-15", "NZDT afternoon same day");

// ── trailingWindow ───────────────────────────────────────────────────────────
{
  const w = trailingWindow(new Date("2026-07-04T06:00:00Z"), 7);
  eq(w.until, "2026-07-04", "window until = today NZ");
  eq(w.since, "2026-06-28", "window since = today-6 NZ (7-day inclusive)");
  const w1 = trailingWindow(new Date("2026-07-04T06:00:00Z"), 1);
  eq(w1.since, w1.until, "1-day window: since == until");
}

// ── buildInsightsUrl ─────────────────────────────────────────────────────────
{
  const url = buildInsightsUrl("act_123", { since: "2026-06-28", until: "2026-07-04", apiVersion: "v23.0", limit: 500 });
  ok(url.startsWith(`${META_GRAPH_BASE}/v23.0/act_123/insights?`), "correct base+version+account path");
  ok(url.includes("level=ad"), "level=ad");
  ok(url.includes("breakdowns=publisher_platform,platform_position"), "breakdowns present");
  ok(url.includes("time_increment=1"), "per-day rows");
  ok(url.includes("limit=500"), "limit passed");
  ok(!/access_token/i.test(url), "NO access_token in the pure builder");
  ok(url.includes("ad_id") && url.includes("spend") && url.includes("impressions"), "fields present");
  const m = url.match(/time_range=([^&]+)/);
  ok(!!m, "time_range param present");
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(m![1])), { since: "2026-06-28", until: "2026-07-04" }, "time_range decodes to JSON"); n++;
}

// ── buildAdEntityUrl ─────────────────────────────────────────────────────────
{
  const url = buildAdEntityUrl("999", { apiVersion: "v23.0" });
  ok(url.startsWith(`${META_GRAPH_BASE}/v23.0/999?`), "node path with id");
  ok(!/access_token/i.test(url), "no token");
  const m = url.match(/fields=([^&]+)/);
  ok(!!m, "fields param present");
  eq(decodeURIComponent(m![1]), "name,adset{name,campaign{name}}", "nested field expansion decodes");
}

// ── parseInsightsPage ────────────────────────────────────────────────────────
{
  const resp = {
    data: [
      {
        ad_id: "111", adset_id: "222", campaign_id: "333",
        ad_name: "Ad A", adset_name: "Set A", campaign_name: "Camp A",
        spend: "12.34", impressions: "1000", clicks: "50",
        publisher_platform: "facebook", platform_position: "feed",
        date_start: "2026-07-01", date_stop: "2026-07-01",
      },
      {
        ad_id: "111", adset_id: "222", campaign_id: "333",
        ad_name: "Ad A", adset_name: "Set A", campaign_name: "Camp A",
        spend: "5.00", impressions: "200", clicks: "9",
        publisher_platform: "instagram", platform_position: "story",
        date_start: "2026-07-01", date_stop: "2026-07-01",
      },
      { adset_id: "x", spend: "9.99", date_start: "2026-07-01" }, // no ad_id → skip
      { ad_id: "444", spend: "1.00" },                            // no date_start → skip
      { ad_id: "555", spend: null, date_start: "2026-07-02" },    // no breakdowns / no spend
    ],
    paging: { next: "https://graph.facebook.com/next-page-token" },
  };
  const rows = parseInsightsPage(resp);
  eq(rows.length, 3, "keeps 3 well-formed rows (2 skipped)");
  const r0 = rows[0];
  eq(r0.adId, "111", "ad_id");
  eq(r0.adsetId, "222", "adset_id");
  eq(r0.campaignId, "333", "campaign_id");
  eq(r0.spendCents, 1234, "spend → cents");
  eq(r0.impressions, 1000, "impressions int");
  eq(r0.clicks, 50, "clicks int");
  eq(r0.publisherPlatform, "facebook", "publisher_platform");
  eq(r0.platformPosition, "feed", "platform_position");
  eq(r0.adName, "Ad A", "ad_name");
  eq(rows[1].publisherPlatform, "instagram", "second row IG");
  eq(rows[1].spendCents, 500, "second row spend");
  const r2 = rows[2];
  eq(r2.adId, "555", "third row ad_id");
  eq(r2.spendCents, 0, "missing spend → 0 cents");
  eq(r2.publisherPlatform, "", "missing breakdown → '' (matches unique key default)");
  eq(r2.platformPosition, "", "missing position → ''");
  eq(r2.adsetId, null, "missing adset_id → null");
  eq(r2.adName, null, "missing name → null");
}
eq(parseInsightsPage({}).length, 0, "no data → []");
eq(parseInsightsPage({ data: null }).length, 0, "null data → []");
eq(parseInsightsPage(null).length, 0, "null json → []");

// ── insightsNextPage ─────────────────────────────────────────────────────────
eq(insightsNextPage({ paging: { next: "https://x/next" } }), "https://x/next", "next cursor returned");
eq(insightsNextPage({ paging: {} }), null, "no next → null");
eq(insightsNextPage({ paging: { next: "" } }), null, "empty next → null");
eq(insightsNextPage({}), null, "no paging → null");
eq(insightsNextPage(null), null, "null → null");

// ── parseAdEntity (node /{ad-id}?fields=name,adset{name,campaign{name}}) ─────
{
  const full = { id: "111", name: "Ad A", adset: { id: "222", name: "Set A", campaign: { id: "333", name: "Camp A" } } };
  const e = parseAdEntity(full);
  ok(!!e, "full node parses");
  eq(e!.adId, "111", "adId from id");
  eq(e!.adName, "Ad A", "adName");
  eq(e!.adsetId, "222", "adsetId nested");
  eq(e!.adsetName, "Set A", "adsetName");
  eq(e!.campaignId, "333", "campaignId nested");
  eq(e!.campaignName, "Camp A", "campaignName");

  const noAdset = parseAdEntity({ id: "9", name: "Solo" });
  eq(noAdset!.adsetId, null, "missing adset → adsetId null");
  eq(noAdset!.campaignId, null, "missing campaign → campaignId null");
  eq(noAdset!.adName, "Solo", "name still captured");

  const fallback = parseAdEntity({ name: "NoId" }, "777");
  eq(fallback!.adId, "777", "falls back to requested id when response omits id");

  eq(parseAdEntity({ name: "x" }), null, "no id + no fallback → null");
  eq(parseAdEntity(null, undefined), null, "null json + no fallback → null");
}

// ── adEntitiesFromSpend (names ride the Insights rows, dedupe per ad) ─────────
{
  const rows = parseInsightsPage({
    data: [
      { ad_id: "A", adset_id: "s1", campaign_id: "c1", ad_name: "Ad A", adset_name: "Set 1", campaign_name: "C1", spend: "1", impressions: "1", clicks: "0", publisher_platform: "facebook", platform_position: "feed", date_start: "2026-07-01" },
      { ad_id: "A", adset_id: "s1", campaign_id: "c1", ad_name: "Ad A", adset_name: "Set 1", campaign_name: "C1", spend: "1", impressions: "1", clicks: "0", publisher_platform: "instagram", platform_position: "story", date_start: "2026-07-01" },
      { ad_id: "B", adset_id: "s2", campaign_id: "c2", ad_name: "Ad B", adset_name: "Set 2", campaign_name: "C2", spend: "1", impressions: "1", clicks: "0", publisher_platform: "facebook", platform_position: "feed", date_start: "2026-07-01" },
    ],
  });
  const ents = adEntitiesFromSpend(rows);
  eq(ents.length, 2, "one entity per ad id (A collapsed across placements)");
  const a = ents.find((e) => e.adId === "A")!;
  eq(a.adName, "Ad A", "A name");
  eq(a.campaignName, "C1", "A campaign name");
  eq(a.adsetId, "s1", "A adset id");
  eq(adEntitiesFromSpend([]).length, 0, "empty → []");
}

console.log(`\n✅ meta ad-spend parsers: ${n} assertions passed`);
