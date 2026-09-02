/**
 * Verify the dashboard revenue engine against the real database.
 *
 * Runs `revenueFor()` — the exact function the route calls — for every
 * workspace, and checks each answer against an independently written control
 * query. A reimplementation that agrees with itself proves nothing; these
 * controls are deliberately written a different way (plain SQL, no shared
 * helpers) so a bug in the engine has to survive both to go unnoticed.
 *
 *   npx tsx --env-file=.env script/_verify-dashboard-revenue.ts
 *
 * Read-only. Touches no HTTP, starts no worker.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { revenueFor } from "../server/dashboard-routes";
import {
  REVENUE_SOURCES,
  eachDay,
  nzTodayIso,
  previousRange,
  resolvePeriod,
  addDaysIso,
  daysInclusive,
  percentChange,
  type DashboardPeriod,
} from "../shared/dashboard";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function one(q: string): Promise<any> {
  const r: any = await db.execute(sql.raw(q));
  return r.rows?.[0] ?? {};
}

async function main() {
  console.log("\n── Pure date logic (no database) ─────────────────────────");
  {
    const today = "2026-09-02";
    check("today resolves to a single day", JSON.stringify(resolvePeriod("today", undefined, today)) === JSON.stringify({ from: "2026-09-02", to: "2026-09-02" }));
    check("7d is 7 days inclusive, ending today", (() => {
      const r = resolvePeriod("7d", undefined, today);
      return r.from === "2026-08-27" && r.to === today && daysInclusive(r.from, r.to) === 7;
    })());
    check("30d is 30 days inclusive", (() => {
      const r = resolvePeriod("30d", undefined, today);
      return daysInclusive(r.from, r.to) === 30 && r.from === "2026-08-04";
    })());
    check("ytd starts 1 January", resolvePeriod("ytd", undefined, today).from === "2026-01-01");
    check("previous range is the same length, ending the day before", (() => {
      const r = resolvePeriod("30d", undefined, today);
      const p = previousRange(r);
      return daysInclusive(p.from, p.to) === 30 && p.to === addDaysIso(r.from, -1);
    })());
    check("a backwards custom range is swapped, not rejected", (() => {
      const r = resolvePeriod("custom", { from: "2026-05-10", to: "2026-05-01" }, today);
      return r.from === "2026-05-01" && r.to === "2026-05-10";
    })());
    // 🔴 Month-end and leap day: the arithmetic is UTC-anchored precisely so
    // these do not drift. A naive local-Date implementation gets these wrong
    // on the days either side of a DST change.
    check("crossing a month boundary backwards", addDaysIso("2026-03-01", -1) === "2026-02-28");
    check("leap day exists in 2028", addDaysIso("2028-02-28", 1) === "2028-02-29");
    check("NZ DST start (late Sep) does not eat a day", daysInclusive("2026-09-20", "2026-09-30") === 11);
    check("NZ DST end (early Apr) does not add a day", daysInclusive("2026-04-01", "2026-04-10") === 10);
    check("eachDay covers the range with no gaps", eachDay({ from: "2026-01-30", to: "2026-02-02" }).join(",") === "2026-01-30,2026-01-31,2026-02-01,2026-02-02");
    check("percentChange from zero is null, never Infinity", percentChange(500, 0) === null);
    check("percentChange is signed correctly", percentChange(150, 100) === 50 && percentChange(50, 100) === -50);
    check("nzTodayIso is a bare YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(nzTodayIso()));
  }

  console.log("\n── Workspaces ────────────────────────────────────────────");
  const orgs: any[] = ((await db.execute(sql.raw("SELECT id, slug FROM organizations ORDER BY id"))) as any).rows;

  for (const org of orgs) {
    const src = REVENUE_SOURCES[org.slug];
    console.log(`\n  ${org.slug} (org ${org.id})${src ? ` → ${src.table}.${src.amountColumn}` : " → no source"}`);

    const ytd = await revenueFor(org.slug, org.id, "ytd");

    if (!src) {
      // 🔴 The whole point of the unwired case: it must be distinguishable
      // from zero revenue, or the Cup's dashboard states the tournament
      // earned nothing.
      check("unwired workspace reports source: null", ytd.source === null);
      check("unwired workspace reports no series", ytd.series.length === 0);
      continue;
    }

    check("source is labelled", !!ytd.source?.label);

    // Control: a plain query written independently of the engine.
    const st = src.statuses.length
      ? `AND ${src.statusColumn ?? "status"} IN (${src.statuses.map((s) => `'${s}'`).join(",")})`
      : "";
    const dt = await one(
      `SELECT data_type FROM information_schema.columns WHERE table_name='${src.table}' AND column_name='${src.dateColumn}'`,
    );
    const kind = String(dt.data_type ?? "").toLowerCase();
    const expr =
      kind === "date"
        ? src.dateColumn
        : kind.includes("with time zone")
          ? `(${src.dateColumn} AT TIME ZONE 'Pacific/Auckland')::date`
          : `(${src.dateColumn} AT TIME ZONE 'UTC' AT TIME ZONE 'Pacific/Auckland')::date`;

    // The control writes the org scope independently too — the engine's
    // assumption that every table has an organization_id is exactly the bug
    // this script caught on its first run.
    const scopeSql =
      src.orgScope.kind === "column"
        ? `${src.orgScope.column} = ${org.id}`
        : `${src.orgScope.column} IN (SELECT id FROM programs WHERE organization_id = ${org.id})`;

    const control = await one(`
      SELECT COALESCE(SUM(${src.amountColumn}),0)::bigint cents, COUNT(*)::int n
      FROM ${src.table}
      WHERE ${scopeSql}
        ${st}
        AND ${src.dateColumn} IS NOT NULL
        AND ${expr} BETWEEN '${ytd.range.from}'::date AND '${ytd.range.to}'::date
    `);
    check(
      `YTD total matches an independent query ($${(ytd.totalCents / 100).toFixed(2)})`,
      ytd.totalCents === Number(control.cents),
      `engine ${ytd.totalCents} vs control ${control.cents}`,
    );
    check(`YTD count matches (${ytd.count})`, ytd.count === Number(control.n));

    // 🔴 The series must sum to the headline. A total that exceeds the sum of
    // its own bars is the thing that makes people stop believing a chart.
    const seriesSum = ytd.series.reduce((a, p) => a + p.cents, 0);
    check("daily series sums to the headline total", seriesSum === ytd.totalCents, `series ${seriesSum} vs total ${ytd.totalCents}`);
    check("series has one point per calendar day", ytd.series.length === daysInclusive(ytd.range.from, ytd.range.to));
    check("series is in date order with no duplicates", (() => {
      const ds = ytd.series.map((p) => p.date);
      return ds.every((d, i) => i === 0 || d > ds[i - 1]);
    })());
    check("no negative day totals", ytd.series.every((p) => p.cents >= 0));

    // Periods must nest: a day cannot exceed the 30 days containing it.
    const today = await revenueFor(org.slug, org.id, "today");
    const d30 = await revenueFor(org.slug, org.id, "30d");
    check("today ≤ last 30 days ≤ year to date", today.totalCents <= d30.totalCents && d30.totalCents <= ytd.totalCents,
      `${today.totalCents} / ${d30.totalCents} / ${ytd.totalCents}`);

    // The previous-period figure must be the real preceding window, not a copy.
    const prev = previousRange(d30.range);
    const prevControl = await one(`
      SELECT COALESCE(SUM(${src.amountColumn}),0)::bigint cents
      FROM ${src.table}
      WHERE ${scopeSql} ${st}
        AND ${src.dateColumn} IS NOT NULL
        AND ${expr} BETWEEN '${prev.from}'::date AND '${prev.to}'::date
    `);
    check("previous-period figure matches its own window", d30.previousCents === Number(prevControl.cents),
      `engine ${d30.previousCents} vs control ${prevControl.cents}`);

    // 🔴 Scoping: this workspace's number must not include another's rows.
    const global = await one(`
      SELECT COALESCE(SUM(${src.amountColumn}),0)::bigint cents
      FROM ${src.table}
      WHERE 1=1 ${st} AND ${src.dateColumn} IS NOT NULL
        AND ${expr} BETWEEN '${ytd.range.from}'::date AND '${ytd.range.to}'::date
    `);
    check("workspace total never exceeds the all-orgs total", ytd.totalCents <= Number(global.cents));
  }

  console.log("\n── Cross-workspace ───────────────────────────────────────");
  {
    // 🔴 Two workspaces sharing a table must not report each other's money.
    const cufc = await revenueFor("christchurch-united", 1, "ytd");
    const mfl = await revenueFor("mini-football-leagues", 3, "ytd");
    check("CUFC and MFL share `registrations` but report different totals",
      cufc.totalCents !== mfl.totalCents || (cufc.totalCents === 0 && mfl.totalCents === 0),
      `cufc ${cufc.totalCents}, mfl ${mfl.totalCents}`);

    const both = await one(`
      SELECT COALESCE(SUM(r.total_cents),0)::bigint cents FROM registrations r
      JOIN programs p ON p.id = r.program_id
      WHERE p.organization_id IN (1,3) AND r.status='confirmed'
        AND (r.registered_at AT TIME ZONE 'UTC' AT TIME ZONE 'Pacific/Auckland')::date
            BETWEEN '${cufc.range.from}'::date AND '${cufc.range.to}'::date
    `);
    // registrations has no organization_id of its own — it scopes through
    // programs — so this also proves the engine is joining, not guessing.
    check("CUFC + MFL equals the two orgs' combined registrations",
      cufc.totalCents + mfl.totalCents === Number(both.cents),
      `${cufc.totalCents} + ${mfl.totalCents} vs ${both.cents}`);
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
