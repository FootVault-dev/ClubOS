import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, X, Handshake, TrendingUp, DollarSign, Award, Filter, Check, Trash2,
  CheckCircle2, Circle, Clock, AlertCircle, Link as LinkIcon, GripVertical, ListChecks,
  Target, ExternalLink, ArrowUpRight, Search, Star, Mail, Phone,
} from "lucide-react";

// Stages mirror Daniel's existing Pipedrive flow exactly so muscle memory carries over.
const STAGES = [
  { key: "new_lead",       label: "New Lead",       color: "#64748b" },
  { key: "contact_made",   label: "Contact Made",   color: "#94a3b8" },
  { key: "qualified",      label: "Qualified",      color: "#06b6d4" },
  { key: "call_scheduled", label: "Call Scheduled", color: "#3b82f6" },
  { key: "proposal_sent",  label: "Proposal Sent",  color: "#6366f1" },
  { key: "negotiating",    label: "Negotiating",    color: "#a855f7" },
  { key: "won",            label: "Won",            color: "#22c55e" },
  { key: "lost",           label: "Lost",           color: "#ef4444" },
  { key: "contract_sent",  label: "Contract Sent",  color: "#14b8a6" },
  { key: "invoice_sent",   label: "Invoice Sent",   color: "#0ea5e9" },
  { key: "invoice_paid",   label: "Invoice Paid",   color: "#10b981" },
  { key: "onboarded",      label: "Onboarded",      color: "#84cc16" },
  { key: "active",         label: "Active",         color: "#22c55e" },
] as const;
type StageKey = typeof STAGES[number]["key"];

const BRANDS = [
  { slug: "cufc",       label: "CUFC",       color: "#3b82f6" },
  { slug: "siu",        label: "SIU",        color: "#8b5cf6" },
  { slug: "mfl",        label: "MFL",        color: "#06b6d4" },
  { slug: "cic",        label: "CIC",        color: "#a855f7" },
  { slug: "usc",        label: "USC",        color: "#22c55e" },
  { slug: "gymnastics", label: "Gymnastics", color: "#ec4899" },
  { slug: "academy",    label: "Academy",    color: "#f59e0b" },
  { slug: "print",      label: "Print",      color: "#f97316" },
];

const ASSET_CATEGORIES = ["kit","stadium","matchday","led","digital","hospitality","content","community","tournament","other"];
const SOURCES = ["inbound","referral","cold_outreach","warm_intro","event","renewal","agency","other"];

interface SponsorshipDeal {
  id: number;
  organizationId: number;
  title: string;
  sponsorCompany: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  stage: StageKey;
  stageChangedAt: string;
  dealValueCents: number;
  contraValueCents: number;
  dealType: "cash" | "contra" | "hybrid";
  currency: string;
  brandTags: string[];
  assetCategory: string | null;
  termMonths: number | null;
  startDate: string | null;
  endDate: string | null;
  exclusivity: string | null;
  ownerId: number | null;
  source: string | null;
  probability: number;
  expectedCloseDate: string | null;
  notes: string | null;
}
interface PipelineSummary {
  totalAcvCents: number;
  totalContraCents: number;
  wonYtdCents: number;
  openPipelineCents: number;
  weightedPipelineCents: number;
  byStage: Record<string, { count: number; valueCents: number }>;
  count: number;
}
interface TeamMember { id: number; first_name: string; last_name: string; email: string; }

const fmtMoney = (cents: number) => {
  if (!cents) return "$0";
  if (cents >= 1_000_000_00) return `$${(cents / 1_000_000_00).toFixed(2)}M`;
  if (cents >= 100_000_00) return `$${Math.round(cents / 100000)}k`;
  if (cents >= 10_00 * 100) return `$${(cents / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
  return `$${(cents / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
};
const fmtMoneyFull = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0, minimumFractionDigits: 0 })}`;

export default function GroupSponsorship() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<"all" | "mine">("all");
  const [dealModal, setDealModal] = useState<{ mode: "create" | "edit"; deal?: Partial<SponsorshipDeal> } | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<StageKey | null>(null);
  const [view, setView] = useState<"pipeline" | "prospects" | "deliverables" | "onboarding" | "billboards">("pipeline");

  const { data: me } = useQuery<{ id: number }>({ queryKey: ["/api/auth/me"] });

  const { data: summary } = useQuery<PipelineSummary>({
    queryKey: ["/api/admin/sponsorship/summary", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/summary?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: deals = [], isLoading: dealsLoading } = useQuery<SponsorshipDeal[]>({
    queryKey: ["/api/admin/sponsorship/deals", { orgId, brand: brandFilter, owner: ownerFilter, meId: me?.id }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("organizationId", String(orgId));
      if (brandFilter) params.set("brand", brandFilter);
      if (ownerFilter === "mine" && me?.id) params.set("ownerId", String(me.id));
      const r = await fetch(`/api/admin/sponsorship/deals?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: team = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/admin/projects/team", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/projects/team?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!orgId,
  });

  const saveDeal = useMutation({
    mutationFn: async ({ id, payload }: { id?: number; payload: any }) => {
      if (id) {
        const r = await apiRequest("PATCH", `/api/admin/sponsorship/deals/${id}`, payload);
        return r.json();
      }
      const r = await apiRequest("POST", "/api/admin/sponsorship/deals", { ...payload, organizationId: orgId });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/summary", orgId] });
      setDealModal(null);
      toast({ title: "Deal saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const deleteDeal = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/sponsorship/deals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/summary", orgId] });
      setDealModal(null);
      toast({ title: "Deal deleted" });
    },
  });

  const dealsByStage = useMemo(() => {
    const m = new Map<StageKey, SponsorshipDeal[]>();
    for (const s of STAGES) m.set(s.key, []);
    for (const d of deals) m.get(d.stage)?.push(d);
    return m;
  }, [deals]);

  if (!orgId) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2"><Handshake className="w-5 h-5 text-blue-400" /> Sponsorship</h1>
            <p className="text-xs text-white/40 mt-0.5">Pipeline · revenue · deliverables across {currentOrg?.name}</p>
          </div>
          <Button onClick={() => setDealModal({ mode: "create" })} data-testid="button-new-deal" className="bg-blue-600 hover:bg-blue-700 text-white">
            <Plus className="w-4 h-4 mr-1.5" /> New deal
          </Button>
        </div>

        {/* Sub-nav */}
        <div className="flex items-center gap-1 mt-4 border-b border-white/[0.06] -mb-4">
          {([
            { key: "pipeline",     label: "Pipeline",     icon: TrendingUp },
            { key: "prospects",    label: "Prospects",    icon: Target },
            { key: "deliverables", label: "Deliverables", icon: ListChecks },
            { key: "onboarding",   label: "Onboarding",   icon: CheckCircle2 },
            { key: "billboards",   label: "Billboards",   icon: DollarSign },
          ] as const).map(t => {
            const Icon = t.icon;
            const active = view === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                data-testid={`tab-${t.key}`}
                className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors ${
                  active
                    ? "text-white border-blue-500"
                    : "text-white/50 hover:text-white/80 border-transparent"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        {view === "pipeline" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <Kpi label="Open pipeline" value={summary ? fmtMoneyFull(summary.openPipelineCents) : "—"} icon={<TrendingUp className="w-4 h-4" />} accent="#3b82f6" />
          <Kpi label="Weighted pipeline" value={summary ? fmtMoneyFull(summary.weightedPipelineCents) : "—"} icon={<TrendingUp className="w-4 h-4" />} accent="#a855f7" sub="× probability" />
          <Kpi label="Booked ACV" value={summary ? fmtMoneyFull(summary.totalAcvCents) : "—"} icon={<DollarSign className="w-4 h-4" />} accent="#22c55e" sub={summary && summary.totalContraCents > 0 ? `+ ${fmtMoneyFull(summary.totalContraCents)} contra` : undefined} />
          <Kpi label="Won YTD" value={summary ? fmtMoneyFull(summary.wonYtdCents) : "—"} icon={<Award className="w-4 h-4" />} accent="#f59e0b" />
        </div>
        )}

        {view === "pipeline" && (
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <button
            onClick={() => setOwnerFilter(ownerFilter === "mine" ? "all" : "mine")}
            data-testid="button-filter-mine"
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border transition flex items-center ${
              ownerFilter === "mine"
                ? "bg-blue-500/15 border-blue-500/40 text-blue-300"
                : "bg-transparent border-white/10 text-white/50 hover:text-white hover:border-white/20"
            }`}
          >
            <Filter className="w-3 h-3 mr-1" />
            {ownerFilter === "mine" ? "My deals" : "All deals"}
          </button>
          {brandFilter && (
            <button onClick={() => setBrandFilter(null)} className="text-[10px] px-2 py-1 rounded-md border border-white/10 text-white/50 hover:text-white">Clear brand</button>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {BRANDS.map(b => {
              const active = brandFilter === b.slug;
              return (
                <button
                  key={b.slug}
                  onClick={() => setBrandFilter(active ? null : b.slug)}
                  data-testid={`chip-brand-${b.slug}`}
                  className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                  style={{
                    borderColor: active ? b.color : "hsl(var(--foreground) / 0.085)",
                    background: active ? `${b.color}25` : "transparent",
                    color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.82)",
                  }}
                >{b.label}</button>
              );
            })}
          </div>
          <span className="text-[10px] text-white/30 ml-auto">{deals.length} deal{deals.length === 1 ? "" : "s"}</span>
        </div>
        )}
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-auto">
        {view === "prospects" && orgId && <ProspectsView orgId={orgId} />}
        {view === "deliverables" && orgId && <CrossDeliverablesView orgId={orgId} team={team} category="contract" />}
        {view === "onboarding" && orgId && <OnboardingMatrixView orgId={orgId} team={team} deals={deals} />}
        {view === "billboards" && orgId && <BillboardsView orgId={orgId} team={team} currentUserId={me?.id} />}
        {view === "pipeline" && (dealsLoading ? (
          <div className="flex gap-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="w-72 h-96 rounded-xl flex-shrink-0" />)}
          </div>
        ) : (
          <div className="flex gap-3 p-4 min-w-max">
            {STAGES.map(s => {
              const items = dealsByStage.get(s.key) || [];
              const totalCents = items.reduce((sum, d) => sum + (d.dealValueCents || 0), 0);
              const isDropTarget = dropTarget === s.key;
              return (
                <div
                  key={s.key}
                  className={`w-72 flex-shrink-0 flex flex-col rounded-xl border transition-colors ${
                    isDropTarget ? "border-blue-500/50 bg-blue-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]"
                  }`}
                  onDragOver={e => { e.preventDefault(); setDropTarget(s.key); }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={e => {
                    e.preventDefault();
                    setDropTarget(null);
                    if (draggingId == null) return;
                    const d = deals.find(x => x.id === draggingId);
                    if (!d || d.stage === s.key) return;
                    saveDeal.mutate({ id: draggingId, payload: { stage: s.key } });
                    setDraggingId(null);
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                      <span className="text-sm font-semibold truncate">{s.label}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-white/40 flex-shrink-0">
                      <span>{items.length}</span>
                      {totalCents > 0 && <span className="text-white/60 font-medium">{fmtMoney(totalCents)}</span>}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[80px]">
                    {items.length === 0 ? (
                      <button
                        onClick={() => setDealModal({ mode: "create", deal: { stage: s.key } })}
                        className="w-full text-[11px] text-white/30 hover:text-white/50 italic py-3 rounded border border-dashed border-white/10"
                      >
                        {isDropTarget ? "Drop here" : "+ Add deal"}
                      </button>
                    ) : items.map(d => (
                      <div
                        key={d.id}
                        draggable
                        onDragStart={e => { setDraggingId(d.id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
                        style={{ opacity: draggingId === d.id ? 0.4 : 1 }}
                      >
                        <DealCard deal={d} team={team} onClick={() => setDealModal({ mode: "edit", deal: d })} highlightMine={d.ownerId === me?.id} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {dealModal && (
        <DealModal
          mode={dealModal.mode}
          deal={dealModal.deal}
          team={team}
          onClose={() => setDealModal(null)}
          onSave={(payload) => saveDeal.mutate({ id: dealModal.deal?.id, payload })}
          onDelete={dealModal.deal?.id ? () => deleteDeal.mutate(dealModal.deal!.id!) : undefined}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, icon, accent, sub }: { label: string; value: string; icon: React.ReactNode; accent: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/40 mb-1.5">
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </div>
      <div className="text-lg font-semibold text-white tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-white/40 mt-0.5">{sub}</div>}
    </div>
  );
}

function DealCard({ deal, team, onClick, highlightMine }: { deal: SponsorshipDeal; team: TeamMember[]; onClick: () => void; highlightMine?: boolean }) {
  const owner = team.find(m => m.id === deal.ownerId);
  const closeDate = deal.expectedCloseDate ? new Date(deal.expectedCloseDate + "T00:00:00") : null;
  const today = new Date(); today.setHours(0,0,0,0);
  const daysToClose = closeDate ? Math.ceil((closeDate.getTime() - today.getTime()) / (1000*60*60*24)) : null;

  return (
    <button
      onClick={onClick}
      data-testid={`card-deal-${deal.id}`}
      className="w-full text-left rounded-lg p-2.5 border transition-all hover:border-white/15"
      style={{
        borderColor: highlightMine ? "rgba(59,130,246,0.4)" : "hsl(var(--foreground) / 0.067)",
        background: highlightMine ? "rgba(59,130,246,0.05)" : "hsl(var(--foreground) / 0.02)",
        boxShadow: highlightMine ? "0 0 0 1px rgba(59,130,246,0.3)" : undefined,
      }}
    >
      <div className="text-xs font-semibold text-white truncate mb-0.5">{deal.sponsorCompany}</div>
      <div className="text-[10px] text-white/50 truncate mb-1.5">{deal.title}</div>
      <div className="flex items-center gap-1.5 mb-1.5">
        {(deal.dealValueCents > 0 || deal.contraValueCents === 0) && (
          <span className="text-[11px] font-semibold text-green-400 tabular-nums">{fmtMoney(deal.dealValueCents)}</span>
        )}
        {deal.contraValueCents > 0 && (
          <span className="text-[10px] font-medium text-orange-300 tabular-nums">+ {fmtMoney(deal.contraValueCents)} contra</span>
        )}
      </div>
      {deal.brandTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {deal.brandTags.slice(0, 3).map(slug => {
            const b = BRANDS.find(x => x.slug === slug);
            return <span key={slug} className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${b?.color || "#64748b"}20`, color: b?.color || "#64748b" }}>{b?.label || slug}</span>;
          })}
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-white/40">
        {owner ? (
          <span className="flex items-center gap-1">
            <span className="w-4 h-4 rounded-full bg-white/[0.08] flex items-center justify-center text-[8px] font-semibold text-white/70">
              {owner.first_name[0]}{owner.last_name[0]}
            </span>
            <span>{owner.first_name}</span>
          </span>
        ) : <span className="italic">Unassigned</span>}
        {daysToClose !== null && (
          <span className={daysToClose < 0 ? "text-red-400" : daysToClose < 14 ? "text-amber-300" : "text-white/40"}>
            {daysToClose < 0 ? `${-daysToClose}d overdue` : daysToClose === 0 ? "today" : `${daysToClose}d`}
          </span>
        )}
      </div>
    </button>
  );
}

