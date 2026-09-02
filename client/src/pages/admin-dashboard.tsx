// ─────────────────────────────────────────────────────────────────────────────
// Dashboard.
//
// Rebuilt 2026-09-02 on Daniel's instruction: revenue, a period filter and a
// trend — and nothing else yet. What it replaced was four stat tiles, a
// programmes list and a quick-actions panel, all of which duplicated a sidebar
// item one click away, and the only number anybody cared about read $0.00
// while Christchurch United had $53,200 of confirmed registrations on file.
//
// 🔴 It is deliberately ONE widget. The instruction was "we're not going to
// bloat things again like we did last time around". The grid below takes more
// widgets the day there is a second number worth looking at every morning —
// adding one is a component and a line, no restructuring — but shipping five
// half-answers is how the last dashboard got ignored.
//
// The period lives in the URL (?period=30d, or ?period=custom&from=&to=), so a
// dashboard someone is looking at can be sent to someone else.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { PeriodPicker } from "@/components/dashboard/period-picker";
import { RevenueWidget } from "@/components/dashboard/revenue-widget";
import {
  DASHBOARD_PERIODS,
  resolvePeriod,
  type DashboardPeriod,
  type DateRange,
} from "@shared/dashboard";

export default function AdminDashboard() {
  const { currentOrg } = useWorkspace();
  const search = useSearch();
  const [, navigate] = useLocation();

  const { period, custom } = useMemo(() => {
    const p = new URLSearchParams(search);
    const raw = p.get("period") ?? "30d";
    const period: DashboardPeriod = (DASHBOARD_PERIODS as readonly string[]).includes(raw)
      ? (raw as DashboardPeriod)
      : "30d";
    // Fall back to the resolved 30-day window so the custom inputs open on a
    // sensible range rather than empty boxes.
    const fallback = resolvePeriod("30d");
    const custom: DateRange = {
      from: p.get("from") || fallback.from,
      to: p.get("to") || fallback.to,
    };
    return { period, custom };
  }, [search]);

  const onChange = useCallback(
    (next: DashboardPeriod, nextCustom?: DateRange) => {
      const p = new URLSearchParams();
      p.set("period", next);
      if (next === "custom") {
        const r = nextCustom ?? custom;
        p.set("from", r.from);
        p.set("to", r.to);
      }
      navigate(`/admin?${p.toString()}`, { replace: true });
    },
    [navigate, custom],
  );

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold tracking-tight text-foreground"
            data-testid="text-page-title"
          >
            Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {currentOrg?.name ?? "Loading…"}
          </p>
        </div>
        <PeriodPicker period={period} custom={custom} onChange={onChange} />
      </div>

      {/* The widget grid. One column today; a second widget drops in beside
          this one without touching anything else. */}
      <div className="grid grid-cols-1 gap-6">
        <RevenueWidget period={period} custom={custom} />
      </div>
    </div>
  );
}
