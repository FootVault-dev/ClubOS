/**
 * Dashboard revenue — one endpoint, one honest number.
 *
 * Replaces the four stat tiles that used to sit on the CUFC dashboard, of
 * which the only one anybody looked at was Revenue and it read $0.00.
 *
 * Two rules this endpoint exists to keep:
 *
 * 🔴 NEVER answer 200 with zeros when something went wrong. The old
 * /api/admin/stats path let the client render `stats?.totalRevenueCents ?? 0`,
 * so a failed request, a missing workspace header and a genuinely empty
 * workspace all painted the same confident "$0.00". A dashboard that cannot
 * tell you it is broken is worse than one that is obviously broken.
 *
 * 🔴 NEVER report $0.00 for a workspace whose money simply is not in ClubOS.
 * Six of the nine workspaces have no `programs` row, and the Cup's 132 team
 * entries all carry `paid_amount_cents = 0`. Those workspaces get an explicit
 * "not wired up" answer, not a zero that reads as "you earned nothing".
 */
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import {
  DASHBOARD_PERIODS,
  eachDay,
  previousRange,
  resolvePeriod,
  revenueSourceFor,
  type DashboardPeriod,
  type DateRange,
  type RevenueResponse,
  type RevenueSource,
} from "@shared/dashboard";

// Identifiers come from the REVENUE_SOURCES registry in shared/dashboard.ts —
// never from the request — but they are interpolated into SQL, so they are
// asserted here too. A registry entry with a typo should fail loudly at the
// boundary rather than become a query.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

/**
 * How to turn this source's date column into a NEW ZEALAND calendar date.
 *
 * 🔴 Three column types, three different expressions, and getting it wrong
 * moves money between days:
 *
 *  - `date` — already a calendar date. Casting it through a timezone is what
 *    produces off-by-one days, so it is left alone.
 *  - `timestamp with time zone` — an instant; shift to NZ, then take the date.
 *  - `timestamp without time zone` — verified against production to hold UTC
 *    (a row written at 22:17 naive belongs to the NEXT day in NZ). It must be
 *    told it is UTC *first*; a bare `AT TIME ZONE 'Pacific/Auckland'` on a
 *    naive column means "interpret this as NZ wall time", which is the exact
 *    opposite and shifts every row 12 hours the wrong way.
 *
 * The type is read from information_schema rather than declared in the source
 * registry, so a column that changes type cannot leave a stale assumption
 * behind. Cached per process — these never change while the app is running.
 */
const dateKindCache = new Map<string, "date" | "timestamptz" | "timestamp">();