function DealModal({ mode, deal, team, onClose, onSave, onDelete }: {
  mode: "create" | "edit";
  deal?: Partial<SponsorshipDeal>;
  team: TeamMember[];
  onClose: () => void;
  onSave: (payload: any) => void;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(deal?.title || "");
  const [sponsorCompany, setSponsorCompany] = useState(deal?.sponsorCompany || "");
  const [stage, setStage] = useState<StageKey>((deal?.stage as StageKey) || "new_lead");
  const [dealType, setDealType] = useState<"cash" | "contra" | "hybrid">(deal?.dealType || "cash");
  const [dealValue, setDealValue] = useState(deal?.dealValueCents != null && deal.dealValueCents > 0 ? (deal.dealValueCents / 100).toString() : "");
  const [contraValue, setContraValue] = useState(deal?.contraValueCents != null && deal.contraValueCents > 0 ? (deal.contraValueCents / 100).toString() : "");
  const [brandTags, setBrandTags] = useState<string[]>(deal?.brandTags || []);
  const [assetCategory, setAssetCategory] = useState(deal?.assetCategory || "");
  const [ownerId, setOwnerId] = useState<number | null>(deal?.ownerId ?? null);
  const [contactName, setContactName] = useState(deal?.primaryContactName || "");
  const [contactEmail, setContactEmail] = useState(deal?.primaryContactEmail || "");
  const [contactPhone, setContactPhone] = useState(deal?.primaryContactPhone || "");
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal?.expectedCloseDate || "");
  const [startDate, setStartDate] = useState(deal?.startDate || "");
  const [endDate, setEndDate] = useState(deal?.endDate || "");
  const [termMonths, setTermMonths] = useState(deal?.termMonths != null ? String(deal.termMonths) : "");
  const [exclusivity, setExclusivity] = useState(deal?.exclusivity || "");
  const [source, setSource] = useState(deal?.source || "");
  const [probability, setProbability] = useState(deal?.probability != null ? String(deal.probability) : "");
  const [notes, setNotes] = useState(deal?.notes || "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = () => {
    if (!sponsorCompany.trim()) return;
    onSave({
      title: title.trim() || `${sponsorCompany.trim()} sponsorship`,
      sponsorCompany: sponsorCompany.trim(),
      stage,
      dealType,
      dealValueCents: dealValue ? Math.round(parseFloat(dealValue) * 100) : 0,
      contraValueCents: contraValue ? Math.round(parseFloat(contraValue) * 100) : 0,
      brandTags,
      assetCategory: assetCategory || null,
      ownerId,
      primaryContactName: contactName || null,
      primaryContactEmail: contactEmail || null,
      primaryContactPhone: contactPhone || null,
      expectedCloseDate: expectedCloseDate || null,
      startDate: startDate || null,
      endDate: endDate || null,
      termMonths: termMonths ? parseInt(termMonths) : null,
      exclusivity: exclusivity || null,
      source: source || null,
      probability: probability ? parseInt(probability) : undefined,
      notes: notes || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in duration-150" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-200 max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Handshake className="w-4 h-4 text-blue-400" />
            {mode === "create" ? "New deal" : "Edit deal"}
          </h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Sponsor company *</Label>
              <Input value={sponsorCompany} onChange={e => setSponsorCompany(e.target.value)} placeholder="e.g. NPD Fuel" autoFocus className="bg-white/[0.04] border-white/10 text-white" data-testid="input-sponsor-company" />
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Deal title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Front-of-shirt 2026-2027" className="bg-white/[0.04] border-white/10 text-white" />
            </div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Stage</Label>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map(s => {
                const active = stage === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStage(s.key)}
                    data-testid={`stage-${s.key}`}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
                    style={{
                      borderColor: active ? s.color : "hsl(var(--foreground) / 0.085)",
                      background: active ? `${s.color}25` : "transparent",
                      color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)",
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Deal type</Label>
              <select value={dealType} onChange={e => setDealType(e.target.value as any)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                <option value="cash">Cash</option>
                <option value="contra">Contra</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Cash value (NZD)</Label>
              <Input type="number" min="0" step="100" value={dealValue} onChange={e => setDealValue(e.target.value)} placeholder="0" className="bg-white/[0.04] border-white/10 text-white h-9" />
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Contra value (NZD)</Label>
              <Input type="number" min="0" step="100" value={contraValue} onChange={e => setContraValue(e.target.value)} placeholder="0" className="bg-white/[0.04] border-white/10 text-white h-9" />
            </div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Brand</Label>
            <div className="flex flex-wrap gap-1.5">
              {BRANDS.map(b => {
                const active = brandTags.includes(b.slug);
                return (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => setBrandTags(prev => active ? prev.filter(x => x !== b.slug) : [...prev, b.slug])}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
                    style={{
                      borderColor: active ? b.color : "hsl(var(--foreground) / 0.085)",
                      background: active ? `${b.color}25` : "transparent",
                      color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)",
                    }}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Asset category</Label>
              <select value={assetCategory} onChange={e => setAssetCategory(e.target.value)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm capitalize">
                <option value="">—</option>
                {ASSET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Owner</Label>
              <select value={ownerId ?? ""} onChange={e => setOwnerId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                <option value="">Unassigned</option>
                {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Primary contact</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Name" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
              <Input value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Email" type="email" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
              <Input value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="Phone" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Term & dates</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Start</Label>
                <DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" />
              </div>
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">End</Label>
                <DatePickerInput value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" />
              </div>
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Term (months)</Label>
                <Input type="number" min="1" value={termMonths} onChange={e => setTermMonths(e.target.value)} placeholder="12" className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" />
              </div>
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Expected close</Label>
                <DatePickerInput value={expectedCloseDate} onChange={e => setExpectedCloseDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Source</Label>
              <select value={source} onChange={e => setSource(e.target.value)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm capitalize">
                <option value="">—</option>
                {SOURCES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Probability % <span className="text-white/30">(auto-set by stage)</span></Label>
              <Input type="number" min="0" max="100" value={probability} onChange={e => setProbability(e.target.value)} placeholder="auto" className="bg-white/[0.04] border-white/10 text-white h-9" />
            </div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1 block">Exclusivity</Label>
            <Input value={exclusivity} onChange={e => setExclusivity(e.target.value)} placeholder="e.g. Category exclusive — Insurance (excluding life insurance)" className="bg-white/[0.04] border-white/10 text-white" />
            <p className="text-[10px] text-white/30 mt-1">The single biggest source of sponsorship disputes. Be specific.</p>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1 block">Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Decision-maker, budget cycle, key competitors, last interaction…" className="bg-white/[0.04] border-white/10 text-white min-h-[70px]" />
          </div>

          {mode === "edit" && deal?.id && (
            <DeliverablesSection dealId={deal.id} team={team} />
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div>
            {onDelete && (
              confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-white/60">Delete deal?</span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} className="text-white/50 h-7 text-xs px-2">Cancel</Button>
                  <Button size="sm" onClick={onDelete} className="bg-red-600 hover:bg-red-700 text-white h-7 text-xs px-2"><Trash2 className="w-3 h-3 mr-1" /> Delete</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                </Button>
              )
            )}
          </div>
          {!confirmDelete && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50">Cancel</Button>
              <Button size="sm" onClick={submit} disabled={!sponsorCompany.trim()} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-deal">
                <Check className="w-3.5 h-3.5 mr-1" /> {mode === "create" ? "Create deal" : "Save"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Deliverables section inside the deal modal ─────────────────────────────
interface SponsorshipDeliverable {
  id: number;
  dealId: number;
  title: string;
  type: string | null;
  triggerType: "once" | "per_match" | "weekly" | "monthly" | "quarterly" | "annually";
  scheduledDate: string | null;
  entitlementQty: number | null;
  usedQty: number | null;
  status: "pending" | "in_progress" | "delivered" | "overdue" | "waived";
  ownerId: number | null;
  proofUrl: string | null;
  deliveredAt: string | null;
  notes: string | null;
}

const DELIVERABLE_TYPES = [
  "led_rotation", "social_post", "kit_branding", "stadium_signage",
  "matchday_pa", "hospitality_seats", "content_feature", "newsletter_mention",
  "training_kit", "community_event", "other",
];

const STATUS_CONFIG: Record<SponsorshipDeliverable["status"], { label: string; color: string; icon: any }> = {
  pending:     { label: "Pending",     color: "#64748b", icon: Circle },
  in_progress: { label: "In progress", color: "#3b82f6", icon: Clock },
  delivered:   { label: "Delivered",   color: "#22c55e", icon: CheckCircle2 },
  overdue:     { label: "Overdue",     color: "#ef4444", icon: AlertCircle },
  waived:      { label: "Waived",      color: "#94a3b8", icon: X },
};

function DeliverablesSection({ dealId, team }: { dealId: number; team: TeamMember[] }) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const { data: items = [], isLoading } = useQuery<SponsorshipDeliverable[]>({
    queryKey: ["/api/admin/sponsorship/deliverables", dealId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/deals/${dealId}/deliverables`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const create = useMutation({
    mutationFn: async (payload: any) => {
      const r = await apiRequest("POST", `/api/admin/sponsorship/deals/${dealId}/deliverables`, payload);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables", dealId] });
      setAdding(false);
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/sponsorship/deliverables/${id}`, patch);
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables", dealId] }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/sponsorship/deliverables/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables", dealId] }),
  });

  const counts = useMemo(() => {
    const total = items.length;
    const delivered = items.filter(i => i.status === "delivered" || i.status === "waived").length;
    const overdue = items.filter(i => {
      if (i.status === "delivered" || i.status === "waived") return false;
      if (!i.scheduledDate) return false;
      return new Date(i.scheduledDate + "T00:00:00") < new Date(new Date().toDateString());
    }).length;
    return { total, delivered, overdue };
  }, [items]);

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold">Deliverables</span>
          {counts.total > 0 && (
            <span className="text-[10px] text-white/40">
              {counts.delivered}/{counts.total} delivered
              {counts.overdue > 0 && <span className="text-red-400 ml-1.5">· {counts.overdue} overdue</span>}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)} className="h-7 text-xs">
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>

      {isLoading ? (
        <div className="text-[11px] text-white/30 italic py-2">Loading…</div>
      ) : items.length === 0 && !adding ? (
        <div className="text-[11px] text-white/30 italic py-2">
          No deliverables yet. Add what you've promised the sponsor (LED rotations, social posts, hospitality seats, etc.).
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map(d => (
            <DeliverableRow
              key={d.id}
              item={d}
              team={team}
              onUpdate={(patch) => update.mutate({ id: d.id, patch })}
              onDelete={() => remove.mutate(d.id)}
            />
          ))}
        </div>
      )}

      {adding && (
        <DeliverableForm
          team={team}
          onSubmit={(payload) => create.mutate(payload)}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function DeliverableRow({ item, team, onUpdate, onDelete }: {
  item: SponsorshipDeliverable;
  team: TeamMember[];
  onUpdate: (patch: any) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [proofUrl, setProofUrl] = useState(item.proofUrl || "");
  const owner = team.find(m => m.id === item.ownerId);
  const sched = item.scheduledDate ? new Date(item.scheduledDate + "T00:00:00") : null;
  const today = new Date(); today.setHours(0,0,0,0);
  const isOverdue = sched && sched < today && item.status !== "delivered" && item.status !== "waived";
  const effectiveStatus = isOverdue && item.status === "pending" ? "overdue" : item.status;
  const cfg = STATUS_CONFIG[effectiveStatus];
  const StatusIcon = cfg.icon;

  const cycleStatus = () => {
    const order: SponsorshipDeliverable["status"][] = ["pending", "in_progress", "delivered"];
    const i = order.indexOf(item.status);
    const next = order[(i + 1) % order.length];
    onUpdate({ status: next });
  };

  return (
    <div className="rounded-md border border-white/[0.04] bg-white/[0.01]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={cycleStatus}
          className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center transition hover:bg-white/[0.06]"
          style={{ color: cfg.color }}
          title={cfg.label}
        >
          <StatusIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex-1 text-left min-w-0"
        >
          <div className={`text-xs font-medium truncate ${item.status === "delivered" || item.status === "waived" ? "line-through text-white/40" : "text-white"}`}>
            {item.title}
          </div>
          <div className="text-[10px] text-white/40 flex items-center gap-1.5 truncate">
            {item.type && <span>{item.type.replace(/_/g, " ")}</span>}
            {item.entitlementQty != null && item.entitlementQty > 1 && (
              <span>· {item.usedQty || 0}/{item.entitlementQty}</span>
            )}
            {sched && (
              <span className={isOverdue ? "text-red-400" : ""}>· {sched.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>
            )}
            {owner && <span>· {owner.first_name}</span>}
            {item.proofUrl && <LinkIcon className="w-2.5 h-2.5 text-blue-400 flex-shrink-0" />}
          </div>
        </button>
        <button onClick={onDelete} className="w-5 h-5 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center" title="Remove">
          <X className="w-3 h-3" />
        </button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-white/[0.04] space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <select
              value={item.status}
              onChange={e => onUpdate({ status: e.target.value })}
              className="text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7"
            >
              {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{STATUS_CONFIG[s as keyof typeof STATUS_CONFIG].label}</option>)}
            </select>
            <select
              value={item.ownerId ?? ""}
              onChange={e => onUpdate({ ownerId: e.target.value ? parseInt(e.target.value) : null })}
              className="text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7"
            >
              <option value="">Unassigned</option>
              {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
            </select>
          </div>
          <DatePickerInput
            value={item.scheduledDate || ""}
            onChange={e => onUpdate({ scheduledDate: e.target.value || null })}
            className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]"
          />
          {item.entitlementQty != null && item.entitlementQty > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/40">Used</span>
              <Input
                type="number"
                min="0"
                max={item.entitlementQty}
                value={item.usedQty ?? 0}
                onChange={e => onUpdate({ usedQty: parseInt(e.target.value || "0") })}
                className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px] w-16"
              />
              <span className="text-[10px] text-white/40">/ {item.entitlementQty}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="Proof URL (photo / social link / signed manifest)"
              value={proofUrl}
              onChange={e => setProofUrl(e.target.value)}
              onBlur={() => { if (proofUrl !== (item.proofUrl || "")) onUpdate({ proofUrl: proofUrl || null }); }}
              className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]"
            />
            {item.proofUrl && (
              <a href={item.proofUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">
                <LinkIcon className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DeliverableForm({ team, onSubmit, onCancel }: {
  team: TeamMember[];
  onSubmit: (payload: any) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [entitlementQty, setEntitlementQty] = useState("1");
  const [ownerId, setOwnerId] = useState<number | null>(null);

  return (
    <div className="mt-2 rounded-md border border-blue-500/20 bg-blue-500/[0.03] p-2 space-y-1.5">
      <Input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && title.trim()) onSubmit({ title: title.trim(), type: type || null, scheduledDate: scheduledDate || null, entitlementQty: parseInt(entitlementQty) || 1, ownerId }); }}
        placeholder="What did we promise? e.g. LED rotation 30s, half-time"
        className="bg-white/[0.04] border-white/10 text-white h-8 text-xs"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <select value={type} onChange={e => setType(e.target.value)} className="text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7 capitalize">
          <option value="">Type…</option>
          {DELIVERABLE_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <DatePickerInput value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]" />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Input type="number" min="1" value={entitlementQty} onChange={e => setEntitlementQty(e.target.value)} placeholder="Qty (e.g. 20 seats)" className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]" />
        <select value={ownerId ?? ""} onChange={e => setOwnerId(e.target.value ? parseInt(e.target.value) : null)} className="text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7">
          <option value="">Unassigned</option>
          {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs text-white/50">Cancel</Button>
        <Button size="sm" onClick={() => { if (title.trim()) onSubmit({ title: title.trim(), type: type || null, scheduledDate: scheduledDate || null, entitlementQty: parseInt(entitlementQty) || 1, ownerId }); }} disabled={!title.trim()} className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white">
          Add
        </Button>
      </div>
    </div>
  );
}

// ── Cross-deal deliverables view ────────────────────────────────────────────
// Every contract deliverable across every active deal in one scrollable list.
// "Are we delivering everything we promised across all sponsors right now?"
function CrossDeliverablesView({ orgId, team, category }: { orgId: number; team: TeamMember[]; category: string }) {
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "overdue" | "delivered">("open");
  const { data: rows = [], isLoading } = useQuery<Array<SponsorshipDeliverable & { deal: SponsorshipDeal | null }>>({
    queryKey: ["/api/admin/sponsorship/deliverables-all", orgId, category],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/deliverables-all?organizationId=${orgId}&category=${category}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/sponsorship/deliverables/${id}`, patch);
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables-all"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/sponsorship/deliverables/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables-all"] }),
  });

  const today = new Date(); today.setHours(0,0,0,0);
  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (statusFilter === "all") return true;
      if (statusFilter === "delivered") return r.status === "delivered" || r.status === "waived";
      if (statusFilter === "overdue") {
        if (r.status === "delivered" || r.status === "waived") return false;
        if (!r.scheduledDate) return false;
        return new Date(r.scheduledDate + "T00:00:00") < today;
      }
      // open
      return r.status !== "delivered" && r.status !== "waived";
    });
  }, [rows, statusFilter]);

  const counts = useMemo(() => {
    const open = rows.filter(r => r.status !== "delivered" && r.status !== "waived").length;
    const delivered = rows.filter(r => r.status === "delivered" || r.status === "waived").length;
    const overdue = rows.filter(r => r.status !== "delivered" && r.status !== "waived" && r.scheduledDate && new Date(r.scheduledDate + "T00:00:00") < today).length;
    return { total: rows.length, open, delivered, overdue };
  }, [rows]);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {([
          { key: "open",      label: `Open (${counts.open})`,         color: "#3b82f6" },
          { key: "overdue",   label: `Overdue (${counts.overdue})`,   color: "#ef4444" },
          { key: "delivered", label: `Delivered (${counts.delivered})`, color: "#22c55e" },
          { key: "all",       label: `All (${counts.total})`,         color: "#94a3b8" },
        ] as const).map(t => {
          const active = statusFilter === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setStatusFilter(t.key)}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
              style={{
                borderColor: active ? t.color : "hsl(var(--foreground) / 0.085)",
                background: active ? `${t.color}25` : "transparent",
                color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.82)",
              }}
            >{t.label}</button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="text-sm text-white/30 py-12 text-center">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
          <ListChecks className="w-10 h-10 text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/40 mb-1">
            {category === "contract" ? "No contract deliverables yet" : "No items"}
          </p>
          <p className="text-xs text-white/30">
            Open any deal and add what you've promised — front-of-shirt, social posts, hospitality seats, signage, etc. They'll show up here.
          </p>
        </div>
      ) : (
        <DeliverablesGroupedBySponsor
          rows={filtered}
          team={team}
          today={today}
          onUpdate={(id, patch) => update.mutate({ id, patch })}
          onDelete={(id) => remove.mutate(id)}
        />
      )}
    </div>
  );
}

// Grouped-by-sponsor renderer for the Deliverables tab. Table-row layout
// like the Onboarding tab — one row per sponsor with a colour-coded
// completion %. Click a row to expand and edit the deliverables underneath.
function DeliverablesGroupedBySponsor({
  rows, team, today, onUpdate, onDelete,
}: {
  rows: Array<SponsorshipDeliverable & { deal: SponsorshipDeal | null }>;
  team: TeamMember[];
  today: Date;
  onUpdate: (id: number, patch: any) => void;
  onDelete?: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState<number | null>(null);

  const createMutation = useMutation({
    mutationFn: async ({ dealId, payload }: { dealId: number; payload: any }) => {
      const r = await apiRequest("POST", `/api/admin/sponsorship/deals/${dealId}/deliverables`, { ...payload, category: "contract" });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables-all"] });
      setAdding(null);
    },
  });

  const groups = useMemo(() => {
    const m = new Map<number, { deal: SponsorshipDeal | null; items: typeof rows }>();
    for (const r of rows) {
      if (!m.has(r.dealId)) m.set(r.dealId, { deal: r.deal, items: [] });
      m.get(r.dealId)!.items.push(r);
    }
    return Array.from(m.values()).sort((a, b) =>
      (a.deal?.sponsorCompany || "").localeCompare(b.deal?.sponsorCompany || "")
    );
  }, [rows]);

  const toggle = (dealId: number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(dealId)) next.delete(dealId); else next.add(dealId);
    return next;
  });

  if (groups.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold w-8"></th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold">Sponsor</th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold">Stage</th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold">Brand</th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold">Done</th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold">Overdue</th>
            <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold w-[200px]">Progress</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => {
            if (!g.deal) return null;
            const total = g.items.length;
            const delivered = g.items.filter(i => i.status === "delivered" || i.status === "waived").length;
            const overdueCount = g.items.filter(i => {
              if (i.status === "delivered" || i.status === "waived") return false;
              if (!i.scheduledDate) return false;
              return new Date(i.scheduledDate + "T00:00:00") < today;
            }).length;
            const pct = total > 0 ? Math.round((delivered / total) * 100) : 0;
            // Red <40% · Amber 40-79% · Green 80%+
            const pctColor = pct >= 80 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
            const pctBg    = pct >= 80 ? "rgba(34,197,94,0.15)" : pct >= 40 ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)";
            const stage = STAGES.find(s => s.key === g.deal!.stage);
            const isExpanded = expanded.has(g.deal.id);

            return (
              <FragmentRows
                key={g.deal.id}
                deal={g.deal}
                items={g.items}
                team={team}
                today={today}
                isExpanded={isExpanded}
                isAdding={adding === g.deal.id}
                stage={stage}
                pct={pct}
                pctColor={pctColor}
                pctBg={pctBg}
                delivered={delivered}
                total={total}
                overdueCount={overdueCount}
                onToggle={() => toggle(g.deal!.id)}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onAddRequested={() => setAdding(g.deal!.id)}
                onAddCancelled={() => setAdding(null)}
                onAddSubmit={(payload) => createMutation.mutate({ dealId: g.deal!.id, payload })}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRows({
  deal, items, team, today, isExpanded, isAdding, stage, pct, pctColor, pctBg,
  delivered, total, overdueCount, onToggle, onUpdate, onDelete,
  onAddRequested, onAddCancelled, onAddSubmit,
}: any) {
  return (
    <>
      <tr className="hover:bg-white/[0.02] cursor-pointer transition-colors" onClick={onToggle}>
        <td className="px-3 py-2.5 border-b border-white/[0.04] text-white/30">
          {isExpanded ? <ChevronDownInline /> : <ChevronRightInline />}
        </td>
        <td className="px-3 py-2.5 border-b border-white/[0.04]">
          <div className="font-semibold text-white truncate">{deal.sponsorCompany}</div>
          {deal.title && deal.title !== deal.sponsorCompany && (
            <div className="text-[10px] text-white/40 truncate">{deal.title}</div>
          )}
        </td>
        <td className="px-3 py-2.5 border-b border-white/[0.04]">
          {stage && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium" style={{ color: stage.color }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: stage.color }} />
              {stage.label}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 border-b border-white/[0.04]">
          <div className="flex gap-1 flex-wrap">
            {(deal.brandTags || []).slice(0, 3).map((slug: string) => {
              const b = BRANDS.find(x => x.slug === slug);
              return <span key={slug} className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${b?.color || "#64748b"}20`, color: b?.color || "#64748b" }}>{b?.label || slug}</span>;
            })}
          </div>
        </td>
        <td className="px-3 py-2.5 border-b border-white/[0.04] text-white/70 tabular-nums">{delivered} / {total}</td>
        <td className="px-3 py-2.5 border-b border-white/[0.04]">
          {overdueCount > 0 ? (
            <span className="text-red-400 font-semibold text-[11px] flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {overdueCount}</span>
          ) : <span className="text-white/25">—</span>}
        </td>
        <td className="px-3 py-2.5 border-b border-white/[0.04]">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: pctBg }}>
              <div className="h-full transition-all" style={{ width: `${pct}%`, background: pctColor }} />
            </div>
            <span className="text-[11px] font-bold tabular-nums w-10 text-right" style={{ color: pctColor }}>{pct}%</span>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="bg-black/20 border-b border-white/[0.04] p-3">
            <div className="space-y-1.5">
              {items.map((d: SponsorshipDeliverable) => (
                <DeliverableEditableRow
                  key={d.id}
                  item={d}
                  team={team}
                  today={today}
                  onUpdate={(patch) => onUpdate(d.id, patch)}
                  onDelete={onDelete ? () => onDelete(d.id) : undefined}
                />
              ))}
              {isAdding ? (
                <DeliverableForm team={team} onCancel={onAddCancelled} onSubmit={onAddSubmit} />
              ) : (
                <button
                  onClick={onAddRequested}
                  className="w-full text-[11px] text-white/30 hover:text-white/60 italic py-2 rounded border border-dashed border-white/10 hover:border-white/20 transition"
                >
                  + Add deliverable to {deal.sponsorCompany}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ChevronDownInline() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>;
}
function ChevronRightInline() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>;
}

// Fully editable deliverable row used inside the grouped Deliverables tab.
// Click anywhere to expand; status icon click cycles status without expanding.
function DeliverableEditableRow({ item, team, today, onUpdate, onDelete }: {
  item: SponsorshipDeliverable;
  team: TeamMember[];
  today: Date;
  onUpdate: (patch: any) => void;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [proofUrl, setProofUrl] = useState(item.proofUrl || "");
  const owner = team.find(m => m.id === item.ownerId);
  const sched = item.scheduledDate ? new Date(item.scheduledDate + "T00:00:00") : null;
  const isOverdue = sched && sched < today && item.status !== "delivered" && item.status !== "waived";
  const effectiveStatus = isOverdue && item.status === "pending" ? "overdue" : item.status;
  const cfg = STATUS_CONFIG[effectiveStatus as keyof typeof STATUS_CONFIG];
  const StatusIcon = cfg.icon;

  const cycleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    const order: SponsorshipDeliverable["status"][] = ["pending", "in_progress", "delivered"];
    const i = order.indexOf(item.status);
    onUpdate({ status: order[(i + 1) % order.length] });
  };

  return (
    <div className="rounded-md border border-white/[0.04] bg-white/[0.02]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={cycleStatus}
          className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center transition hover:bg-white/[0.06]"
          style={{ color: cfg.color }}
          title={cfg.label}
        >
          <StatusIcon className="w-4 h-4" />
        </button>
        <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left min-w-0">
          <div className={`text-xs font-medium truncate ${item.status === "delivered" || item.status === "waived" ? "line-through text-white/40" : "text-white"}`}>
            {item.title}
          </div>
          <div className="text-[10px] text-white/40 flex items-center gap-1.5 truncate">
            {item.type && <span>{item.type.replace(/_/g, " ")}</span>}
            {item.entitlementQty != null && item.entitlementQty > 1 && (
              <span>· {item.usedQty || 0}/{item.entitlementQty}</span>
            )}
            {sched && (
              <span className={isOverdue ? "text-red-400" : ""}>· {sched.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "2-digit" })}</span>
            )}
            {owner && <span>· {owner.first_name}</span>}
            {item.proofUrl && <LinkIcon className="w-2.5 h-2.5 text-blue-400 flex-shrink-0" />}
          </div>
        </button>
        {onDelete && (
          <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete deliverable "${item.title}"?`)) onDelete(); }} className="w-5 h-5 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center" title="Delete">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-white/[0.04] space-y-2">
          <div>
            <Label className="text-[10px] text-white/50 mb-0.5 block">Title</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() && title.trim() !== item.title) onUpdate({ title: title.trim() }); }}
              className="bg-white/[0.04] border-white/10 text-white h-7 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <Label className="text-[10px] text-white/50 mb-0.5 block">Status</Label>
              <select
                value={item.status}
                onChange={e => onUpdate({ status: e.target.value })}
                className="w-full text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7"
              >
                {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{STATUS_CONFIG[s as keyof typeof STATUS_CONFIG].label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[10px] text-white/50 mb-0.5 block">Owner</Label>
              <select
                value={item.ownerId ?? ""}
                onChange={e => onUpdate({ ownerId: e.target.value ? parseInt(e.target.value) : null })}
                className="w-full text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7"
              >
                <option value="">Unassigned</option>
                {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <div>
              <Label className="text-[10px] text-white/50 mb-0.5 block">Type</Label>
              <select
                value={item.type || ""}
                onChange={e => onUpdate({ type: e.target.value || null })}
                className="w-full text-[11px] bg-white/[0.04] border border-white/10 rounded px-2 h-7 capitalize"
              >
                <option value="">—</option>
                {DELIVERABLE_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[10px] text-white/50 mb-0.5 block">Scheduled</Label>
              <DatePickerInput
                value={item.scheduledDate || ""}
                onChange={e => onUpdate({ scheduledDate: e.target.value || null })}
                className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]"
              />
            </div>
            <div>
              <Label className="text-[10px] text-white/50 mb-0.5 block">Qty</Label>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min="0"
                  value={item.usedQty ?? 0}
                  onChange={e => onUpdate({ usedQty: parseInt(e.target.value || "0") })}
                  className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px] w-12"
                />
                <span className="text-[10px] text-white/40">/ {item.entitlementQty ?? 1}</span>
              </div>
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-white/50 mb-0.5 block">Proof URL</Label>
            <div className="flex items-center gap-1">
              <Input
                value={proofUrl}
                onChange={e => setProofUrl(e.target.value)}
                onBlur={() => { if (proofUrl !== (item.proofUrl || "")) onUpdate({ proofUrl: proofUrl || null }); }}
                placeholder="https://… (photo / social link / signed manifest)"
                className="bg-white/[0.04] border-white/10 text-white h-7 text-[11px]"
              />
              {item.proofUrl && (
                <a href={item.proofUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 px-1.5">
                  <LinkIcon className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Onboarding matrix view ──────────────────────────────────────────────────
// Grid of every signed sponsor × every onboarding template item. Cells show
// status. Click a cell to cycle pending → in-progress → delivered.
interface OnboardingTemplate {
  id: number;
  organizationId: number;
  title: string;
  description: string | null;
  defaultOwnerId: number | null;
  displayOrder: number;
  isActive: boolean;
}

function OnboardingMatrixView({ orgId, team, deals }: { orgId: number; team: TeamMember[]; deals: SponsorshipDeal[] }) {
  const { data: templates = [] } = useQuery<OnboardingTemplate[]>({
    queryKey: ["/api/admin/sponsorship/onboarding-templates", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/onboarding-templates?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const { data: allDeliverables = [] } = useQuery<Array<SponsorshipDeliverable & { deal: SponsorshipDeal | null }>>({
    queryKey: ["/api/admin/sponsorship/deliverables-all", orgId, "onboarding"],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/deliverables-all?organizationId=${orgId}&category=onboarding`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/sponsorship/deliverables/${id}`, patch);
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables-all", orgId, "onboarding"] }),
  });

  const applyOnboarding = useMutation({
    mutationFn: async (dealId: number) => {
      const r = await apiRequest("POST", `/api/admin/sponsorship/deals/${dealId}/apply-onboarding`, {});
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deliverables-all", orgId, "onboarding"] }),
  });

  const wonStages = ["won", "contract_sent", "invoice_sent", "invoice_paid", "onboarded", "active"];
  const wonDeals = useMemo(() => deals.filter(d => wonStages.includes(d.stage)), [deals]);

  // Index deliverables by (dealId, title) so the cells can look up status quickly
  const cells = useMemo(() => {
    const m = new Map<string, SponsorshipDeliverable>();
    for (const d of allDeliverables) m.set(`${d.dealId}|${d.title}`, d);
    return m;
  }, [allDeliverables]);

  if (templates.length === 0) {
    return (
      <div className="p-12 text-center">
        <CheckCircle2 className="w-10 h-10 text-white/15 mx-auto mb-3" />
        <p className="text-sm text-white/40 mb-1">No onboarding template set up yet</p>
        <p className="text-xs text-white/30">Add items like "Send 50th Anniversary book", "Create WhatsApp group", "Send merch pack" — they'll auto-apply to every new sponsor.</p>
      </div>
    );
  }

  if (wonDeals.length === 0) {
    return (
      <div className="p-12 text-center">
        <Handshake className="w-10 h-10 text-white/15 mx-auto mb-3" />
        <p className="text-sm text-white/40 mb-1">No signed sponsors yet</p>
        <p className="text-xs text-white/30">When a deal moves to Won, it'll appear here with the onboarding checklist auto-populated.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="text-[11px] text-white/40 mb-3">
        {wonDeals.length} signed sponsor{wonDeals.length === 1 ? "" : "s"} · {templates.length} onboarding step{templates.length === 1 ? "" : "s"} · click any cell to advance status
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-x-auto">
        <table className="min-w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold sticky left-0 bg-[#0a0e1a] z-10 min-w-[200px]">Sponsor</th>
              {templates.map(t => (
                <th key={t.id} className="px-2 py-2 border-b border-l border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40 font-semibold text-center min-w-[120px]" title={t.description || ""}>
                  {t.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {wonDeals.map(d => {
              const dealOnboardingCount = allDeliverables.filter(dl => dl.dealId === d.id).length;
              const needsApply = dealOnboardingCount === 0;
              return (
                <tr key={d.id} className="hover:bg-white/[0.02]">
                  <td className="px-3 py-2 border-b border-white/[0.04] sticky left-0 bg-[#0a0e1a] z-10">
                    <div className="text-xs font-semibold text-white truncate">{d.sponsorCompany}</div>
                    <div className="text-[10px] text-white/40 truncate">{d.title}</div>
                    {needsApply && (
                      <button
                        onClick={() => applyOnboarding.mutate(d.id)}
                        className="mt-1 text-[10px] text-blue-300 hover:text-blue-200 underline"
                      >
                        Apply onboarding template
                      </button>
                    )}
                  </td>
                  {templates.map(t => {
                    const cell = cells.get(`${d.id}|${t.title}`);
                    if (!cell) return (
                      <td key={t.id} className="px-2 py-2 border-b border-l border-white/[0.04] text-center text-white/15">—</td>
                    );
                    const cfg = STATUS_CONFIG[cell.status];
                    const StatusIcon = cfg.icon;
                    return (
                      <td key={t.id} className="px-2 py-2 border-b border-l border-white/[0.04] text-center">
                        <button
                          onClick={() => {
                            const order: SponsorshipDeliverable["status"][] = ["pending", "in_progress", "delivered"];
                            const i = order.indexOf(cell.status);
                            update.mutate({ id: cell.id, patch: { status: order[(i + 1) % order.length] } });
                          }}
                          className="w-7 h-7 rounded-md flex items-center justify-center transition hover:bg-white/[0.06]"
                          style={{ color: cfg.color }}
                          title={cfg.label + (cell.deliveredAt ? ` · ${new Date(cell.deliveredAt).toLocaleDateString("en-NZ")}` : "")}
                        >
                          <StatusIcon className="w-4 h-4" />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Billboards view (Go Media contra resell) ────────────────────────────────
const BILLBOARD_STAGES = [
  { key: "lead",          label: "Lead",          color: "#64748b" },
  { key: "contacted",     label: "Contacted",     color: "#94a3b8" },
  { key: "quoted",        label: "Quoted",        color: "#06b6d4" },
  { key: "negotiating",   label: "Negotiating",   color: "#a855f7" },
  { key: "contract_sent", label: "Contract Sent", color: "#3b82f6" },
  { key: "paid",          label: "Paid",          color: "#10b981" },
  { key: "live",          label: "Live",          color: "#22c55e" },
  { key: "completed",     label: "Completed",     color: "#84cc16" },
  { key: "lost",          label: "Lost",          color: "#ef4444" },
] as const;
type BillboardStageKey = typeof BILLBOARD_STAGES[number]["key"];

const BILLBOARD_SOURCES = [
  { key: "existing_sponsor", label: "Existing sponsor", color: "#22c55e" },
  { key: "walk_in",          label: "Walk-in",          color: "#f59e0b" },
  { key: "referral",         label: "Referral",         color: "#a855f7" },
  { key: "ad",               label: "Ad",               color: "#3b82f6" },
  { key: "cold_outreach",    label: "Cold outreach",    color: "#64748b" },
  { key: "inbound",          label: "Inbound",          color: "#06b6d4" },
  { key: "other",            label: "Other",            color: "#94a3b8" },
];

interface BillboardDeal {
  id: number;
  organizationId: number;
  customerName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: string;
  sourceNotes: string | null;
  stage: BillboardStageKey;
  rateCardValueCents: number;
  discountPct: number;
  netValueCents: number;
  revenueCollectedCents: number;
  creditConsumedCents: number;
  billboardLocations: string[];
  startDate: string | null;
  endDate: string | null;
  weeksBooked: number | null;
  expectedCloseDate: string | null;
  ownerId: number | null;
  notes: string | null;
}
interface BillboardSummary {
  creditCapCents: number;
  revenueTargetCents: number;
  creditConsumedCents: number;
  creditRemainingCents: number;
  revenueCollectedCents: number;
  revenueGapCents: number;
  openPipelineNetCents: number;
  wonCount: number;
  totalCount: number;
  byStage: Record<string, { count: number; netCents: number }>;
  bySource: Record<string, { count: number; netCents: number; revenueCents: number }>;
}

function BillboardsView({ orgId, team, currentUserId }: { orgId: number; team: TeamMember[]; currentUserId?: number }) {
  const { toast } = useToast();
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [dealModal, setDealModal] = useState<{ mode: "create" | "edit"; deal?: Partial<BillboardDeal> } | null>(null);

  const { data: summary } = useQuery<BillboardSummary>({
    queryKey: ["/api/admin/billboards/summary", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/billboards/summary?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load summary");
      return r.json();
    },
  });

  const { data: deals = [], isLoading } = useQuery<BillboardDeal[]>({
    queryKey: ["/api/admin/billboards/deals", { orgId, source: sourceFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ organizationId: String(orgId) });
      if (sourceFilter) params.set("source", sourceFilter);
      const r = await fetch(`/api/admin/billboards/deals?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const saveDeal = useMutation({
    mutationFn: async ({ id, payload }: { id?: number; payload: any }) => {
      if (id) {
        const r = await apiRequest("PATCH", `/api/admin/billboards/deals/${id}`, payload);
        return r.json();
      }
      const r = await apiRequest("POST", "/api/admin/billboards/deals", { ...payload, organizationId: orgId });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/billboards/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/billboards/summary", orgId] });
      setDealModal(null);
      toast({ title: "Billboard deal saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const deleteDeal = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/billboards/deals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/billboards/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/billboards/summary", orgId] });
      setDealModal(null);
      toast({ title: "Deleted" });
    },
  });

  const dealsByStage = useMemo(() => {
    const m = new Map<BillboardStageKey, BillboardDeal[]>();
    for (const s of BILLBOARD_STAGES) m.set(s.key, []);
    for (const d of deals) m.get(d.stage as BillboardStageKey)?.push(d);
    return m;
  }, [deals]);

  // Credit pacing colour: red <40%, amber 40-79%, green 80%+
  const creditPct = summary ? Math.min(100, Math.round((summary.creditConsumedCents / summary.creditCapCents) * 100)) : 0;
  const revenuePct = summary ? Math.min(100, Math.round((summary.revenueCollectedCents / summary.revenueTargetCents) * 100)) : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/40 mb-0.5">Go Media contra · $250k credit · $200k revenue target · 20-30% discount range</div>
          </div>
          <Button onClick={() => setDealModal({ mode: "create" })} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-new-billboard">
            <Plus className="w-4 h-4 mr-1.5" /> New billboard deal
          </Button>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <BBKpi
            label="Credit consumed"
            value={summary ? fmtMoneyFull(summary.creditConsumedCents) : "—"}
            sub={summary ? `of ${fmtMoneyFull(summary.creditCapCents)} · ${fmtMoneyFull(summary.creditRemainingCents)} left` : undefined}
            pct={creditPct}
            colorAt={(p) => (p >= 80 ? "#22c55e" : p >= 40 ? "#f59e0b" : "#3b82f6")}
            icon={<DollarSign className="w-4 h-4" />}
          />
          <BBKpi
            label="Revenue collected"
            value={summary ? fmtMoneyFull(summary.revenueCollectedCents) : "—"}
            sub={summary ? `of ${fmtMoneyFull(summary.revenueTargetCents)} · ${fmtMoneyFull(summary.revenueGapCents)} to go` : undefined}
            pct={revenuePct}
            colorAt={(p) => (p >= 80 ? "#22c55e" : p >= 40 ? "#f59e0b" : "#ef4444")}
            icon={<Award className="w-4 h-4" />}
          />
          <BBKpi
            label="Open pipeline (net)"
            value={summary ? fmtMoneyFull(summary.openPipelineNetCents) : "—"}
            sub={summary ? `${summary.totalCount - (summary.wonCount || 0)} open` : undefined}
            icon={<TrendingUp className="w-4 h-4" />}
          />
          <BBKpi
            label="Booked deals"
            value={summary ? String(summary.wonCount) : "—"}
            sub={summary && summary.totalCount > 0 ? `of ${summary.totalCount} total · ${Math.round((summary.wonCount / summary.totalCount) * 100)}% win rate` : undefined}
            icon={<CheckCircle2 className="w-4 h-4" />}
          />
        </div>

        {/* Source filter chips */}
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-white/30 mr-1">Source:</span>
          {sourceFilter && (
            <button onClick={() => setSourceFilter(null)} className="text-[10px] px-2 py-1 rounded-md border border-white/10 text-white/50 hover:text-white">Clear</button>
          )}
          {BILLBOARD_SOURCES.map(s => {
            const active = sourceFilter === s.key;
            const sCount = summary?.bySource?.[s.key]?.count ?? 0;
            return (
              <button
                key={s.key}
                onClick={() => setSourceFilter(active ? null : s.key)}
                className="text-[10px] font-semibold px-2 py-1 rounded-md border transition flex items-center gap-1"
                style={{
                  borderColor: active ? s.color : "hsl(var(--foreground) / 0.085)",
                  background: active ? `${s.color}25` : "transparent",
                  color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.85)",
                }}
              >
                {s.label}
                {sCount > 0 && <span className="text-white/30">{sCount}</span>}
              </button>
            );
          })}
          <span className="text-[10px] text-white/30 ml-auto">{deals.length} deal{deals.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      {/* Pipeline kanban */}
      <div className="flex-1 overflow-x-auto overflow-y-auto">
        {isLoading ? (
          <div className="flex gap-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="w-72 h-96 rounded-xl flex-shrink-0" />)}
          </div>
        ) : (
          <div className="flex gap-3 p-4 min-w-max">
            {BILLBOARD_STAGES.map(s => {
              const items = dealsByStage.get(s.key) || [];
              const totalNet = items.reduce((sum, d) => sum + (d.netValueCents || 0), 0);
              return (
                <div key={s.key} className="w-72 flex-shrink-0 flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                      <span className="text-sm font-semibold truncate">{s.label}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-white/40 flex-shrink-0">
                      <span>{items.length}</span>
                      {totalNet > 0 && <span className="text-white/60 font-medium">{fmtMoney(totalNet)}</span>}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[80px]">
                    {items.length === 0 ? (
                      <button onClick={() => setDealModal({ mode: "create", deal: { stage: s.key } })} className="w-full text-[11px] text-white/30 hover:text-white/50 italic py-3 rounded border border-dashed border-white/10">+ Add deal</button>
                    ) : items.map(d => (
                      <BillboardDealCard key={d.id} deal={d} team={team} highlightMine={d.ownerId === currentUserId} onClick={() => setDealModal({ mode: "edit", deal: d })} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dealModal && (
        <BillboardDealModal
          mode={dealModal.mode}
          deal={dealModal.deal}
          team={team}
          onClose={() => setDealModal(null)}
          onSave={(payload) => saveDeal.mutate({ id: dealModal.deal?.id, payload })}
          onDelete={dealModal.deal?.id ? () => deleteDeal.mutate(dealModal.deal!.id!) : undefined}
        />
      )}
    </div>
  );
}

function BBKpi({ label, value, sub, pct, colorAt, icon }: {
  label: string; value: string; sub?: string; pct?: number; colorAt?: (p: number) => string; icon: React.ReactNode;
}) {
  const accent = pct != null && colorAt ? colorAt(pct) : "#3b82f6";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/40 mb-1.5">
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </div>
      <div className="text-lg font-semibold text-white tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-white/40 mt-0.5">{sub}</div>}
      {pct != null && (
        <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div className="h-full transition-all" style={{ width: `${pct}%`, background: accent }} />
        </div>
      )}
    </div>
  );
}

function BillboardDealCard({ deal, team, highlightMine, onClick }: { deal: BillboardDeal; team: TeamMember[]; highlightMine?: boolean; onClick: () => void }) {
  const owner = team.find(m => m.id === deal.ownerId);
  const closeDate = deal.expectedCloseDate ? new Date(deal.expectedCloseDate + "T00:00:00") : null;
  const today = new Date(); today.setHours(0,0,0,0);
  const daysToClose = closeDate ? Math.ceil((closeDate.getTime() - today.getTime()) / (1000*60*60*24)) : null;
  const sourceCfg = BILLBOARD_SOURCES.find(x => x.key === deal.source);

  return (
    <button
      onClick={onClick}
      data-testid={`card-billboard-${deal.id}`}
      className="w-full text-left rounded-lg p-2.5 border transition-all hover:border-white/15"
      style={{
        borderColor: highlightMine ? "rgba(59,130,246,0.4)" : "hsl(var(--foreground) / 0.067)",
        background: highlightMine ? "rgba(59,130,246,0.05)" : "hsl(var(--foreground) / 0.02)",
        boxShadow: highlightMine ? "0 0 0 1px rgba(59,130,246,0.3)" : undefined,
      }}
    >
      <div className="text-xs font-semibold text-white truncate mb-0.5">{deal.customerName}</div>
      {deal.contactName && <div className="text-[10px] text-white/50 truncate mb-1">{deal.contactName}</div>}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <span className="text-[11px] font-semibold text-green-400 tabular-nums">{fmtMoney(deal.netValueCents)}</span>
        {deal.discountPct > 0 && <span className="text-[10px] text-white/40">@ {deal.discountPct}% off</span>}
        {deal.rateCardValueCents > 0 && <span className="text-[10px] text-white/30">RC {fmtMoney(deal.rateCardValueCents)}</span>}
      </div>
      {sourceCfg && (
        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded inline-block mb-1.5" style={{ background: `${sourceCfg.color}20`, color: sourceCfg.color }}>
          {sourceCfg.label}
        </span>
      )}
      {deal.billboardLocations.length > 0 && (
        <div className="text-[10px] text-white/40 truncate mb-1">📍 {deal.billboardLocations.slice(0, 2).join(", ")}{deal.billboardLocations.length > 2 ? ` +${deal.billboardLocations.length - 2}` : ""}</div>
      )}
      <div className="flex items-center justify-between text-[10px] text-white/40">
        {owner ? (
          <span className="flex items-center gap-1">
            <span className="w-4 h-4 rounded-full bg-white/[0.08] flex items-center justify-center text-[8px] font-semibold text-white/70">{owner.first_name[0]}{owner.last_name[0]}</span>
            <span>{owner.first_name}</span>
          </span>
        ) : <span className="italic">Unassigned</span>}
        {daysToClose !== null && (
          <span className={daysToClose < 0 ? "text-red-400" : daysToClose < 14 ? "text-amber-300" : "text-white/40"}>
            {daysToClose < 0 ? `${-daysToClose}d overdue` : daysToClose === 0 ? "today" : `${daysToClose}d`}
          </span>
        )}
      </div>
    </button>
  );
}

function BillboardDealModal({ mode, deal, team, onClose, onSave, onDelete }: {
  mode: "create" | "edit";
  deal?: Partial<BillboardDeal>;
  team: TeamMember[];
  onClose: () => void;
  onSave: (payload: any) => void;
  onDelete?: () => void;
}) {
  const [customerName, setCustomerName] = useState(deal?.customerName || "");
  const [contactName, setContactName] = useState(deal?.contactName || "");
  const [contactEmail, setContactEmail] = useState(deal?.contactEmail || "");
  const [contactPhone, setContactPhone] = useState(deal?.contactPhone || "");
  const [source, setSource] = useState(deal?.source || "cold_outreach");
  const [sourceNotes, setSourceNotes] = useState(deal?.sourceNotes || "");
  const [stage, setStage] = useState<BillboardStageKey>((deal?.stage as BillboardStageKey) || "lead");
  const [rateCard, setRateCard] = useState(deal?.rateCardValueCents != null && deal.rateCardValueCents > 0 ? (deal.rateCardValueCents / 100).toString() : "");
  const [discount, setDiscount] = useState(deal?.discountPct != null ? String(deal.discountPct) : "20");
  const [revenueCollected, setRevenueCollected] = useState(deal?.revenueCollectedCents != null && deal.revenueCollectedCents > 0 ? (deal.revenueCollectedCents / 100).toString() : "");
  const [locations, setLocations] = useState<string[]>(deal?.billboardLocations || []);
  const [locationInput, setLocationInput] = useState("");
  const [startDate, setStartDate] = useState(deal?.startDate || "");
  const [endDate, setEndDate] = useState(deal?.endDate || "");
  const [weeksBooked, setWeeksBooked] = useState(deal?.weeksBooked != null ? String(deal.weeksBooked) : "");
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal?.expectedCloseDate || "");
  const [ownerId, setOwnerId] = useState<number | null>(deal?.ownerId ?? null);
  const [notes, setNotes] = useState(deal?.notes || "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Auto-compute net from rate × discount
  const rcCents = rateCard ? Math.round(parseFloat(rateCard) * 100) : 0;
  const dPct = parseInt(discount || "0") || 0;
  const netCents = Math.round(rcCents * (100 - Math.max(0, Math.min(100, dPct))) / 100);

  const submit = () => {
    if (!customerName.trim()) return;
    onSave({
      customerName: customerName.trim(),
      contactName: contactName || null,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      source,
      sourceNotes: sourceNotes || null,
      stage,
      rateCardValueCents: rcCents,
      discountPct: dPct,
      netValueCents: netCents,
      revenueCollectedCents: revenueCollected ? Math.round(parseFloat(revenueCollected) * 100) : 0,
      billboardLocations: locations,
      startDate: startDate || null,
      endDate: endDate || null,
      weeksBooked: weeksBooked ? parseInt(weeksBooked) : null,
      expectedCloseDate: expectedCloseDate || null,
      ownerId,
      notes: notes || null,
    });
  };

  const addLocation = () => {
    const v = locationInput.trim();
    if (v && !locations.includes(v)) {
      setLocations([...locations, v]);
      setLocationInput("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in duration-150" onClick={onClose}>
      <div className="w-full max-w-2xl bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-200 max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2"><DollarSign className="w-4 h-4 text-blue-400" />{mode === "create" ? "New billboard deal" : "Edit billboard deal"}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Customer / Business *</Label>
              <Input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="e.g. Harcourts Riccarton" autoFocus className="bg-white/[0.04] border-white/10 text-white" data-testid="input-customer-name" />
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Owner</Label>
              <select value={ownerId ?? ""} onChange={e => setOwnerId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                <option value="">Unassigned</option>
                {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Stage</Label>
            <div className="flex flex-wrap gap-1.5">
              {BILLBOARD_STAGES.map(s => {
                const active = stage === s.key;
                return (
                  <button key={s.key} type="button" onClick={() => setStage(s.key)} className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition" style={{ borderColor: active ? s.color : "hsl(var(--foreground) / 0.085)", background: active ? `${s.color}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)" }}>{s.label}</button>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Source — where did this lead come from?</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {BILLBOARD_SOURCES.map(s => {
                const active = source === s.key;
                return (
                  <button key={s.key} type="button" onClick={() => setSource(s.key)} className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition" style={{ borderColor: active ? s.color : "hsl(var(--foreground) / 0.085)", background: active ? `${s.color}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)" }}>{s.label}</button>
                );
              })}
            </div>
            <Input value={sourceNotes} onChange={e => setSourceNotes(e.target.value)} placeholder="e.g. Walked into Harcourts Riccarton, met branch manager" className="bg-white/[0.04] border-white/10 text-white h-8 text-xs" />
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Pricing — Go Media credit @ {discount || "?"}% off</div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Rate card value (NZD)</Label>
                <Input type="number" min="0" step="100" value={rateCard} onChange={e => setRateCard(e.target.value)} placeholder="0" className="bg-white/[0.04] border-white/10 text-white h-9" />
              </div>
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Discount %</Label>
                <Input type="number" min="0" max="100" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="20" className="bg-white/[0.04] border-white/10 text-white h-9" />
                <p className="text-[9px] text-white/30 mt-0.5">20% base · up to 30% volume</p>
              </div>
              <div>
                <Label className="text-[10px] text-white/50 mb-1 block">Net invoice (auto)</Label>
                <div className="h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 flex items-center text-sm text-green-400 font-semibold tabular-nums">${(netCents / 100).toLocaleString("en-NZ")}</div>
              </div>
            </div>
            <div className="mt-2">
              <Label className="text-[10px] text-white/50 mb-1 block">Revenue collected to date (NZD)</Label>
              <Input type="number" min="0" step="100" value={revenueCollected} onChange={e => setRevenueCollected(e.target.value)} placeholder="0" className="bg-white/[0.04] border-white/10 text-white h-9 max-w-xs" />
              <p className="text-[10px] text-white/30 mt-0.5">Auto-fills to net value when stage moves to Paid (override anytime).</p>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Primary contact</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Name" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
              <Input value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Email" type="email" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
              <Input value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="Phone" className="bg-white/[0.04] border-white/10 text-white h-9 text-sm" />
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 font-semibold">Billboard locations</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {locations.map((loc, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/[0.06] text-white/80">
                  {loc}
                  <button onClick={() => setLocations(locations.filter((_, j) => j !== i))} className="text-white/30 hover:text-red-400"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={locationInput} onChange={e => setLocationInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addLocation(); } }} placeholder="e.g. Riccarton 5L" className="bg-white/[0.04] border-white/10 text-white h-8 text-xs" />
              <Button size="sm" onClick={addLocation} className="h-8 text-xs bg-blue-600 hover:bg-blue-700 text-white" type="button">Add</Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div><Label className="text-[10px] text-white/50 mb-1 block">Start</Label><DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" /></div>
            <div><Label className="text-[10px] text-white/50 mb-1 block">End</Label><DatePickerInput value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" /></div>
            <div><Label className="text-[10px] text-white/50 mb-1 block">Weeks</Label><Input type="number" min="1" value={weeksBooked} onChange={e => setWeeksBooked(e.target.value)} placeholder="4" className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" /></div>
            <div><Label className="text-[10px] text-white/50 mb-1 block">Expected close</Label><DatePickerInput value={expectedCloseDate} onChange={e => setExpectedCloseDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9 text-xs" /></div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1 block">Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Decision-maker, budget cycle, follow-up plan…" className="bg-white/[0.04] border-white/10 text-white min-h-[60px]" />
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div>
            {onDelete && (
              confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-white/60">Delete deal?</span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} className="text-white/50 h-7 text-xs px-2">Cancel</Button>
                  <Button size="sm" onClick={onDelete} className="bg-red-600 hover:bg-red-700 text-white h-7 text-xs px-2"><Trash2 className="w-3 h-3 mr-1" />Delete</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} className="text-red-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5 mr-1" />Delete</Button>
              )
            )}
          </div>
          {!confirmDelete && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50">Cancel</Button>
              <Button size="sm" onClick={submit} disabled={!customerName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white"><Check className="w-3.5 h-3.5 mr-1" />{mode === "create" ? "Create deal" : "Save"}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Prospect database (raw scraped leads, separate from the pipeline) ─────────
interface SponsorshipProspect {
  id: number;
  organizationId: number;
  company: string;
  website: string | null;
  sector: string | null;
  location: string | null;
  brandTags: string[];
  segment: string | null;
  category: string | null;
  tier: string | null;
  fitScore: number | null;
  spendCapacityScore: number | null;
  reachabilityScore: number | null;
  capacityEstimate: string | null;
  alreadyBacksSport: boolean | null;
  sportEvidence: string | null;
  whyFit: string | null;
  brief: string | null;
  contactName: string | null;
  contactEmail: string | null;
  emailConfidence: string | null;
  contactPhone: string | null;
  decisionMakerName: string | null;
  decisionMakerRole: string | null;
  decisionMakerLinkedin: string | null;
  linkedinUrl: string | null;
  sources: string[];
  gradeRationale: string | null;
  detail: string | null;
  status: "new" | "reviewing" | "shortlisted" | "promoted" | "dismissed";
  promotedDealId: number | null;
  ownerId: number | null;
  notes: string | null;
}

const PROSPECT_STATUSES = [
  { key: "new",         label: "New",         color: "#64748b" },
  { key: "reviewing",   label: "Reviewing",   color: "#3b82f6" },
  { key: "shortlisted", label: "Shortlisted", color: "#f59e0b" },
  { key: "promoted",    label: "Promoted",    color: "#22c55e" },
  { key: "dismissed",   label: "Dismissed",   color: "#ef4444" },
] as const;
const TIER_COLOR: Record<string, string> = { A: "#22c55e", B: "#3b82f6", C: "#94a3b8" };

function ProspectsView({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<SponsorshipProspect | null>(null);

  const { data: prospects = [], isLoading } = useQuery<SponsorshipProspect[]>({
    queryKey: ["/api/admin/sponsorship/prospects", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/sponsorship/prospects?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load prospects");
      return r.json();
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => (await apiRequest("PATCH", `/api/admin/sponsorship/prospects/${id}`, patch)).json(),
    onSuccess: (row: SponsorshipProspect) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/prospects", orgId] });
      setSelected(s => (s && s.id === row.id ? row : s));
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });

  const promote = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/admin/sponsorship/prospects/${id}/promote`, {})).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/prospects", orgId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sponsorship/summary", orgId] });
      setSelected(null);
      toast({ title: "Promoted to pipeline", description: "Added to the pipeline as a New Lead." });
    },
    onError: (e: any) => toast({ title: "Couldn't promote", description: e.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prospects.filter(p => {
      if (tierFilter && (p.tier || "").toUpperCase() !== tierFilter) return false;
      if (brandFilter && !(p.brandTags || []).map(b => b.toLowerCase()).includes(brandFilter)) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      if (q) {
        const hay = `${p.company} ${p.sector || ""} ${p.location || ""} ${p.category || ""} ${p.capacityEstimate || ""} ${(p.brandTags || []).join(" ")} ${p.decisionMakerName || ""} ${p.decisionMakerRole || ""} ${p.contactName || ""} ${p.contactEmail || ""} ${p.contactPhone || ""} ${p.whyFit || ""} ${p.brief || ""} ${p.detail || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [prospects, search, tierFilter, brandFilter, statusFilter]);

  const counts = useMemo(() => ({
    total: prospects.length,
    a: prospects.filter(p => (p.tier || "").toUpperCase() === "A").length,
    email: prospects.filter(p => p.contactEmail).length,
    promoted: prospects.filter(p => p.status === "promoted").length,
  }), [prospects]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-white/[0.06]">
        <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">Outreach prospect database · raw scraped leads · promote to pipeline when actioned</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Kpi label="Prospects" value={String(counts.total)} icon={<Target className="w-4 h-4" />} accent="#3b82f6" />
          <Kpi label="Tier A" value={String(counts.a)} icon={<Star className="w-4 h-4" />} accent="#22c55e" />
          <Kpi label="With email" value={String(counts.email)} icon={<Mail className="w-4 h-4" />} accent="#a855f7" />
          <Kpi label="Promoted" value={String(counts.promoted)} icon={<ArrowUpRight className="w-4 h-4" />} accent="#f59e0b" />
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-white/30" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search company, person, email, category…"
              className="bg-white/[0.04] border border-white/10 rounded-md pl-7 pr-2 py-1.5 text-xs text-white placeholder:text-white/30 w-64 sm:w-80 focus:outline-none focus:border-blue-500/50" />
          </div>
          <div className="flex items-center gap-1">
            {["A", "B", "C"].map(t => {
              const active = tierFilter === t;
              return <button key={t} onClick={() => setTierFilter(active ? null : t)} className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                style={{ borderColor: active ? TIER_COLOR[t] : "hsl(var(--foreground) / 0.085)", background: active ? `${TIER_COLOR[t]}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.85)" }}>Tier {t}</button>;
            })}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {BRANDS.map(b => {
              const active = brandFilter === b.slug;
              return <button key={b.slug} onClick={() => setBrandFilter(active ? null : b.slug)} className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                style={{ borderColor: active ? b.color : "hsl(var(--foreground) / 0.085)", background: active ? `${b.color}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.82)" }}>{b.label}</button>;
            })}
          </div>
          <div className="flex items-center gap-1">
            {PROSPECT_STATUSES.map(s => {
              const active = statusFilter === s.key;
              return <button key={s.key} onClick={() => setStatusFilter(active ? null : s.key)} className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                style={{ borderColor: active ? s.color : "hsl(var(--foreground) / 0.085)", background: active ? `${s.color}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.82)" }}>{s.label}</button>;
            })}
          </div>
          <span className="text-[10px] text-white/30 ml-auto">{filtered.length} of {prospects.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-white/40 gap-2 p-8">
            <Target className="w-8 h-8 text-white/20" />
            <p className="text-sm">{prospects.length === 0 ? "No prospects imported yet." : "No prospects match these filters."}</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#0e0f12] z-10 text-white/40 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-white/[0.06]">
                <th className="text-left font-medium px-4 py-2">Company</th>
                <th className="text-left font-medium px-2 py-2">Brands</th>
                <th className="text-center font-medium px-2 py-2">Tier</th>
                <th className="text-center font-medium px-2 py-2" title="Fit · Spend · Reach">F·S·R</th>
                <th className="text-left font-medium px-2 py-2">Capacity</th>
                <th className="text-left font-medium px-2 py-2">Best contact</th>
                <th className="text-left font-medium px-2 py-2">Status</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const st = PROSPECT_STATUSES.find(s => s.key === p.status);
                const tc = p.tier ? TIER_COLOR[p.tier.toUpperCase()] || "#94a3b8" : "#64748b";
                return (
                  <tr key={p.id} onClick={() => setSelected(p)} className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer">
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-white/90">{p.company}</div>
                      <div className="text-[10px] text-white/40 truncate max-w-[220px]">{[p.sector, p.location].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex gap-1 flex-wrap max-w-[150px]">
                        {(p.brandTags || []).map(b => { const br = BRANDS.find(x => x.slug === b.toLowerCase()); return <span key={b} className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${br?.color || "#64748b"}22`, color: br?.color || "#94a3b8" }}>{br?.label || b}</span>; })}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-center">{p.tier && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: `${tc}22`, color: tc }}>{p.tier.toUpperCase()}</span>}</td>
                    <td className="px-2 py-2.5 text-center text-white/50 tabular-nums">{[p.fitScore, p.spendCapacityScore, p.reachabilityScore].map(x => x ?? "–").join("·")}</td>
                    <td className="px-2 py-2.5 text-white/60 truncate max-w-[150px]">{p.capacityEstimate || "—"}</td>
                    <td className="px-2 py-2.5">
                      <div className="text-white/80 truncate max-w-[190px]">{p.decisionMakerName || p.contactName || "—"}{p.decisionMakerRole ? <span className="text-white/40"> · {p.decisionMakerRole}</span> : null}</div>
                      <div className="text-[10px] text-white/40 truncate max-w-[190px]">{p.contactEmail || p.contactPhone || "no direct contact"}</div>
                    </td>
                    <td className="px-2 py-2.5">{st && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>}</td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap">
                      {p.status !== "promoted"
                        ? <button onClick={e => { e.stopPropagation(); promote.mutate(p.id); }} className="text-[10px] font-semibold text-blue-300 hover:text-white border border-blue-500/30 hover:border-blue-500/60 rounded px-2 py-1 inline-flex items-center gap-1"><ArrowUpRight className="w-3 h-3" />Promote</button>
                        : <span className="text-[10px] text-emerald-400/70 inline-flex items-center gap-1"><Check className="w-3 h-3" />In pipeline</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <ProspectDetail prospect={selected} onClose={() => setSelected(null)} onUpdate={(patch) => update.mutate({ id: selected.id, patch })} onPromote={() => promote.mutate(selected.id)} />
      )}
    </div>
  );
}

function ProspectDetail({ prospect, onClose, onUpdate, onPromote }: {
  prospect: SponsorshipProspect; onClose: () => void; onUpdate: (patch: any) => void; onPromote: () => void;
}) {
  const p = prospect;
  const [notes, setNotes] = useState(p.notes || "");
  let dms: any[] = [];
  let socials: Record<string, string> = {};
  try { const d = p.detail ? JSON.parse(p.detail) : {}; dms = d.decision_makers || d.decisionMakers || []; socials = d.socials || {}; } catch {}
  if (dms.length === 0 && p.decisionMakerName) dms = [{ name: p.decisionMakerName, role: p.decisionMakerRole, linkedin: p.decisionMakerLinkedin }];
  const tc = p.tier ? TIER_COLOR[p.tier.toUpperCase()] || "#94a3b8" : "#64748b";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-[#0e0f12] border-l border-white/10 overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-[#0e0f12] border-b border-white/[0.06] px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-white">{p.company}</h2>
              {p.tier && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: `${tc}22`, color: tc }}>Tier {p.tier.toUpperCase()}</span>}
            </div>
            <div className="text-[11px] text-white/40 mt-0.5">{[p.sector, p.location].filter(Boolean).join(" · ")}</div>
            {p.website && <a href={p.website} target="_blank" rel="noreferrer" className="text-[11px] text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 mt-1">{p.website.replace(/^https?:\/\/(www\.)?/, "")}<ExternalLink className="w-3 h-3" /></a>}
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="grid grid-cols-3 gap-2">
            {([["Fit", p.fitScore], ["Spend", p.spendCapacityScore], ["Reach", p.reachabilityScore]] as [string, number | null][]).map(([l, v]) => (
              <div key={l} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-center">
                <div className="text-[9px] uppercase tracking-wider text-white/40">{l}</div>
                <div className="text-lg font-semibold text-white tabular-nums">{v ?? "–"}<span className="text-xs text-white/30">/5</span></div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {(p.brandTags || []).map(b => { const br = BRANDS.find(x => x.slug === b.toLowerCase()); return <span key={b} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: `${br?.color || "#64748b"}22`, color: br?.color || "#94a3b8" }}>{br?.label || b}</span>; })}
            {p.capacityEstimate && <span className="text-[11px] text-white/50 ml-auto">Est. {p.capacityEstimate}</span>}
          </div>

          {p.whyFit && <ProspectSection title="Why they fit">{p.whyFit}</ProspectSection>}
          {p.sportEvidence && <ProspectSection title="Existing sport / community investment">{p.sportEvidence}</ProspectSection>}
          {p.brief && <ProspectSection title="Brief">{p.brief}</ProspectSection>}

          {dms.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Decision-makers</div>
              <div className="space-y-1.5">
                {dms.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-white/80">{d.name || "—"}</span>
                    {d.role && <span className="text-white/40">{d.role}</span>}
                    {d.linkedin && <a href={d.linkedin} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 ml-auto inline-flex items-center gap-1">LinkedIn<ExternalLink className="w-3 h-3" /></a>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-white/40">Best contact</div>
            <div className="text-white/85">{p.contactName || p.decisionMakerName || "—"}</div>
            {p.contactEmail && <div className="flex items-center gap-2 text-white/60"><Mail className="w-3.5 h-3.5 text-white/30" /><a href={`mailto:${p.contactEmail}`} className="text-blue-400 hover:text-blue-300">{p.contactEmail}</a>{p.emailConfidence && <span className="text-[10px] text-white/30">({p.emailConfidence})</span>}</div>}
            {p.contactPhone && <div className="flex items-center gap-2 text-white/60"><Phone className="w-3.5 h-3.5 text-white/30" />{p.contactPhone}</div>}
            {!p.contactEmail && !p.contactPhone && <div className="text-[11px] text-white/30 italic">No direct contact found — verify before outreach.</div>}
          </div>

          {p.sources?.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Sources</div>
              <div className="space-y-1">{p.sources.map((s, i) => <a key={i} href={s} target="_blank" rel="noreferrer" className="block text-[11px] text-blue-400/80 hover:text-blue-300 truncate">{s.replace(/^https?:\/\/(www\.)?/, "")}</a>)}</div>
            </div>
          )}

          <div className="pt-2 border-t border-white/[0.06] space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Status</div>
              <div className="flex gap-1 flex-wrap">
                {PROSPECT_STATUSES.map(s => (
                  <button key={s.key} onClick={() => onUpdate({ status: s.key })} className="text-[10px] font-semibold px-2.5 py-1 rounded-md border transition"
                    style={{ borderColor: p.status === s.key ? s.color : "hsl(var(--foreground) / 0.085)", background: p.status === s.key ? `${s.color}25` : "transparent", color: p.status === s.key ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.85)" }}>{s.label}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Notes</div>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => { if (notes !== (p.notes || "")) onUpdate({ notes }); }} rows={3} placeholder="Internal notes…" className="bg-white/[0.04] border-white/10 text-xs" />
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 bg-[#0e0f12] border-t border-white/[0.06] px-5 py-3 flex items-center justify-between gap-2">
          {p.promotedDealId
            ? <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" />Already in pipeline (deal #{p.promotedDealId})</span>
            : <span className="text-[11px] text-white/30">Promote to add this as a deal in the pipeline.</span>}
          <Button onClick={onPromote} disabled={!!p.promotedDealId} className="bg-blue-600 hover:bg-blue-700 text-white"><ArrowUpRight className="w-4 h-4 mr-1.5" />{p.promotedDealId ? "In pipeline" : "Promote to pipeline"}</Button>
        </div>
      </div>
    </div>
  );
}

function ProspectSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">{title}</div>
      <p className="text-[13px] text-white/70 leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  );
}
