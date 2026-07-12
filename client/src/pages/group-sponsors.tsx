import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Share2, Plus, X, Search, Copy, ExternalLink, Trash2, Users, Clock,
  Check, Link2, Monitor, Smartphone, Tablet, Globe,
  RefreshCw, CircleCheck, CircleX, CircleHelp, MousePointerClick,
} from "lucide-react";

// ── Config ──────────────────────────────────────────────────────────────────
// Same brand palette as the Proposal Tracker, for visual consistency across
// the Group workspace's tabs.
const BRANDS = [
  { slug: "cufc", label: "CUFC", color: "#3b82f6" },
  { slug: "siu", label: "SIU", color: "#8b5cf6" },
  { slug: "mfl", label: "MFL", color: "#06b6d4" },
  { slug: "cic", label: "CIC", color: "#a855f7" },
  { slug: "usc", label: "USC", color: "#22c55e" },
  { slug: "cugc", label: "Gymnastics", color: "#ec4899" },
  { slug: "academy", label: "Academy", color: "#f59e0b" },
  { slug: "print", label: "Print", color: "#f97316" },
  { slug: "usg", label: "USG", color: "#eab308" },
];
const brandCfg = (b: string) => BRANDS.find(x => x.slug === b) || { slug: b, label: (b || "?").toUpperCase(), color: "#64748b" };

interface SponsorStats {
  clicks30d: number;
  unique30d: number;
  totalClicks: number;
  lastClick: string | null;
  byDay: { day: string; clicks: number }[];
}
interface Sponsor {
  id: number; organizationId: number; name: string; brand: string;
  websiteUrl: string; shortCode: string; logoUrl: string | null; tier: string | null;
  siteStatus: "ok" | "down" | "unknown"; siteStatusCode: number | null; siteCheckedAt: string | null;
  active: boolean; notes: string | null; openCount: number; lastOpenedAt: string | null;
  createdAt: string; updatedAt: string;
  stats?: SponsorStats;
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return fmtDate(iso);
};

// Fill a 30-day window so every sparkline has the same bar count/spacing,
// even for a sponsor with no clicks on most days.
function fillDays(byDay: { day: string; clicks: number }[] = []): { day: string; clicks: number }[] {
  const map = new Map(byDay.map(d => [d.day, d.clicks]));
  const out: { day: string; clicks: number }[] = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, clicks: map.get(key) || 0 });
  }
  return out;
}

