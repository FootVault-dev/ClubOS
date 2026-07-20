// Standalone proof of the behavioral rollup SQL-builder module (T4). No DB / network.
//   npx tsx script/test-behavior-rollups.ts
//
// Covers the pinned design decisions from AGENTS.md / PLAN.md T4:
//   - every builder returns { text, params } with params = [day]
//   - every builder's query is bounded to the given day ($1::date .. +1 day)
//   - every builder upserts (ON CONFLICT ... DO UPDATE) against the right unique key
//   - no builder ever emits a destructive verb (DROP / TRUNCATE / DELETE)
//   - hour_of_day_profile is an INCREMENT (sessions = table.sessions + EXCLUDED.sessions),
//     the other four are full overwrites (column = EXCLUDED.column)
//   - assertDay rejects malformed day strings
//   - ROLLUP_BUILDERS manifest matches the 5 rollup tables from the T3 migration
//   - the pure read-shape reducers (scrollHistToFunnel / hourProfileToGrid) compute
//     correctly on sample data, including empty/missing input

import {
  buildPageStatsDailyUpsert,
  buildSectionStatsDailyUpsert,
  buildClickStatsDailyUpsert,
  buildJourneyEdgesDailyUpsert,
  buildHourOfDayProfileUpsert,
  ROLLUP_BUILDERS,
  SCROLL_BANDS,
  scrollHistToFunnel,
  hourProfileToGrid,
  type SqlQuery,
} from "../shared/behavior-rollups";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const ok =
    typeof actual === "object" && actual !== null
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  check(ok, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const DAY = "2026-07-09";
const NO_DESTRUCTIVE_VERB = /\b(DROP|TRUNCATE|DELETE)\b/i;

const ALL: Array<{ name: string; build: (day: string) => SqlQuery; conflictKey: string; increment: boolean }> = [
  { name: "page_stats_daily", build: buildPageStatsDailyUpsert, conflictKey: "(site, page_path, day)", increment: false },
  { name: "section_stats_daily", build: buildSectionStatsDailyUpsert, conflictKey: "(page_path, section_key, day)", increment: false },
  { name: "click_stats_daily", build: buildClickStatsDailyUpsert, conflictKey: "(page_path, css_path, viewport, day)", increment: false },
  { name: "journey_edges_daily", build: buildJourneyEdgesDailyUpsert, conflictKey: "(site, from_path, to_path, day)", increment: false },
  { name: "hour_of_day_profile", build: buildHourOfDayProfileUpsert, conflictKey: "(site, dow, hour)", increment: true },
];

for (const { name, build, conflictKey, increment } of ALL) {
  const q = build(DAY);

  check(q.text.toUpperCase().includes(`INSERT INTO ${name.toUpperCase()}`), `${name}: inserts into the right table`);
  eq(q.params.length, 1, `${name}: exactly one bound param`);
  eq(q.params[0], DAY, `${name}: param is the day passed in`);
  check(q.text.includes("$1"), `${name}: uses a $1 placeholder (parameterised, not interpolated)`);
  check(q.text.includes("$1::date") && q.text.includes("+ interval '1 day'"), `${name}: WHERE clause is day-bounded`);
  check(q.text.includes("is_bot = false") || name === "journey_edges_daily", `${name}: excludes bot rows`);
  check(q.text.toUpperCase().includes(`ON CONFLICT ${conflictKey.toUpperCase()}`), `${name}: upserts on its natural unique key`);
  check(q.text.toUpperCase().includes("DO UPDATE SET"), `${name}: is an UPSERT, not an insert-only`);
  check(!NO_DESTRUCTIVE_VERB.test(q.text), `${name}: never emits DROP/TRUNCATE/DELETE`);

  if (increment) {
    check(
      q.text.includes(`${name}.sessions + EXCLUDED.sessions`),
      `${name}: increments the counter instead of overwriting (rolling weekly profile)`,
    );
  } else {
    check(!q.text.includes(".sessions +"), `${name}: is a full overwrite, not an increment`);
  }
}

// journey_edges_daily specifically reads BOTH analytics_events and behavior_events
{
  const q = buildJourneyEdgesDailyUpsert(DAY);
  check(q.text.includes("FROM analytics_events"), "journey_edges_daily: reads analytics_events page_view rows");
  check(q.text.includes("FROM behavior_events"), "journey_edges_daily: reads behavior_events route_change rows");
  check(q.text.includes("event_type = 'route_change'"), "journey_edges_daily: filters behavior_events to route_change");
  check(q.text.includes("event_type = 'page_view'"), "journey_edges_daily: filters analytics_events to page_view");
}

// page_stats_daily scroll histogram covers every band 0..100
{
  const q = buildPageStatsDailyUpsert(DAY);
  for (const band of SCROLL_BANDS) {
    check(q.text.includes(`'${band}',`), `page_stats_daily: scroll histogram includes band ${band}`);
  }
}

// assertDay rejects malformed input
for (const bad of ["", "2026-7-9", "not-a-date", "2026/07/09", "2026-07-09T00:00:00Z"]) {
  let threw = false;
  try {
    buildPageStatsDailyUpsert(bad);
  } catch {
    threw = true;
  }
  check(threw, `assertDay rejects malformed day "${bad}"`);
}
check(!!buildPageStatsDailyUpsert(DAY), `assertDay accepts a well-formed day "${DAY}"`);

// ROLLUP_BUILDERS manifest matches the 5 rollup tables from the T3 migration
eq(ROLLUP_BUILDERS.length, 5, "ROLLUP_BUILDERS lists exactly 5 rollups");
eq(
  ROLLUP_BUILDERS.map((r) => r.name).sort().join(","),
  ["page_stats_daily", "section_stats_daily", "click_stats_daily", "journey_edges_daily", "hour_of_day_profile"].sort().join(","),
  "ROLLUP_BUILDERS names match the 5 rollup tables exactly",
);
for (const { name, build } of ROLLUP_BUILDERS) {
  const q = build(DAY);
  check(q.text.length > 0 && q.params.length === 1, `ROLLUP_BUILDERS['${name}'].build is wired to a real builder`);
}

// ── scrollHistToFunnel ────────────────────────────────────────────────────────
{
  const funnel = scrollHistToFunnel({ "0": 100, "10": 90, "50": 40, "100": 5 });
  eq(funnel.length, SCROLL_BANDS.length, "scrollHistToFunnel: one entry per scroll band");
  eq(funnel[0], { band: 0, sessions: 100, pct: 100 }, "scrollHistToFunnel: band 0 is 100% of baseline");
  eq(funnel[5], { band: 50, sessions: 40, pct: 40 }, "scrollHistToFunnel: band 50 pct relative to baseline");
  eq(funnel[10], { band: 100, sessions: 5, pct: 5 }, "scrollHistToFunnel: band 100 pct relative to baseline");
  const missingBand = funnel.find((f) => f.band === 20)!;
  eq(missingBand, { band: 20, sessions: 0, pct: 0 }, "scrollHistToFunnel: a missing band key defaults to 0");
}
{
  const empty = scrollHistToFunnel(null);
  eq(empty.every((f) => f.sessions === 0 && f.pct === 0), true, "scrollHistToFunnel: null hist → all zeros, no throw");
  const emptyObj = scrollHistToFunnel({});
  eq(emptyObj.every((f) => f.sessions === 0 && f.pct === 0), true, "scrollHistToFunnel: {} hist → all zeros, no throw");
}

// ── hourProfileToGrid ─────────────────────────────────────────────────────────
{
  const grid = hourProfileToGrid([
    { dow: 1, hour: 9, sessions: 12 },
    { dow: 1, hour: 18, sessions: 30 },
    { dow: 6, hour: 23, sessions: 4 },
  ]);
  eq(grid.length, 7, "hourProfileToGrid: 7 rows (one per day of week)");
  eq(grid[0].length, 24, "hourProfileToGrid: 24 columns (one per hour)");
  eq(grid[1][9], 12, "hourProfileToGrid: places a value at [dow][hour]");
  eq(grid[1][18], 30, "hourProfileToGrid: multiple entries same dow, different hour");
  eq(grid[6][23], 4, "hourProfileToGrid: boundary dow=6/hour=23 placed correctly");
  eq(grid[0][0], 0, "hourProfileToGrid: unfilled buckets default to 0");
}
{
  const grid = hourProfileToGrid([{ dow: -1, hour: 9, sessions: 5 }, { dow: 3, hour: 99, sessions: 5 }]);
  eq(
    grid.every((row) => row.every((v) => v === 0)),
    true,
    "hourProfileToGrid: out-of-range dow/hour are ignored, not thrown",
  );
}
eq(hourProfileToGrid([]).flat().every((v) => v === 0), true, "hourProfileToGrid: empty rows → all-zero grid");

console.log(`behavior-rollups (T4): ${pass} checks passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
