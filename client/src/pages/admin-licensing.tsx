import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Award, X, Search, AlertTriangle, ExternalLink, CheckCircle2, Clock,
  Circle, CircleDot, MinusCircle, RotateCcw, ChevronRight,
} from "lucide-react";

// ── config ──────────────────────────────────────────────────────────────────
const DEADLINE = "2026-07-24"; // OFC final/resubmission window
const CATEGORY_ORDER = [
  "Sporting", "Infrastructure", "Personnel & Administration",
  "Legal", "Financial", "Social Responsibility & Marketing",
];

const STATUSES = [
  { key: "not_started",  label: "Not started",  color: "#64748b" },
  { key: "in_progress",  label: "In progress",  color: "#3b82f6" },
  { key: "needs_review", label: "Needs review", color: "#f59e0b" },
  { key: "ready",        label: "Ready",        color: "#22c55e" },
  { key: "submitted",    label: "Submitted",    color: "#6366f1" },
  { key: "feedback",     label: "OFC feedback",  color: "#f97316" },
  { key: "approved",     label: "Approved",     color: "#10b981" },
] as const;
const statusCfg = (s: string) => STATUSES.find((x) => x.key === s) || STATUSES[0];

const SUB_STATUSES = [
  { key: "not_started", label: "To do",  color: "#64748b", icon: Circle },
  { key: "in_progress", label: "Doing",  color: "#3b82f6", icon: CircleDot },
  { key: "done",        label: "Done",   color: "#22c55e", icon: CheckCircle2 },
  { key: "na",          label: "N/A",    color: "#6b7280", icon: MinusCircle },
] as const;
const subCfg = (s: string) => SUB_STATUSES.find((x) => x.key === s) || SUB_STATUSES[0];
const nextSubStatus = (s: string) => {
  const order = ["not_started", "in_progress", "done", "na"];
  return order[(order.indexOf(s) + 1) % order.length];
};

const GRADES: Record<string, { label: string; short: string; color: string }> = {
  A: { label: "A · Mandatory",     short: "A", color: "#ef4444" },
  B: { label: "B · Sanctionable",  short: "B", color: "#f59e0b" },
  C: { label: "C · Best practice", short: "C", color: "#64748b" },
};
const gradeCfg = (g: string) => GRADES[(g || "A").trim().toUpperCase()] || GRADES.A;

// ── types ───────────────────────────────────────────────────────────────────
interface Criterion {
  id: number; organizationId: number; code: string; category: string; name: string;
  grade: string; requirementType: string | null; owner: string | null; deadline: string | null;
  status: string; assessment: string | null; priority: string | null; maturityTarget: number | null;
  actionRequired: string | null; evidence2025: string | null; keyRisk: string | null;
  sourceUrls: string | null; ofcFeedback: string | null; resubmitNeeded: boolean;
  notes: string | null; subtaskTotal: number; subtaskDone: number;
}
interface Subtask {
  id: number; criterionId: number; code: string; itemNum: string | null; description: string;
  grade: string | null; required: boolean; dueDate: string | null; status: string;
  evidence2025: string | null; actionRequired: string | null; sourceUrls: string | null;
}

const daysUntil = (d: string) => Math.ceil((new Date(d + "T00:00:00").getTime() - Date.now()) / 86400000);
const splitUrls = (s: string | null) =>
  (s || "").split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));

