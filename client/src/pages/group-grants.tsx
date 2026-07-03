import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, X, Landmark, FileText, DollarSign, Award, Search, Star, Mail, Phone,
  ExternalLink, Trash2, AlertCircle, TrendingUp,
} from "lucide-react";

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

const STATUSES = [
  { key: "planning",  label: "Planning",  color: "#64748b" },
  { key: "drafting",  label: "Drafting",  color: "#94a3b8" },
  { key: "submitted", label: "Submitted", color: "#3b82f6" },
  { key: "approved",  label: "Approved",  color: "#22c55e" },
  { key: "declined",  label: "Declined",  color: "#ef4444" },
  { key: "paid",      label: "Paid",      color: "#10b981" },
  { key: "acquitted", label: "Acquitted", color: "#84cc16" },
  { key: "withdrawn", label: "Withdrawn", color: "#6b7280" },
] as const;
type StatusKey = typeof STATUSES[number]["key"];
const statusCfg = (s: string) => STATUSES.find(x => x.key === s) || STATUSES[0];

interface GrantFunder {
  id: number;
  organizationId: number;
  name: string;
  funderType: string | null;
  geography: string | null;
  whatTheyFund: string | null;
  priorityScore: number | null;
  typicalGrant: string | null;
  maxGrant: string | null;
  applicationWindows: string | null;
  eligibility: string | null;
  relationshipRequirements: string | null;
  proSportExcluded: boolean | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  segment: string | null;
  notes: string | null;
  archived: boolean;
}

interface GrantApplication {
  id: number;
  organizationId: number;
  funderId: number | null;
  funderName: string;
  projectTitle: string;
  purpose: string | null;
  brandTags: string[];
  amountRequestedCents: number;
  amountApprovedCents: number | null;
  status: StatusKey;
  round: string | null;
  owner: string | null;
  referenceNumber: string | null;
  submittedAt: string | null;
  decisionAt: string | null;
  paidAt: string | null;
  acquittalDueAt: string | null;
  acquittedAt: string | null;
  docsUrl: string | null;
  notes: string | null;
  updatedAt: string;
}

const fmtMoney = (cents: number | null | undefined) =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";
const toDateInput = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "");
const dollarsToCents = (v: string) => {
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100);
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

function StatusPill({ status }: { status: string }) {
  const c = statusCfg(status);
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }}>
      {c.label}
    </span>
  );
}

function BrandChips({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="flex items-center gap-1 flex-wrap">
      {tags.map(t => {
        const b = BRANDS.find(x => x.slug === t);
        return (
          <span key={t} className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
            style={{ background: `${b?.color || "#64748b"}22`, color: b?.color || "#94a3b8" }}>
            {b?.label || t}
          </span>
        );
      })}
    </span>
  );
}

