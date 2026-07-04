import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Send, Plus, X, Search, Copy, ExternalLink, Trash2, Eye, MousePointerClick,
  Users, Clock, TrendingUp, Tag, LayoutGrid, Rows3, Check, Link2, Monitor,
  Smartphone, Tablet, Globe, Sparkles, Building2,
} from "lucide-react";

// ── Config ──────────────────────────────────────────────────────────────────
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

const TYPES = [
  { key: "sponsorship", label: "Sponsorship", color: "#3b82f6" },
  { key: "partnership", label: "Partnership", color: "#8b5cf6" },
  { key: "investor", label: "Investor", color: "#f59e0b" },
  { key: "development", label: "Development", color: "#06b6d4" },
  { key: "client", label: "Client", color: "#ec4899" },
  { key: "grant", label: "Grant", color: "#22c55e" },
  { key: "other", label: "Other", color: "#64748b" },
] as const;
const typeCfg = (t: string) => TYPES.find(x => x.key === t) || TYPES[TYPES.length - 1];

const STATUSES = [
  { key: "draft", label: "Draft", color: "#64748b" },
  { key: "sent", label: "Sent", color: "#3b82f6" },
  { key: "opened", label: "Opened", color: "#0ea5e9" },
  { key: "in_discussion", label: "In discussion", color: "#a855f7" },
  { key: "negotiating", label: "Negotiating", color: "#f59e0b" },
  { key: "won", label: "Won", color: "#22c55e" },
  { key: "lost", label: "Lost", color: "#ef4444" },
  { key: "on_hold", label: "On hold", color: "#6b7280" },
] as const;
const statusCfg = (s: string) => STATUSES.find(x => x.key === s) || STATUSES[0];
const OPEN_STATUSES = ["sent", "opened", "in_discussion", "negotiating"];

interface Proposal {
  id: number; organizationId: number; title: string; company: string | null;
  proposalType: string; category: string | null; brandTags: string[]; status: string;
  valueCents: number | null; currency: string; owner: string | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  linkUrl: string | null; shortCode: string | null; sourceTag: string | null;
  notes: string | null; sentAt: string | null; decisionAt: string | null;
  lastOpenedAt: string | null; openCount: number; archived: boolean;
  createdAt: string; updatedAt: string;
  stats?: { opens: number; uniqueOpens: number; ctaClicks: number; lastOpen: string | null };
}
interface ProposalCategory {
  id: number; name: string; proposalType: string | null; color: string; sortOrder: number;
}