// ── small components ─────────────────────────────────────────────────────────
function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="text-[11px] text-white/40 font-medium">{label}</div>
      <div className="text-xl font-semibold mt-1" style={{ color: accent }}>{value}</div>
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
function GradeBadge({ grade }: { grade: string }) {
  const c = gradeCfg(grade);
  return (
    <span className="text-[10px] font-bold w-5 h-5 rounded flex items-center justify-center shrink-0"
      style={{ background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }} title={c.label}>
      {c.short}
    </span>
  );
}
function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5 w-24">
      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct === 100 ? "#22c55e" : "#3b82f6" }} />
      </div>
      <span className="text-[10px] text-white/40 tabular-nums w-9 text-right">{done}/{total}</span>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function AdminLicensing() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [search, setSearch] = useState("");
  const [gradeFilter, setGradeFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const { data: criteria = [], isLoading } = useQuery<Criterion[]>({
    queryKey: ["/api/admin/licensing/criteria", orgId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/licensing/criteria?organizationId=${orgId}`)).json(),
    enabled: !!orgId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/licensing/criteria", orgId] });

  const patchCrit = useMutation({
    mutationFn: async ({ id, ...body }: { id: number } & Partial<Criterion>) =>
      apiRequest("PATCH", `/api/admin/licensing/criteria/${id}`, body),
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const owners = useMemo(
    () => Array.from(new Set(criteria.map((c) => c.owner).filter(Boolean))) as string[],
    [criteria],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return criteria.filter((c) => {
      if (gradeFilter && (c.grade || "A").trim().toUpperCase() !== gradeFilter) return false;
      if (ownerFilter === "__none" ? c.owner : ownerFilter && c.owner !== ownerFilter) return false;
      if (statusFilter === "__resubmit" ? !c.resubmitNeeded : statusFilter && c.status !== statusFilter) return false;
      if (q && !(`${c.code} ${c.name} ${c.category} ${c.assessment || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [criteria, search, gradeFilter, ownerFilter, statusFilter]);

  const kpis = useMemo(() => {
    const a = criteria.filter((c) => (c.grade || "A").trim().toUpperCase() === "A");
    const aReady = a.filter((c) => ["ready", "submitted", "approved"].includes(c.status)).length;
    const done = criteria.filter((c) => ["submitted", "approved", "ready"].includes(c.status)).length;
    const resubmit = criteria.filter((c) => c.resubmitNeeded).length;
    return { aTotal: a.length, aReady, pct: criteria.length ? Math.round((done / criteria.length) * 100) : 0, resubmit };
  }, [criteria]);

  const grouped = useMemo(() => {
    const map: Record<string, Criterion[]> = {};
    for (const c of filtered) (map[c.category] ||= []).push(c);
    const cats = Object.keys(map).sort((x, y) => {
      const ix = CATEGORY_ORDER.indexOf(x), iy = CATEGORY_ORDER.indexOf(y);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    return cats.map((cat) => ({ cat, items: map[cat] }));
  }, [filtered]);

  const dLeft = daysUntil(DEADLINE);
  const openCrit = criteria.find((c) => c.id === openId) || null;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto text-white">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Award className="w-5 h-5 text-amber-400" /> OFC Pro League Licensing
          </h1>
          <p className="text-[13px] text-white/40 mt-0.5">
            Christchurch United FC Inc — competing in the OFC Professional League as South Island United
          </p>
        </div>
        <div className="rounded-xl border px-3 py-2 text-center"
          style={{ borderColor: dLeft <= 7 ? "#ef444455" : "#f59e0b55", background: dLeft <= 7 ? "#ef444414" : "#f59e0b14" }}>
          <div className="text-[10px] uppercase tracking-wide text-white/40">Resubmission</div>
          <div className="text-lg font-bold tabular-nums" style={{ color: dLeft <= 7 ? "#f87171" : "#fbbf24" }}>
            {dLeft > 0 ? `${dLeft} days` : "Due"}
          </div>
          <div className="text-[10px] text-white/40">24 Jul 2026</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
        <Kpi label="Mandatory (A) ready" value={`${kpis.aReady}/${kpis.aTotal}`} accent="#22c55e" sub="ready · submitted · approved" />
        <Kpi label="Overall progress" value={`${kpis.pct}%`} accent="#3b82f6" sub={`${criteria.length} criteria`} />
        <Kpi label="Needs resubmit" value={String(kpis.resubmit)} accent={kpis.resubmit ? "#f97316" : "#64748b"} sub="from OFC feedback" />
        <Kpi label="Total items" value={String(criteria.reduce((s, c) => s + c.subtaskTotal, 0))} accent="#a78bfa" sub="evidence sub-tasks" />
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search criteria…"
            className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-[13px] placeholder:text-white/30 focus:outline-none focus:border-white/20" />
        </div>
        <FilterGroup label="Grade" value={gradeFilter} onChange={setGradeFilter}
          options={[{ v: "A", l: "A" }, { v: "B", l: "B" }, { v: "C", l: "C" }]} />
        <FilterGroup label="Owner" value={ownerFilter} onChange={setOwnerFilter}
          options={[...owners.map((o) => ({ v: o, l: o })), { v: "__none", l: "Unassigned" }]} />
        <FilterGroup label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[{ v: "__resubmit", l: "Resubmit" }, ...STATUSES.map((s) => ({ v: s.key, l: s.label }))]} />
      </div>

      {/* list */}
      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-11 w-full bg-white/[0.04] rounded-lg" />)}</div>
      ) : (
        <div className="space-y-5">
          {grouped.map(({ cat, items }) => (
            <div key={cat}>
              <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold mb-1.5 px-1">
                {cat} <span className="text-white/20">· {items.length}</span>
              </div>
              <div className="rounded-xl border border-white/[0.06] overflow-hidden divide-y divide-white/[0.05]">
                {items.map((c) => (
                  <div key={c.id} onClick={() => setOpenId(c.id)}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03] cursor-pointer transition-colors">
                    <GradeBadge grade={c.grade} />
                    <span className="text-[11px] font-mono text-white/40 w-16 shrink-0">{c.code}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium truncate flex items-center gap-1.5">
                        {c.name}
                        {c.resubmitNeeded && <AlertTriangle className="w-3.5 h-3.5 text-orange-400 shrink-0" />}
                      </div>
                      {c.owner && <div className="text-[10px] text-white/30">{c.owner}</div>}
                    </div>
                    {c.subtaskTotal > 0 && <div className="hidden sm:block"><ProgressBar done={c.subtaskDone} total={c.subtaskTotal} /></div>}
                    <select value={c.status} onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchCrit.mutate({ id: c.id, status: e.target.value })}
                      className="text-[10px] font-semibold rounded-full px-2 py-1 bg-transparent border cursor-pointer focus:outline-none"
                      style={{ color: statusCfg(c.status).color, borderColor: `${statusCfg(c.status).color}55` }}>
                      {STATUSES.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900 text-white">{s.label}</option>)}
                    </select>
                    <ChevronRight className="w-4 h-4 text-white/20 shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!filtered.length && <div className="text-center text-white/30 text-sm py-12">No criteria match these filters.</div>}
        </div>
      )}

      {openCrit && <CriterionDrawer key={openCrit.id} orgId={orgId!} criterion={openCrit} onClose={() => setOpenId(null)} onSaved={invalidate} owners={owners} />}
    </div>
  );
}

function FilterGroup({ label, value, onChange, options }:
  { label: string; value: string | null; onChange: (v: string | null) => void; options: { v: string; l: string }[] }) {
  return (
    <select value={value || ""} onChange={(e) => onChange(e.target.value || null)}
      className="bg-white/[0.03] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] text-white/70 focus:outline-none focus:border-white/20 cursor-pointer">
      <option value="" className="bg-neutral-900">{label}: all</option>
      {options.map((o) => <option key={o.v} value={o.v} className="bg-neutral-900">{o.l}</option>)}
    </select>
  );
}

// ── detail drawer ────────────────────────────────────────────────────────────
function CriterionDrawer({ orgId, criterion, onClose, onSaved, owners }:
  { orgId: number; criterion: Criterion; onClose: () => void; onSaved: () => void; owners: string[] }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    status: criterion.status,
    owner: criterion.owner || "",
    priority: criterion.priority || "",
    ofcFeedback: criterion.ofcFeedback || "",
    resubmitNeeded: criterion.resubmitNeeded,
    actionRequired: criterion.actionRequired || "",
    notes: criterion.notes || "",
  });
  const set = (k: keyof typeof form, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const { data: detail } = useQuery<Criterion & { subtasks: Subtask[] }>({
    queryKey: ["/api/admin/licensing/criteria", criterion.id, "detail"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/licensing/criteria/${criterion.id}`)).json(),
  });
  const subtasks = detail?.subtasks || [];

  const patchSub = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) =>
      apiRequest("PATCH", `/api/admin/licensing/subtasks/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/licensing/criteria", criterion.id, "detail"] });
      onSaved();
    },
  });

  const save = useMutation({
    mutationFn: async () => apiRequest("PATCH", `/api/admin/licensing/criteria/${criterion.id}`, {
      ...form, owner: form.owner || null, priority: form.priority || null,
    }),
    onSuccess: () => { onSaved(); toast({ title: "Saved" }); onClose(); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const g = gradeCfg(criterion.grade);
  const evidenceUrls = splitUrls(criterion.sourceUrls);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg h-full bg-neutral-950 border-l border-white/10 overflow-y-auto text-white">
        {/* header */}
        <div className="sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-white/10 px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: `${g.color}22`, color: g.color }}>{g.label}</span>
              <span className="text-[11px] font-mono text-white/40">{criterion.code}</span>
            </div>
            <h2 className="text-lg font-semibold mt-1 leading-tight">{criterion.name}</h2>
            <div className="text-[11px] text-white/30 mt-0.5">{criterion.category}</div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* status + owner + priority */}
          <div className="grid grid-cols-3 gap-2">
            <Field label="Status">
              <select value={form.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
                {STATUSES.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900">{s.label}</option>)}
              </select>
            </Field>
            <Field label="Owner">
              <select value={form.owner} onChange={(e) => set("owner", e.target.value)} className={inputCls}>
                <option value="" className="bg-neutral-900">—</option>
                {Array.from(new Set([...owners, "Ryan", "Dan", "Zach"])).map((o) => <option key={o} value={o} className="bg-neutral-900">{o}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(e) => set("priority", e.target.value)} className={inputCls}>
                <option value="" className="bg-neutral-900">—</option>
                {["High", "Medium", "Low"].map((p) => <option key={p} value={p} className="bg-neutral-900">{p}</option>)}
              </select>
            </Field>
          </div>

          {/* OFC feedback + resubmit — the resubmission workflow */}
          <div className="rounded-xl border border-orange-500/20 bg-orange-500/[0.04] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[12px] font-semibold text-orange-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> OFC review feedback
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer">
                <input type="checkbox" checked={form.resubmitNeeded} onChange={(e) => set("resubmitNeeded", e.target.checked)} className="accent-orange-500" />
                Needs resubmit
              </label>
            </div>
            <Textarea value={form.ofcFeedback} onChange={(e) => set("ofcFeedback", e.target.value)}
              placeholder="Paste OFC's feedback for this criterion (from Ryan's emails)…"
              className="min-h-[70px] bg-white/[0.03] border-white/10 text-[13px]" />
          </div>

          {/* action required */}
          <Field label="Action required">
            <Textarea value={form.actionRequired} onChange={(e) => set("actionRequired", e.target.value)}
              className="min-h-[60px] bg-white/[0.03] border-white/10 text-[13px]" />
          </Field>

          {/* read-only context */}
          {criterion.assessment && <ReadRow label="2025 assessment" value={criterion.assessment} />}
          {criterion.keyRisk && <ReadRow label="Key issue / risk" value={criterion.keyRisk} />}
          {criterion.evidence2025 && <ReadRow label="2025 evidence" value={criterion.evidence2025} />}
          {evidenceUrls.length > 0 && (
            <div>
              <div className="text-[11px] text-white/40 font-medium mb-1">Source files</div>
              <div className="flex flex-col gap-1">
                {evidenceUrls.map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noreferrer"
                    className="text-[12px] text-blue-400 hover:underline flex items-center gap-1 truncate">
                    <ExternalLink className="w-3 h-3 shrink-0" /> <span className="truncate">{u}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* subtasks checklist */}
          <div>
            <div className="text-[12px] font-semibold text-white/70 mb-2 flex items-center gap-1.5">
              Evidence checklist <span className="text-white/30">· {subtasks.filter((s) => ["done", "na"].includes(s.status)).length}/{subtasks.length}</span>
            </div>
            <div className="space-y-1">
              {subtasks.map((s) => {
                const sc = subCfg(s.status); const Icon = sc.icon;
                return (
                  <button key={s.id} onClick={() => patchSub.mutate({ id: s.id, status: nextSubStatus(s.status) })}
                    className="w-full flex items-start gap-2 text-left p-2 rounded-lg hover:bg-white/[0.03] transition-colors group">
                    <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: sc.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] leading-snug" style={{ color: s.status === "done" ? "hsl(var(--foreground) / 0.74)" : "hsl(var(--foreground) / 0.97)", textDecoration: s.status === "done" ? "line-through" : "none" }}>
                        {s.itemNum && <span className="text-white/30 mr-1">{s.itemNum}</span>}{s.description}
                      </div>
                      {s.actionRequired && <div className="text-[10px] text-white/30 mt-0.5">{s.actionRequired}</div>}
                    </div>
                    {!s.required && <span className="text-[9px] text-white/30 border border-white/10 rounded px-1 py-0.5 shrink-0">optional</span>}
                  </button>
                );
              })}
              {!subtasks.length && <div className="text-[12px] text-white/30 py-2">No evidence sub-items.</div>}
            </div>
          </div>

          {/* notes */}
          <Field label="Working notes">
            <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)}
              placeholder="Notes for the team…" className="min-h-[60px] bg-white/[0.03] border-white/10 text-[13px]" />
          </Field>
        </div>

        {/* footer */}
        <div className="sticky bottom-0 bg-neutral-950/95 backdrop-blur border-t border-white/10 px-5 py-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-amber-500 hover:bg-amber-400 text-black font-semibold">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-white focus:outline-none focus:border-white/25 cursor-pointer";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-white/40 font-medium mb-1">{label}</div>
      {children}
    </div>
  );
}
function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-white/40 font-medium mb-0.5">{label}</div>
      <div className="text-[12px] text-white/70 leading-snug whitespace-pre-wrap">{value}</div>
    </div>
  );
}