export default function GroupGrants() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [view, setView] = useState<"applications" | "funders">("applications");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [appModal, setAppModal] = useState<{ mode: "create" | "edit"; app?: Partial<GrantApplication> } | null>(null);
  const [funderModal, setFunderModal] = useState<{ mode: "create" | "edit"; funder?: Partial<GrantFunder> } | null>(null);

  const { data: funders = [], isLoading: fundersLoading } = useQuery<GrantFunder[]>({
    queryKey: ["/api/admin/grants/funders", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/grants/funders?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load funders");
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: apps = [], isLoading: appsLoading } = useQuery<GrantApplication[]>({
    queryKey: ["/api/admin/grants/applications", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/grants/applications?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load applications");
      return r.json();
    },
    enabled: !!orgId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/grants/applications", orgId] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/grants/funders", orgId] });
  };

  const saveApp = useMutation({
    mutationFn: async (body: any) =>
      body.id
        ? apiRequest("PATCH", `/api/admin/grants/applications/${body.id}`, body)
        : apiRequest("POST", `/api/admin/grants/applications`, { ...body, organizationId: orgId }),
    onSuccess: () => { invalidate(); setAppModal(null); toast({ title: "Application saved" }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const deleteApp = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/grants/applications/${id}`),
    onSuccess: () => { invalidate(); setAppModal(null); toast({ title: "Application deleted" }); },
  });
  const saveFunder = useMutation({
    mutationFn: async (body: any) =>
      body.id
        ? apiRequest("PATCH", `/api/admin/grants/funders/${body.id}`, body)
        : apiRequest("POST", `/api/admin/grants/funders`, { ...body, organizationId: orgId }),
    onSuccess: () => { invalidate(); setFunderModal(null); toast({ title: "Funder saved" }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const deleteFunder = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/grants/funders/${id}`),
    onSuccess: () => { invalidate(); setFunderModal(null); toast({ title: "Funder deleted" }); },
  });

  const kpis = useMemo(() => {
    const decided = apps.filter(a => ["approved", "paid", "acquitted", "declined"].includes(a.status));
    const won = decided.filter(a => a.status !== "declined");
    const openApps = apps.filter(a => ["planning", "drafting", "submitted"].includes(a.status));
    return {
      approvedCents: won.reduce((s, a) => s + (a.amountApprovedCents || 0), 0),
      approvedCount: won.length,
      openRequestedCents: openApps.reduce((s, a) => s + (a.amountRequestedCents || 0), 0),
      openCount: openApps.length,
      submittedCount: apps.filter(a => a.status === "submitted").length,
      winRate: decided.length ? Math.round((won.length / decided.length) * 100) : null,
    };
  }, [apps]);

  const filteredApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return apps.filter(a =>
      (!statusFilter || a.status === statusFilter) &&
      (!q || [a.projectTitle, a.funderName, a.owner, a.purpose, a.notes, a.round].filter(Boolean).join(" ").toLowerCase().includes(q))
    );
  }, [apps, statusFilter, search]);

  const filteredFunders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return funders.filter(f =>
      !f.archived &&
      (!q || [f.name, f.funderType, f.geography, f.whatTheyFund, f.eligibility, f.notes].filter(Boolean).join(" ").toLowerCase().includes(q))
    );
  }, [funders, search]);

  if (!orgId) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2"><Landmark className="w-5 h-5 text-emerald-400" /> Grant Funding</h1>
            <p className="text-xs text-white/40 mt-0.5">Funder directory · applications · outcomes across {currentOrg?.name}</p>
          </div>
          <div className="flex items-center gap-2">
            {view === "funders" && (
              <Button variant="outline" onClick={() => setFunderModal({ mode: "create" })} data-testid="button-new-funder" className="border-white/10">
                <Plus className="w-4 h-4 mr-1.5" /> New funder
              </Button>
            )}
            <Button onClick={() => setAppModal({ mode: "create" })} data-testid="button-new-application" className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Plus className="w-4 h-4 mr-1.5" /> New application
            </Button>
          </div>
        </div>

        {/* Sub-nav */}
        <div className="flex items-center gap-1 mt-4 border-b border-white/[0.06] -mb-4">
          {([
            { key: "applications", label: "Applications", icon: FileText },
            { key: "funders",      label: "Funders",      icon: Landmark },
          ] as const).map(t => {
            const Icon = t.icon;
            const active = view === t.key;
            return (
              <button key={t.key} onClick={() => { setView(t.key); setSearch(""); }} data-testid={`tab-${t.key}`}
                className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors ${
                  active ? "text-white border-emerald-500" : "text-white/50 hover:text-white/80 border-transparent"
                }`}>
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                <span className="text-[9px] text-white/30 font-normal">{t.key === "applications" ? apps.length : funders.filter(f => !f.archived).length}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <Kpi label="Approved (all time)" value={fmtMoney(kpis.approvedCents)} icon={<Award className="w-4 h-4" />} accent="#22c55e" sub={`${kpis.approvedCount} grant${kpis.approvedCount === 1 ? "" : "s"}`} />
          <Kpi label="In flight" value={fmtMoney(kpis.openRequestedCents)} icon={<TrendingUp className="w-4 h-4" />} accent="#3b82f6" sub={`${kpis.openCount} open · ${kpis.submittedCount} awaiting decision`} />
          <Kpi label="Win rate" value={kpis.winRate == null ? "—" : `${kpis.winRate}%`} icon={<DollarSign className="w-4 h-4" />} accent="#a855f7" sub="of decided applications" />
          <Kpi label="Funders tracked" value={String(funders.filter(f => !f.archived).length)} icon={<Landmark className="w-4 h-4" />} accent="#f59e0b" sub="in the directory" />
        </div>

        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={view === "applications" ? "Search applications…" : "Search funders…"}
              className="pl-8 h-8 w-56 sm:w-72 bg-white/[0.03] border-white/10 text-xs" data-testid="input-search" />
          </div>
          {view === "applications" && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {STATUSES.map(s => {
                const active = statusFilter === s.key;
                const count = apps.filter(a => a.status === s.key).length;
                if (!count && !active) return null;
                return (
                  <button key={s.key} onClick={() => setStatusFilter(active ? null : s.key)} data-testid={`chip-status-${s.key}`}
                    className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                    style={{
                      borderColor: active ? s.color : "rgba(255,255,255,0.1)",
                      background: active ? `${s.color}25` : "transparent",
                      color: active ? "white" : "rgba(255,255,255,0.5)",
                    }}>
                    {s.label} {count ? `· ${count}` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {view === "applications" && (
          appsLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
          ) : filteredApps.length === 0 ? (
            <div className="p-10 text-center text-white/40 text-sm">
              <Landmark className="w-8 h-8 mx-auto mb-3 text-white/20" />
              {apps.length === 0 ? (
                <>No applications yet. Pick a funder from the directory and start your first one — every application (approved or declined) builds the club's funding intelligence.</>
              ) : "Nothing matches that filter."}
            </div>
          ) : (
            <div className="p-4 overflow-x-auto">
              <table className="w-full text-xs min-w-[840px]">
                <thead>
                  <tr className="text-white/35 text-[10px] uppercase tracking-wide">
                    <th className="text-left font-semibold px-3 py-2">Project</th>
                    <th className="text-left font-semibold px-3 py-2">Funder</th>
                    <th className="text-left font-semibold px-3 py-2">Brands</th>
                    <th className="text-right font-semibold px-3 py-2">Requested</th>
                    <th className="text-right font-semibold px-3 py-2">Approved</th>
                    <th className="text-left font-semibold px-3 py-2">Status</th>
                    <th className="text-left font-semibold px-3 py-2">Submitted</th>
                    <th className="text-left font-semibold px-3 py-2">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredApps.map(a => (
                    <tr key={a.id} onClick={() => setAppModal({ mode: "edit", app: a })} data-testid={`row-app-${a.id}`}
                      className="border-t border-white/[0.05] hover:bg-white/[0.03] cursor-pointer transition-colors">
                      <td className="px-3 py-2.5 font-medium text-white/90">{a.projectTitle}</td>
                      <td className="px-3 py-2.5 text-white/60">{a.funderName}</td>
                      <td className="px-3 py-2.5"><BrandChips tags={a.brandTags} /></td>
                      <td className="px-3 py-2.5 text-right text-white/70">{fmtMoney(a.amountRequestedCents)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold" style={{ color: a.amountApprovedCents ? "#22c55e" : "rgba(255,255,255,0.3)" }}>{fmtMoney(a.amountApprovedCents)}</td>
                      <td className="px-3 py-2.5"><StatusPill status={a.status} /></td>
                      <td className="px-3 py-2.5 text-white/50">{fmtDate(a.submittedAt)}</td>
                      <td className="px-3 py-2.5 text-white/50">{a.owner || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {view === "funders" && (
          fundersLoading ? (
            <div className="p-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-xl" />)}</div>
          ) : (
            <div className="p-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredFunders.map(f => (
                <div key={f.id} data-testid={`card-funder-${f.id}`} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-sm text-white/90">{f.name}</div>
                      <div className="text-[10px] text-white/40 mt-0.5">{f.funderType || "Funder"}</div>
                    </div>
                    {f.priorityScore != null && (
                      <span className="flex items-center gap-0.5 shrink-0" title={`Priority ${f.priorityScore}/5`}>
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star key={i} className="w-3 h-3" style={{ color: i < (f.priorityScore || 0) ? "#f59e0b" : "rgba(255,255,255,0.12)", fill: i < (f.priorityScore || 0) ? "#f59e0b" : "none" }} />
                        ))}
                      </span>
                    )}
                  </div>
                  {f.proSportExcluded && (
                    <span className="flex items-center gap-1 text-[10px] text-red-400/90 font-medium">
                      <AlertCircle className="w-3 h-3" /> Excludes professional sport — don't frame as SIU/first-team
                    </span>
                  )}
                  <div className="text-[11px] text-white/60 space-y-1">
                    {(f.typicalGrant || f.maxGrant) && (
                      <div><span className="text-white/35">Typical:</span> {f.typicalGrant || "—"}{f.maxGrant ? <span className="text-white/35"> · Max: {f.maxGrant}</span> : null}</div>
                    )}
                    {f.applicationWindows && <div className="line-clamp-2"><span className="text-white/35">Windows:</span> {f.applicationWindows}</div>}
                    {f.eligibility && <div className="line-clamp-2"><span className="text-white/35">Eligibility:</span> {f.eligibility}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mt-auto pt-1">
                    {f.contactEmail && <a href={`mailto:${f.contactEmail}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1 text-[10px] text-blue-300/80 hover:text-blue-300"><Mail className="w-3 h-3" />{f.contactEmail}</a>}
                    {f.contactPhone && <span className="flex items-center gap-1 text-[10px] text-white/50"><Phone className="w-3 h-3" />{f.contactPhone}</span>}
                    {f.website && <a href={f.website} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-1 text-[10px] text-white/50 hover:text-white"><ExternalLink className="w-3 h-3" />site</a>}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white" data-testid={`button-apply-${f.id}`}
                      onClick={() => setAppModal({ mode: "create", app: { funderId: f.id, funderName: f.name } })}>
                      <Plus className="w-3 h-3 mr-1" /> Apply
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-white/10" data-testid={`button-edit-funder-${f.id}`}
                      onClick={() => setFunderModal({ mode: "edit", funder: f })}>
                      Edit
                    </Button>
                    <span className="text-[10px] text-white/25 ml-auto">{apps.filter(a => a.funderId === f.id).length || ""}{apps.filter(a => a.funderId === f.id).length ? " apps" : ""}</span>
                  </div>
                </div>
              ))}
              {filteredFunders.length === 0 && (
                <div className="col-span-full p-10 text-center text-white/40 text-sm">No funders match. Add one with “New funder”.</div>
              )}
            </div>
          )
        )}
      </div>

      {appModal && (
        <ApplicationModal
          modal={appModal}
          funders={funders}
          onClose={() => setAppModal(null)}
          onSave={(body) => saveApp.mutate(body)}
          onDelete={(id) => { if (confirm("Delete this application?")) deleteApp.mutate(id); }}
          saving={saveApp.isPending}
        />
      )}
      {funderModal && (
        <FunderModal
          modal={funderModal}
          onClose={() => setFunderModal(null)}
          onSave={(body) => saveFunder.mutate(body)}
          onDelete={(id) => { if (confirm("Delete this funder? Applications keep their funder name.")) deleteFunder.mutate(id); }}
          saving={saveFunder.isPending}
        />
      )}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-white/50">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-[#101215] border border-white/10 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#101215] border-b border-white/[0.06] px-5 py-3.5 flex items-center justify-between z-10">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white" data-testid="button-close-modal"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const inputCls = "bg-white/[0.03] border-white/10 text-sm";