async function dateKind(table: string, column: string) {
  const key = `${table}.${column}`;
  const hit = dateKindCache.get(key);
  if (hit) return hit;
  const rows = await db.execute(
    sql.raw(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = '${ident(table)}' AND column_name = '${ident(column)}'
      LIMIT 1
    `),
  );
  const dt = String(((rows as any).rows?.[0]?.data_type ?? "")).toLowerCase();
  const kind =
    dt === "date" ? "date" : dt.includes("with time zone") ? "timestamptz" : "timestamp";
  dateKindCache.set(key, kind);
  return kind;
}

function dateExprFor(column: string, kind: "date" | "timestamptz" | "timestamp"): string {
  const col = `t.${ident(column)}`;
  if (kind === "date") return `${col}`;
  if (kind === "timestamptz") return `(${col} AT TIME ZONE 'Pacific/Auckland')::date`;
  return `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Pacific/Auckland')::date`;
}

function whereFor(source: RevenueSource, orgId: number, range: DateRange, dateExpr: string) {
  const scope = source.orgScope;
  const parts: string[] =
    scope.kind === "column"
      ? [`t.${ident(scope.column)} = ${orgId}`]
      : // `registrations` reaches its workspace through the programme it is
        // for; it has no organization_id of its own.
        [
          `t.${ident(scope.column)} IN (SELECT id FROM programs WHERE organization_id = ${orgId})`,
        ];
  parts.push(`${dateExpr} BETWEEN '${range.from}'::date AND '${range.to}'::date`);
  if (source.statuses.length > 0) {
    const col = ident(source.statusColumn ?? "status");
    const list = source.statuses.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
    parts.push(`t.${col} IN (${list})`);
  }
  // A NULL date cannot be placed on a chart. Excluding it here means the total
  // and the series always agree — a total that exceeds the sum of its own bars
  // is the kind of thing people stop trusting a dashboard over.
  parts.push(`t.${ident(source.dateColumn)} IS NOT NULL`);
  return parts.join(" AND ");
}

async function sumFor(
  source: RevenueSource,
  orgId: number,
  range: DateRange,
  dateExpr: string,
) {
  const rows = await db.execute(
    sql.raw(`
      SELECT COALESCE(SUM(t.${ident(source.amountColumn)}), 0)::bigint AS cents,
             COUNT(*)::int AS n
      FROM ${ident(source.table)} t
      WHERE ${whereFor(source, orgId, range, dateExpr)}
    `),
  );
  const row: any = (rows as any).rows?.[0] ?? {};
  return { cents: Number(row.cents ?? 0), count: Number(row.n ?? 0) };
}

async function seriesFor(
  source: RevenueSource,
  orgId: number,
  range: DateRange,
  dateExpr: string,
) {
  const rows = await db.execute(
    sql.raw(`
      SELECT ${dateExpr} AS d,
             COALESCE(SUM(t.${ident(source.amountColumn)}), 0)::bigint AS cents
      FROM ${ident(source.table)} t
      WHERE ${whereFor(source, orgId, range, dateExpr)}
      GROUP BY 1
      ORDER BY 1
    `),
  );
  const byDate = new Map<string, number>();
  for (const r of ((rows as any).rows ?? []) as any[]) {
    // pg returns a `date` as a local-midnight JS Date. Formatting it with
    // toISOString() would shift it a day; read the calendar parts instead.
    const d = r.d instanceof Date ? isoFromLocalDate(r.d) : String(r.d).slice(0, 10);
    byDate.set(d, Number(r.cents ?? 0));
  }
  // Fill every day so the chart shows real gaps rather than joining across them.
  return eachDay(range).map((date) => ({ date, cents: byDate.get(date) ?? 0 }));
}

function isoFromLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The whole engine, callable without an HTTP request — so the verification
 * script exercises exactly the code the route runs, rather than a
 * reimplementation of it that can agree with itself while both are wrong.
 */
export async function revenueFor(
  orgSlug: string,
  orgId: number,
  period: DashboardPeriod,
  custom?: { from?: string; to?: string },
): Promise<RevenueResponse> {
  const range = resolvePeriod(period, custom);
  const source = revenueSourceFor(orgSlug);
  if (!source) {
    return { source: null, range, totalCents: 0, previousCents: 0, series: [], count: 0 };
  }
  const kind = await dateKind(source.table, source.dateColumn);
  const expr = dateExprFor(source.dateColumn, kind);
  const prev = previousRange(range);
  const [current, previous, series] = await Promise.all([
    sumFor(source, orgId, range, expr),
    sumFor(source, orgId, prev, expr),
    seriesFor(source, orgId, range, expr),
  ]);
  return {
    source: { label: source.label, caveat: source.dateCaveat },
    range,
    totalCents: current.cents,
    previousCents: previous.cents,
    series,
    count: current.count,
  };
}

export function registerDashboardRoutes(
  app: Express,
  requireAuth: any,
  workspaceOrg: (req: any) => Promise<{ id: number; slug: string } | null>,
) {
  app.get("/api/admin/dashboard/revenue", requireAuth, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      // 🔴 An unresolved workspace is an ERROR, not an empty result. Answering
      // 200 with zeros here is precisely how the old dashboard hid the fact
      // that it had no idea which club it was talking about.
      if (!org) {
        return res.status(400).json({
          message:
            "No workspace selected. Reload the page, or pick a workspace from the switcher.",
        });
      }

      const rawPeriod = String(req.query.period ?? "30d");
      const period: DashboardPeriod = (DASHBOARD_PERIODS as readonly string[]).includes(rawPeriod)
        ? (rawPeriod as DashboardPeriod)
        : "30d";
      const range = resolvePeriod(period, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });

      const body = await revenueFor(org.slug, org.id, period, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(body);
    } catch (error: any) {
      // Let the client show "couldn't load" rather than a plausible zero.
      res.status(500).json({ message: error?.message ?? "Failed to load revenue" });
    }
  });
}
