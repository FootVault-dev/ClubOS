import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Bug, Sparkles, Wrench, Plus, Search, Trash2, ExternalLink,
  MessageSquarePlus, Check, Clock, ListChecks, Ban, Inbox, StickyNote,
} from "lucide-react";

// ── Config ───────────────────────────────────────────────────────────────────
const TYPES = [
  { key: "bug", label: "Bug", icon: Bug, color: "#ef4444", hint: "Something is broken or not working" },
  { key: "feature", label: "Feature", icon: Sparkles, color: "#8b5cf6", hint: "A new thing you'd like added" },
  { key: "improvement", label: "Improvement", icon: Wrench, color: "#06b6d4", hint: "Change or improve something we have" },
] as const;
const typeCfg = (t: string) => TYPES.find((x) => x.key === t) || TYPES[0];

const STATUSES = [
  { key: "new", label: "New", color: "#3b82f6", icon: Inbox },
  { key: "planned", label: "Planned", color: "#a855f7", icon: ListChecks },
  { key: "in_progress", label: "In progress", color: "#f59e0b", icon: Clock },
  { key: "done", label: "Done", color: "#22c55e", icon: Check },
  { key: "declined", label: "Won't do", color: "#6b7280", icon: Ban },
] as const;
const statusCfg = (s: string) => STATUSES.find((x) => x.key === s) || STATUSES[0];

const PRIORITIES = [
  { key: "low", label: "Low", color: "#64748b" },
  { key: "normal", label: "Normal", color: "#3b82f6" },
  { key: "high", label: "High", color: "#f59e0b" },
  { key: "urgent", label: "Urgent", color: "#ef4444" },
] as const;
const priorityCfg = (p: string) => PRIORITIES.find((x) => x.key === p) || PRIORITIES[1];

const AREAS = [
  "General", "ClubOS", "CUFC", "SIU", "MFL", "CIC", "Gymnastics",
  "Print", "Website", "App", "Other",
];

interface FeatureRequest {
  id: number; type: string; title: string; description: string | null;
  area: string | null; pageUrl: string | null; status: string; priority: string;
  adminNotes: string | null; createdBy: number | null; resolvedAt: string | null;
  createdAt: string; updatedAt: string; submitterName: string;
}
interface FeedbackResponse {
  viewer: { userId: number; isManager: boolean };
  requests: FeatureRequest[];
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return fmtDate(iso);
};

