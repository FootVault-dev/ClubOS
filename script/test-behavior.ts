// Standalone proof of the Behavioral Depth event-shaping module (T1). No DB / network.
//   npx tsx script/test-behavior.ts
//
// Covers the pinned design decisions from AGENTS.md / PLAN.md T1:
//   - event_type whitelist (page_leave/scroll/section_view/click/rage_click/
//     route_change/form_start/form_abandon/vitals) — anything else drops the row
//   - missing/illegal visitorId or sessionId → null (silently dropped)
//   - css_path capped + control chars stripped
//   - offset_x/offset_y CLAMPED (not dropped) to [0,1]
//   - scroll bucketed to the nearest 10% band
//   - viewport coerced to mobile|tablet|desktop (explicit string or width bucketing)
//   - raw text is NEVER stored — only a stable text hash
//   - vitals metric whitelist (LCP/CLS/INP), case-insensitive
//   - bot flag reuses shared/attribution.ts detectBot
//   - batch: drops malformed, respects limit, non-array → []

import {
  shapeBehaviorEvent,
  shapeBehaviorEvents,
  BEHAVIOR_EVENT_TYPES,
  VIEWPORT_BUCKETS,
  VITALS_METRICS,
} from "../shared/behavior";

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

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function base(overrides: Record<string, unknown> = {}) {
  return { visitorId: "v1", sessionId: "s1", eventType: "click", ...overrides };
}

// ── malformed input → null ──────────────────────────────────────────────────
eq(shapeBehaviorEvent(null), null, "null raw → null");
eq(shapeBehaviorEvent(undefined), null, "undefined raw → null");
eq(shapeBehaviorEvent("string"), null, "non-object raw → null");
eq(shapeBehaviorEvent([]), null, "array raw → null");
eq(shapeBehaviorEvent(base({ visitorId: undefined })), null, "missing visitorId → null");
eq(shapeBehaviorEvent(base({ sessionId: undefined })), null, "missing sessionId → null");
eq(shapeBehaviorEvent(base({ visitorId: "undefined" })), null, "illegal visitorId 'undefined' → null");
eq(shapeBehaviorEvent(base({ visitorId: "{{visitor.id}}" })), null, "macro visitorId → null");
eq(shapeBehaviorEvent(base({ eventType: undefined })), null, "missing eventType → null");
eq(shapeBehaviorEvent(base({ eventType: "click_xyz" })), null, "unrecognised eventType → null");
eq(shapeBehaviorEvent(base({ eventType: "PAGE_VIEW" })), null, "not-behavior eventType (attribution's) → null");

// ── event_type whitelist — every taxonomy member accepted ───────────────────
for (const t of BEHAVIOR_EVENT_TYPES) {
  const shaped = shapeBehaviorEvent(base({ eventType: t }), { userAgent: CHROME_UA });
  check(shaped !== null && shaped.eventType === t, `whitelisted eventType '${t}' accepted`);
}

// ── css_path sanitising ──────────────────────────────────────────────────────
{
  const shaped = shapeBehaviorEvent(base({ cssPath: "div.foo > span#bar" }), { userAgent: CHROME_UA });
  eq(shaped!.cssPath, "div.foo > span#bar", "css_path passes through unchanged");
}
{
  const shaped = shapeBehaviorEvent(base({ cssPath: "div\x00\x1F.foo" }), { userAgent: CHROME_UA });
  eq(shaped!.cssPath, "div.foo", "css_path strips control/null chars");
}
{
  const long = "a".repeat(600);
  const shaped = shapeBehaviorEvent(base({ cssPath: long }), { userAgent: CHROME_UA });
  eq(shaped!.cssPath!.length, 512, "css_path capped at 512 chars");
}
{
  const shaped = shapeBehaviorEvent(base({ cssPath: "{{el.path}}" }), { userAgent: CHROME_UA });
  eq(shaped!.cssPath, null, "macro css_path → null");
}