function Sparkline({ data, height = 20 }: { data: { day: string; clicks: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map(d => d.clicks));
  return (
    <div className="flex items-end gap-[1.5px]" style={{ height }}>
      {data.map(d => (
        <div key={d.day} title={`${d.day}: ${d.clicks}`}
          className="w-[3px] bg-blue-500/60 rounded-sm min-h-[1px]"
          style={{ height: `${Math.max(6, (d.clicks / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function HealthBadge({ status }: { status: string }) {
  if (status === "ok") return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
      <CircleCheck className="w-3 h-3" /> Site OK
    </span>
  );
  if (status === "down") return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 whitespace-nowrap">
      <CircleX className="w-3 h-3" /> Site down
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10 whitespace-nowrap">
      <CircleHelp className="w-3 h-3" /> Unchecked
    </span>
  );
}

function Kpi({ label, value, icon, accent, sub }: { label: string; value: string; icon: React.ReactNode; accent: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2 text-[11px] text-white/40 font-medium">
        <span style={{ color: accent }}>{icon}</span> {label}
      </div>
      <div className="text-lg font-semibold mt-1">{value}</div>
      {sub && <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>}
    </div>
  );
}
function BrandPill({ brand }: { brand: string }) {
  const b = brandCfg(brand);
  return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap"
      style={{ background: `${b.color}22`, color: b.color }}>{b.label}</span>
  );
}
function SponsorLogo({ url, name }: { url: string | null; name: string }) {
  if (url) return <img src={url} alt={name} className="w-6 h-6 rounded object-contain bg-white/5 flex-shrink-0" />;
  return (
    <div className="w-6 h-6 rounded bg-white/[0.06] flex items-center justify-center text-[10px] font-semibold text-white/40 flex-shrink-0">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50";

export default function GroupSponsors() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;

  const [groupBy, setGroupBy] = useState<"none" | "brand" | "company">("none");
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partial<Sponsor> | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data: sponsors = [], isLoading } = useQuery<Sponsor[]>({
    queryKey: ["/api/admin/sponsor-traffic", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsor-traffic?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load sponsors");
      return r.json();
    },
    enabled: !!orgId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsor-traffic", orgId] });

  const save = useMutation({
    mutationFn: async (body: any) =>
      (body.id
        ? apiRequest("PATCH", `/api/admin/sponsor-traffic/${body.id}`, body)
        : apiRequest("POST", `/api/admin/sponsor-traffic`, { ...body, organizationId: orgId })).then(r => r.json()),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: "Sponsor saved" }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/sponsor-traffic/${id}`),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: "Sponsor deleted" }); },
  });
  const checkOne = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/admin/sponsor-traffic/${id}/check`).then(r => r.json()),
    onSuccess: (row: Sponsor) => {
      invalidate();
      toast({ title: row.siteStatus === "ok" ? "Site is up" : "Site looks down", description: row.websiteUrl });
    },
    onError: (e: any) => toast({ title: "Check failed", description: e.message, variant: "destructive" }),
  });
  const checkAll = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/admin/sponsor-traffic/check-all`, { organizationId: orgId }).then(r => r.json()),
    onSuccess: (data: { checked: number; ok: number; down: number }) => {
      invalidate();
      toast({ title: "Health check complete", description: `${data.ok} OK · ${data.down} down (of ${data.checked} checked)` });
    },
    onError: (e: any) => toast({ title: "Check failed", description: e.message, variant: "destructive" }),
  });

  // Deep-link from global search: /admin/sponsor-traffic?open=<id> opens that sponsor.
  useEffect(() => {
    if (!sponsors.length) return;
    const openId = new URLSearchParams(window.location.search).get("open");
    if (!openId) return;
    const s = sponsors.find(x => String(x.id) === openId);
    if (s) {
      setEditing(s);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [sponsors]);

  const trackedLink = (s: Partial<Sponsor>) =>
    s.shortCode ? `${window.location.origin}/s/${s.shortCode}` : "";
  const copyLink = async (s: Sponsor) => {
    const link = trackedLink(s);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(s.id);
      setTimeout(() => setCopiedId(v => (v === s.id ? null : v)), 1800);
      toast({ title: "Tracked link copied", description: link });
    } catch { toast({ title: "Copy failed", description: link, variant: "destructive" }); }
  };

  const kpis = useMemo(() => {
    const live = sponsors.filter(s => showInactive ? true : s.active);
    return {
      total: live.length,
      clicks30d: live.reduce((sum, s) => sum + (s.stats?.clicks30d ?? 0), 0),
      unique30d: live.reduce((sum, s) => sum + (s.stats?.unique30d ?? 0), 0),
      down: live.filter(s => s.siteStatus === "down").length,
    };
  }, [sponsors, showInactive]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sponsors.filter(s =>
      (showInactive ? true : s.active) &&
      (!brandFilter || s.brand === brandFilter) &&
      (!q || [s.name, s.brand, s.tier, s.websiteUrl, s.notes].filter(Boolean).join(" ").toLowerCase().includes(q))
    );
  }, [sponsors, search, brandFilter, showInactive]);

  const sorted = useMemo(() =>
    [...filtered].sort((a, b) => (b.stats?.clicks30d ?? 0) - (a.stats?.clicks30d ?? 0) || (b.openCount - a.openCount)),
    [filtered]);

  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "__all", items: sorted }];
    const map = new Map<string, Sponsor[]>();
    for (const s of sorted) {
      const key = groupBy === "brand" ? s.brand : s.name;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    const arr = Array.from(map.entries()).map(([key, items]) => ({ key, items }));
    arr.sort((a, b) => {
      const at = a.items.reduce((s, x) => s + (x.stats?.clicks30d ?? 0), 0);
      const bt = b.items.reduce((s, x) => s + (x.stats?.clicks30d ?? 0), 0);
      return bt - at;
    });
    return arr;
  }, [sorted, groupBy]);

  const groupLabel = (key: string) => groupBy === "brand" ? brandCfg(key).label : key;

  if (!orgId) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2"><Share2 className="w-5 h-5 text-blue-400" /> Sponsor Traffic</h1>
            <p className="text-xs text-white/40 mt-0.5">How much website traffic we send each sponsor via tracked links — plus a live check that their site is still up.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-white/50 hover:text-white/80 text-xs h-8"
              onClick={() => checkAll.mutate()} disabled={checkAll.isPending || !sponsors.length}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${checkAll.isPending ? "animate-spin" : ""}`} />
              {checkAll.isPending ? "Checking…" : "Check all sites"}
            </Button>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-8"
              onClick={() => setEditing({ brand: "cufc", active: true })}>
              <Plus className="w-4 h-4 mr-1" /> Add sponsor
            </Button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">
          <Kpi label="Sponsors tracked" value={String(kpis.total)} icon={<Share2 className="w-3.5 h-3.5" />} accent="#3b82f6" />
          <Kpi label="Clicks (30d)" value={String(kpis.clicks30d)} icon={<MousePointerClick className="w-3.5 h-3.5" />} accent="#0ea5e9" />
          <Kpi label="Unique visitors sent (30d)" value={String(kpis.unique30d)} icon={<Users className="w-3.5 h-3.5" />} accent="#a855f7" />
          <Kpi label="Sites down" value={String(kpis.down)} icon={<CircleX className="w-3.5 h-3.5" />} accent={kpis.down > 0 ? "#ef4444" : "#22c55e"} />
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 sm:px-6 py-3 border-b border-white/[0.06] flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] border border-white/10 p-0.5">
          {(["none", "brand", "company"] as const).map(g => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`text-[11px] px-2.5 py-1 rounded-md capitalize transition-colors ${groupBy === g ? "bg-blue-600 text-white" : "text-white/50 hover:text-white/80"}`}>
              {g === "none" ? "Leaderboard" : g === "brand" ? "By brand" : "By company"}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search sponsors…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-[13px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-blue-500/50" />
        </div>
        <select value={brandFilter || ""} onChange={e => setBrandFilter(e.target.value || null)}
          className="text-[11px] rounded-lg bg-white/[0.03] border border-white/10 px-2 py-1.5 text-white/70">
          <option value="">All brands</option>
          {BRANDS.map(b => <option key={b.slug} value={b.slug}>{b.label}</option>)}
        </select>
        <button onClick={() => setShowInactive(v => !v)}
          className={`text-[11px] px-2 py-1.5 rounded-lg border ${showInactive ? "border-blue-500/40 text-blue-300 bg-blue-500/10" : "border-white/10 text-white/40"}`}>
          Inactive
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12 rounded-xl bg-white/[0.03]" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Share2 className="w-10 h-10 text-white/15 mb-3" />
            <div className="text-white/50 text-sm font-medium">No sponsors tracked yet</div>
            <div className="text-white/30 text-xs mt-1 max-w-xs">Add each sponsor placement (one per brand site) to get a tracked link and start seeing real traffic sent their way.</div>
            <Button size="sm" className="mt-4 bg-blue-600 hover:bg-blue-500 text-white text-xs"
              onClick={() => setEditing({ brand: "cufc", active: true })}>
              <Plus className="w-4 h-4 mr-1" /> Add sponsor
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(group => (
              <div key={group.key}>
                {groupBy !== "none" && (
                  <div className="flex items-center gap-2 mb-2">
                    {groupBy === "brand" && <span className="w-2 h-2 rounded-full" style={{ background: brandCfg(group.key).color }} />}
                    <h2 className="text-sm font-semibold text-white/80">{groupLabel(group.key)}</h2>
                    <span className="text-[11px] text-white/30">{group.items.length}</span>
                  </div>
                )}
                <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                  <table className="w-full text-xs min-w-[820px]">
                    <thead>
                      <tr className="text-white/35 text-[10px] uppercase tracking-wide border-b border-white/[0.06]">
                        <th className="text-left font-medium px-3 py-2">Sponsor</th>
                        <th className="text-left font-medium px-3 py-2">Tier</th>
                        <th className="text-right font-medium px-3 py-2">Clicks (30d)</th>
                        <th className="text-right font-medium px-3 py-2">Unique (30d)</th>
                        <th className="text-right font-medium px-3 py-2">Total sent</th>
                        <th className="text-left font-medium px-3 py-2">Last 30 days</th>
                        <th className="text-left font-medium px-3 py-2">Health</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(s => (
                        <tr key={s.id} onClick={() => setEditing(s)}
                          className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer last:border-0">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <SponsorLogo url={s.logoUrl} name={s.name} />
                              <div>
                                <div className="font-medium text-white/90 flex items-center gap-1.5">
                                  {s.name}
                                  {!s.active && <span className="text-[9px] text-white/30 border border-white/15 rounded px-1">inactive</span>}
                                </div>
                                <div className="text-[11px] text-white/40 mt-0.5"><BrandPill brand={s.brand} /></div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-white/50">{s.tier || "—"}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-white/85">{s.stats?.clicks30d ?? 0}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-white/60">{s.stats?.unique30d ?? 0}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-white/50">{s.openCount}</td>
                          <td className="px-3 py-2.5"><Sparkline data={fillDays(s.stats?.byDay)} /></td>
                          <td className="px-3 py-2.5"><HealthBadge status={s.siteStatus} /></td>
                          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                            <button onClick={() => copyLink(s)} title="Copy tracked link"
                              className="text-white/40 hover:text-blue-300 transition-colors">
                              {copiedId === s.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <SponsorDialog
          sponsor={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate(body)}
          onDelete={(id) => { if (confirm("Delete this sponsor? This cannot be undone.")) remove.mutate(id); }}
          onCheck={(id) => checkOne.mutate(id)}
          checking={checkOne.isPending}
          saving={save.isPending}
          trackedLink={trackedLink}
        />
      )}
    </div>
  );
}

// ── Sponsor create / edit / analytics dialog ────────────────────────────────
function SponsorDialog({ sponsor, onClose, onSave, onDelete, onCheck, checking, saving, trackedLink }: {
  sponsor: Partial<Sponsor>; onClose: () => void; onSave: (b: any) => void; onDelete: (id: number) => void;
  onCheck: (id: number) => void; checking: boolean; saving: boolean; trackedLink: (s: Partial<Sponsor>) => string;
}) {
  const { toast } = useToast();
  const isEdit = !!sponsor.id;
  const [f, setF] = useState({
    name: sponsor.name || "", brand: sponsor.brand || "cufc", websiteUrl: sponsor.websiteUrl || "",
    tier: sponsor.tier || "", logoUrl: sponsor.logoUrl || "", notes: sponsor.notes || "",
    active: sponsor.active ?? true,
  });
  const set = (k: string, v: any) => setF(s => ({ ...s, [k]: v }));

  const submit = () => {
    if (!f.name.trim()) { toast({ title: "Add a sponsor name", variant: "destructive" }); return; }
    if (!f.websiteUrl.trim()) { toast({ title: "Add their website URL", variant: "destructive" }); return; }
    onSave({ id: sponsor.id, ...f });
  };

  const link = trackedLink(sponsor);
  const copyLink = async () => { if (link) { await navigator.clipboard.writeText(link); toast({ title: "Copied", description: link }); } };
  const openSite = f.websiteUrl ? (/^https?:\/\//i.test(f.websiteUrl) ? f.websiteUrl : `https://${f.websiteUrl}`) : "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto p-0 gap-0 bg-[#0a0e17] border-white/10">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-white/[0.08] bg-[#0a0e17]/95 backdrop-blur">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold">{isEdit ? "Sponsor" : "Add sponsor"}</span>
          </div>
          <div className="flex items-center gap-2">
            {isEdit && sponsor.id && (
              <button onClick={() => onDelete(sponsor.id!)} className="text-white/30 hover:text-red-400 transition-colors" title="Delete">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} className="text-white/40 hover:text-white/80"><X className="w-4.5 h-4.5" /></button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-5 p-5">
          {/* Left: details form */}
          <div className="space-y-3">
            <div>
              <Label className="text-[11px] text-white/50">Sponsor name</Label>
              <input className={inputCls} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Moana Skies" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[11px] text-white/50">Brand (which site)</Label>
                <input className={inputCls} list="sponsor-brands" value={f.brand} onChange={e => set("brand", e.target.value)} placeholder="cufc, siu…" />
                <datalist id="sponsor-brands">{BRANDS.map(b => <option key={b.slug} value={b.slug}>{b.label}</option>)}</datalist>
              </div>
              <div>
                <Label className="text-[11px] text-white/50">Tier</Label>
                <input className={inputCls} value={f.tier} onChange={e => set("tier", e.target.value)} placeholder="partner, Principal partner…" />
              </div>
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Website URL (their real destination)</Label>
              <input className={inputCls} value={f.websiteUrl} onChange={e => set("websiteUrl", e.target.value)} placeholder="https://www.example.co.nz" />
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Logo URL</Label>
              <input className={inputCls} value={f.logoUrl} onChange={e => set("logoUrl", e.target.value)} placeholder="https://…/logo.png" />
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Notes</Label>
              <Textarea className={`${inputCls} min-h-[64px]`} value={f.notes} onChange={e => set("notes", e.target.value)} />
            </div>
            {isEdit && (
              <label className="flex items-center gap-2 text-[11px] text-white/50 pt-1">
                <input type="checkbox" checked={f.active} onChange={e => set("active", e.target.checked)} /> Active (unticking archives this placement)
              </label>
            )}
          </div>

          {/* Right: tracked link + health + analytics */}
          <div className="space-y-4">
            {isEdit ? (
              <>
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-blue-300/80 font-medium mb-1.5"><Link2 className="w-3.5 h-3.5" /> Tracked link</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[11px] text-white/80 bg-black/30 rounded-lg px-2.5 py-2 truncate">{link || "—"}</code>
                    <button onClick={copyLink} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60"><Copy className="w-3.5 h-3.5" /></button>
                    {openSite && <a href={openSite} target="_blank" rel="noreferrer" className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60"><ExternalLink className="w-3.5 h-3.5" /></a>}
                  </div>
                  <p className="text-[10px] text-white/30 mt-1.5">Use this on the brand site instead of the raw URL — every click is logged below (your own clicks are excluded).</p>
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] text-white/60 font-medium">Sponsor-site health</div>
                    <Button size="sm" variant="ghost" className="h-6 text-[11px] text-white/50 hover:text-white/80"
                      onClick={() => onCheck(sponsor.id!)} disabled={checking}>
                      <RefreshCw className={`w-3 h-3 mr-1 ${checking ? "animate-spin" : ""}`} /> Check now
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <HealthBadge status={sponsor.siteStatus || "unknown"} />
                    {sponsor.siteStatusCode != null && <span className="text-[10px] text-white/30">HTTP {sponsor.siteStatusCode}</span>}
                    <span className="text-[10px] text-white/30">checked {fmtRelative(sponsor.siteCheckedAt)}</span>
                  </div>
                </div>

                <SponsorAnalytics sponsorId={sponsor.id!} />
              </>
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
                <Share2 className="w-7 h-7 text-blue-400/40 mx-auto mb-2" />
                <div className="text-sm text-white/70 font-medium">A tracked link is generated on save</div>
                <div className="text-[11px] text-white/40 mt-1">Wire <code className="text-white/60">app.usg.co.nz/s/…</code> into the brand site and watch clicks, unique visitors, device &amp; site health appear here.</div>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.08] bg-[#0a0e17]/95 backdrop-blur">
          <Button variant="ghost" size="sm" className="text-white/50 text-xs" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white text-xs" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add sponsor"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SponsorAnalytics({ sponsorId }: { sponsorId: number }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/sponsor-traffic", sponsorId, "analytics"],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsor-traffic/${sponsorId}/analytics`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load analytics");
      return r.json();
    },
  });
  if (isLoading) return <Skeleton className="h-40 rounded-xl bg-white/[0.03]" />;
  const s = data?.summary || {};
  const clicks = Number(s.clicks || 0);
  const uniques = Number(s.unique_visitors || 0);
  const byDay = fillDays((data?.byDay || []).map((d: any) => ({ day: d.day, clicks: Number(d.clicks) })));
  const byDevice: { device: string; n: number }[] = (data?.byDevice || []).map((d: any) => ({ device: d.device, n: Number(d.n) }));
  const byReferrer: { referrer: string; n: number }[] = (data?.byReferrer || []).map((d: any) => ({ referrer: d.referrer, n: Number(d.n) }));
  const bySource: { source: string; n: number }[] = (data?.bySource || []).map((d: any) => ({ source: d.source, n: Number(d.n) }));
  const timeline: any[] = data?.timeline || [];
  const devIcon = (d: string) => d === "mobile" ? <Smartphone className="w-3 h-3" /> : d === "tablet" ? <Tablet className="w-3 h-3" /> : d === "desktop" ? <Monitor className="w-3 h-3" /> : <Globe className="w-3 h-3" />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
          <div className="text-lg font-semibold text-white/90">{clicks}</div>
          <div className="text-[10px] text-white/40 flex items-center justify-center gap-1"><MousePointerClick className="w-3 h-3" /> clicks</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
          <div className="text-lg font-semibold text-white/90">{uniques}</div>
          <div className="text-[10px] text-white/40 flex items-center justify-center gap-1"><Users className="w-3 h-3" /> unique</div>
        </div>
      </div>

      {clicks === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-center text-[11px] text-white/40">
          No clicks yet. Once the tracked link is live on the brand site, clicks and visitors show here.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] text-white/40 mb-2 flex items-center gap-1"><Clock className="w-3 h-3" /> Clicks · last 30 days</div>
            <Sparkline data={byDay} height={56} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
              <div className="text-[10px] text-white/40 mb-1.5">Devices</div>
              {byDevice.map(d => (
                <div key={d.device} className="flex items-center justify-between text-[11px] text-white/60 py-0.5">
                  <span className="flex items-center gap-1 capitalize">{devIcon(d.device)} {d.device}</span>
                  <span className="tabular-nums text-white/40">{d.n}</span>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
              <div className="text-[10px] text-white/40 mb-1.5">Which page sent them</div>
              {byReferrer.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] text-white/60 py-0.5">
                  <span className="truncate max-w-[110px]" title={d.referrer}>{d.referrer.replace(/^https?:\/\//, "")}</span>
                  <span className="tabular-nums text-white/40">{d.n}</span>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
              <div className="text-[10px] text-white/40 mb-1.5">Source (?src=)</div>
              {bySource.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] text-white/60 py-0.5">
                  <span className="truncate max-w-[110px]" title={d.source}>{d.source}</span>
                  <span className="tabular-nums text-white/40">{d.n}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
            <div className="text-[10px] text-white/40 mb-1.5">Recent activity</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {timeline.slice(0, 20).map((e, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
                  <span className="flex items-center gap-1.5 text-white/60">
                    <MousePointerClick className="w-3 h-3 text-blue-400" /> Clicked
                    {e.source && <span className="text-[9px] text-white/30 border border-white/10 rounded px-1">{e.source}</span>}
                    {e.is_internal && <span className="text-[9px] text-white/25 border border-white/10 rounded px-1">you</span>}
                  </span>
                  <span className="text-white/35">{fmtRelative(e.occurred_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
