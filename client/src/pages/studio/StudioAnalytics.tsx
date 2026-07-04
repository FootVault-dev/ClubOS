// USG Studio — "Signal" analytics dashboard. Route: /admin/studio/:id/signal.
//
// The payoff: know exactly how every named prospect engaged with the proposal.
// Four views (06-proposal-analytics.md §c), built as dependency-light CSS viz so
// they read as one system in the dark ClubOS admin theme (no chart lib):
//   1. Overview  — stat tiles + a viewed→halfway→end→CTA funnel
//   2. Recipients — the per-session timeline ("know when to call")
//   3. Sections  — a per-block READ / SKIMMED / SKIPPED heatmap
//   4. Hot leads — who's warm right now, across the whole workspace
import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Radar, Users, Repeat, Clock, MousePointerClick, ArrowDownWideNarrow,
  Flame, Eye, Smartphone, Monitor, Tablet, Signal as SignalIcon, CheckCircle2, RefreshCw,
} from "lucide-react";
import { engagementLevel } from "@shared/studio-signal";
import type { StudioDocRow } from "./studio-shared";
import { brandName } from "./studio-shared";

// ── Server read-model shapes (mirror server/storage.ts) ───────────────────────
interface KeyCount { key: string; count: number; }
interface Overview {
  uniqueVisitors: number; totalSessions: number; returningVisitors: number;
  avgEngagedMs: number; medianEngagedMs: number; avgScrollPct: number;
  ctaClicks: number; ctaClickSessions: number; reachedEndSessions: number;
  scrolledHalfSessions: number; deviceSplit: KeyCount[]; countrySplit: KeyCount[];
  sourceSplit: KeyCount[]; firstActivityAt: string | null; lastActivityAt: string | null;
}
interface SectionRow {
  blockId: string; type: string; label: string; wordCount: number; expectedReadMs: number;
  medianDwellMs: number; avgDwellMs: number; reachedSessions: number; reachedPct: number;
  readRatio: number | null; readClass: "read" | "skimmed" | "skipped";
}
interface AnalyticsResp { overview: Overview; sections: { totalSessions: number; sections: SectionRow[] }; }
interface SessionRow {
  id: number; sessionId: string; visitorId: string | null; firstSeenAt: string; lastSeenAt: string;
  engagedMs: number; maxScrollPct: number; device: string | null; country: string | null;
  sourceTag: string | null; ctaClicks: number; isReturning: boolean;
}
export interface HotLead {
  documentId: number; title: string; brandId: string; partner: string | null; sessionId: string;
  visitorId: string | null; lastSeenAt: string; engagedMs: number; maxScrollPct: number;
  device: string | null; country: string | null; ctaClicks: number; isReturning: boolean;
}

// ── formatting ────────────────────────────────────────────────────────────────
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
}
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function shortId(v: string | null): string {
  if (!v) return "anon";
  const clean = v.replace(/^anon-/, "");
  return clean.slice(0, 6);
}
function DeviceIcon({ d, className }: { d: string | null; className?: string }) {
  const cls = className ?? "w-3.5 h-3.5";
  if (d === "mobile") return <Smartphone className={cls} />;
  if (d === "tablet") return <Tablet className={cls} />;
  if (d === "desktop") return <Monitor className={cls} />;
  return <Eye className={cls} />;
}