// ── offset clamping to [0,1] (CLAMPED, not dropped) ─────────────────────────
{
  const shaped = shapeBehaviorEvent(base({ offsetX: -0.5, offsetY: 1.5 }), { userAgent: CHROME_UA });
  eq(shaped!.offsetX, 0, "offsetX < 0 clamps to 0");
  eq(shaped!.offsetY, 1, "offsetY > 1 clamps to 1");
}
{
  const shaped = shapeBehaviorEvent(base({ offsetX: 0.42, offsetY: 0.9 }), { userAgent: CHROME_UA });
  eq(shaped!.offsetX, 0.42, "valid offsetX passes through");
  eq(shaped!.offsetY, 0.9, "valid offsetY passes through");
}
{
  const shaped = shapeBehaviorEvent(base({ offsetX: "not-a-number" }), { userAgent: CHROME_UA });
  eq(shaped!.offsetX, null, "non-numeric offsetX → null");
}
{
  const shaped = shapeBehaviorEvent(base({}), { userAgent: CHROME_UA });
  eq(shaped!.offsetX, null, "missing offsetX → null");
}

// ── scroll band bucketing (nearest 10%) ──────────────────────────────────────
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: 0 }), { userAgent: CHROME_UA })!.scrollBand, 0, "0 → band 0");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: 34 }), { userAgent: CHROME_UA })!.scrollBand, 30, "34 → band 30");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: 35 }), { userAgent: CHROME_UA })!.scrollBand, 40, "35 → band 40 (round half up)");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: 100 }), { userAgent: CHROME_UA })!.scrollBand, 100, "100 → band 100");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: 137 }), { userAgent: CHROME_UA })!.scrollBand, 100, "137 clamps then buckets → 100");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollBand: -20 }), { userAgent: CHROME_UA })!.scrollBand, 0, "-20 clamps then buckets → 0");
eq(shapeBehaviorEvent(base({ eventType: "scroll", scrollPercent: 62 }), { userAgent: CHROME_UA })!.scrollBand, 60, "scrollPercent alias → band 60");

// ── viewport coercion ────────────────────────────────────────────────────────
eq(shapeBehaviorEvent(base({ viewport: "mobile" }), { userAgent: CHROME_UA })!.viewport, "mobile", "explicit 'mobile' accepted");
eq(shapeBehaviorEvent(base({ viewport: "Tablet" }), { userAgent: CHROME_UA })!.viewport, "tablet", "explicit viewport case-insensitive");
eq(shapeBehaviorEvent(base({ viewport: "phablet" }), { userAgent: CHROME_UA })!.viewport, null, "invalid viewport string and no width → null");
eq(shapeBehaviorEvent(base({ viewportWidth: 767 }), { userAgent: CHROME_UA })!.viewport, "mobile", "width 767 → mobile");
eq(shapeBehaviorEvent(base({ viewportWidth: 768 }), { userAgent: CHROME_UA })!.viewport, "tablet", "width 768 → tablet boundary");
eq(shapeBehaviorEvent(base({ viewportWidth: 1023 }), { userAgent: CHROME_UA })!.viewport, "tablet", "width 1023 → tablet");
eq(shapeBehaviorEvent(base({ viewportWidth: 1024 }), { userAgent: CHROME_UA })!.viewport, "desktop", "width 1024 → desktop boundary");
for (const v of VIEWPORT_BUCKETS) {
  check(
    shapeBehaviorEvent(base({ viewport: v }), { userAgent: CHROME_UA })!.viewport === v,
    `viewport bucket '${v}' round-trips`,
  );
}

// ── site normalising ─────────────────────────────────────────────────────────
eq(shapeBehaviorEvent(base({ site: "https://www.cufc.co.nz/some/path?x=1" }), { userAgent: CHROME_UA })!.site, "cufc.co.nz", "site strips protocol/www/path/query");
eq(shapeBehaviorEvent(base({ site: "MiniFootball.co.nz" }), { userAgent: CHROME_UA })!.site, "minifootball.co.nz", "site lowercased");
eq(shapeBehaviorEvent(base({}), { userAgent: CHROME_UA })!.site, null, "missing site → null");

// ── text → hash only, never raw text ────────────────────────────────────────
{
  const shaped = shapeBehaviorEvent(base({ text: "Book Now" }), { userAgent: CHROME_UA })!;
  check(typeof shaped.textHash === "string" && shaped.textHash!.length > 0, "text produces a hash");
  check(shaped.textHash !== "Book Now", "hash is not the raw text");
  check(!("text" in shaped), "shaped row has no raw 'text' field");
}
{
  const a = shapeBehaviorEvent(base({ text: "Book Now" }), { userAgent: CHROME_UA })!;
  const b = shapeBehaviorEvent(base({ text: "Book Now" }), { userAgent: CHROME_UA })!;
  eq(a.textHash, b.textHash, "same text → same stable hash");
}
{
  const a = shapeBehaviorEvent(base({ text: "Book Now" }), { userAgent: CHROME_UA })!;
  const b = shapeBehaviorEvent(base({ text: "Sign Up" }), { userAgent: CHROME_UA })!;
  check(a.textHash !== b.textHash, "different text → different hash");
}
eq(shapeBehaviorEvent(base({}), { userAgent: CHROME_UA })!.textHash, null, "no text → null hash");

