import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, X, Calendar, CalendarDays, MapPin, Users, Megaphone, Trash2, Search, TrendingUp,
  CheckCircle2, Circle, Clock, ListTodo, LayoutGrid, AlertTriangle,
} from "lucide-react";

// ── config ──────────────────────────────────────────────────────────────────
const STATUSES = [
  { key: "idea",      label: "Idea",      color: "#64748b" },
  { key: "outreach",  label: "Outreach",  color: "#f59e0b" },
  { key: "confirmed", label: "Confirmed", color: "#3b82f6" },
  { key: "scheduled", label: "Scheduled", color: "#8b5cf6" },
  { key: "completed", label: "Completed", color: "#22c55e" },
  { key: "reviewed",  label: "Reviewed",  color: "#10b981" },
] as const;
const ALL_STATUSES = [...STATUSES, { key: "cancelled", label: "Cancelled", color: "#6b7280" }];
const statusCfg = (s: string) => ALL_STATUSES.find((x) => x.key === s) || STATUSES[0];

const TYPES = [
  { key: "watch_along",      label: "Watch-Along",   color: "#ef4444" },
  { key: "club_visit",       label: "Club Visit",    color: "#3b82f6" },
  { key: "community_day",    label: "Community Day", color: "#22c55e" },
  { key: "school_visit",     label: "School Visit",  color: "#f59e0b" },
  { key: "merch_activation", label: "Merch",         color: "#ec4899" },
  { key: "fan_event",        label: "Fan Event",     color: "#8b5cf6" },
  { key: "outreach",         label: "Outreach",      color: "#06b6d4" },
  { key: "other",            label: "Other",         color: "#64748b" },
];
const typeCfg = (t: string) => TYPES.find((x) => x.key === t) || TYPES[TYPES.length - 1];

const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONF = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const calFmt = (s: string) => { const [, m, dd] = s.split("-"); return `${parseInt(dd)} ${MON[parseInt(m)]}`; };

interface CEvent {
  id: number; organizationId: number; title: string; eventType: string; status: string;
  owner: string | null; partner: string | null; eventDate: string | null; location: string | null;
  description: string | null; outreachNotes: string | null; reviewNotes: string | null;
  attendance: number | null; reach: string | null; links: string | null; updatedAt: string;
}
interface CTask { id: number; eventId: number; title: string; dueDate: string | null; done: boolean; owner: string | null; sortOrder: number; }

const fmtDate = (d: string | null) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : null;

