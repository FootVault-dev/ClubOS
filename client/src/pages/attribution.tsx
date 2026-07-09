// AttributionOS — Attribution dashboard tab (T20).
//
// Read-only reporting UI over the T19 admin endpoints (/api/admin/attribution/*),
// which are backed by the T18 query layer + T18/T17/T16 pure models. One
// opinionated default (last-non-direct, 90 days); model + window + new/returning
// switchers drive every panel. Group workspaces can roll every brand up (?group=1;
// the server ignores it for non-group workspaces, so the toggle only shows there).
//
// Panels: 4 header stat cards → channel table (with spend/ROAS/CAC) →
// campaign + ad drilldown (FB-vs-IG split) → leads → reconciliation (three
// deliberately-divergent columns) → recent conversions list → journey drawer.
//
// Dark premium conventions, data-testids, exact react-query keys (each carries the
// live controls so a switch refetches). Client-safe imports only.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Target,
  TrendingUp,
  DollarSign,
  HelpCircle,
  Users,
  X,
  ArrowRight,
  MousePointerClick,
  Layers,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceTypeFor } from "@shared/tabs";

// ── Response shapes (mirrors of the T18/T19 server payloads — kept local so the
// client never imports server code just for a type) ─────────────────────────
interface RollupRow {
  key: string;
  conversions: number;
  leads: number;
  sales: number;
  revenueCents: number;
  newConversions: number;
  returningConversions: number;
}
interface ChannelRow extends RollupRow {
  spendCents: number;
  impressions: number;
  clicks: number;
  roas: number | null;
  cacCents: number | null;
}
interface OverviewResp {
  group: boolean;
  model: string;
  windowDays: number;
  filter: string;
  availableModels: string[];
  stats: {
    trackedRevenueCents: number;
    totalConversions: number;
    totalSales: number;
    totalLeads: number;
    topChannel: string | null;
    pctUnattributed: number;
    paidSpendCents: number;
    paidRevenueCents: number;
    paidRoas: number | null;
    paidCacCents: number | null;
  };
  channels: ChannelRow[];
}
interface CampaignsResp {
  campaigns: RollupRow[];
}
interface AdRow {
  adId: string;
  adName: string;
  conversions: number;
  revenueCents: number;
  facebookRevenueCents: number;
  instagramRevenueCents: number;
  otherRevenueCents: number;
  facebookConversions: number;
  instagramConversions: number;
  otherConversions: number;
  spendCents: number;
  clicks: number;
  roas: number | null;
  cacCents: number | null;
}
interface AdsResp {
  ads: AdRow[];
}
interface LeadsResp {
  channels: RollupRow[];
}
interface ReconRow {
  channel: string;
  trackedConversions: number;
  trackedRevenueCents: number;
  hdyhauCount: number;
  spendCents: number;
  clicks: number;
  impressions: number;
}
interface ReconResp {
  rows: ReconRow[];
}
interface ConversionListItem {
  source: string;
  id: number;
  personId: number | null;
  visitorId: string | null;
  timestamp: number;
  revenueCents: number;
  isLead: boolean;
  isNew: boolean;
  channel: string | null;
}
interface JourneysResp {
  total: number;
  conversions: ConversionListItem[];
}
interface JourneyItem {
  type: "touch" | "conversion";
  timestamp: number;
  channel: string | null;
  channelRaw?: string | null;
  campaign?: string | null;
  landingUrl?: string | null;
  source?: string;
  id?: number;
  revenueCents?: number;
  isLead?: boolean;
}
interface JourneyResp {
  person: { id: number; email: string | null; phone: string | null; firstName: string | null; lastName: string | null };
  touchCount: number;
  conversionCount: number;
  timeline: JourneyItem[];
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function formatRoas(roas: number | null): string {
  return roas == null ? "—" : `${roas.toFixed(roas >= 10 ? 0 : 1)}×`;
}
function formatPct(fraction: number): string {
  return `${Math.round((fraction || 0) * 100)}%`;
}
function channelLabel(key: string | null | undefined): string {
  if (!key) return "Direct";
  return key
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    registration: "Registration",
    cugc_registration: "Gymnastics",
    print_order: "Print order",
    cugc_free_session: "Free session",
    league_waitlist: "Waitlist",
    cic7s_registration: "CIC 7's",
    football_institute: "Football Institute",
    booking_request: "Booking request",
  };
  return map[source] || channelLabel(source);
}
function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const CHANNEL_BADGE: Record<string, string> = {
  facebook: "bg-blue-500/15 text-blue-300 border-blue-500/25",
  instagram: "bg-pink-500/15 text-pink-300 border-pink-500/25",
  google: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
  email: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  whatsapp: "bg-green-500/15 text-green-300 border-green-500/25",
  sms: "bg-cyan-500/15 text-cyan-300 border-cyan-500/25",
  qr: "bg-violet-500/15 text-violet-300 border-violet-500/25",
  referral: "bg-indigo-500/15 text-indigo-300 border-indigo-500/25",
  organic: "bg-teal-500/15 text-teal-300 border-teal-500/25",
  meta_unattributed: "bg-blue-500/10 text-blue-200/70 border-blue-500/20",
  direct: "bg-white/10 text-white/60 border-white/15",
  unattributed: "bg-white/[0.04] text-white/40 border-white/10",
  other: "bg-white/10 text-white/50 border-white/15",
};
function channelBadgeClass(key: string): string {
  return CHANNEL_BADGE[key] || CHANNEL_BADGE.other;
}