function Pill({ label, color, icon }: { label: string; color: string; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {icon} {label}
    </span>
  );
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50";
const selectCls = "rounded-lg bg-white/[0.04] border border-white/10 px-2 py-1 text-[11px] text-white/80 focus:outline-none focus:border-blue-500/50 cursor-pointer";

export default function Feedback() {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("open"); // open = not done/declined
  const [search, setSearch] = useState("");
  const [notesOpen, setNotesOpen] = useState<number | null>(null);

  // New-request form state
  const [fType, setFType] = useState<string>("bug");
  const [fTitle, setFTitle] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fArea, setFArea] = useState("General");
  const [fUrl, setFUrl] = useState("");

  const { data, isLoading } = useQuery<FeedbackResponse>({ queryKey: ["/api/admin/feedback"] });
  const requests = data?.requests ?? [];
  const isManager = !!data?.viewer?.isManager;
  const myId = data?.viewer?.userId;

  const createMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/feedback", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/feedback"] });
      setShowForm(false);
      setFType("bug"); setFTitle(""); setFDesc(""); setFArea("General"); setFUrl("");
      toast({ title: "Sent 🙌", description: "Thanks — Daniel will see this and triage it." });
    },
    onError: (e: any) => toast({ title: "Couldn't send", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: any) => apiRequest("PATCH", `/api/admin/feedback/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/feedback"] }),
    onError: (e: any) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/feedback/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/feedback"] });
      toast({ title: "Removed" });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { new: 0, planned: 0, in_progress: 0, done: 0, declined: 0 };
    for (const r of requests) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [requests]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (statusFilter === "open" && (r.status === "done" || r.status === "declined")) return false;
      else if (statusFilter !== "open" && statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q && !(`${r.title} ${r.description ?? ""} ${r.area ?? ""} ${r.submitterName}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [requests, typeFilter, statusFilter, search]);

  const submit = () => {
    if (!fTitle.trim()) { toast({ title: "Add a short title", variant: "destructive" }); return; }
    createMut.mutate({ type: fType, title: fTitle, description: fDesc, area: fArea, pageUrl: fUrl });
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto text-white/90">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MessageSquarePlus className="w-5 h-5 text-blue-400" /> Feedback
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Spot a bug or want a change? Report it here instead of WhatsApp — everything lands in one place and gets worked through.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          data-testid="button-new-request"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 transition-colors"
        >
          <Plus className="w-4 h-4" /> Report something
        </button>
      </div>

      {/* Status stat chips (also act as filters) */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUSES.map((s) => {
          const Icon = s.icon;
          const active = statusFilter === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setStatusFilter(active ? "open" : s.key)}
              data-testid={`filter-status-${s.key}`}
              className="rounded-xl border px-3 py-2 text-left transition-colors"
              style={{
                borderColor: active ? `${s.color}88` : "rgba(255,255,255,0.06)",
                background: active ? `${s.color}18` : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-medium" style={{ color: s.color }}>
                <Icon className="w-3 h-3" /> {s.label}
              </div>
              <div className="text-lg font-semibold mt-0.5">{counts[s.key] || 0}</div>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1">
          {[{ key: "all", label: "All" }, ...TYPES.map((t) => ({ key: t.key, label: t.label + "s" }))].map((t) => (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              data-testid={`filter-type-${t.key}`}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                typeFilter === t.key
                  ? "bg-white/[0.08] border-white/20 text-white/90"
                  : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:text-white/70"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setStatusFilter(statusFilter === "all" ? "open" : "all")}
          className={`rounded-lg px-3 py-1.5 text-[12px] font-medium border transition-colors ${
            statusFilter === "all" ? "bg-white/[0.08] border-white/20 text-white/90" : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:text-white/70"
          }`}
        >
          {statusFilter === "all" ? "Showing closed too" : "Show closed"}
        </button>
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            data-testid="input-search"
            className="rounded-lg bg-white/[0.03] border border-white/10 pl-8 pr-3 py-1.5 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 w-44"
          />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <Inbox className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">Nothing here yet.</div>
          <button onClick={() => setShowForm(true)} className="text-blue-400 text-[13px] mt-2 hover:underline">
            Report the first one →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const tc = typeCfg(r.type);
            const sc = statusCfg(r.status);
            const pc = priorityCfg(r.priority);
            const TIcon = tc.icon;
            const canEditOwn = !isManager && r.createdBy === myId && r.status === "new";
            const canDelete = isManager || r.createdBy === myId;
            return (
              <div
                key={r.id}
                data-testid={`card-request-${r.id}`}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/10 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ background: `${tc.color}18`, border: `1px solid ${tc.color}44` }}>
                    <TIcon className="w-4 h-4" style={{ color: tc.color }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-[14px] text-white/90">{r.title}</span>
                      <Pill label={sc.label} color={sc.color} />
                      {r.priority !== "normal" && <Pill label={pc.label} color={pc.color} />}
                    </div>
                    {r.description && (
                      <p className="text-[13px] text-white/50 mt-1 whitespace-pre-wrap">{r.description}</p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap mt-2 text-[11px] text-white/35">
                      {r.area && <span className="px-1.5 py-0.5 rounded bg-white/[0.04] text-white/45">{r.area}</span>}
                      <span>{r.submitterName}</span>
                      <span>·</span>
                      <span>{fmtRelative(r.createdAt)}</span>
                      {r.pageUrl && (
                        <a href={r.pageUrl} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1 text-blue-400/70 hover:text-blue-400">
                          <ExternalLink className="w-3 h-3" /> link
                        </a>
                      )}
                    </div>

                    {/* Admin notes (visible to everyone if set; editable by managers) */}
                    {(r.adminNotes || notesOpen === r.id) && (
                      <div className="mt-2">
                        {isManager && notesOpen === r.id ? (
                          <div className="flex items-start gap-2">
                            <textarea
                              defaultValue={r.adminNotes ?? ""}
                              placeholder="Triage note…"
                              data-testid={`textarea-notes-${r.id}`}
                              className={inputCls + " text-[12px] min-h-[52px]"}
                              onBlur={(e) => {
                                if (e.target.value !== (r.adminNotes ?? "")) updateMut.mutate({ id: r.id, adminNotes: e.target.value });
                                setNotesOpen(null);
                              }}
                              autoFocus
                            />
                          </div>
                        ) : (
                          <div className="text-[12px] text-amber-300/70 bg-amber-500/[0.06] border border-amber-500/15 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                            <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
                            <span className="whitespace-pre-wrap">{r.adminNotes}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right column: manager triage controls */}
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {isManager && (
                      <>
                        <select
                          value={r.status}
                          onChange={(e) => updateMut.mutate({ id: r.id, status: e.target.value })}
                          data-testid={`select-status-${r.id}`}
                          className={selectCls}
                        >
                          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <select
                          value={r.priority}
                          onChange={(e) => updateMut.mutate({ id: r.id, priority: e.target.value })}
                          data-testid={`select-priority-${r.id}`}
                          className={selectCls}
                        >
                          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                        </select>
                        <button
                          onClick={() => setNotesOpen(notesOpen === r.id ? null : r.id)}
                          className="text-[11px] text-white/30 hover:text-amber-300 inline-flex items-center gap-1"
                        >
                          <StickyNote className="w-3 h-3" /> Note
                        </button>
                      </>
                    )}
                    {canEditOwn && (
                      <span className="text-[10px] text-white/25">your request</span>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => { if (confirm("Delete this request?")) deleteMut.mutate(r.id); }}
                        data-testid={`button-delete-${r.id}`}
                        className="text-white/20 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New-request dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold">Report something</h2>
          </div>

          {/* Type */}
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map((t) => {
              const Icon = t.icon;
              const active = fType === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setFType(t.key)}
                  data-testid={`type-${t.key}`}
                  className="rounded-xl border p-2.5 text-center transition-colors"
                  style={{
                    borderColor: active ? `${t.color}99` : "rgba(255,255,255,0.08)",
                    background: active ? `${t.color}1a` : "rgba(255,255,255,0.02)",
                  }}
                >
                  <Icon className="w-4 h-4 mx-auto mb-1" style={{ color: t.color }} />
                  <div className="text-[12px] font-medium" style={{ color: active ? t.color : "rgba(255,255,255,0.7)" }}>{t.label}</div>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-white/35 -mt-1">{typeCfg(fType).hint}</p>

          <div className="space-y-2.5 mt-1">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Title *</label>
              <input
                value={fTitle}
                onChange={(e) => setFTitle(e.target.value)}
                placeholder={fType === "bug" ? "e.g. Register button does nothing on mobile" : "e.g. Add a bulk-export to the Registrations tab"}
                data-testid="input-title"
                className={inputCls}
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Details</label>
              <textarea
                value={fDesc}
                onChange={(e) => setFDesc(e.target.value)}
                placeholder={fType === "bug" ? "What did you do, what happened, what did you expect?" : "What would you like, and why would it help?"}
                data-testid="input-description"
                className={inputCls + " min-h-[90px]"}
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Area</label>
                <select value={fArea} onChange={(e) => setFArea(e.target.value)} data-testid="select-area" className={inputCls + " cursor-pointer"}>
                  {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Link (optional)</label>
                <input
                  value={fUrl}
                  onChange={(e) => setFUrl(e.target.value)}
                  placeholder="Page URL / screenshot"
                  data-testid="input-url"
                  className={inputCls}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setShowForm(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
            <button
              onClick={submit}
              disabled={createMut.isPending}
              data-testid="button-submit-request"
              className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
            >
              <Check className="w-4 h-4" /> {createMut.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