// ── vitals metric whitelist ──────────────────────────────────────────────────
for (const m of VITALS_METRICS) {
  const shaped = shapeBehaviorEvent(base({ eventType: "vitals", metric: m.toLowerCase(), metricValue: 12.5 }), {
    userAgent: CHROME_UA,
  })!;
  eq(shaped.metric, m, `metric '${m.toLowerCase()}' normalised to '${m}'`);
  eq(shaped.metricValue, 12.5, `metricValue passes through for ${m}`);
}
eq(
  shapeBehaviorEvent(base({ eventType: "vitals", metric: "FID" }), { userAgent: CHROME_UA })!.metric,
  null,
  "unknown vitals metric → null",
);
eq(
  shapeBehaviorEvent(base({ eventType: "vitals", metricValue: -5 }), { userAgent: CHROME_UA })!.metricValue,
  0,
  "negative metricValue clamps to 0",
);

// ── dwell/visible ms clamping ─────────────────────────────────────────────────
eq(shapeBehaviorEvent(base({ eventType: "page_leave", dwellMs: 4500 }), { userAgent: CHROME_UA })!.dwellMs, 4500, "dwellMs passes through");
eq(
  shapeBehaviorEvent(base({ eventType: "page_leave", dwellMs: 999999999999 }), { userAgent: CHROME_UA })!.dwellMs,
  24 * 60 * 60 * 1000,
  "absurd dwellMs clamps to the 24h ceiling",
);
eq(shapeBehaviorEvent(base({ eventType: "page_leave", dwellMs: -100 }), { userAgent: CHROME_UA })!.dwellMs, 0, "negative dwellMs clamps to 0");
eq(
  shapeBehaviorEvent(base({ eventType: "section_view", sectionKey: "hero", visibleMs: 2500 }), { userAgent: CHROME_UA })!
    .visibleMs,
  2500,
  "visibleMs passes through",
);

// ── formId / sectionKey capped ────────────────────────────────────────────────
{
  const long = "f".repeat(300);
  const shaped = shapeBehaviorEvent(base({ eventType: "form_start", formId: long }), { userAgent: CHROME_UA })!;
  eq(shaped.formId!.length, 256, "formId capped at 256 chars");
}

// ── bot flagging reuses shared/attribution.ts ────────────────────────────────
{
  const shaped = shapeBehaviorEvent(base({}), { userAgent: "Googlebot/2.1" })!;
  eq(shaped.isBot, true, "bot UA flags the row");
}
{
  const shaped = shapeBehaviorEvent(base({ webdriver: true }), { userAgent: CHROME_UA })!;
  eq(shaped.isBot, true, "navigator.webdriver flags the row");
}
{
  const shaped = shapeBehaviorEvent(base({}), { userAgent: CHROME_UA })!;
  eq(shaped.isBot, false, "real browser UA is not flagged");
}

// ── shapeBehaviorEvents — drops malformed, respects limit, non-array → [] ────
{
  const batch = shapeBehaviorEvents(
    [
      base({}),
      { sessionId: "s1", eventType: "click" }, // malformed (no visitorId)
      base({ visitorId: "v2", sessionId: "s2", eventType: "scroll", scrollBand: 50 }),
    ],
    { userAgent: CHROME_UA },
  );
  eq(batch.length, 2, "batch drops the malformed row");
}
{
  const many = [1, 2, 3, 4].map((n) => base({ visitorId: "v" + n, sessionId: "s" + n }));
  eq(shapeBehaviorEvents(many, { userAgent: CHROME_UA }, 2).length, 2, "batch respects the limit");
}
eq(shapeBehaviorEvents(null).length, 0, "non-array batch → empty");
eq(shapeBehaviorEvents(undefined).length, 0, "undefined batch → empty");
eq(shapeBehaviorEvents("nope").length, 0, "string batch → empty");

console.log(`behavior (T1): ${pass} checks passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