const fmtMoney = (cents: number | null | undefined) =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
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
function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{label}</span>
  );
}
function BrandChips({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="flex items-center gap-1 flex-wrap">
      {tags.map(t => {
        const b = BRANDS.find(x => x.slug === t);
        return <span key={t} className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
          style={{ background: `${b?.color || "#64748b"}22`, color: b?.color || "#94a3b8" }}>{b?.label || t}</span>;
      })}
    </span>
  );
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50";

export default function GroupProposals() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;

  const [groupBy, setGroupBy] = useState<"type" | "category" | "status">("type");
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Partial<Proposal> | null>(null); // dialog (create/edit)
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showCatMgr, setShowCatMgr] = useState(false);

  const { data: proposals = [], isLoading } = useQuery<Proposal[]>({
    queryKey: ["/api/admin/proposals", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/proposals?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load proposals");
      return r.json();
    },
    enabled: !!orgId,
  });
  const { data: categories = [] } = useQuery<ProposalCategory[]>({
    queryKey: ["/api/admin/proposal-categories", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/proposal-categories?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load categories");
      return r.json();
    },
    enabled: !!orgId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/proposals", orgId] });

  const save = useMutation({
    mutationFn: async (body: any) =>
      (body.id
        ? apiRequest("PATCH", `/api/admin/proposals/${body.id}`, body)
        : apiRequest("POST", `/api/admin/proposals`, { ...body, organizationId: orgId })).then(r => r.json()),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: "Proposal saved" }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/proposals/${id}`),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: "Proposal deleted" }); },
  });
  const saveCategory = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", `/api/admin/proposal-categories`, { ...body, organizationId: orgId }).then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/proposal-categories", orgId] }); toast({ title: "Category added" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Deep-link from global search: /admin/proposals?open=<id> opens that proposal.
  useEffect(() => {
    if (!proposals.length) return;
    const openId = new URLSearchParams(window.location.search).get("open");
    if (!openId) return;
    const p = proposals.find(x => String(x.id) === openId);
    if (p) {
      setEditing(p);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [proposals]);

  const catColor = (name: string | null) => categories.find(c => c.name === name)?.color || "#64748b";

  const trackedLink = (p: Partial<Proposal>) =>
    p.shortCode ? `${window.location.origin}/r/${p.shortCode}` : "";
  const copyLink = async (p: Proposal) => {
    const link = trackedLink(p);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(v => (v === p.id ? null : v)), 1800);
      toast({ title: "Tracked link copied", description: link });
    } catch { toast({ title: "Copy failed", description: link, variant: "destructive" }); }
  };

  const kpis = useMemo(() => {
    const live = proposals.filter(p => !p.archived);
    const sent = live.filter(p => p.status !== "draft");
    const opened = live.filter(p => (p.stats?.opens ?? 0) > 0);
    const won = live.filter(p => p.status === "won");
    const pipeline = live.filter(p => OPEN_STATUSES.includes(p.status)).reduce((s, p) => s + (p.valueCents || 0), 0);
    const wonValue = won.reduce((s, p) => s + (p.valueCents || 0), 0);
    return {
      total: live.length, sent: sent.length, opened: opened.length,
      totalOpens: live.reduce((s, p) => s + (p.stats?.opens ?? 0), 0),
      wonCount: won.length, wonValue, pipeline,
    };
  }, [proposals]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return proposals.filter(p =>
      (showArchived ? true : !p.archived) &&
      (!statusFilter || p.status === statusFilter) &&
      (!categoryFilter || p.category === categoryFilter) &&
      (!q || [p.title, p.company, p.category, p.owner, p.contactName, p.contactEmail, p.notes, p.sourceTag]
        .filter(Boolean).join(" ").toLowerCase().includes(q))
    );
  }, [proposals, search, statusFilter, categoryFilter, showArchived]);

  const groups = useMemo(() => {
    const map = new Map<string, Proposal[]>();
    for (const p of filtered) {
      const key = groupBy === "type" ? p.proposalType : groupBy === "status" ? p.status : (p.category || "Uncategorised");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    const arr = Array.from(map.entries()).map(([key, items]) => ({ key, items }));
    // biggest groups first, but keep a stable order for type/status by their config order
    if (groupBy === "type") arr.sort((a, b) => TYPES.findIndex(t => t.key === a.key) - TYPES.findIndex(t => t.key === b.key));
    else if (groupBy === "status") arr.sort((a, b) => STATUSES.findIndex(t => t.key === a.key) - STATUSES.findIndex(t => t.key === b.key));
    else arr.sort((a, b) => b.items.length - a.items.length);
    return arr;
  }, [filtered, groupBy]);

  const groupLabel = (key: string) =>
    groupBy === "type" ? typeCfg(key).label : groupBy === "status" ? statusCfg(key).label : key;
  const groupColor = (key: string) =>
    groupBy === "type" ? typeCfg(key).color : groupBy === "status" ? statusCfg(key).color : catColor(key);

  if (!orgId) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2"><Send className="w-5 h-5 text-blue-400" /> Proposals</h1>
            <p className="text-xs text-white/40 mt-0.5">Every proposal sent — sorted by type &amp; category, with tracked-link analytics.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-white/50 hover:text-white/80 text-xs h-8" onClick={() => setShowCatMgr(true)}>
              <Tag className="w-3.5 h-3.5 mr-1" /> Categories
            </Button>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-8"
              onClick={() => setEditing({ proposalType: "sponsorship", status: "draft", currency: "NZD", brandTags: [] })}>
              <Plus className="w-4 h-4 mr-1" /> New proposal
            </Button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mt-4">
          <Kpi label="Total" value={String(kpis.total)} icon={<Send className="w-3.5 h-3.5" />} accent="#3b82f6" />
          <Kpi label="Sent" value={String(kpis.sent)} icon={<ExternalLink className="w-3.5 h-3.5" />} accent="#0ea5e9" />
          <Kpi label="Opened" value={String(kpis.opened)} icon={<Eye className="w-3.5 h-3.5" />} accent="#a855f7" sub={`${kpis.totalOpens} total opens`} />
          <Kpi label="Won" value={String(kpis.wonCount)} icon={<Check className="w-3.5 h-3.5" />} accent="#22c55e" sub={kpis.wonValue ? fmtMoney(kpis.wonValue) : undefined} />
          <Kpi label="Pipeline" value={fmtMoney(kpis.pipeline)} icon={<TrendingUp className="w-3.5 h-3.5" />} accent="#f59e0b" sub="open value" />
          <Kpi label="Categories" value={String(categories.length)} icon={<Tag className="w-3.5 h-3.5" />} accent="#ec4899" />
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 sm:px-6 py-3 border-b border-white/[0.06] flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] border border-white/10 p-0.5">
          {(["type", "category", "status"] as const).map(g => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`text-[11px] px-2.5 py-1 rounded-md capitalize transition-colors ${groupBy === g ? "bg-blue-600 text-white" : "text-white/50 hover:text-white/80"}`}>
              {g}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search proposals…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-[13px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-blue-500/50" />
        </div>
        {/* status filter */}
        <select value={statusFilter || ""} onChange={e => setStatusFilter(e.target.value || null)}
          className="text-[11px] rounded-lg bg-white/[0.03] border border-white/10 px-2 py-1.5 text-white/70">
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {/* category filter */}
        <select value={categoryFilter || ""} onChange={e => setCategoryFilter(e.target.value || null)}
          className="text-[11px] rounded-lg bg-white/[0.03] border border-white/10 px-2 py-1.5 text-white/70">
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <button onClick={() => setShowArchived(v => !v)}
          className={`text-[11px] px-2 py-1.5 rounded-lg border ${showArchived ? "border-blue-500/40 text-blue-300 bg-blue-500/10" : "border-white/10 text-white/40"}`}>
          Archived
        </button>
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] border border-white/10 p-0.5 ml-auto">
          <button onClick={() => setLayout("table")} className={`p-1 rounded ${layout === "table" ? "bg-white/10 text-white" : "text-white/40"}`}><Rows3 className="w-3.5 h-3.5" /></button>
          <button onClick={() => setLayout("cards")} className={`p-1 rounded ${layout === "cards" ? "bg-white/10 text-white" : "text-white/40"}`}><LayoutGrid className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12 rounded-xl bg-white/[0.03]" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Send className="w-10 h-10 text-white/15 mb-3" />
            <div className="text-white/50 text-sm font-medium">No proposals yet</div>
            <div className="text-white/30 text-xs mt-1 max-w-xs">Add the ones you and Ryan have sent — La Liga, the gym partners, breweries, Core Pilates — each gets a tracked link.</div>
            <Button size="sm" className="mt-4 bg-blue-600 hover:bg-blue-500 text-white text-xs"
              onClick={() => setEditing({ proposalType: "sponsorship", status: "draft", currency: "NZD", brandTags: [] })}>
              <Plus className="w-4 h-4 mr-1" /> New proposal
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(group => (
              <div key={group.key}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: groupColor(group.key) }} />
                  <h2 className="text-sm font-semibold text-white/80">{groupLabel(group.key)}</h2>
                  <span className="text-[11px] text-white/30">{group.items.length}</span>
                </div>

                {layout === "table" ? (
                  <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                    <table className="w-full text-xs min-w-[760px]">
                      <thead>
                        <tr className="text-white/35 text-[10px] uppercase tracking-wide border-b border-white/[0.06]">
                          <th className="text-left font-medium px-3 py-2">Proposal</th>
                          <th className="text-left font-medium px-3 py-2">Category</th>
                          <th className="text-left font-medium px-3 py-2">Status</th>
                          <th className="text-right font-medium px-3 py-2">Value</th>
                          <th className="text-center font-medium px-3 py-2">Opens</th>
                          <th className="text-left font-medium px-3 py-2">Last opened</th>
                          <th className="text-left font-medium px-3 py-2">Owner</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map(p => (
                          <tr key={p.id} onClick={() => setEditing(p)}
                            className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer last:border-0">
                            <td className="px-3 py-2.5">
                              <div className="font-medium text-white/90 flex items-center gap-1.5">{p.title}
                                {p.archived && <span className="text-[9px] text-white/30 border border-white/15 rounded px-1">archived</span>}
                              </div>
                              <div className="text-[11px] text-white/40 flex items-center gap-1.5 mt-0.5">
                                {p.company && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{p.company}</span>}
                                <BrandChips tags={p.brandTags} />
                              </div>
                            </td>
                            <td className="px-3 py-2.5">{p.category ? <Pill label={p.category} color={catColor(p.category)} /> : <span className="text-white/25">—</span>}</td>
                            <td className="px-3 py-2.5"><Pill label={statusCfg(p.status).label} color={statusCfg(p.status).color} /></td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-white/80">{fmtMoney(p.valueCents)}</td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="inline-flex items-center gap-1 tabular-nums" title={`${p.stats?.uniqueOpens ?? 0} unique`}>
                                <Eye className="w-3 h-3 text-white/30" />
                                <span className={(p.stats?.opens ?? 0) > 0 ? "text-white/85" : "text-white/30"}>{p.stats?.opens ?? 0}</span>
                                {(p.stats?.uniqueOpens ?? 0) > 0 && <span className="text-white/30 text-[10px]">/{p.stats?.uniqueOpens}u</span>}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-white/50">{fmtRelative(p.stats?.lastOpen)}</td>
                            <td className="px-3 py-2.5 text-white/50">{p.owner || "—"}</td>
                            <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                              {p.shortCode && (
                                <button onClick={() => copyLink(p)} title="Copy tracked link"
                                  className="text-white/40 hover:text-blue-300 transition-colors">
                                  {copiedId === p.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.items.map(p => (
                      <div key={p.id} onClick={() => setEditing(p)}
                        className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-white/90 text-sm">{p.title}</div>
                          <Pill label={statusCfg(p.status).label} color={statusCfg(p.status).color} />
                        </div>
                        {p.company && <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-1"><Building2 className="w-3 h-3" />{p.company}</div>}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          {p.category && <Pill label={p.category} color={catColor(p.category)} />}
                          <BrandChips tags={p.brandTags} />
                        </div>
                        <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.06] text-[11px] text-white/50">
                          <span className="tabular-nums text-white/70">{fmtMoney(p.valueCents)}</span>
                          <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{p.stats?.opens ?? 0} · {fmtRelative(p.stats?.lastOpen)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ProposalDialog
          proposal={editing}
          categories={categories}
          orgId={orgId}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate(body)}
          onDelete={(id) => { if (confirm("Delete this proposal? This cannot be undone.")) remove.mutate(id); }}
          saving={save.isPending}
          trackedLink={trackedLink}
        />
      )}
      {showCatMgr && (
        <CategoryManager
          categories={categories}
          onClose={() => setShowCatMgr(false)}
          onAdd={(body) => saveCategory.mutate(body)}
        />
      )}
    </div>
  );
}

// ── Proposal create / edit / analytics dialog ───────────────────────────────
function ProposalDialog({ proposal, categories, orgId, onClose, onSave, onDelete, saving, trackedLink }: {
  proposal: Partial<Proposal>; categories: ProposalCategory[]; orgId: number;
  onClose: () => void; onSave: (b: any) => void; onDelete: (id: number) => void;
  saving: boolean; trackedLink: (p: Partial<Proposal>) => string;
}) {
  const { toast } = useToast();
  const isEdit = !!proposal.id;
  const [f, setF] = useState({
    title: proposal.title || "", company: proposal.company || "",
    proposalType: proposal.proposalType || "sponsorship", category: proposal.category || "",
    status: proposal.status || "draft", owner: proposal.owner || "",
    valueDollars: centsToDollarInput(proposal.valueCents ?? null),
    contactName: proposal.contactName || "", contactEmail: proposal.contactEmail || "",
    contactPhone: proposal.contactPhone || "", linkUrl: proposal.linkUrl || "",
    sourceTag: proposal.sourceTag || "", notes: proposal.notes || "",
    brandTags: proposal.brandTags || [], archived: proposal.archived || false,
  });
  const set = (k: string, v: any) => setF(s => ({ ...s, [k]: v }));
  const toggleBrand = (slug: string) => set("brandTags", f.brandTags.includes(slug) ? f.brandTags.filter(t => t !== slug) : [...f.brandTags, slug]);

  const submit = () => {
    if (!f.title.trim()) { toast({ title: "Add a title", variant: "destructive" }); return; }
    onSave({
      id: proposal.id, organizationId: orgId, ...f,
      valueCents: dollarInputToCents(f.valueDollars),
    });
  };

  const link = trackedLink(proposal);
  const copyLink = async () => { if (link) { await navigator.clipboard.writeText(link); toast({ title: "Copied", description: link }); } };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto p-0 gap-0 bg-[#0a0e17] border-white/10">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-white/[0.08] bg-[#0a0e17]/95 backdrop-blur">
          <div className="flex items-center gap-2">
            <Send className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold">{isEdit ? "Proposal" : "New proposal"}</span>
          </div>
          <div className="flex items-center gap-2">
            {isEdit && proposal.id && (
              <button onClick={() => onDelete(proposal.id!)} className="text-white/30 hover:text-red-400 transition-colors" title="Delete">
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
              <Label className="text-[11px] text-white/50">Title</Label>
              <input className={inputCls} value={f.title} onChange={e => set("title", e.target.value)} placeholder="e.g. La Liga × SIU partnership" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[11px] text-white/50">Company</Label>
                <input className={inputCls} value={f.company} onChange={e => set("company", e.target.value)} placeholder="Partner / prospect" />
              </div>
              <div>
                <Label className="text-[11px] text-white/50">Owner</Label>
                <input className={inputCls} value={f.owner} onChange={e => set("owner", e.target.value)} placeholder="Daniel / Ryan" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[11px] text-white/50">Type</Label>
                <select className={inputCls} value={f.proposalType} onChange={e => set("proposalType", e.target.value)}>
                  {TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-[11px] text-white/50">Category</Label>
                <input className={inputCls} list="proposal-cats" value={f.category} onChange={e => set("category", e.target.value)} placeholder="Breweries, Gyms, La Liga…" />
                <datalist id="proposal-cats">{categories.map(c => <option key={c.id} value={c.name} />)}</datalist>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[11px] text-white/50">Status</Label>
                <select className={inputCls} value={f.status} onChange={e => set("status", e.target.value)}>
                  {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-[11px] text-white/50">Deal value</Label>
                <MoneyInput value={f.valueDollars} onChange={v => set("valueDollars", v)} className={inputCls} />
              </div>
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Brands</Label>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                {BRANDS.map(b => (
                  <button key={b.slug} onClick={() => toggleBrand(b.slug)}
                    className="text-[10px] font-semibold px-2 py-1 rounded-md border transition-colors"
                    style={f.brandTags.includes(b.slug)
                      ? { background: `${b.color}22`, color: b.color, borderColor: `${b.color}66` }
                      : { borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.4)" }}>
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-[11px] text-white/50">Contact name</Label><input className={inputCls} value={f.contactName} onChange={e => set("contactName", e.target.value)} /></div>
              <div><Label className="text-[11px] text-white/50">Contact email</Label><input className={inputCls} value={f.contactEmail} onChange={e => set("contactEmail", e.target.value)} /></div>
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Proposal link (page / PDF / deck)</Label>
              <input className={inputCls} value={f.linkUrl} onChange={e => set("linkUrl", e.target.value)} placeholder="https://partner.southislandunited.com/la-liga" />
              <p className="text-[10px] text-white/30 mt-1">The real link. Send the tracked link (right) to capture opens.</p>
            </div>
            <div>
              <Label className="text-[11px] text-white/50">Notes</Label>
              <Textarea className={`${inputCls} min-h-[64px]`} value={f.notes} onChange={e => set("notes", e.target.value)} />
            </div>
            {isEdit && (
              <label className="flex items-center gap-2 text-[11px] text-white/50 pt-1">
                <input type="checkbox" checked={f.archived} onChange={e => set("archived", e.target.checked)} /> Archived
              </label>
            )}
          </div>

          {/* Right: tracked link + analytics */}
          <div className="space-y-4">
            {isEdit ? (
              <>
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-blue-300/80 font-medium mb-1.5"><Link2 className="w-3.5 h-3.5" /> Tracked link</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[11px] text-white/80 bg-black/30 rounded-lg px-2.5 py-2 truncate">{link || "—"}</code>
                    <button onClick={copyLink} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60"><Copy className="w-3.5 h-3.5" /></button>
                    {f.linkUrl && <a href={link} target="_blank" rel="noreferrer" className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60"><ExternalLink className="w-3.5 h-3.5" /></a>}
                  </div>
                  <p className="text-[10px] text-white/30 mt-1.5">Send this instead of the raw link — every open is logged below (your own opens are excluded).</p>
                </div>
                <ProposalAnalytics proposalId={proposal.id!} />
              </>
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
                <Sparkles className="w-7 h-7 text-blue-400/40 mx-auto mb-2" />
                <div className="text-sm text-white/70 font-medium">A tracked link is generated on save</div>
                <div className="text-[11px] text-white/40 mt-1">Send <code className="text-white/60">app.usg.co.nz/r/…</code> and watch opens, unique visitors, device &amp; last-seen appear here.</div>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.08] bg-[#0a0e17]/95 backdrop-blur">
          <Button variant="ghost" size="sm" className="text-white/50 text-xs" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white text-xs" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create proposal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProposalAnalytics({ proposalId }: { proposalId: number }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/proposals", proposalId, "analytics"],
    queryFn: async () => {
      const r = await fetch(`/api/admin/proposals/${proposalId}/analytics`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load analytics");
      return r.json();
    },
  });
  if (isLoading) return <Skeleton className="h-40 rounded-xl bg-white/[0.03]" />;
  const s = data?.summary || {};
  const opens = Number(s.opens || 0);
  const uniques = Number(s.unique_opens || 0);
  const cta = Number(s.cta_clicks || 0);
  const byDay: { day: string; opens: number }[] = (data?.byDay || []).map((d: any) => ({ day: d.day, opens: Number(d.opens) }));
  const maxDay = Math.max(1, ...byDay.map(d => d.opens));
  const byDevice: { device: string; n: number }[] = (data?.byDevice || []).map((d: any) => ({ device: d.device, n: Number(d.n) }));
  const byReferrer: { referrer: string; n: number }[] = (data?.byReferrer || []).map((d: any) => ({ referrer: d.referrer, n: Number(d.n) }));
  const timeline: any[] = data?.timeline || [];
  const devIcon = (d: string) => d === "mobile" ? <Smartphone className="w-3 h-3" /> : d === "tablet" ? <Tablet className="w-3 h-3" /> : d === "desktop" ? <Monitor className="w-3 h-3" /> : <Globe className="w-3 h-3" />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
          <div className="text-lg font-semibold text-white/90">{opens}</div>
          <div className="text-[10px] text-white/40 flex items-center justify-center gap-1"><Eye className="w-3 h-3" /> opens</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
          <div className="text-lg font-semibold text-white/90">{uniques}</div>
          <div className="text-[10px] text-white/40 flex items-center justify-center gap-1"><Users className="w-3 h-3" /> unique</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
          <div className="text-lg font-semibold text-white/90">{cta}</div>
          <div className="text-[10px] text-white/40 flex items-center justify-center gap-1"><MousePointerClick className="w-3 h-3" /> clicks</div>
        </div>
      </div>

      {opens === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-center text-[11px] text-white/40">
          No opens yet. Once you send the tracked link, opens and visitors show here.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] text-white/40 mb-2 flex items-center gap-1"><Clock className="w-3 h-3" /> Opens · last 30 days</div>
            <div className="flex items-end gap-0.5 h-14">
              {byDay.length === 0 ? <div className="text-[11px] text-white/30">—</div> : byDay.map(d => (
                <div key={d.day} title={`${d.day}: ${d.opens}`} className="flex-1 bg-blue-500/60 rounded-sm min-h-[2px]" style={{ height: `${(d.opens / maxDay) * 100}%` }} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
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
              <div className="text-[10px] text-white/40 mb-1.5">Sources</div>
              {byReferrer.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] text-white/60 py-0.5">
                  <span className="truncate max-w-[120px]" title={d.referrer}>{d.referrer.replace(/^https?:\/\//, "")}</span>
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
                    {e.kind === "cta_click" ? <MousePointerClick className="w-3 h-3 text-amber-400" /> : <Eye className="w-3 h-3 text-blue-400" />}
                    {e.kind === "cta_click" ? "Clicked CTA" : "Opened"}
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

// ── Category manager ────────────────────────────────────────────────────────
function CategoryManager({ categories, onClose, onAdd }: {
  categories: ProposalCategory[]; onClose: () => void; onAdd: (b: any) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [type, setType] = useState("sponsorship");
  const add = () => { if (name.trim()) { onAdd({ name: name.trim(), color, proposalType: type }); setName(""); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-[#0a0e17] border-white/10">
        <div className="flex items-center gap-2 mb-1"><Tag className="w-4 h-4 text-pink-400" /><span className="text-sm font-semibold">Categories</span></div>
        <p className="text-[11px] text-white/40 -mt-1 mb-2">Buckets to sort proposals by (Breweries, Gyms, La Liga…).</p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {categories.map(c => <Pill key={c.id} label={c.name} color={c.color} />)}
        </div>
        <div className="space-y-2 border-t border-white/[0.08] pt-3">
          <div className="flex items-center gap-2">
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="New category name" onKeyDown={e => e.key === "Enter" && add()} />
            <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-9 h-9 rounded-lg bg-transparent border border-white/10 cursor-pointer" />
          </div>
          <select className={inputCls} value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <Button size="sm" className="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs" onClick={add}><Plus className="w-4 h-4 mr-1" /> Add category</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
