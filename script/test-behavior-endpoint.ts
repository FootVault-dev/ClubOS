// Standalone proof of the T5 collector's request→insert-rows mapping. No DB / network —
// `POST /api/public/analytics/behavior` calls `behaviorEventsToInsert(req.body.events, ctx)`
// verbatim and passes the result straight to `db.insert(behaviorEvents).values(...)`, so
// this function IS the endpoint's logic (see AGENTS.md T5 note + server/routes.ts).
//   npx tsx script/test-behavior-endpoint.ts
//
// Covers:
//   - a well-formed batch shapes 1:1 into rows with the exact BehaviorEvent column keys
//   - bot-flagged rows are DROPPED entirely (not stored-and-flagged, unlike analytics_events)
//   - malformed rows within a batch are dropped, valid ones survive
//   - non-array / missing `events` → empty array (fail-silent: still a 200 { ok: true, count: 0 })
//   - batch is capped at 50
//   - textHash is present, never raw text

import { behaviorEventsToInsert } from "../shared/behavior";

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
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function evt(overrides: Record<string, unknown> = {}) {
  return { visitorId: "v1", sessionId: "s1", eventType: "click", pagePath: "/home", ...overrides };
}

// ── missing / non-array body.events → [] (never throws) ────────────────────
eq(behaviorEventsToInsert(undefined).length, 0, "undefined events → []");
eq(behaviorEventsToInsert(null).length, 0, "null events → []");
eq(behaviorEventsToInsert({}).length, 0, "object (not array) events → []");
eq(behaviorEventsToInsert("oops").length, 0, "string events → []");

// ── a well-formed batch shapes 1:1, columns match the drizzle behaviorEvents mirror ──
{
  const rows = behaviorEventsToInsert(
    [evt({ eventType: "scroll", scrollBand: 47 }), evt({ eventType: "section_view", sectionKey: "hero", visibleMs: 1200 })],
    { userAgent: CHROME_UA },
  );
  eq(rows.length, 2, "2 valid events → 2 rows");
  const expectedKeys = [
    "visitorId", "sessionId", "site", "eventType", "pagePath", "cssPath",
    "offsetX", "offsetY", "viewport", "scrollBand", "sectionKey", "visibleMs",
    "dwellMs", "formId", "metric", "metricValue", "textHash", "isBot",
  ].sort();
  check(
    JSON.stringify(Object.keys(rows[0]).sort()) === JSON.stringify(expectedKeys),
    `row keys match ShapedBehaviorEvent shape — got ${JSON.stringify(Object.keys(rows[0]).sort())}`,
  );
  eq(rows[0].scrollBand, 50, "scroll 47 buckets to nearest-10 band (50)");
  eq(rows[1].sectionKey, "hero", "section_view keeps sectionKey");
  eq(rows[1].visibleMs, 1200, "section_view keeps visibleMs");
  eq(rows.every((r) => r.isBot === false), true, "non-bot UA → isBot false on every row");
}

// ── bot rows are DROPPED entirely, not stored-and-flagged ───────────────────
{
  const rows = behaviorEventsToInsert([evt(), evt({ eventType: "scroll", scrollBand: 20 })], { userAgent: BOT_UA });
  eq(rows.length, 0, "bot UA → every row dropped (no is_bot=true rows land in behavior_events)");
}
{
  // A mix in one batch: the bot signal is per-request (shared UA), so mixing isn't
  // possible via UA alone — but webdriver:true on one row bot-flags only that row.
  const rows = behaviorEventsToInsert(
    [evt({ visitorId: "v1" }), evt({ visitorId: "v2", webdriver: true })],
    { userAgent: CHROME_UA },
  );
  eq(rows.length, 1, "per-row webdriver:true flags only that row as bot, and it's dropped");
  eq(rows[0].visitorId, "v1", "the surviving row is the non-bot one");
}

// ── malformed rows are dropped, valid ones in the same batch survive ────────
{
  const rows = behaviorEventsToInsert(
    [evt({ visitorId: undefined }), evt({ eventType: "not_a_real_type" }), evt({ visitorId: "v3" })],
    { userAgent: CHROME_UA },
  );
  eq(rows.length, 1, "2 malformed + 1 valid → 1 row survives");
  eq(rows[0].visitorId, "v3", "surviving row is the valid one");
}

// ── raw text is never stored, only textHash ──────────────────────────────────
{
  const rows = behaviorEventsToInsert([evt({ eventType: "click", cssPath: "button.cta", text: "Book Now" })], {
    userAgent: CHROME_UA,
  });
  eq(rows.length, 1, "click with text → 1 row");
  check(!("text" in rows[0]), "no raw `text` field on the shaped row");
  check(typeof rows[0].textHash === "string" && rows[0].textHash!.length === 8, "textHash present, 8-hex-char hash");
}

// ── batch cap respected (endpoint always passes 50, but verify the param wires through) ──
{
  const many = Array.from({ length: 12 }, (_, i) => evt({ visitorId: `v${i}` }));
  const rows = behaviorEventsToInsert(many, { userAgent: CHROME_UA }, 5);
  eq(rows.length, 5, "limit param caps the insert batch at 5");
}

// ── empty array → empty rows (endpoint still responds 200 { ok:true, count:0 }) ──
eq(behaviorEventsToInsert([]).length, 0, "empty array → []");

console.log(`\n${pass} assertions passed, ${fail} failed.`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of fails) console.error(" - " + f);
  process.exit(1);
}