const LEVEL_STYLE: Record<string, { label: string; cls: string }> = {
  "highly-engaged": { label: "Highly engaged", cls: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
  engaged: { label: "Engaged", cls: "text-sky-300 bg-sky-400/10 border-sky-400/25" },
  neutral: { label: "Neutral", cls: "text-amber-300 bg-amber-400/10 border-amber-400/25" },
  disengaged: { label: "Cool", cls: "text-white/40 bg-white/5 border-white/10" },
};
function LevelBadge({ engagedMs, scroll }: { engagedMs: number; scroll: number }) {
  const lvl = engagementLevel(engagedMs, scroll);
  const st = LEVEL_STYLE[lvl];
  return <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>;
}

const READ_STYLE: Record<SectionRow["readClass"], { label: string; text: string; bar: string; track: string }> = {
  read: { label: "READ", text: "text-emerald-300", bar: "bg-emerald-400/70", track: "bg-emerald-400/10" },
  skimmed: { label: "SKIMMED", text: "text-amber-300", bar: "bg-amber-400/60", track: "bg-amber-400/10" },
  skipped: { label: "SKIPPED", text: "text-white/40", bar: "bg-white/25", track: "bg-white/[0.04]" },
};

type Tab = "overview" | "recipients" | "sections" | "hot";

export default function StudioAnalytics() {
  const [, params] = useRoute("/admin/studio/:id/signal");
  const [, navigate] = useLocation();
  const id = Number(params?.id);
  const [tab, setTab] = useState<Tab>("overview");

  const { data: doc } = useQuery<StudioDocRow>({
    queryKey: ["/api/admin/studio", String(id)],
    enabled: Number.isFinite(id),
  });
  const { data: analytics, isLoading } = useQuery<AnalyticsResp>({
    queryKey: ["/api/admin/studio", String(id), "analytics"],
    enabled: Number.isFinite(id),
  });
  const { data: sessions = [] } = useQuery<SessionRow[]>({
    queryKey: ["/api/admin/studio", String(id), "analytics", "sessions"],
    enabled: Number.isFinite(id),
  });
  const { data: hotLeads = [] } = useQuery<HotLead[]>({
    queryKey: ["/api/admin/studio/analytics/hot-leads"],
    refetchInterval: 60_000, // "who's warm right now" — keep it live
  });

  const overview = analytics?.overview;
  const sections = analytics?.sections.sections ?? [];
  const hasData = !!overview && overview.totalSessions > 0;

  const TABS: { id: Tab; label: string; icon: typeof Eye }[] = [
    { id: "overview", label: "Overview", icon: SignalIcon },
    { id: "recipients", label: "Recipients", icon: Users },
    { id: "sections", label: "Sections", icon: ArrowDownWideNarrow },
    { id: "hot", label: "Hot leads", icon: Flame },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate(`/admin/studio/${id}`)} className="text-white/40 hover:text-white/70 transition-colors" data-testid="button-back-editor">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Radar className="w-5 h-5 text-amber-400 shrink-0" /> Signal
          </h1>
          <p className="text-xs text-white/40 mt-0.5 truncate">
            {doc ? `${doc.title} · ${brandName(doc.brandId)}` : "How prospects actually read this proposal"}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06] w-fit max-w-full overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 whitespace-nowrap ${
              tab === t.id ? "bg-amber-400/15 text-amber-300" : "text-white/45 hover:text-white/70"
            }`}
            data-testid={`tab-${t.id}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
            {t.id === "hot" && hotLeads.length > 0 && (
              <span className="text-[10px] px-1.5 rounded-full bg-amber-400/20 text-amber-200">{hotLeads.length}</span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center text-white/30 py-16">Loading…</div>
      ) : tab === "hot" ? (
        <HotLeadsView leads={hotLeads} onOpen={(docId) => navigate(`/admin/studio/${docId}/signal`)} />
      ) : !hasData ? (
        <EmptyState />
      ) : tab === "overview" ? (
        <OverviewView overview={overview!} />
      ) : tab === "recipients" ? (
        <RecipientsView sessions={sessions} />
      ) : (
        <SectionsView sections={sections} totalSessions={analytics!.sections.totalSessions} />
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl">
      <div className="w-12 h-12 rounded-2xl bg-amber-400/10 text-amber-400 flex items-center justify-center mx-auto mb-3">
        <Radar className="w-6 h-6" />
      </div>
      <div className="text-white/70 font-medium">No reads yet</div>
      <p className="text-white/40 text-sm mt-1 max-w-sm mx-auto">
        Signal lights up the moment a real recipient opens the link. Your own previews and staff
        views are excluded, so this stays empty until a prospect reads it.
      </p>
    </div>
  );
}

// ── 1. Overview ───────────────────────────────────────────────────────────────
function StatTile({ icon: Icon, label, value, sub }: { icon: typeof Eye; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
      <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

function OverviewView({ overview: o }: { overview: Overview }) {
  const funnel = [
    { label: "Viewed", n: o.totalSessions, icon: Eye },
    { label: "Scrolled halfway", n: o.scrolledHalfSessions, icon: ArrowDownWideNarrow },
    { label: "Reached the end", n: o.reachedEndSessions, icon: CheckCircle2 },
    { label: "Clicked the CTA", n: o.ctaClickSessions, icon: MousePointerClick },
  ];
  const top = Math.max(1, o.totalSessions);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatTile icon={Users} label="Unique viewers" value={String(o.uniqueVisitors)} />
        <StatTile icon={Eye} label="Total sessions" value={String(o.totalSessions)} />
        <StatTile icon={Repeat} label="Returning viewers" value={String(o.returningVisitors)} />
        <StatTile icon={Clock} label="Median engaged time" value={fmtDur(o.medianEngagedMs)} sub={`avg ${fmtDur(o.avgEngagedMs)}`} />
        <StatTile icon={ArrowDownWideNarrow} label="Avg scroll depth" value={`${o.avgScrollPct}%`} />
        <StatTile icon={MousePointerClick} label="CTA clicks" value={String(o.ctaClicks)} sub={`${o.ctaClickSessions} session${o.ctaClickSessions === 1 ? "" : "s"}`} />
      </div>

      {/* Funnel */}
      <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <div className="text-sm font-semibold text-white/80 mb-4">Engagement funnel</div>
        <div className="space-y-3">
          {funnel.map((f, i) => {
            const pct = Math.round((f.n / top) * 100);
            const conv = i === 0 ? 100 : Math.round((f.n / top) * 100);
            return (
              <div key={f.label} className="flex items-center gap-3">
                <div className="w-36 shrink-0 text-xs text-white/55 flex items-center gap-1.5">
                  <f.icon className="w-3.5 h-3.5 text-white/35" /> {f.label}
                </div>
                <div className="flex-1 h-7 rounded-lg bg-white/[0.04] overflow-hidden relative">
                  <div
                    className="h-full bg-gradient-to-r from-amber-400/70 to-amber-500/50 rounded-lg transition-all"
                    style={{ width: `${Math.max(pct, f.n > 0 ? 4 : 0)}%` }}
                  />
                  <div className="absolute inset-0 flex items-center px-3 text-xs font-medium text-white/90 tabular-nums">
                    {f.n}
                  </div>
                </div>
                <div className="w-12 shrink-0 text-right text-[11px] text-white/40 tabular-nums">{conv}%</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Splits */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SplitCard title="Devices" rows={o.deviceSplit} />
        <SplitCard title="Countries" rows={o.countrySplit} />
        <SplitCard title="Sources" rows={o.sourceSplit} />
      </div>

      <div className="text-[11px] text-white/35">
        First open {fmtTime(o.firstActivityAt)} · last activity {fmtTime(o.lastActivityAt)} · staff/preview views excluded.
      </div>
    </div>
  );
}

function SplitCard({ title, rows }: { title: string; rows: KeyCount[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
      <div className="text-xs font-semibold text-white/60 mb-3">{title}</div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-white/30">No data</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 5).map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <div className="w-20 shrink-0 text-[11px] text-white/55 truncate capitalize">{r.key}</div>
              <div className="flex-1 h-2 rounded-full bg-white/[0.05] overflow-hidden">
                <div className="h-full bg-amber-400/50 rounded-full" style={{ width: `${Math.round((r.count / total) * 100)}%` }} />
              </div>
              <div className="w-8 shrink-0 text-right text-[11px] text-white/45 tabular-nums">{r.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 2. Recipients (session timeline) ──────────────────────────────────────────
function RecipientsView({ sessions }: { sessions: SessionRow[] }) {
  if (sessions.length === 0) {
    return <div className="text-center text-white/30 py-12 text-sm">No recipient sessions yet.</div>;
  }
  return (
    <div className="space-y-2.5">
      <div className="text-[11px] text-white/40">Newest activity first. Each row is one viewing session — this is your "know when to call" surface.</div>
      {sessions.map((s) => (
        <div key={s.id} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex items-center gap-4 flex-wrap" data-testid={`session-${s.id}`}>
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] text-white/50 flex items-center justify-center shrink-0">
            <DeviceIcon d={s.device} className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-white/85 font-medium tabular-nums">#{shortId(s.visitorId)}</span>
              {s.isReturning && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border text-violet-300 bg-violet-400/10 border-violet-400/25 flex items-center gap-1">
                  <Repeat className="w-2.5 h-2.5" /> Returning
                </span>
              )}
              {s.ctaClicks > 0 && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border text-amber-300 bg-amber-400/10 border-amber-400/25 flex items-center gap-1">
                  <MousePointerClick className="w-2.5 h-2.5" /> Booked
                </span>
              )}
            </div>
            <div className="text-[11px] text-white/40 mt-0.5">
              {fmtTime(s.lastSeenAt)}{s.country ? ` · ${s.country}` : ""}{s.device ? ` · ${s.device}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-5 shrink-0">
            <Metric label="Engaged" value={fmtDur(s.engagedMs)} />
            <Metric label="Scrolled" value={`${s.maxScrollPct}%`} />
            <LevelBadge engagedMs={s.engagedMs} scroll={s.maxScrollPct} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="text-sm text-white/85 font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-white/35 uppercase tracking-wider">{label}</div>
    </div>
  );
}

// ── 3. Sections heatmap ───────────────────────────────────────────────────────
function SectionsView({ sections, totalSessions }: { sections: SectionRow[]; totalSessions: number }) {
  if (sections.length === 0) {
    return <div className="text-center text-white/30 py-12 text-sm">This page has no content blocks to measure.</div>;
  }
  const maxDwell = Math.max(1, ...sections.map((s) => s.medianDwellMs));
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-white/40 mb-1">
        Each block coloured by how it was read — <span className="text-emerald-300">READ</span>,{" "}
        <span className="text-amber-300">SKIMMED</span>, <span className="text-white/40">SKIPPED</span>. Shows where the pitch lands and what gets skipped.
      </div>
      {sections.map((s, i) => {
        const st = READ_STYLE[s.readClass];
        return (
          <div key={s.blockId} className={`rounded-2xl border border-white/5 p-4 ${st.track}`} data-testid={`section-${s.blockId}`}>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="w-6 h-6 rounded-lg bg-white/[0.05] text-white/40 flex items-center justify-center text-[11px] shrink-0 tabular-nums">{i + 1}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/85 font-medium truncate">{s.label}</div>
                <div className="text-[10px] text-white/35 uppercase tracking-wider capitalize">{s.type.replace(/_/g, " ")} · {s.wordCount} words</div>
              </div>
              <span className={`text-[10px] font-bold tracking-wider ${st.text} shrink-0`}>{st.label}</span>
            </div>
            {/* dwell bar */}
            <div className="flex items-center gap-3 mt-3">
              <div className="flex-1 h-2.5 rounded-full bg-white/[0.05] overflow-hidden">
                <div className={`h-full rounded-full ${st.bar}`} style={{ width: `${Math.round((s.medianDwellMs / maxDwell) * 100)}%` }} />
              </div>
              <div className="text-[11px] text-white/50 tabular-nums w-16 text-right">{fmtDur(s.medianDwellMs)}</div>
            </div>
            <div className="flex items-center gap-4 mt-2 text-[11px] text-white/40 tabular-nums">
              <span>{s.reachedPct}% reached ({s.reachedSessions}/{totalSessions})</span>
              {s.readRatio != null && <span>read ratio {s.readRatio.toFixed(2)}×</span>}
              <span className="text-white/25">expected {fmtDur(s.expectedReadMs)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 4. Hot leads ──────────────────────────────────────────────────────────────
export function HotLeadsView({ leads, onOpen }: { leads: HotLead[]; onOpen?: (docId: number) => void }) {
  if (leads.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl">
        <div className="w-12 h-12 rounded-2xl bg-amber-400/10 text-amber-400 flex items-center justify-center mx-auto mb-3">
          <Flame className="w-6 h-6" />
        </div>
        <div className="text-white/70 font-medium">Nobody reading right now</div>
        <p className="text-white/40 text-sm mt-1 max-w-sm mx-auto">
          When a prospect opens any published proposal, they show up here — sorted by how warm they are. Call them while they're reading.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      <div className="text-[11px] text-white/40 flex items-center gap-1.5">
        <RefreshCw className="w-3 h-3" /> Active in the last 48 hours across all published proposals · updates every minute.
      </div>
      {leads.map((l) => (
        <div
          key={l.sessionId}
          className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex items-center gap-4 flex-wrap hover:bg-white/[0.05] transition-colors cursor-pointer"
          onClick={() => onOpen?.(l.documentId)}
          data-testid={`hot-lead-${l.sessionId}`}
        >
          <div className="w-9 h-9 rounded-xl bg-amber-400/10 text-amber-400 flex items-center justify-center shrink-0">
            <Flame className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white/85 font-medium truncate">{l.title}</div>
            <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>#{shortId(l.visitorId)}</span>
              <span>· {brandName(l.brandId)}</span>
              <span>· {ago(l.lastSeenAt)}</span>
              {l.country ? <span>· {l.country}</span> : null}
              {l.isReturning && <span className="text-violet-300">· returning</span>}
              {l.ctaClicks > 0 && <span className="text-amber-300">· booked</span>}
            </div>
          </div>
          <div className="flex items-center gap-5 shrink-0">
            <Metric label="Engaged" value={fmtDur(l.engagedMs)} />
            <Metric label="Scrolled" value={`${l.maxScrollPct}%`} />
            <LevelBadge engagedMs={l.engagedMs} scroll={l.maxScrollPct} />
          </div>
        </div>
      ))}
    </div>
  );
}