const MODELS: { value: string; label: string }[] = [
  { value: "last_non_direct", label: "Last non-direct" },
  { value: "first_touch", label: "First touch" },
  { value: "lifetime_first", label: "Lifetime first" },
];
const WINDOWS: { value: number; label: string }[] = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 365, label: "Last 12 months" },
];

const selectClass =
  "premium-input text-white/80 rounded-xl w-full h-9 px-3 bg-white/[0.03] appearance-none text-sm";

// Build the shared query string every panel appends. Keeping the array-form
// react-query key aligned with these params means any control change refetches.
function buildQs(model: string, days: number, filter: string, group: boolean): string {
  const p = new URLSearchParams();
  p.set("model", model);
  p.set("days", String(days));
  p.set("windowDays", String(days));
  if (filter !== "all") p.set("filter", filter);
  if (group) p.set("group", "1");
  return p.toString();
}

function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  const key = channel || "direct";
  return (
    <Badge variant="outline" className={`text-[10px] ${channelBadgeClass(key)}`}>
      {channelLabel(key)}
    </Badge>
  );
}

export default function AttributionPage() {
  const { currentOrg } = useWorkspace();
  const isGroupWorkspace = workspaceTypeFor(currentOrg?.slug) === "group";

  const [model, setModel] = useState("last_non_direct");
  const [days, setDays] = useState(90);
  const [filter, setFilter] = useState<"all" | "new" | "returning">("all");
  const [group, setGroup] = useState(false);
  const [journeyPersonId, setJourneyPersonId] = useState<number | null>(null);

  const useGroup = isGroupWorkspace && group;
  const qs = buildQs(model, days, filter, useGroup);
  const keyBase = [model, days, filter, useGroup] as const;

  const overview = useQuery<OverviewResp>({
    queryKey: ["/api/admin/attribution/overview", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/overview?${qs}`)).json(),
  });
  const campaigns = useQuery<CampaignsResp>({
    queryKey: ["/api/admin/attribution/campaigns", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/campaigns?${qs}`)).json(),
  });
  const ads = useQuery<AdsResp>({
    queryKey: ["/api/admin/attribution/ads", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/ads?${qs}`)).json(),
  });
  const leads = useQuery<LeadsResp>({
    queryKey: ["/api/admin/attribution/leads", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/leads?${qs}`)).json(),
  });
  const recon = useQuery<ReconResp>({
    queryKey: ["/api/admin/attribution/reconciliation", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/reconciliation?${qs}`)).json(),
  });
  const journeys = useQuery<JourneysResp>({
    queryKey: ["/api/admin/attribution/journeys", ...keyBase],
    queryFn: async () => (await apiRequest("GET", `/api/admin/attribution/journeys?${qs}&limit=100`)).json(),
  });

  const journey = useQuery<JourneyResp>({
    queryKey: ["/api/admin/attribution/journey", journeyPersonId, useGroup],
    enabled: journeyPersonId != null,
    queryFn: async () =>
      (await apiRequest("GET", `/api/admin/attribution/journey/${journeyPersonId}?${useGroup ? "group=1" : ""}`)).json(),
  });

  const stats = overview.data?.stats;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header + controls */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1
            className="text-xl sm:text-2xl font-semibold text-white tracking-tight flex items-center gap-2"
            data-testid="text-page-title"
          >
            <Target className="w-5 h-5 text-blue-400" />
            Attribution
            {overview.data?.group && (
              <Badge variant="outline" className="text-[10px] bg-blue-500/15 text-blue-300 border-blue-500/25">
                Group rollup
              </Badge>
            )}
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Where revenue and leads actually come from — modelled at query time from the touch log.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={`${selectClass} sm:w-40`}
            data-testid="select-model"
            aria-label="Attribution model"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value} className="bg-[#0a0e1a]">
                {m.label}
              </option>
            ))}
          </select>
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
          {/* New-vs-returning toggle */}
          <div className="flex rounded-xl border border-white/[0.06] overflow-hidden" data-testid="toggle-filter">
            {(["all", "new", "returning"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 h-9 text-xs capitalize transition-colors ${
                  filter === f ? "bg-blue-600 text-white" : "text-white/50 hover:text-white/80 bg-white/[0.02]"
                }`}
                data-testid={`button-filter-${f}`}
              >
                {f}
              </button>
            ))}
          </div>
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

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<DollarSign className="w-4 h-4 text-emerald-400" />}
          label="Tracked revenue"
          value={stats ? formatCents(stats.trackedRevenueCents) : "—"}
          sub={stats ? `${stats.totalSales} sales · ${stats.totalLeads} leads` : ""}
          loading={overview.isLoading}
          testid="stat-tracked-revenue"
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-blue-400" />}
          label="Top channel"
          value={stats?.topChannel ? channelLabel(stats.topChannel) : "—"}
          sub={stats ? `${stats.totalConversions} conversions` : ""}
          loading={overview.isLoading}
          testid="stat-top-channel"
        />
        <StatCard
          icon={<Target className="w-4 h-4 text-violet-400" />}
          label="Paid ROAS"
          value={stats ? formatRoas(stats.paidRoas) : "—"}
          sub={stats ? `${formatCents(stats.paidSpendCents)} spend` : ""}
          loading={overview.isLoading}
          testid="stat-paid-roas"
        />
        <StatCard
          icon={<HelpCircle className="w-4 h-4 text-amber-400" />}
          label="Unattributed"
          value={stats ? formatPct(stats.pctUnattributed) : "—"}
          sub="of conversions"
          loading={overview.isLoading}
          testid="stat-unattributed"
        />
      </div>

      {/* Channel table */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-400" />
            Revenue by channel
            <span className="text-white/30 text-xs font-normal">
              {MODELS.find((m) => m.value === model)?.label} · {days}d
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {overview.isLoading ? (
            <TableSkeleton />
          ) : !overview.data?.channels.length ? (
            <EmptyState text="No tracked conversions in this window yet." testid="text-channels-empty" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-channels">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium text-right">Sales</th>
                    <th className="px-4 py-2 font-medium text-right">Leads</th>
                    <th className="px-4 py-2 font-medium text-right hidden sm:table-cell">New / Ret</th>
                    <th className="px-4 py-2 font-medium text-right">Revenue</th>
                    <th className="px-4 py-2 font-medium text-right hidden md:table-cell">Spend</th>
                    <th className="px-4 py-2 font-medium text-right">ROAS</th>
                    <th className="px-4 py-2 font-medium text-right hidden md:table-cell">CAC</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {overview.data.channels.map((c) => (
                    <tr key={c.key} className="hover:bg-white/[0.02]" data-testid={`row-channel-${c.key}`}>
                      <td className="px-4 py-2.5">
                        <ChannelBadge channel={c.key} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-emerald-400 font-medium">{c.sales}</td>
                      <td className="px-4 py-2.5 text-right text-white/70">{c.leads}</td>
                      <td className="px-4 py-2.5 text-right text-white/40 hidden sm:table-cell text-xs">
                        {c.newConversions} / {c.returningConversions}
                      </td>
                      <td className="px-4 py-2.5 text-right text-white font-medium">{formatCents(c.revenueCents)}</td>
                      <td className="px-4 py-2.5 text-right text-white/50 hidden md:table-cell">
                        {c.spendCents ? formatCents(c.spendCents) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-white/80">{formatRoas(c.roas)}</td>
                      <td className="px-4 py-2.5 text-right text-white/50 hidden md:table-cell">
                        {c.cacCents != null ? formatCents(c.cacCents) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Campaign → Ad drilldown */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="premium-card border-white/[0.06]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white/90 text-base">Campaigns</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {campaigns.isLoading ? (
              <TableSkeleton />
            ) : !campaigns.data?.campaigns.length ? (
              <EmptyState text="No campaign-tagged conversions yet." testid="text-campaigns-empty" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-campaigns">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                      <th className="px-4 py-2 font-medium">Campaign</th>
                      <th className="px-4 py-2 font-medium text-right">Conv.</th>
                      <th className="px-4 py-2 font-medium text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {campaigns.data.campaigns.map((c) => (
                      <tr key={c.key} className="hover:bg-white/[0.02]" data-testid={`row-campaign-${c.key}`}>
                        <td className="px-4 py-2.5 text-white/80 truncate max-w-[220px]">{c.key}</td>
                        <td className="px-4 py-2.5 text-right text-white/60">{c.conversions}</td>
                        <td className="px-4 py-2.5 text-right text-white font-medium">{formatCents(c.revenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="premium-card border-white/[0.06]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white/90 text-base flex items-center gap-2">
              Ads
              <span className="text-white/30 text-xs font-normal">FB vs IG split</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {ads.isLoading ? (
              <TableSkeleton />
            ) : !ads.data?.ads.length ? (
              <EmptyState text="No ad-attributed conversions yet." testid="text-ads-empty" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-ads">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                      <th className="px-4 py-2 font-medium">Ad</th>
                      <th className="px-4 py-2 font-medium text-right text-blue-300/70">FB</th>
                      <th className="px-4 py-2 font-medium text-right text-pink-300/70">IG</th>
                      <th className="px-4 py-2 font-medium text-right">Revenue</th>
                      <th className="px-4 py-2 font-medium text-right hidden sm:table-cell">ROAS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {ads.data.ads.map((a) => (
                      <tr key={a.adId} className="hover:bg-white/[0.02]" data-testid={`row-ad-${a.adId}`}>
                        <td className="px-4 py-2.5 text-white/80 truncate max-w-[180px]" title={a.adName}>
                          {a.adName}
                        </td>
                        <td className="px-4 py-2.5 text-right text-blue-300/80">{a.facebookConversions}</td>
                        <td className="px-4 py-2.5 text-right text-pink-300/80">{a.instagramConversions}</td>
                        <td className="px-4 py-2.5 text-right text-white font-medium">{formatCents(a.revenueCents)}</td>
                        <td className="px-4 py-2.5 text-right text-white/70 hidden sm:table-cell">{formatRoas(a.roas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Leads */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <MousePointerClick className="w-4 h-4 text-cyan-400" />
            Leads by channel
            <span className="text-white/30 text-xs font-normal">waitlist · free sessions · enquiries</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {leads.isLoading ? (
            <TableSkeleton />
          ) : !leads.data?.channels.length ? (
            <EmptyState text="No leads captured in this window." testid="text-leads-empty" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-leads">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium text-right">Leads</th>
                    <th className="px-4 py-2 font-medium text-right hidden sm:table-cell">New / Ret</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {leads.data.channels.map((c) => (
                    <tr key={c.key} className="hover:bg-white/[0.02]" data-testid={`row-lead-${c.key}`}>
                      <td className="px-4 py-2.5">
                        <ChannelBadge channel={c.key} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-white font-medium">{c.leads}</td>
                      <td className="px-4 py-2.5 text-right text-white/40 hidden sm:table-cell text-xs">
                        {c.newConversions} / {c.returningConversions}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reconciliation */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base">Reconciliation</CardTitle>
          <p className="text-xs text-amber-300/60 mt-1" data-testid="text-recon-note">
            These three columns will not match — the divergence is the information. Tracked = what we cookied;
            self-reported = what buyers told us; ad platform = what Meta counted.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {recon.isLoading ? (
            <TableSkeleton />
          ) : !recon.data?.rows.length ? (
            <EmptyState text="Nothing to reconcile yet." testid="text-recon-empty" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-recon">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium text-right">Tracked conv.</th>
                    <th className="px-4 py-2 font-medium text-right">Self-reported</th>
                    <th className="px-4 py-2 font-medium text-right hidden sm:table-cell">Ad spend</th>
                    <th className="px-4 py-2 font-medium text-right hidden md:table-cell">Ad clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {recon.data.rows.map((r) => (
                    <tr key={r.channel} className="hover:bg-white/[0.02]" data-testid={`row-recon-${r.channel}`}>
                      <td className="px-4 py-2.5">
                        <ChannelBadge channel={r.channel} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-white/80">
                        {r.trackedConversions}
                        <span className="text-white/30 text-xs ml-1">({formatCents(r.trackedRevenueCents)})</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-white/70">{r.hdyhauCount}</td>
                      <td className="px-4 py-2.5 text-right text-white/50 hidden sm:table-cell">
                        {r.spendCents ? formatCents(r.spendCents) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-white/50 hidden md:table-cell">
                        {r.clicks || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent conversions → journey drawer */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white/90 text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" />
            Recent conversions
            {journeys.data && (
              <span className="text-white/30 text-xs font-normal">
                showing {journeys.data.conversions.length} of {journeys.data.total}
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-white/30 mt-1">Click an identified buyer to open their full journey timeline.</p>
        </CardHeader>
        <CardContent className="p-0">
          {journeys.isLoading ? (
            <TableSkeleton />
          ) : !journeys.data?.conversions.length ? (
            <EmptyState text="No conversions in this window." testid="text-journeys-empty" />
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {journeys.data.conversions.map((c) => {
                const clickable = c.personId != null;
                return (
                  <button
                    key={`${c.source}-${c.id}`}
                    disabled={!clickable}
                    onClick={() => clickable && setJourneyPersonId(c.personId)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                      clickable ? "hover:bg-white/[0.03] cursor-pointer" : "cursor-default opacity-70"
                    }`}
                    data-testid={`row-conversion-${c.source}-${c.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-white/80">{sourceLabel(c.source)}</span>
                        <ChannelBadge channel={c.channel} />
                        {c.isNew ? (
                          <Badge variant="outline" className="text-[9px] bg-emerald-500/10 text-emerald-300 border-emerald-500/20">
                            New
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] text-white/40 border-white/10">
                            Returning
                          </Badge>
                        )}
                        {!clickable && <span className="text-[10px] text-white/25">anonymous</span>}
                      </div>
                      <p className="text-[11px] text-white/30 mt-0.5">{formatDateTime(c.timestamp)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-medium ${c.isLead ? "text-white/50" : "text-emerald-400"}`}>
                        {c.isLead ? "Lead" : formatCents(c.revenueCents)}
                      </p>
                    </div>
                    {clickable && <ArrowRight className="w-4 h-4 text-white/20 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Journey drawer */}
      {journeyPersonId != null && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
          onClick={() => setJourneyPersonId(null)}
          data-testid="drawer-journey"
        >
          <div
            className="relative h-full w-full max-w-md bg-[#0a0e1a] border-l border-blue-500/15 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#0a0e1a]/95 backdrop-blur border-b border-white/[0.06] px-5 py-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-white font-semibold text-base">Journey</h2>
                {journey.data?.person && (
                  <p className="text-xs text-white/40 mt-0.5 truncate">
                    {[journey.data.person.firstName, journey.data.person.lastName].filter(Boolean).join(" ") ||
                      journey.data.person.email ||
                      `Person #${journey.data.person.id}`}
                  </p>
                )}
              </div>
              <button
                onClick={() => setJourneyPersonId(null)}
                className="w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-white/40 hover:text-white/80 flex-shrink-0"
                data-testid="button-journey-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5">
              {journey.isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-xl bg-white/[0.03]" />
                  ))}
                </div>
              ) : !journey.data ? (
                <EmptyState text="Couldn't load this journey." testid="text-journey-error" />
              ) : (
                <>
                  <div className="flex gap-4 mb-4 text-xs text-white/40">
                    <span>{journey.data.touchCount} touches</span>
                    <span>{journey.data.conversionCount} conversions</span>
                  </div>
                  <ol className="relative border-l border-white/[0.08] ml-2 space-y-4">
                    {journey.data.timeline.map((item, i) => (
                      <li key={i} className="ml-4" data-testid={`journey-item-${i}`}>
                        <span
                          className={`absolute -left-[5px] w-2.5 h-2.5 rounded-full ${
                            item.type === "conversion" ? "bg-emerald-400" : "bg-blue-400/60"
                          }`}
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          {item.type === "conversion" ? (
                            <>
                              <span className="text-sm text-white/90 font-medium">
                                {sourceLabel(item.source || "conversion")}
                              </span>
                              <span className={`text-xs ${item.isLead ? "text-white/40" : "text-emerald-400"}`}>
                                {item.isLead ? "Lead" : formatCents(item.revenueCents || 0)}
                              </span>
                            </>
                          ) : (
                            <>
                              <ChannelBadge channel={item.channel} />
                              {item.campaign && <span className="text-[11px] text-white/40">{item.campaign}</span>}
                            </>
                          )}
                        </div>
                        {item.type === "touch" && item.landingUrl && (
                          <p className="text-[10px] text-white/25 mt-0.5 truncate">{item.landingUrl}</p>
                        )}
                        <p className="text-[10px] text-white/25 mt-0.5">{formatDateTime(item.timestamp)}</p>
                      </li>
                    ))}
                  </ol>
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
function StatCard({
  icon,
  label,
  value,
  sub,
  loading,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  loading: boolean;
  testid: string;
}) {
  return (
    <div
      className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-4"
      data-testid={testid}
    >
      <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-wider">
        {icon}
        {label}
      </div>
      {loading ? (
        <Skeleton className="h-7 w-24 mt-2 rounded-lg bg-white/[0.04]" />
      ) : (
        <p className="text-xl sm:text-2xl font-semibold text-white mt-1.5 truncate">{value}</p>
      )}
      {sub && <p className="text-[11px] text-white/30 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

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
    <div className="p-10 text-center text-white/40 text-sm" data-testid={testid}>
      {text}
    </div>
  );
}
