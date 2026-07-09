// Total Tracking Platform, Phase 1 — Behavior dashboard (T10 + T11).
//
// Read-only reporting UI over the T8 admin endpoints (/api/admin/behavior/*),
// which read ONLY the *_daily rollup tables (never behavior_events directly —
// AGENTS.md North star). Mirrors attribution.tsx's dark-premium conventions:
// header controls -> stat panels -> a page table -> a journeys panel -> a
// click-through detail drawer.
//
// Client-safe: response shapes are redeclared locally (no server-type import).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  Layers,
  MousePointerClick,
  Clock,
  TrendingDown,
  Flame,
  X,
  GitBranch,
  ArrowRight,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceTypeFor } from "@shared/tabs";

// ── Response shapes (mirrors server/behavior-reports.ts payloads) ───────────
interface OverviewRow {
  site: string;
  pagePath: string;
  views: number;
  uniques: number;
  avgDwellMs: number;
  exitRate: number;
}
interface OverviewResp {
  group: boolean;
  range: { startDay: string; endDay: string };
  rows: OverviewRow[];
}
interface ScrollFunnelBand {
  band: number;
  sessions: number;
  pct: number;
}
interface SectionRow {
  sectionKey: string;
  avgVisibleMs: number;
  viewCount: number;
}
interface ClickRow {
  cssPath: string;
  viewport: string;
  clicks: number;
  uniques: number;
  avgOffsetX: number;
  avgOffsetY: number;
}
interface PageDetailResp {
  group: boolean;
  range: { startDay: string; endDay: string };
  site: string;
  pagePath: string;
  scrollFunnel: ScrollFunnelBand[];
  sections: SectionRow[];
  topClicks: ClickRow[];
}
interface HoursResp {
  group: boolean;
  grid: number[][]; // grid[dow][hour], dow 0=Sun..6=Sat
}
interface JourneyEdge {
  fromPath: string;
  toPath: string;
  count: number;
}
interface JourneysResp {
  group: boolean;
  range: { startDay: string; endDay: string };
  edges: JourneyEdge[];
}
interface JourneySourceGroup {
  fromPath: string;
  total: number;
  edges: JourneyEdge[];
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function formatMs(ms: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function formatPct(fraction: number): string {
  return `${Math.round((fraction || 0) * 100)}%`;
}
function formatPath(path: string): string {
  return path || "/";
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const WINDOWS: { value: number; label: string }[] = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

const selectClass =
  "premium-input text-white/80 rounded-xl w-full h-9 px-3 bg-white/[0.03] appearance-none text-sm";

export default function BehaviorPage() {
  const { currentOrg } = useWorkspace();
  const isGroupWorkspace = workspaceTypeFor(currentOrg?.slug) === "group";

  const [days, setDays] = useState(30);
  const [group, setGroup] = useState(false);
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [selectedPage, setSelectedPage] = useState<{ site: string; pagePath: string } | null>(null);

  const useGroup = isGroupWorkspace && group;
  const qs = new URLSearchParams({ days: String(days), ...(useGroup ? { group: "1" } : {}) }).toString();
  const keyBase = [days, useGroup] as const;

  const overview = useQuery<OverviewResp>({
    queryKey: ["/api/admin/behavior/overview", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/behavior/overview?${qs}`)).json(),
  });

  const hours = useQuery<HoursResp>({
    queryKey: ["/api/admin/behavior/hours", useGroup],
    queryFn: async () => (await apiRequest("GET", `/api/admin/behavior/hours?${useGroup ? "group=1" : ""}`)).json(),
  });

  const journeys = useQuery<JourneysResp>({
    queryKey: ["/api/admin/behavior/journeys", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/behavior/journeys?${qs}`)).json(),
  });

  const detail = useQuery<PageDetailResp>({
    queryKey: ["/api/admin/behavior/page", selectedPage?.site, selectedPage?.pagePath, ...keyBase],
    enabled: !!selectedPage,
    queryFn: async () => {
      const p = new URLSearchParams({
        site: selectedPage!.site,
        path: selectedPage!.pagePath,
        days: String(days),
        ...(useGroup ? { group: "1" } : {}),
      });
      return (await apiRequest("GET", `/api/admin/behavior/page?${p.toString()}`)).json();
    },
  });

  const sites = useMemo(() => {
    const s = new Set<string>();
    for (const r of overview.data?.rows || []) if (r.site) s.add(r.site);
    return Array.from(s).sort();
  }, [overview.data]);

  const rows = useMemo(() => {
    const all = overview.data?.rows || [];
    return siteFilter === "all" ? all : all.filter((r) => r.site === siteFilter);
  }, [overview.data, siteFilter]);

  const maxHourSessions = useMemo(() => {
    let max = 0;
    for (const row of hours.data?.grid || []) for (const v of row) if (v > max) max = v;
    return max;
  }, [hours.data]);

  const maxSectionMs = useMemo(() => {
    let max = 0;
    for (const s of detail.data?.sections || []) if (s.avgVisibleMs > max) max = s.avgVisibleMs;
    return max;
  }, [detail.data]);

  // Group edges by source page, rank sources by total outgoing traffic, and
  // cap to the top 15 sources (each showing up to 6 of its busiest
  // destinations) — a lightweight "top transitions" flow view with no new dep.
  const journeySources = useMemo<JourneySourceGroup[]>(() => {
    const bySource = new Map<string, JourneySourceGroup>();
    for (const e of journeys.data?.edges || []) {
      let g = bySource.get(e.fromPath);
      if (!g) {
        g = { fromPath: e.fromPath, total: 0, edges: [] };
        bySource.set(e.fromPath, g);
      }
      g.total += e.count;
      g.edges.push(e);
    }
    const groups = Array.from(bySource.values());
    for (const g of groups) g.edges.sort((a, b) => b.count - a.count);
    groups.sort((a, b) => b.total - a.total);
    return groups.slice(0, 15);
  }, [journeys.data]);

  const maxJourneyCount = useMemo(() => {
    let max = 0;
    for (const g of journeySources) for (const e of g.edges) if (e.count > max) max = e.count;
    return max;
  }, [journeySources]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header + controls */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1
            className="text-xl sm:text-2xl font-semibold text-white tracking-tight flex items-center gap-2"
            data-testid="text-page-title"
          >
            <Activity className="w-5 h-5 text-blue-400" />
            Behavior
            {overview.data?.group && (
              <Badge variant="outline" className="text-[10px] bg-blue-500/15 text-blue-300 border-blue-500/25">
                Group rollup
              </Badge>
            )}
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Heatmaps, scroll depth, section timing, and traffic patterns from the site's behavioral tracker.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {sites.length > 1 && (
            <select
              value={siteFilter}
              onChange={(e) => setSiteFilter(e.target.value)}
              className={`${selectClass} sm:w-44`}
              data-testid="select-site"
              aria-label="Site"
            >
              <option value="all" className="bg-[#0a0e1a]">
                All sites
              </option>
              {sites.map((s) => (
                <option key={s} value={s} className="bg-[#0a0e1a]">
                  {s}
                </option>
              ))}
            </select>
          )}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={`${selectClass} sm:w-36`}
            data-testid="select-window"
            aria-label="Reporting window"
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value} className="bg-[#0a0e1a]">
                {w.label}
              </option>
            ))}
          </select>
          {isGroupWorkspace && (
            <label className="flex items-center gap-2 text-xs text-white/50 cursor-pointer select-none px-2 h-9">
              <input
                type="checkbox"
                checked={group}
                onChange={(e) => setGroup(e.target.checked)}
                className="accent-blue-500 w-4 h-4"
                data-testid="checkbox-group"
              />
              All brands
            </label>
          )}
        </div>
      </div>

      {/* Hour-of-day heat strip */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-400" />
            Traffic by hour of day
            <span className="text-white/30 text-xs font-normal">rolling profile, all time so far</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hours.isLoading ? (
            <Skeleton className="h-40 w-full rounded-lg bg-white/[0.03]" />
          ) : maxHourSessions === 0 ? (
            <EmptyState text="No hour-of-day data collected yet." testid="text-hours-empty" />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]" data-testid="grid-hours">
                {(hours.data?.grid || []).map((row, dow) => (
                  <div key={dow} className="flex items-center gap-1 mb-1">
                    <span className="w-8 text-[10px] text-white/30 flex-shrink-0">{DAY_LABELS[dow]}</span>
                    <div className="flex gap-[2px] flex-1">
                      {row.map((v, hour) => {
                        const intensity = maxHourSessions > 0 ? v / maxHourSessions : 0;
                        return (
                          <div
                            key={hour}
                            className="flex-1 aspect-square rounded-sm"
                            style={{ backgroundColor: `rgba(59,130,246,${0.06 + intensity * 0.85})` }}
                            title={`${DAY_LABELS[dow]} ${hour}:00 — ${v} sessions`}
                            data-testid={`cell-hour-${dow}-${hour}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-1 mt-1">
                  <span className="w-8 flex-shrink-0" />
                  <div className="flex gap-[2px] flex-1 text-[9px] text-white/25">
                    {Array.from({ length: 24 }, (_, h) => (
                      <span key={h} className="flex-1 text-center">
                        {h % 6 === 0 ? `${h}h` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Page table */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-400" />
            Pages
            <span className="text-white/30 text-xs font-normal">
              {WINDOWS.find((w) => w.value === days)?.label}
            </span>
          </CardTitle>
          <p className="text-xs text-white/30 mt-1">
            Click a page to see its scroll depth, section timing, and top-clicked elements.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {overview.isLoading ? (
            <TableSkeleton />
          ) : !rows.length ? (
            <EmptyState text="No behavioral events collected in this window yet." testid="text-pages-empty" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-pages">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    {sites.length > 1 && <th className="px-4 py-2 font-medium">Site</th>}
                    <th className="px-4 py-2 font-medium">Page</th>
                    <th className="px-4 py-2 font-medium text-right">Views</th>
                    <th className="px-4 py-2 font-medium text-right">Uniques</th>
                    <th className="px-4 py-2 font-medium text-right hidden sm:table-cell">Avg dwell</th>
                    <th className="px-4 py-2 font-medium text-right hidden md:table-cell">Exit rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {rows.map((r) => {
                    const active = selectedPage?.site === r.site && selectedPage?.pagePath === r.pagePath;
                    return (
                      <tr
                        key={`${r.site}-${r.pagePath}`}
                        onClick={() => setSelectedPage({ site: r.site, pagePath: r.pagePath })}
                        className={`cursor-pointer hover:bg-white/[0.03] ${active ? "bg-blue-500/[0.06]" : ""}`}
                        data-testid={`row-page-${r.pagePath}`}
                      >
                        {sites.length > 1 && <td className="px-4 py-2.5 text-white/40 text-xs">{r.site || "—"}</td>}
                        <td className="px-4 py-2.5 text-white/80 truncate max-w-[280px]" title={r.pagePath}>
                          {formatPath(r.pagePath)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-white font-medium">{r.views}</td>
                        <td className="px-4 py-2.5 text-right text-white/70">{r.uniques}</td>
                        <td className="px-4 py-2.5 text-right text-white/50 hidden sm:table-cell">
                          {formatMs(r.avgDwellMs)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-white/50 hidden md:table-cell">
                          {formatPct(r.exitRate)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User journeys — top page->page transitions */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-emerald-400" />
            User journeys
            <span className="text-white/30 text-xs font-normal">
              {WINDOWS.find((w) => w.value === days)?.label}
            </span>
          </CardTitle>
          <p className="text-xs text-white/30 mt-1">
            Top page-to-page transitions, grouped by where visitors came from.
          </p>
        </CardHeader>
        <CardContent>
          {journeys.isLoading ? (
            <TableSkeleton />
          ) : !journeySources.length ? (
            <EmptyState
              text="No journey data yet — fills in after the nightly rollup runs."
              testid="text-journeys-empty"
            />
          ) : (
            <div className="space-y-5" data-testid="list-journeys">
              {journeySources.map((g) => (
                <div key={g.fromPath} data-testid={`group-journey-${g.fromPath}`}>
                  <p className="text-[11px] text-white/50 font-mono mb-1.5 truncate" title={g.fromPath}>
                    {formatPath(g.fromPath)}
                    <span className="text-white/25"> · {g.total} transitions</span>
                  </p>
                  <div className="space-y-1.5">
                    {g.edges.slice(0, 6).map((e) => (
                      <div
                        key={`${e.fromPath}->${e.toPath}`}
                        className="flex items-center gap-2"
                        data-testid={`row-journey-${e.fromPath}-${e.toPath}`}
                      >
                        <ArrowRight className="w-3 h-3 text-white/20 flex-shrink-0" />
                        <span
                          className="w-28 sm:w-48 text-[11px] text-white/70 truncate flex-shrink-0"
                          title={e.toPath}
                        >
                          {formatPath(e.toPath)}
                        </span>
                        <div className="flex-1 h-3 rounded bg-white/[0.03] overflow-hidden min-w-[40px]">
                          <div
                            className="h-full bg-emerald-500/50 rounded"
                            style={{
                              width: `${maxJourneyCount > 0 ? Math.max((e.count / maxJourneyCount) * 100, 3) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="w-10 text-[10px] text-white/40 flex-shrink-0 text-right">{e.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Page detail drawer */}
      {selectedPage && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
          onClick={() => setSelectedPage(null)}
          data-testid="drawer-page-detail"
        >
          <div
            className="relative h-full w-full max-w-lg bg-[#0a0e1a] border-l border-blue-500/15 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#0a0e1a]/95 backdrop-blur border-b border-white/[0.06] px-5 py-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-white font-semibold text-base truncate" title={selectedPage.pagePath}>
                  {formatPath(selectedPage.pagePath)}
                </h2>
                <p className="text-xs text-white/40 mt-0.5 truncate">{selectedPage.site || "—"}</p>
              </div>
              <button
                onClick={() => setSelectedPage(null)}
                className="w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-white/40 hover:text-white/80 flex-shrink-0"
                data-testid="button-detail-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-6">
              {detail.isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-xl bg-white/[0.03]" />
                  ))}
                </div>
              ) : !detail.data ? (
                <EmptyState text="Couldn't load this page's detail." testid="text-detail-error" />
              ) : (
                <>
                  {/* Scroll depth funnel */}
                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
                      <TrendingDown className="w-3.5 h-3.5" />
                      Scroll depth
                    </h3>
                    {!detail.data.scrollFunnel.some((b) => b.sessions > 0) ? (
                      <EmptyState text="No scroll data yet." testid="text-scroll-empty" />
                    ) : (
                      <div className="space-y-1.5" data-testid="funnel-scroll">
                        {detail.data.scrollFunnel.map((b) => (
                          <div key={b.band} className="flex items-center gap-2" data-testid={`row-scroll-${b.band}`}>
                            <span className="w-9 text-[10px] text-white/40 flex-shrink-0 text-right">{b.band}%</span>
                            <div className="flex-1 h-4 rounded bg-white/[0.03] overflow-hidden">
                              <div
                                className="h-full bg-blue-500/50 rounded"
                                style={{ width: `${Math.min(b.pct, 100)}%` }}
                              />
                            </div>
                            <span className="w-20 text-[10px] text-white/40 flex-shrink-0 text-right">
                              {b.sessions} ({b.pct}%)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Section timing */}
                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      Section timing
                    </h3>
                    {!detail.data.sections.length ? (
                      <EmptyState text="No tagged sections ([data-track-section]) seen yet." testid="text-sections-empty" />
                    ) : (
                      <div className="space-y-1.5" data-testid="bars-sections">
                        {detail.data.sections.map((s) => (
                          <div key={s.sectionKey} className="flex items-center gap-2" data-testid={`row-section-${s.sectionKey}`}>
                            <span
                              className="w-24 text-[11px] text-white/60 flex-shrink-0 truncate"
                              title={s.sectionKey}
                            >
                              {s.sectionKey}
                            </span>
                            <div className="flex-1 h-4 rounded bg-white/[0.03] overflow-hidden">
                              <div
                                className="h-full bg-violet-500/50 rounded"
                                style={{
                                  width: `${maxSectionMs > 0 ? Math.max((s.avgVisibleMs / maxSectionMs) * 100, 3) : 0}%`,
                                }}
                              />
                            </div>
                            <span className="w-20 text-[10px] text-white/40 flex-shrink-0 text-right">
                              {formatMs(s.avgVisibleMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Top clicked elements */}
                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-white/40 mb-3 flex items-center gap-1.5">
                      <MousePointerClick className="w-3.5 h-3.5" />
                      Top clicked elements
                    </h3>
                    {!detail.data.topClicks.length ? (
                      <EmptyState text="No clicks recorded yet." testid="text-clicks-empty" />
                    ) : (
                      <div className="divide-y divide-white/[0.04]" data-testid="list-clicks">
                        {detail.data.topClicks.slice(0, 25).map((c, i) => (
                          <div key={`${c.cssPath}-${c.viewport}-${i}`} className="py-2 flex items-center gap-2" data-testid={`row-click-${i}`}>
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-white/70 font-mono truncate" title={c.cssPath}>
                                {c.cssPath}
                              </p>
                              <p className="text-[10px] text-white/30 mt-0.5">
                                {c.viewport || "unknown"} · offset {(c.avgOffsetX * 100).toFixed(0)}%,
                                {(c.avgOffsetY * 100).toFixed(0)}%
                              </p>
                            </div>
                            <span className="text-sm text-white font-medium flex-shrink-0">{c.clicks}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
function TableSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg bg-white/[0.03]" />
      ))}
    </div>
  );
}

function EmptyState({ text, testid }: { text: string; testid: string }) {
  return (
    <div className="p-6 text-center text-white/40 text-sm" data-testid={testid}>
      {text}
    </div>
  );
}