function ApplicationModal({ modal, funders, onClose, onSave, onDelete, saving }: {
  modal: { mode: "create" | "edit"; app?: Partial<GrantApplication> };
  funders: GrantFunder[];
  onClose: () => void;
  onSave: (body: any) => void;
  onDelete: (id: number) => void;
  saving: boolean;
}) {
  const a = modal.app || {};
  const [form, setForm] = useState({
    funderId: a.funderId ?? null as number | null,
    funderName: a.funderName || "",
    projectTitle: a.projectTitle || "",
    purpose: a.purpose || "",
    brandTags: a.brandTags || [],
    amountRequested: a.amountRequestedCents ? String(a.amountRequestedCents / 100) : "",
    amountApproved: a.amountApprovedCents != null ? String(a.amountApprovedCents / 100) : "",
    status: (a.status || "planning") as StatusKey,
    round: a.round || "",
    owner: a.owner || "",
    referenceNumber: a.referenceNumber || "",
    submittedAt: toDateInput(a.submittedAt),
    decisionAt: toDateInput(a.decisionAt),
    acquittalDueAt: toDateInput(a.acquittalDueAt),
    docsUrl: a.docsUrl || "",
    notes: a.notes || "",
  });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.funderName.trim() || !form.projectTitle.trim()) return;
    onSave({
      ...(a.id ? { id: a.id } : {}),
      funderId: form.funderId,
      funderName: form.funderName.trim(),
      projectTitle: form.projectTitle.trim(),
      purpose: form.purpose || null,
      brandTags: form.brandTags,
      amountRequestedCents: dollarsToCents(form.amountRequested),
      amountApprovedCents: form.amountApproved === "" ? null : dollarsToCents(form.amountApproved),
      status: form.status,
      round: form.round || null,
      owner: form.owner || null,
      referenceNumber: form.referenceNumber || null,
      submittedAt: form.submittedAt || null,
      decisionAt: form.decisionAt || null,
      acquittalDueAt: form.acquittalDueAt || null,
      docsUrl: form.docsUrl || null,
      notes: form.notes || null,
    });
  };

  return (
    <ModalShell title={modal.mode === "create" ? "New grant application" : "Edit application"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Funder" className="sm:col-span-2">
          <select
            className="w-full h-9 rounded-md bg-white/[0.03] border border-white/10 text-sm px-2.5 text-white"
            value={form.funderId ?? ""}
            data-testid="select-funder"
            onChange={e => {
              const id = e.target.value ? parseInt(e.target.value) : null;
              const f = funders.find(x => x.id === id);
              setForm(prev => ({ ...prev, funderId: id, funderName: f ? f.name : prev.funderName }));
            }}>
            <option value="">— Other / not in directory —</option>
            {funders.filter(f => !f.archived).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {!form.funderId && (
            <Input className={`${inputCls} mt-2`} placeholder="Funder name" value={form.funderName} onChange={e => set("funderName", e.target.value)} data-testid="input-funder-name" />
          )}
        </Field>
        <Field label="Project title *" className="sm:col-span-2">
          <Input className={inputCls} value={form.projectTitle} onChange={e => set("projectTitle", e.target.value)} placeholder="e.g. MFL junior league equipment 2026" data-testid="input-project-title" />
        </Field>
        <Field label="What the money is for" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.purpose} onChange={e => set("purpose", e.target.value)} />
        </Field>
        <Field label="Brands" className="sm:col-span-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {BRANDS.map(b => {
              const active = form.brandTags.includes(b.slug);
              return (
                <button key={b.slug} type="button" onClick={() => set("brandTags", active ? form.brandTags.filter((t: string) => t !== b.slug) : [...form.brandTags, b.slug])}
                  className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                  style={{
                    borderColor: active ? b.color : "rgba(255,255,255,0.1)",
                    background: active ? `${b.color}25` : "transparent",
                    color: active ? "white" : "rgba(255,255,255,0.5)",
                  }}>{b.label}</button>
              );
            })}
          </div>
        </Field>
        <Field label="Amount requested (NZD)">
          <Input className={inputCls} inputMode="decimal" value={form.amountRequested} onChange={e => set("amountRequested", e.target.value)} placeholder="e.g. 15000" data-testid="input-amount-requested" />
        </Field>
        <Field label="Amount approved (NZD)">
          <Input className={inputCls} inputMode="decimal" value={form.amountApproved} onChange={e => set("amountApproved", e.target.value)} placeholder="blank until decided" data-testid="input-amount-approved" />
        </Field>
        <Field label="Status">
          <select className="w-full h-9 rounded-md bg-white/[0.03] border border-white/10 text-sm px-2.5 text-white" value={form.status} onChange={e => set("status", e.target.value)} data-testid="select-status">
            {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Owner">
          <Input className={inputCls} value={form.owner} onChange={e => set("owner", e.target.value)} placeholder="e.g. Tim Shanahan / Daniel" data-testid="input-owner" />
        </Field>
        <Field label="Round / committee">
          <Input className={inputCls} value={form.round} onChange={e => set("round", e.target.value)} placeholder="e.g. Aug 2026 meeting" />
        </Field>
        <Field label="Reference #">
          <Input className={inputCls} value={form.referenceNumber} onChange={e => set("referenceNumber", e.target.value)} />
        </Field>
        <Field label="Submitted">
          <Input type="date" className={inputCls} value={form.submittedAt} onChange={e => set("submittedAt", e.target.value)} data-testid="input-submitted-at" />
        </Field>
        <Field label="Decision">
          <Input type="date" className={inputCls} value={form.decisionAt} onChange={e => set("decisionAt", e.target.value)} />
        </Field>
        <Field label="Acquittal / accountability due">
          <Input type="date" className={inputCls} value={form.acquittalDueAt} onChange={e => set("acquittalDueAt", e.target.value)} />
        </Field>
        <Field label="Docs link">
          <Input className={inputCls} value={form.docsUrl} onChange={e => set("docsUrl", e.target.value)} placeholder="Drive folder URL" />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea className={inputCls} rows={3} value={form.notes} onChange={e => set("notes", e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2 mt-5">
        {a.id && (
          <Button variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => onDelete(a.id!)} data-testid="button-delete-application">
            <Trash2 className="w-4 h-4 mr-1.5" /> Delete
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" className="border-white/10" onClick={onClose}>Cancel</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={submit} disabled={saving || !form.funderName.trim() || !form.projectTitle.trim()} data-testid="button-save-application">
            {saving ? "Saving…" : "Save application"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function FunderModal({ modal, onClose, onSave, onDelete, saving }: {
  modal: { mode: "create" | "edit"; funder?: Partial<GrantFunder> };
  onClose: () => void;
  onSave: (body: any) => void;
  onDelete: (id: number) => void;
  saving: boolean;
}) {
  const f = modal.funder || {};
  const [form, setForm] = useState({
    name: f.name || "",
    funderType: f.funderType || "",
    geography: f.geography || "",
    whatTheyFund: f.whatTheyFund || "",
    priorityScore: f.priorityScore != null ? String(f.priorityScore) : "",
    typicalGrant: f.typicalGrant || "",
    maxGrant: f.maxGrant || "",
    applicationWindows: f.applicationWindows || "",
    eligibility: f.eligibility || "",
    relationshipRequirements: f.relationshipRequirements || "",
    proSportExcluded: !!f.proSportExcluded,
    contactName: f.contactName || "",
    contactEmail: f.contactEmail || "",
    contactPhone: f.contactPhone || "",
    website: f.website || "",
    notes: f.notes || "",
    archived: !!f.archived,
  });
  const set = (k: string, v: any) => setForm(x => ({ ...x, [k]: v }));

  const submit = () => {
    if (!form.name.trim()) return;
    onSave({
      ...(f.id ? { id: f.id } : {}),
      name: form.name.trim(),
      funderType: form.funderType || null,
      geography: form.geography || null,
      whatTheyFund: form.whatTheyFund || null,
      priorityScore: form.priorityScore === "" ? null : parseInt(form.priorityScore),
      typicalGrant: form.typicalGrant || null,
      maxGrant: form.maxGrant || null,
      applicationWindows: form.applicationWindows || null,
      eligibility: form.eligibility || null,
      relationshipRequirements: form.relationshipRequirements || null,
      proSportExcluded: form.proSportExcluded,
      contactName: form.contactName || null,
      contactEmail: form.contactEmail || null,
      contactPhone: form.contactPhone || null,
      website: form.website || null,
      notes: form.notes || null,
      archived: form.archived,
    });
  };

  return (
    <ModalShell title={modal.mode === "create" ? "New funder" : "Edit funder"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Name *" className="sm:col-span-2">
          <Input className={inputCls} value={form.name} onChange={e => set("name", e.target.value)} data-testid="input-funder-modal-name" />
        </Field>
        <Field label="Type">
          <Input className={inputCls} value={form.funderType} onChange={e => set("funderType", e.target.value)} placeholder="e.g. Class 4 gaming trust" />
        </Field>
        <Field label="Priority (1–5)">
          <Input className={inputCls} inputMode="numeric" value={form.priorityScore} onChange={e => set("priorityScore", e.target.value)} />
        </Field>
        <Field label="Geography" className="sm:col-span-2">
          <Input className={inputCls} value={form.geography} onChange={e => set("geography", e.target.value)} />
        </Field>
        <Field label="What they fund" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.whatTheyFund} onChange={e => set("whatTheyFund", e.target.value)} />
        </Field>
        <Field label="Typical grant">
          <Input className={inputCls} value={form.typicalGrant} onChange={e => set("typicalGrant", e.target.value)} />
        </Field>
        <Field label="Max grant">
          <Input className={inputCls} value={form.maxGrant} onChange={e => set("maxGrant", e.target.value)} />
        </Field>
        <Field label="Application windows / deadlines" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.applicationWindows} onChange={e => set("applicationWindows", e.target.value)} />
        </Field>
        <Field label="Eligibility for us" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.eligibility} onChange={e => set("eligibility", e.target.value)} />
        </Field>
        <Field label="Accountability / relationship requirements" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.relationshipRequirements} onChange={e => set("relationshipRequirements", e.target.value)} />
        </Field>
        <Field label="Contact name">
          <Input className={inputCls} value={form.contactName} onChange={e => set("contactName", e.target.value)} />
        </Field>
        <Field label="Contact email">
          <Input className={inputCls} value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} />
        </Field>
        <Field label="Contact phone">
          <Input className={inputCls} value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} />
        </Field>
        <Field label="Website">
          <Input className={inputCls} value={form.website} onChange={e => set("website", e.target.value)} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea className={inputCls} rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} />
        </Field>
        <div className="sm:col-span-2 flex items-center gap-5">
          <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer">
            <input type="checkbox" checked={form.proSportExcluded} onChange={e => set("proSportExcluded", e.target.checked)} />
            Excludes professional sport (SIU ineligible)
          </label>
          <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer">
            <input type="checkbox" checked={form.archived} onChange={e => set("archived", e.target.checked)} />
            Archived
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-5">
        {f.id && (
          <Button variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => onDelete(f.id!)} data-testid="button-delete-funder">
            <Trash2 className="w-4 h-4 mr-1.5" /> Delete
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" className="border-white/10" onClick={onClose}>Cancel</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={submit} disabled={saving || !form.name.trim()} data-testid="button-save-funder">
            {saving ? "Saving…" : "Save funder"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