function Kpi({ label, value, icon, accent }: { label: string; value: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-white/40 font-medium"><span style={{ color: accent }}>{icon}</span>{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}
function TypeBadge({ type }: { type: string }) {
  const c = typeCfg(type);
  return <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${c.color}22`, color: c.color }}>{c.label}</span>;
}

export default function AdminEvents() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [view, setView] = useState<"board" | "calendar">("board");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [modal, setModal] = useState<Partial<CEvent> | null>(null);

  const { data: events = [], isLoading } = useQuery<CEvent[]>({
    queryKey: ["/api/admin/community-events", orgId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/community-events?organizationId=${orgId}`)).json(),
    enabled: !!orgId,
  });
  const { data: tasks = [] } = useQuery<CTask[]>({
    queryKey: ["/api/admin/community-event-tasks", orgId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/community-event-tasks?organizationId=${orgId}`)).json(),
    enabled: !!orgId,
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/community-events", orgId] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/community-event-tasks", orgId] });
  };

  const patchStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => apiRequest("PATCH", `/api/admin/community-events/${id}`, { status }),
    onSuccess: () => invalidate(),
  });

  const owners = useMemo(() => Array.from(new Set(events.map((e) => e.owner).filter(Boolean))) as string[], [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (!showCancelled && e.status === "cancelled") return false;
      if (typeFilter && e.eventType !== typeFilter) return false;
      if (ownerFilter && e.owner !== ownerFilter) return false;
      if (q && !`${e.title} ${e.partner || ""} ${e.location || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, search, typeFilter, ownerFilter, showCancelled]);

  const openTaskCount = (eventId: number) => tasks.filter((t) => t.eventId === eventId && !t.done).length;

  const kpis = useMemo(() => {
    const upcoming = events.filter((e) => ["confirmed", "scheduled"].includes(e.status)).length;
    const outreach = events.filter((e) => e.status === "outreach").length;
    const done = events.filter((e) => ["completed", "reviewed"].includes(e.status)).length;
    const openTasks = tasks.filter((t) => !t.done).length;
    return { upcoming, outreach, done, openTasks };
  }, [events, tasks]);

  const byStatus = (s: string) => filtered.filter((e) => e.status === s);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto text-white">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Megaphone className="w-5 h-5 text-emerald-400" /> Community Events</h1>
          <p className="text-[13px] text-white/40 mt-0.5">Fan engagement, community days, watch-alongs, club &amp; school visits — from first outreach to post-event review.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white/[0.03] border border-white/[0.07] rounded-lg p-1">
            <button onClick={() => setView("board")} className="px-2.5 py-1.5 rounded-md text-[12px] font-medium flex items-center gap-1.5" style={{ background: view === "board" ? "rgba(255,255,255,0.08)" : "transparent", color: view === "board" ? "#fff" : "rgba(255,255,255,0.5)" }}><LayoutGrid className="w-3.5 h-3.5" /> Board</button>
            <button onClick={() => setView("calendar")} className="px-2.5 py-1.5 rounded-md text-[12px] font-medium flex items-center gap-1.5" style={{ background: view === "calendar" ? "rgba(255,255,255,0.08)" : "transparent", color: view === "calendar" ? "#fff" : "rgba(255,255,255,0.5)" }}><CalendarDays className="w-3.5 h-3.5" /> Calendar</button>
          </div>
          <Button onClick={() => setModal({ status: "idea", eventType: "other" })} className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold"><Plus className="w-4 h-4 mr-1" /> New event</Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
        <Kpi label="Upcoming" value={String(kpis.upcoming)} icon={<Calendar className="w-3.5 h-3.5" />} accent="#8b5cf6" />
        <Kpi label="In outreach" value={String(kpis.outreach)} icon={<Clock className="w-3.5 h-3.5" />} accent="#f59e0b" />
        <Kpi label="Completed" value={String(kpis.done)} icon={<CheckCircle2 className="w-3.5 h-3.5" />} accent="#22c55e" />
        <Kpi label="Open tasks" value={String(kpis.openTasks)} icon={<ListTodo className="w-3.5 h-3.5" />} accent="#06b6d4" />
      </div>

      {view === "board" ? (
        <>
          {/* filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events, partners…"
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-[13px] placeholder:text-white/30 focus:outline-none focus:border-white/20" />
            </div>
            <select value={typeFilter || ""} onChange={(e) => setTypeFilter(e.target.value || null)} className={filterCls}>
              <option value="" className="bg-neutral-900">Type: all</option>
              {TYPES.map((t) => <option key={t.key} value={t.key} className="bg-neutral-900">{t.label}</option>)}
            </select>
            <select value={ownerFilter || ""} onChange={(e) => setOwnerFilter(e.target.value || null)} className={filterCls}>
              <option value="" className="bg-neutral-900">Owner: all</option>
              {owners.map((o) => <option key={o} value={o} className="bg-neutral-900">{o}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-[12px] text-white/50 cursor-pointer px-1">
              <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} className="accent-white/40" /> cancelled
            </label>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-40 w-full bg-white/[0.04] rounded-xl" />)}</div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-3">
              {STATUSES.map((col) => {
                const items = byStatus(col.key);
                return (
                  <div key={col.key} className="flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2 mb-2 px-1">
                      <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                      <span className="text-[12px] font-semibold text-white/70">{col.label}</span>
                      <span className="text-[11px] text-white/30">{items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((e) => {
                        const openT = openTaskCount(e.id);
                        return (
                          <div key={e.id} onClick={() => setModal(e)}
                            className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 cursor-pointer hover:bg-white/[0.04] hover:border-white/[0.12] transition-colors">
                            <div className="text-[13px] font-medium leading-snug mb-1.5">{e.title}</div>
                            <div className="flex items-center gap-1.5 flex-wrap mb-2">
                              <TypeBadge type={e.eventType} />
                              {e.partner && <span className="text-[10px] text-white/40">· {e.partner}</span>}
                            </div>
                            {e.eventDate && <div className="text-[11px] text-white/40 flex items-center gap-1 mb-1"><Calendar className="w-3 h-3" /> {fmtDate(e.eventDate)}</div>}
                            {e.location && <div className="text-[11px] text-white/30 flex items-center gap-1 mb-1 truncate"><MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{e.location}</span></div>}
                            <div className="flex items-center justify-between mt-2">
                              <div className="flex items-center gap-2">
                                {e.owner && <span className="text-[10px] text-white/40 flex items-center gap-1"><Users className="w-3 h-3" /> {e.owner}</span>}
                                {openT > 0 && <span className="text-[10px] text-cyan-300/80 flex items-center gap-0.5"><ListTodo className="w-3 h-3" /> {openT}</span>}
                              </div>
                              <select value={e.status} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => patchStatus.mutate({ id: e.id, status: ev.target.value })}
                                className="text-[9px] font-semibold rounded px-1 py-0.5 bg-transparent border cursor-pointer focus:outline-none"
                                style={{ color: statusCfg(e.status).color, borderColor: `${statusCfg(e.status).color}55` }}>
                                {ALL_STATUSES.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900 text-white">{s.label}</option>)}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                      {!items.length && <div className="text-[11px] text-white/20 px-1 py-2">—</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <EventCalendar events={events} tasks={tasks} onOpenEvent={(e) => setModal(e)} />
      )}

      {modal && <EventModal orgId={orgId!} event={modal} owners={owners} tasks={tasks.filter((t) => t.eventId === modal.id)} onClose={() => setModal(null)} onSaved={invalidate} />}
    </div>
  );
}

// ── Calendar view (grant-calendar style: Act now + month timeline) ───────────
type CalItem = { key: string; date: string; kind: "event" | "task"; title: string; sub: string; owner: string | null; color: string; done?: boolean; overdue?: boolean; eventId: number; event: CEvent };

function EventCalendar({ events, tasks, onOpenEvent }: { events: CEvent[]; tasks: CTask[]; onOpenEvent: (e: CEvent) => void }) {
  const today = useMemo(() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }, []);
  const daysUntil = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000); };
  const eventById = useMemo(() => Object.fromEntries(events.map((e) => [e.id, e])), [events]);

  const items = useMemo<CalItem[]>(() => {
    const out: CalItem[] = [];
    for (const e of events) {
      if (e.status === "cancelled" || !e.eventDate) continue;
      out.push({ key: `e${e.id}`, date: e.eventDate.slice(0, 10), kind: "event", title: e.title, sub: typeCfg(e.eventType).label + (e.partner ? ` · ${e.partner}` : ""), owner: e.owner, color: typeCfg(e.eventType).color, eventId: e.id, event: e });
    }
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const e = eventById[t.eventId]; if (!e || e.status === "cancelled") continue;
      const overdue = !t.done && daysUntil(t.dueDate.slice(0, 10)) < 0;
      out.push({ key: `t${t.id}`, date: t.dueDate.slice(0, 10), kind: "task", title: t.title, sub: `Task · ${e.title}`, owner: t.owner, color: t.done ? "#22c55e" : overdue ? "#ef4444" : "#06b6d4", done: t.done, overdue, eventId: t.eventId, event: e });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [events, tasks]);

  const pressing = useMemo(() => items.filter((i) => {
    if (i.kind === "task" && i.overdue) return true;                 // overdue tasks always pressing
    if (i.done) return false;
    const n = daysUntil(i.date);
    return n >= 0 && n <= 21;                                        // within 3 weeks
  }).sort((a, b) => (a.overdue === b.overdue ? (a.date < b.date ? -1 : 1) : a.overdue ? -1 : 1)), [items]);

  const timeline = useMemo(() => {
    const groups: { ym: string; items: CalItem[] }[] = [];
    for (const i of items) {
      const ym = i.date.slice(0, 7);
      let g = groups.find((x) => x.ym === ym);
      if (!g) { g = { ym, items: [] }; groups.push(g); }
      g.items.push(i);
    }
    return groups;
  }, [items]);

  if (!items.length) return (
    <div className="p-10 text-center text-white/40 text-sm">
      <CalendarDays className="w-8 h-8 mx-auto mb-3 text-white/20" />
      Nothing dated yet. Add a date to an event, or give an event some tasks with deadlines — they'll show up here.
    </div>
  );

  return (
    <div className="space-y-7">
      {/* Act now / pressing */}
      <section>
        <div className="flex items-center gap-2 mb-3"><AlertTriangle className="w-4 h-4 text-red-400" /><h3 className="text-sm font-semibold">Pressing</h3><span className="text-[11px] text-white/30">overdue + next 3 weeks · {pressing.length}</span></div>
        {pressing.length === 0 ? <div className="text-xs text-white/30 py-2">Nothing pressing right now. 🎉</div> : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {pressing.map((i) => {
              const n = daysUntil(i.date);
              const u = i.overdue ? "#ef4444" : n <= 7 ? "#f59e0b" : "rgba(255,255,255,0.14)";
              return (
                <div key={i.key} onClick={() => onOpenEvent(i.event)} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 cursor-pointer hover:bg-white/[0.04]" style={{ borderLeft: `3px solid ${u}` }}>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-xs font-semibold">{calFmt(i.date)}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ color: u, background: `${u}22` }}>{i.overdue ? `${Math.abs(n)}d overdue` : n === 0 ? "today" : n === 1 ? "1 day" : `${n} days`}</span>
                  </div>
                  <div className="text-[13px] font-semibold text-white/90 leading-tight flex items-center gap-1.5">
                    {i.kind === "task" && <ListTodo className="w-3.5 h-3.5 shrink-0" style={{ color: i.color }} />}{i.title}
                  </div>
                  <div className="text-[11px] text-white/50 mt-0.5 leading-snug">{i.sub}</div>
                  {i.owner && <div className="text-[10px] text-white/35 mt-1.5 flex items-center gap-1"><Users className="w-3 h-3" /> {i.owner}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Timeline */}
      <section>
        <div className="flex items-center gap-2 mb-3"><CalendarDays className="w-4 h-4 text-emerald-400" /><h3 className="text-sm font-semibold">Timeline</h3><span className="text-[11px] text-white/30">{items.length} dated items</span></div>
        <div className="space-y-4">
          {timeline.map((g) => {
            const [y, m] = g.ym.split("-");
            return (
              <div key={g.ym}>
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-white/80">{MONF[parseInt(m)]}</span>
                  <span className="text-[10px] text-white/30">{y}</span>
                  <div className="flex-1 h-px bg-white/[0.06]" />
                  <span className="text-[10px] text-white/25">{g.items.length}</span>
                </div>
                {g.items.map((i) => {
                  const past = daysUntil(i.date) < 0;
                  const dow = DOW[new Date(+i.date.slice(0, 4), +i.date.slice(5, 7) - 1, +i.date.slice(8, 10)).getDay()];
                  return (
                    <div key={i.key} onClick={() => onOpenEvent(i.event)}
                      className="grid grid-cols-[52px_1fr] sm:grid-cols-[66px_1fr_auto] gap-3 items-baseline px-2.5 py-2 rounded-lg hover:bg-white/[0.03] cursor-pointer"
                      style={past && !i.overdue ? { opacity: 0.55 } : undefined}>
                      <div className="text-[12px] font-semibold text-white/80">{calFmt(i.date)}<span className="block text-[9px] text-white/30 font-normal">{dow}</span></div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-white/90 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: i.color }} />
                          {i.kind === "task" && i.done && <span className="text-emerald-400 text-[11px]">✓</span>}
                          <span className={i.kind === "task" && i.done ? "line-through text-white/50" : ""}>{i.title}</span>
                        </div>
                        <div className="text-[11px] text-white/45 leading-snug pl-3.5">{i.sub}</div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap sm:justify-end col-span-2 sm:col-span-1 mt-1 sm:mt-0 pl-3.5 sm:pl-0">
                        {i.kind === "event" ? <TypeBadge type={i.event.eventType} /> : i.overdue ? <span className="text-[9px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-full">overdue</span> : null}
                        {i.owner && <span className="text-[10px] text-white/35">{i.owner}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const filterCls = "bg-white/[0.03] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] text-white/70 focus:outline-none focus:border-white/20 cursor-pointer";
const inputCls = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-2.5 py-2 text-[13px] text-white focus:outline-none focus:border-white/25";

function EventModal({ orgId, event, owners, tasks, onClose, onSaved }:
  { orgId: number; event: Partial<CEvent>; owners: string[]; tasks: CTask[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const isEdit = !!event.id;
  const [f, setF] = useState<Partial<CEvent>>({ ...event });
  const set = (k: keyof CEvent, v: any) => setF((p) => ({ ...p, [k]: v }));
  const showReview = ["completed", "reviewed"].includes(f.status || "");
  const [newTask, setNewTask] = useState({ title: "", dueDate: "" });

  const save = useMutation({
    mutationFn: async () => {
      const body: any = { ...f };
      if (isEdit) return apiRequest("PATCH", `/api/admin/community-events/${event.id}`, body);
      return apiRequest("POST", `/api/admin/community-events`, { ...body, organizationId: orgId });
    },
    onSuccess: () => { onSaved(); toast({ title: isEdit ? "Event saved" : "Event added" }); onClose(); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/community-events/${event.id}`),
    onSuccess: () => { onSaved(); toast({ title: "Event deleted" }); onClose(); },
  });
  const addTask = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/admin/community-event-tasks`, { organizationId: orgId, eventId: event.id, title: newTask.title.trim(), dueDate: newTask.dueDate || null }),
    onSuccess: () => { setNewTask({ title: "", dueDate: "" }); onSaved(); },
  });
  const toggleTask = useMutation({
    mutationFn: async (t: CTask) => apiRequest("PATCH", `/api/admin/community-event-tasks/${t.id}`, { done: !t.done }),
    onSuccess: () => onSaved(),
  });
  const delTask = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/community-event-tasks/${id}`),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-lg h-full bg-neutral-950 border-l border-white/10 overflow-y-auto text-white">
        <div className="sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-white/10 px-5 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold">{isEdit ? "Edit event" : "New event"}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <div className="text-[11px] text-white/40 font-medium mb-1">Title</div>
            <Input value={f.title || ""} onChange={(e) => set("title", e.target.value)} placeholder="e.g. All Whites Watch-Along" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><select value={f.eventType || "other"} onChange={(e) => set("eventType", e.target.value)} className={inputCls}>{TYPES.map((t) => <option key={t.key} value={t.key} className="bg-neutral-900">{t.label}</option>)}</select></Field>
            <Field label="Status"><select value={f.status || "idea"} onChange={(e) => set("status", e.target.value)} className={inputCls}>{ALL_STATUSES.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900">{s.label}</option>)}</select></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner">
              <input list="ce-owners" value={f.owner || ""} onChange={(e) => set("owner", e.target.value)} placeholder="Ruby / Conor / Brad" className={inputCls} />
              <datalist id="ce-owners">{Array.from(new Set([...owners, "Ruby", "Conor", "Brad"])).map((o) => <option key={o} value={o} />)}</datalist>
            </Field>
            <Field label="Partner"><Input value={f.partner || ""} onChange={(e) => set("partner", e.target.value)} placeholder="e.g. Nomads, Flying Kiwis" className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><input type="date" value={f.eventDate ? String(f.eventDate).slice(0, 10) : ""} onChange={(e) => set("eventDate", e.target.value)} className={inputCls} /></Field>
            <Field label="Location"><Input value={f.location || ""} onChange={(e) => set("location", e.target.value)} placeholder="Venue" className={inputCls} /></Field>
          </div>
          <Field label="Plan / description"><Textarea value={f.description || ""} onChange={(e) => set("description", e.target.value)} className="min-h-[64px] bg-white/[0.03] border-white/10 text-[13px]" placeholder="What's the event and what needs to happen?" /></Field>
          <Field label="Outreach / pipeline notes"><Textarea value={f.outreachNotes || ""} onChange={(e) => set("outreachNotes", e.target.value)} className="min-h-[56px] bg-white/[0.03] border-white/10 text-[13px]" placeholder="Who did we contact, when, what did they say?" /></Field>

          {/* Tasks — only for saved events */}
          {isEdit && (
            <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.03] p-3">
              <div className="text-[12px] font-semibold text-cyan-200/90 mb-2 flex items-center gap-1.5"><ListTodo className="w-3.5 h-3.5" /> Tasks &amp; deadlines <span className="text-white/30 font-normal">· {tasks.filter((t) => !t.done).length} open</span></div>
              <div className="space-y-1 mb-2">
                {tasks.sort((a, b) => (a.dueDate || "9") < (b.dueDate || "9") ? -1 : 1).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 group">
                    <button onClick={() => toggleTask.mutate(t)} className="shrink-0">{t.done ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Circle className="w-4 h-4 text-white/30 hover:text-white/60" />}</button>
                    <span className={`text-[12px] flex-1 ${t.done ? "line-through text-white/40" : "text-white/85"}`}>{t.title}</span>
                    {t.dueDate && <span className="text-[10px] text-white/40 whitespace-nowrap">{fmtDate(t.dueDate)}</span>}
                    <button onClick={() => delTask.mutate(t.id)} className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                {!tasks.length && <div className="text-[11px] text-white/30">No tasks yet — add what needs doing for this event.</div>}
              </div>
              <div className="flex gap-2">
                <Input value={newTask.title} onChange={(e) => setNewTask((p) => ({ ...p, title: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && newTask.title.trim()) addTask.mutate(); }} placeholder="Add a task…" className="flex-1 bg-white/[0.03] border-white/10 text-[12px] h-8" />
                <input type="date" value={newTask.dueDate} onChange={(e) => setNewTask((p) => ({ ...p, dueDate: e.target.value }))} className="bg-white/[0.03] border border-white/10 rounded-md px-2 text-[11px] text-white/70 h-8" />
                <Button onClick={() => addTask.mutate()} disabled={!newTask.title.trim() || addTask.isPending} className="h-8 px-2.5 bg-cyan-500/80 hover:bg-cyan-400 text-black"><Plus className="w-4 h-4" /></Button>
              </div>
            </div>
          )}

          {showReview && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 space-y-3">
              <div className="text-[12px] font-semibold text-emerald-300">Post-event review</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Attendance"><Input type="number" value={f.attendance ?? ""} onChange={(e) => set("attendance", e.target.value === "" ? null : Number(e.target.value))} className={inputCls} /></Field>
                <Field label="Reach / notes"><Input value={f.reach || ""} onChange={(e) => set("reach", e.target.value)} placeholder="e.g. 12k IG reach" className={inputCls} /></Field>
              </div>
              <Field label="What worked / what to improve"><Textarea value={f.reviewNotes || ""} onChange={(e) => set("reviewNotes", e.target.value)} className="min-h-[56px] bg-white/[0.03] border-white/10 text-[13px]" placeholder="Learnings for next time…" /></Field>
            </div>
          )}
          <Field label="Links"><Input value={f.links || ""} onChange={(e) => set("links", e.target.value)} placeholder="Docs, social posts…" className={inputCls} /></Field>
          {!isEdit && <p className="text-[11px] text-white/30">Save the event first, then add its tasks &amp; deadlines.</p>}
        </div>

        <div className="sticky bottom-0 bg-neutral-950/95 backdrop-blur border-t border-white/10 px-5 py-3 flex justify-between gap-2">
          {isEdit
            ? <Button variant="ghost" onClick={() => del.mutate()} className="text-red-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-4 h-4 mr-1" /> Delete</Button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !f.title?.trim()} className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold">{save.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] text-white/40 font-medium mb-1">{label}</div>{children}</div>;
}
