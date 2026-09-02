import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowDownRight, ArrowUpRight, Minus, Info } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import {
  PERIOD_LABELS,
  percentChange,
  type DashboardPeriod,
  type DateRange,
  type RevenueResponse,
} from "@shared/dashboard";

/**
 * The revenue widget.
 *
 * 🔴 Its whole job is to be honest. The tile it replaces rendered
 * `stats?.totalRevenueCents ?? 0`, so a failed request, a workspace with no
 * money recorded in ClubOS, and a genuinely quiet week all painted the same
 * confident "$0.00" — and the CUFC dashboard sat on $0.00 while the club had
 * $53,200 of confirmed registrations. Four states, four different answers:
 *
 *   loading        → skeleton, no number
 *   error          → says so, and offers a retry
 *   no source      → "not wired up in ClubOS", never $0.00
 *   real data      → the number, what it counts, and where the date comes from
 */

function shortDate(iso: string) {
  // Bare calendar string → label. Split the parts rather than parsing a Date:
  // `new Date("2026-09-02")` is UTC midnight and renders as 1 September in NZ.
  const [y, m, d] = iso.split("-").map(Number);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${MONTHS[m - 1]}`;
}

/**
 * Measure the container ourselves instead of using recharts'
 * `<ResponsiveContainer>`.
 *
 * 🔴 ResponsiveContainer measures ZERO on first paint and corrects itself on
 * the next ResizeObserver tick. The chart drawn in that first pass collapses
 * every point onto one x — a single vertical blue line where the graph should
 * be — and that is what a fresh page load renders before it settles. Caught by
 * screenshotting: it looked perfect in a browser that had already been sitting
 * on the page, and broken in every capture taken at load.
 *
 * Rendering nothing until the width is known makes the first painted frame the
 * correct one, which is the only frame some people will look at.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setWidth(el.clientWidth);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

function rangeLabel(range: DateRange) {
  if (range.from === range.to) return shortDate(range.from);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return sameYear
    ? `${shortDate(range.from)} – ${shortDate(range.to)} ${range.to.slice(0, 4)}`
    : `${shortDate(range.from)} ${range.from.slice(0, 4)} – ${shortDate(range.to)} ${range.to.slice(0, 4)}`;
}

export function RevenueWidget({
  period,
  custom,
}: {
  period: DashboardPeriod;
  custom: DateRange;
}) {
  const params = new URLSearchParams({ period });
  if (period === "custom") {
    params.set("from", custom.from);
    params.set("to", custom.to);
  }
  const url = `/api/admin/dashboard/revenue?${params.toString()}`;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<RevenueResponse>({
    queryKey: [url],
    // A wrong number is worse than a slightly stale one, but a slightly stale
    // one is worse than a spinner on every tab change.
    staleTime: 30_000,
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground">Revenue</h2>
            <p className="text-xs text-muted-foreground/80 mt-0.5">
              {data ? rangeLabel(data.range) : PERIOD_LABELS[period]}
            </p>
          </div>
          {isFetching && !isLoading && (
            <span className="text-[11px] text-muted-foreground">Updating…</span>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {isLoading && (
          <div className="space-y-4" data-testid="revenue-loading">
            <Skeleton className="h-10 w-44" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-[220px] w-full" />
          </div>
        )}

        {isError && (
          <div
            className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
            data-testid="revenue-error"
          >
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Couldn't load revenue</p>
              <p className="text-xs text-muted-foreground mt-1 break-words">
                {(error as Error)?.message ?? "Something went wrong."}
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="text-xs font-medium text-primary hover:underline mt-2"
                data-testid="button-retry-revenue"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* 🔴 No source is NOT zero. Six of the nine workspaces record their
            money somewhere ClubOS doesn't read yet — the Cup's 132 team entries
            all carry paid_amount_cents = 0. Printing "$0.00" here would state
            in the club's own dashboard that the tournament earned nothing. */}
        {!isLoading && !isError && data && !data.source && (
          <div
            className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4"
            data-testid="revenue-unwired"
          >
            <Info className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Revenue isn't wired up for this workspace yet
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                This workspace takes money outside ClubOS, so there's nothing here to total.
                It's shown as unavailable rather than $0.00, which would read as "you earned
                nothing".
              </p>
            </div>
          </div>
        )}

        {!isLoading && !isError && data?.source && (
          <RevenueBody data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function RevenueBody({ data }: { data: RevenueResponse }) {
  const chart = useMeasuredWidth<HTMLDivElement>();
  const change = percentChange(data.totalCents, data.previousCents);
  const flat = change !== null && Math.abs(change) < 0.5;
  const up = change !== null && change > 0;

  const hasAny = data.series.some((p) => p.cents > 0);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className="text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums"
            data-testid="text-revenue-total"
          >
            {formatCurrency(data.totalCents, { fromCents: true })}
          </span>

          {/* A change from nothing is not a percentage — showing +100% or ∞%
              against a zero baseline is a fiction, so it says so instead. */}
          {change === null ? (
            data.previousCents === 0 && data.totalCents > 0 ? (
              <span className="text-xs text-muted-foreground">no revenue in the previous period</span>
            ) : null
          ) : (
            <span
              className={`inline-flex items-center gap-1 text-sm font-medium ${
                flat ? "text-muted-foreground" : up ? "text-emerald-600" : "text-rose-600"
              }`}
              data-testid="text-revenue-change"
            >
              {flat ? (
                <Minus className="w-3.5 h-3.5" />
              ) : up ? (
                <ArrowUpRight className="w-4 h-4" />
              ) : (
                <ArrowDownRight className="w-4 h-4" />
              )}
              {Math.abs(change).toFixed(change >= 10 || change <= -10 ? 0 : 1)}%
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground mt-1.5">
          {data.source!.label} · {data.count.toLocaleString("en-NZ")}{" "}
          {data.count === 1 ? "record" : "records"}
          {change !== null && (
            <>
              {" · vs "}
              {formatCurrency(data.previousCents, { fromCents: true })} previous period
            </>
          )}
        </p>

        {/* The caveat is not fine print to be tucked away — a confirmed venue
            booking is money owed, not money banked, and the number means
            something different in each workspace. */}
        {data.source!.caveat && (
          <p className="text-[11px] text-muted-foreground/80 mt-1 leading-relaxed">
            {data.source!.caveat}
          </p>
        )}
      </div>

      {hasAny ? (
        <div ref={chart.ref} className="h-[220px] -ml-2" data-testid="revenue-chart">
          {chart.width > 0 && (
            <AreaChart
              width={chart.width}
              height={220}
              data={data.series}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                tickFormatter={(c: number) =>
                  c >= 100000 ? `$${Math.round(c / 100000)}k` : `$${Math.round(c / 100)}`
                }
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip
                cursor={{ stroke: "hsl(var(--border))" }}
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "hsl(var(--popover-foreground))",
                }}
                labelFormatter={(d: string) => shortDate(d)}
                formatter={(v: number) => [formatCurrency(v, { fromCents: true }), "Revenue"]}
              />
              {/* `linear`, not `monotone`. These are daily buckets: a smooth
                  curve between a zero day and a spike draws revenue on days
                  that had none, and registrations genuinely arrive in bursts.
                  The chart should show the bursts, not round them off. */}
              <Area
                type="linear"
                dataKey="cents"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#revenueFill)"
                // The entry animation also draws from a zero-width layout.
                // A revenue line does not need to swoosh; it needs to be right
                // the instant it appears.
                isAnimationActive={false}
              />
            </AreaChart>
          )}
        </div>
      ) : (
        <div
          className="h-[220px] flex items-center justify-center rounded-lg border border-dashed border-border"
          data-testid="revenue-empty"
        >
          <p className="text-sm text-muted-foreground">
            No {data.source!.label.toLowerCase()} in this period.
          </p>
        </div>
      )}
    </div>
  );
}
