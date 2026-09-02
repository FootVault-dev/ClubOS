// USG Content Calendar / Media Production — the media & marketing team's
// Monday.com-style home (group "Content" tab). Five views over one shared
// dataset: Calendar (week/month/quarter/year), Pipeline board (drag between
// stages), Table (dense grid), Sessions (meetings/shoots/scripting/etc.) and a
// Planned-vs-Delivered scoreboard (day/week/month/quarter/year).
//
// Conventions match group-projects.tsx: native <select>, hand-rolled modals,
// apiRequest + react-query, dark-theme tokens, brand chips from lib/work.

import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useState, useMemo } from "react";
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
  Plus, X, Check, Trash2, ChevronLeft, ChevronRight, Calendar as CalIcon,
  LayoutGrid, Table as TableIcon, Clapperboard, Gauge, Users, Camera, Video,
  Scissors, MapPin, Clock, Link as LinkIcon, ExternalLink, Filter, Megaphone,
} from "lucide-react";
import {
  BRANDS, PRIORITY_COLORS, CONTENT_STATUSES, statusMeta, CONTENT_FORMATS, formatLabel,
  CHANNELS, channelMeta, SESSION_TYPES, sessionMeta, PRODUCTION_ROLES, roleLabel, PRIORITIES,
  memberName, initials, isDelivered, brandMeta, fmtDate, toLocalDateStr,
  type ContentItem, type ContentSession, type ContentTask, type TeamMember,
} from "@/lib/content";

type View = "calendar" | "board" | "table" | "sessions" | "scoreboard";
type CalMode = "week" | "month" | "quarter" | "year";

// ── date helpers ─────────────────────────────────────────────────────────────
function startOfWeek(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const off = (x.getDay() + 6) % 7;         // Monday-start
  x.setDate(x.getDate() - off);
  return x;
}
function weekDays(cursor: Date): Date[] {
  const s = startOfWeek(cursor);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; });
}
function monthMatrix(cursor: Date): Date[][] {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const start = startOfWeek(new Date(y, m, 1));
  const weeks: Date[][] = [];
  const d = new Date(start);
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let i = 0; i < 7; i++) { row.push(new Date(d)); d.setDate(d.getDate() + 1); }
    weeks.push(row);
  }
  return weeks.filter(week => week.some(day => day.getMonth() === m));
}
function isSameDay(a: Date, b: Date) { return toLocalDateStr(a) === toLocalDateStr(b); }
function monthLabel(d: Date) { return d.toLocaleDateString("en-NZ", { month: "long", year: "numeric" }); }
function sessionDay(s: ContentSession): string { return toLocalDateStr(new Date(s.startAt)); }
function sessionTime(s: ContentSession): string {
  if (s.allDay) return "All day";
  const t = new Date(s.startAt).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true });
  return t;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ═════════════════════════════════════════════════════════════════════════════
export default function GroupContentPage() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;

  const [view, setView] = useState<View>("calendar");
  const [calMode, setCalMode] = useState<CalMode>("month");
  const [cursor, setCursor] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [navOpen, setNavOpen] = useState(false);

  // filters
  const [fBrand, setFBrand] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fFormat, setFFormat] = useState("");
  const [fChannel, setFChannel] = useState("");
  const [fPerson, setFPerson] = useState<number | "">("");

  const [itemModal, setItemModal] = useState<{ mode: "create" | "edit"; item?: ContentItem; plannedDate?: string } | null>(null);
  const [sessionModal, setSessionModal] = useState<{ mode: "create" | "edit"; session?: ContentSession; day?: string } | null>(null);

  // ── data ───────────────────────────────────────────────────────────────────
  const { data: items = [], isLoading: itemsLoading } = useQuery<ContentItem[]>({
    queryKey: ["/api/admin/content/items", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/content/items?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load content");
      return r.json();
    },
    enabled: !!orgId,
  });
  const { data: sessions = [] } = useQuery<ContentSession[]>({
    queryKey: ["/api/admin/content/sessions", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/content/sessions?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load sessions");
      return r.json();
    },
    enabled: !!orgId,
  });
  const { data: team = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/admin/content/team", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/content/team?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load team");
      return r.json();
    },
    enabled: !!orgId,
  });

  // ── mutations ────────────────────────────────────────────────────────────────
  const invItems = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/content/items"] });
  const invSessions = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/content/sessions"] });

  const saveItem = useMutation({
    mutationFn: async ({ id, body }: { id?: number; body: any }) => {
      const r = id
        ? await apiRequest("PATCH", `/api/admin/content/items/${id}`, body)
        : await apiRequest("POST", "/api/admin/content/items", { ...body, organizationId: orgId });
      return r.json();
    },
    onSuccess: (row) => { invItems(); if (itemModal?.mode === "create") setItemModal({ mode: "edit", item: row }); toast({ title: "Saved" }); },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });
  const deleteItem = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/content/items/${id}`),
    onSuccess: () => { invItems(); setItemModal(null); toast({ title: "Deleted" }); },
  });
  const patchItem = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => { const r = await apiRequest("PATCH", `/api/admin/content/items/${id}`, body); return r.json(); },
    onSuccess: () => invItems(),
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });

  const saveSession = useMutation({
    mutationFn: async ({ id, body }: { id?: number; body: any }) => {
      const r = id
        ? await apiRequest("PATCH", `/api/admin/content/sessions/${id}`, body)
        : await apiRequest("POST", "/api/admin/content/sessions", { ...body, organizationId: orgId });
      return r.json();
    },
    onSuccess: () => { invSessions(); setSessionModal(null); toast({ title: "Session saved" }); },
    onError: (e: any) => toast({ title: "Couldn't save session", description: e.message, variant: "destructive" }),
  });
  const deleteSession = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/content/sessions/${id}`),
    onSuccess: () => { invSessions(); setSessionModal(null); toast({ title: "Session deleted" }); },
  });

  // task (checklist) mutations
  const addTask = useMutation({
    mutationFn: async ({ itemId, body }: { itemId: number; body: any }) => { const r = await apiRequest("POST", `/api/admin/content/items/${itemId}/tasks`, body); return r.json(); },
    onSuccess: () => invItems(),
  });
  const patchTask = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => { const r = await apiRequest("PATCH", `/api/admin/content/tasks/${id}`, body); return r.json(); },
    onSuccess: () => invItems(),
  });
  const delTask = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/content/tasks/${id}`),
    onSuccess: () => invItems(),
  });

  // ── filtering ────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => items.filter(i => {
    if (fBrand && !i.brandTags.includes(fBrand)) return false;
    if (fStatus && i.status !== fStatus) return false;
    if (fFormat && i.format !== fFormat) return false;
    if (fChannel && !i.channels.includes(fChannel)) return false;
    if (fPerson !== "" && ![i.ownerId, i.photographerId, i.videographerId, i.editorId].includes(fPerson)) return false;
    return true;
  }), [items, fBrand, fStatus, fFormat, fChannel, fPerson]);

  const anyFilter = fBrand || fStatus || fFormat || fChannel || fPerson !== "";
  const clearFilters = () => { setFBrand(""); setFStatus(""); setFFormat(""); setFChannel(""); setFPerson(""); };

  if (!orgId) return null;

  const NAV: { key: View; label: string; icon: any; badge?: number }[] = [
    { key: "calendar", label: "Calendar", icon: CalIcon },
    { key: "board", label: "Pipeline", icon: LayoutGrid, badge: items.filter(i => !isDelivered(i) && i.status !== "cancelled").length },
    { key: "table", label: "All content", icon: TableIcon, badge: items.length },
    { key: "sessions", label: "Sessions", icon: Video, badge: sessions.length },
    { key: "scoreboard", label: "Delivered", icon: Gauge },
  ];

  return (
    <div className="flex h-full relative">
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 sm:hidden" onClick={() => setNavOpen(false)} />}

      {/* left sub-sidebar */}
      <aside className={`w-60 border-r border-white/[0.06] flex flex-col bg-[#0a0e1a] sm:bg-transparent fixed sm:static inset-y-0 left-0 z-40 transition-transform ${navOpen ? "translate-x-0" : "-translate-x-full sm:translate-x-0"}`}>
        <div className="px-4 py-4 border-b border-white/[0.06] flex items-center gap-2">
          <Clapperboard className="w-5 h-5 text-pink-400" />
          <div>
            <div className="text-sm font-semibold">Content</div>
            <div className="text-[11px] text-white/40">Media & marketing team</div>
          </div>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map(item => {
            const Icon = item.icon; const active = view === item.key;
            return (
              <button key={item.key} onClick={() => { setView(item.key); setNavOpen(false); }}
                className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors border-l-2 ${active ? "bg-pink-500/[0.08] text-pink-200 border-pink-500" : "text-white/70 hover:bg-white/[0.03] border-transparent"}`}>
                <span className="flex items-center gap-2"><Icon className="w-4 h-4" />{item.label}</span>
                {!!item.badge && item.badge > 0 && <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded">{item.badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t border-white/[0.06] space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-white/30 font-semibold mb-1.5">Pipeline</div>
          {CONTENT_STATUSES.filter(s => s.key !== "cancelled").map(s => (
            <div key={s.key} className="flex items-center gap-2 text-[11px] text-white/50">
              <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}
            </div>
          ))}
        </div>
      </aside>

      {/* main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* header */}
        <div className="px-4 sm:px-6 py-3 border-b border-white/[0.06] flex items-center gap-3 flex-wrap">
          <button className="sm:hidden w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center" onClick={() => setNavOpen(true)}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-semibold capitalize">{NAV.find(n => n.key === view)?.label}</h1>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="text-white/70 hover:text-white" onClick={() => setSessionModal({ mode: "create" })}>
            <Video className="w-4 h-4 mr-1.5" />New session
          </Button>
          <Button size="sm" className="bg-pink-600 hover:bg-pink-700 text-white" onClick={() => setItemModal({ mode: "create" })}>
            <Plus className="w-4 h-4 mr-1" />New content
          </Button>
        </div>

        {/* filters */}
        <div className="px-4 sm:px-6 py-2 border-b border-white/[0.04] flex items-center gap-2 flex-wrap text-xs">
          <span className="flex items-center gap-1 text-white/30"><Filter className="w-3.5 h-3.5" /></span>
          <FilterSelect value={fBrand} onChange={setFBrand} placeholder="All brands" options={BRANDS.map(b => ({ value: b.slug, label: b.label }))} />
          <FilterSelect value={fStatus} onChange={setFStatus} placeholder="All stages" options={CONTENT_STATUSES.map(s => ({ value: s.key, label: s.label }))} />
          <FilterSelect value={fFormat} onChange={setFFormat} placeholder="All formats" options={CONTENT_FORMATS.map(f => ({ value: f.key, label: f.label }))} />
          <FilterSelect value={fChannel} onChange={setFChannel} placeholder="All channels" options={CHANNELS.map(c => ({ value: c.key, label: c.label }))} />
          <FilterSelect value={fPerson === "" ? "" : String(fPerson)} onChange={(v) => setFPerson(v ? Number(v) : "")} placeholder="Anyone"
            options={team.map(t => ({ value: String(t.id), label: `${t.first_name} ${t.last_name}` }))} />
          {anyFilter && <button onClick={clearFilters} className="text-white/40 hover:text-white flex items-center gap-1"><X className="w-3 h-3" />Clear</button>}
          <div className="flex-1" />
          <span className="text-white/30">{filtered.length} shown</span>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto">
          {itemsLoading ? (
            <div className="p-6 space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full bg-white/[0.04]" />)}</div>
          ) : (
            <>
              {view === "calendar" && (
                <CalendarView
                  calMode={calMode} setCalMode={setCalMode} cursor={cursor} setCursor={setCursor}
                  items={filtered} sessions={sessions} team={team}
                  onItem={(item) => setItemModal({ mode: "edit", item })}
                  onSession={(s) => setSessionModal({ mode: "edit", session: s })}
                  onNewOnDay={(day) => setItemModal({ mode: "create", plannedDate: day })}
                />
              )}
              {view === "board" && (
                <BoardView items={filtered} team={team}
                  onItem={(item) => setItemModal({ mode: "edit", item })}
                  onMove={(id, status) => patchItem.mutate({ id, body: { status } })} />
              )}
              {view === "table" && (
                <TableView items={filtered} team={team}
                  onItem={(item) => setItemModal({ mode: "edit", item })}
                  onStatus={(id, status) => patchItem.mutate({ id, body: { status } })} />
              )}
              {view === "sessions" && (
                <SessionsView sessions={sessions} team={team}
                  onSession={(s) => setSessionModal({ mode: "edit", session: s })}
                  onNew={() => setSessionModal({ mode: "create" })} />
              )}
              {view === "scoreboard" && <ScoreboardView items={items} team={team} />}
            </>
          )}
        </div>
      </div>

      {itemModal && (
        <ItemModal
          key={itemModal.item?.id ?? "new"}
          mode={itemModal.mode} item={itemModal.item} plannedDate={itemModal.plannedDate} team={team}
          saving={saveItem.isPending}
          onClose={() => setItemModal(null)}
          onSave={(body: any) => saveItem.mutate({ id: itemModal.item?.id, body })}
          onDelete={itemModal.item ? () => deleteItem.mutate(itemModal.item!.id) : undefined}
          onAddTask={(body: any) => itemModal.item && addTask.mutate({ itemId: itemModal.item.id, body })}
          onToggleTask={(t: ContentTask) => patchTask.mutate({ id: t.id, body: { done: !t.done } })}
          onDeleteTask={(id: number) => delTask.mutate(id)}
          liveItem={items.find(i => i.id === itemModal.item?.id)}
        />
      )}
      {sessionModal && (
        <SessionModal
          key={sessionModal.session?.id ?? "new"}
          mode={sessionModal.mode} session={sessionModal.session} day={sessionModal.day} team={team}
          saving={saveSession.isPending}
          onClose={() => setSessionModal(null)}
          onSave={(body: any) => saveSession.mutate({ id: sessionModal.session?.id, body })}
          onDelete={sessionModal.session ? () => deleteSession.mutate(sessionModal.session!.id) : undefined}
        />
      )}
    </div>
  );
}

// ── little filter dropdown ────────────────────────────────────────────────────
function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`h-7 rounded-md border px-2 text-xs ${value ? "bg-pink-500/10 border-pink-500/40 text-pink-100" : "bg-white/[0.04] border-white/10 text-white/70"}`}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────
function BrandChips({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map(t => { const b = brandMeta(t); return (
        <span key={t} className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: `${b.color}22`, color: b.color }}>{b.label}</span>
      ); })}
    </div>
  );
}
function Avatar({ name, title }: { name: string | null; title?: string }) {
  return <span title={title ? `${title}: ${name}` : name || undefined} className="w-6 h-6 rounded-full bg-white/10 text-[9px] font-bold flex items-center justify-center text-white/80 border border-white/10">{initials(name)}</span>;
}
function TaskProgress({ item }: { item: ContentItem }) {
  const tasks = item.tasks || [];
  if (!tasks.length) return null;
  const done = tasks.filter(t => t.done).length;
  return <span className="text-[10px] text-white/40 flex items-center gap-1"><Check className="w-3 h-3" />{done}/{tasks.length}</span>;
}
function StatusPill({ status }: { status: string }) {
  const s = statusMeta(status);
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${s.color}22`, color: s.color }}>{s.label}</span>;
}

// ═══ CALENDAR ════════════════════════════════════════════════════════════════
function CalendarView({ calMode, setCalMode, cursor, setCursor, items, sessions, team, onItem, onSession, onNewOnDay }: {
  calMode: CalMode; setCalMode: (m: CalMode) => void; cursor: Date; setCursor: (d: Date) => void;
  items: ContentItem[]; sessions: ContentSession[]; team: TeamMember[];
  onItem: (i: ContentItem) => void; onSession: (s: ContentSession) => void; onNewOnDay: (day: string) => void;
}) {
  const step = (dir: number) => {
    const d = new Date(cursor);
    if (calMode === "week") d.setDate(d.getDate() + dir * 7);
    else if (calMode === "month") d.setMonth(d.getMonth() + dir);
    else if (calMode === "quarter") d.setMonth(d.getMonth() + dir * 3);
    else d.setFullYear(d.getFullYear() + dir);
    setCursor(d);
  };
  const itemsOn = (day: Date) => items.filter(i => i.plannedDate === toLocalDateStr(day));
  const sessionsOn = (day: Date) => sessions.filter(s => sessionDay(s) === toLocalDateStr(day));

  const rangeLabel = () => {
    if (calMode === "week") { const w = weekDays(cursor); return `${w[0].toLocaleDateString("en-NZ", { day: "numeric", month: "short" })} – ${w[6].toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}`; }
    if (calMode === "month") return monthLabel(cursor);
    if (calMode === "quarter") { const q = Math.floor(cursor.getMonth() / 3); return `Q${q + 1} ${cursor.getFullYear()}`; }
    return String(cursor.getFullYear());
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
          <button onClick={() => step(-1)} className="w-8 h-8 hover:bg-white/[0.06] flex items-center justify-center"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setCursor(d); }} className="px-3 h-8 text-xs hover:bg-white/[0.06] border-x border-white/10">Today</button>
          <button onClick={() => step(1)} className="w-8 h-8 hover:bg-white/[0.06] flex items-center justify-center"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <div className="text-base font-semibold min-w-[140px]">{rangeLabel()}</div>
        <div className="flex-1" />
        <div className="flex items-center rounded-lg border border-white/10 overflow-hidden text-xs">
          {(["week", "month", "quarter", "year"] as CalMode[]).map(m => (
            <button key={m} onClick={() => setCalMode(m)} className={`px-3 h-8 capitalize ${calMode === m ? "bg-pink-500/20 text-pink-100" : "hover:bg-white/[0.06] text-white/60"}`}>{m}</button>
          ))}
        </div>
      </div>

      {calMode === "month" && <MonthGrid cursor={cursor} itemsOn={itemsOn} sessionsOn={sessionsOn} onItem={onItem} onSession={onSession} onNewOnDay={onNewOnDay} />}
      {calMode === "week" && <WeekGrid cursor={cursor} itemsOn={itemsOn} sessionsOn={sessionsOn} team={team} onItem={onItem} onSession={onSession} onNewOnDay={onNewOnDay} />}
      {(calMode === "quarter" || calMode === "year") && (
        <AgendaGrid cursor={cursor} months={calMode === "quarter" ? 3 : 12} startMonth={calMode === "quarter" ? Math.floor(cursor.getMonth() / 3) * 3 : 0}
          items={items} sessions={sessions} onItem={onItem} onSession={onSession} onNewOnDay={onNewOnDay} />
      )}
    </div>
  );
}

function DayPill({ item, onItem }: { item: ContentItem; onItem: (i: ContentItem) => void }) {
  const s = statusMeta(item.status); const delivered = isDelivered(item);
  return (
    <button onClick={(e) => { e.stopPropagation(); onItem(item); }}
      className="w-full text-left text-[11px] px-1.5 py-1 rounded truncate flex items-center gap-1 hover:brightness-125"
      style={{ background: `${s.color}1f`, borderLeft: `2px solid ${s.color}` }}>
      {delivered && <Check className="w-2.5 h-2.5 shrink-0" style={{ color: s.color }} />}
      <span className="truncate">{item.title}</span>
    </button>
  );
}
function SessionPill({ session, onSession }: { session: ContentSession; onSession: (s: ContentSession) => void }) {
  const m = sessionMeta(session.sessionType);
  return (
    <button onClick={(e) => { e.stopPropagation(); onSession(session); }}
      className="w-full text-left text-[11px] px-1.5 py-1 rounded truncate flex items-center gap-1 hover:brightness-125 border border-dashed"
      style={{ borderColor: `${m.color}66`, color: m.color }}>
      <Video className="w-2.5 h-2.5 shrink-0" /><span className="truncate">{session.title}</span>
    </button>
  );
}

function MonthGrid({ cursor, itemsOn, sessionsOn, onItem, onSession, onNewOnDay }: any) {
  const weeks = monthMatrix(cursor); const m = cursor.getMonth();
  const today = new Date();
  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="grid grid-cols-7 border-b border-white/[0.06]">
        {DAY_NAMES.map(d => <div key={d} className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-white/30 font-semibold text-center">{d}</div>)}
      </div>
      {weeks.map((week: Date[], wi: number) => (
        <div key={wi} className="grid grid-cols-7 border-b border-white/[0.04] last:border-0">
          {week.map((day: Date, di: number) => {
            const inMonth = day.getMonth() === m; const isToday = isSameDay(day, today);
            const its = itemsOn(day); const sess = sessionsOn(day);
            return (
              <div key={di} onClick={() => onNewOnDay(toLocalDateStr(day))}
                className={`min-h-[92px] p-1 border-r border-white/[0.04] last:border-0 cursor-pointer hover:bg-white/[0.02] ${inMonth ? "" : "opacity-35"}`}>
                <div className={`text-[11px] mb-1 px-1 ${isToday ? "inline-flex items-center justify-center w-5 h-5 rounded-full bg-pink-600 text-white font-bold" : "text-white/40"}`}>{day.getDate()}</div>
                <div className="space-y-0.5">
                  {sess.map((s: ContentSession) => <SessionPill key={"s" + s.id} session={s} onSession={onSession} />)}
                  {its.slice(0, 4).map((i: ContentItem) => <DayPill key={i.id} item={i} onItem={onItem} />)}
                  {its.length > 4 && <div className="text-[10px] text-white/30 px-1">+{its.length - 4} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function WeekGrid({ cursor, itemsOn, sessionsOn, team, onItem, onSession, onNewOnDay }: any) {
  const days = weekDays(cursor); const today = new Date();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
      {days.map((day: Date, i: number) => {
        const its = itemsOn(day); const sess = sessionsOn(day); const isToday = isSameDay(day, today);
        return (
          <div key={i} className={`rounded-xl border p-2 min-h-[160px] ${isToday ? "border-pink-500/40 bg-pink-500/[0.04]" : "border-white/[0.06] bg-white/[0.02]"}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold">{DAY_NAMES[i]} <span className="text-white/40">{day.getDate()}</span></div>
              <button onClick={() => onNewOnDay(toLocalDateStr(day))} className="w-5 h-5 rounded text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
            </div>
            <div className="space-y-1">
              {sess.map((s: ContentSession) => (
                <button key={"s" + s.id} onClick={() => onSession(s)} className="w-full text-left text-[11px] px-1.5 py-1 rounded border border-dashed hover:brightness-125" style={{ borderColor: `${sessionMeta(s.sessionType).color}66`, color: sessionMeta(s.sessionType).color }}>
                  <div className="flex items-center gap-1"><Video className="w-2.5 h-2.5" />{sessionTime(s)}</div>
                  <div className="truncate text-white/80">{s.title}</div>
                </button>
              ))}
              {its.map((it: ContentItem) => (
                <button key={it.id} onClick={() => onItem(it)} className="w-full text-left rounded p-1.5 hover:brightness-125" style={{ background: `${statusMeta(it.status).color}14`, borderLeft: `2px solid ${statusMeta(it.status).color}` }}>
                  <div className="text-[11px] truncate flex items-center gap-1">{isDelivered(it) && <Check className="w-2.5 h-2.5" style={{ color: statusMeta(it.status).color }} />}{it.title}</div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-[9px] text-white/40">{formatLabel(it.format)}</span>
                    <BrandChips tags={it.brandTags} />
                  </div>
                </button>
              ))}
              {!its.length && !sess.length && <div className="text-[10px] text-white/20 py-2 text-center">—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Quarter / Year = agenda grouped by month (the long-horizon planning view).
function AgendaGrid({ cursor, months, startMonth, items, sessions, onItem, onSession, onNewOnDay }: any) {
  const year = cursor.getFullYear();
  const monthsArr = Array.from({ length: months }, (_, k) => new Date(year, startMonth + k, 1));
  return (
    <div className={`grid gap-3 ${months === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
      {monthsArr.map((mDate, k) => {
        const mi = mDate.getMonth(), my = mDate.getFullYear();
        const its = (items as ContentItem[]).filter(i => i.plannedDate && new Date(i.plannedDate + "T00:00:00").getMonth() === mi && new Date(i.plannedDate + "T00:00:00").getFullYear() === my).sort((a, b) => (a.plannedDate! < b.plannedDate! ? -1 : 1));
        const sess = (sessions as ContentSession[]).filter(s => { const d = new Date(s.startAt); return d.getMonth() === mi && d.getFullYear() === my; });
        const delivered = its.filter(isDelivered).length;
        return (
          <div key={k} className="rounded-xl border border-white/[0.06] bg-white/[0.02] flex flex-col">
            <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
              <div className="text-sm font-semibold">{mDate.toLocaleDateString("en-NZ", { month: "long" })}</div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-white/40">{its.length} planned</span>
                {delivered > 0 && <span className="text-emerald-300">{delivered} out</span>}
                <button onClick={() => onNewOnDay(toLocalDateStr(new Date(my, mi, 1)))} className="text-white/30 hover:text-white"><Plus className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="p-2 space-y-1 max-h-[300px] overflow-auto">
              {sess.map(s => <SessionPill key={"s" + s.id} session={s} onSession={onSession} />)}
              {its.map(i => (
                <button key={i.id} onClick={() => onItem(i)} className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:brightness-125 flex items-center gap-1.5" style={{ background: `${statusMeta(i.status).color}14` }}>
                  <span className="text-white/40 tabular-nums">{i.plannedDate ? new Date(i.plannedDate + "T00:00:00").getDate() : "–"}</span>
                  <span className="truncate flex-1">{i.title}</span>
                  {isDelivered(i) && <Check className="w-2.5 h-2.5 text-emerald-300" />}
                </button>
              ))}
              {!its.length && !sess.length && <div className="text-[10px] text-white/20 py-3 text-center">Nothing planned</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══ BOARD (pipeline kanban, drag between stages) ═════════════════════════════
function BoardView({ items, team, onItem, onMove }: { items: ContentItem[]; team: TeamMember[]; onItem: (i: ContentItem) => void; onMove: (id: number, status: string) => void }) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const cols = CONTENT_STATUSES;
  return (
    <div className="p-4 sm:p-6 h-full">
      <div className="flex gap-3 h-full overflow-x-auto pb-2">
        {cols.map(col => {
          const colItems = items.filter(i => i.status === col.key);
          return (
            <div key={col.key}
              onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
              onDragLeave={() => setOverCol(c => c === col.key ? null : c)}
              onDrop={(e) => { e.preventDefault(); if (dragId != null) onMove(dragId, col.key); setDragId(null); setOverCol(null); }}
              className={`w-[260px] shrink-0 rounded-xl border flex flex-col ${overCol === col.key ? "border-pink-500/50 bg-pink-500/[0.04]" : "border-white/[0.06] bg-white/[0.015]"}`}>
              <div className="px-3 py-2 flex items-center justify-between border-b border-white/[0.06]">
                <div className="flex items-center gap-2 text-xs font-semibold"><span className="w-2 h-2 rounded-full" style={{ background: col.color }} />{col.label}</div>
                <span className="text-[10px] text-white/40">{colItems.length}</span>
              </div>
              <div className="p-2 space-y-2 flex-1 overflow-y-auto min-h-[120px]">
                {colItems.map(item => (
                  <div key={item.id} draggable
                    onDragStart={() => setDragId(item.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    onClick={() => onItem(item)}
                    className={`rounded-lg border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/15 p-2.5 cursor-pointer ${dragId === item.id ? "opacity-40" : ""}`}>
                    <div className="text-[13px] font-medium leading-snug mb-1.5">{item.title}</div>
                    <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                      <span className="text-[9px] text-white/50 bg-white/[0.06] px-1.5 py-0.5 rounded">{formatLabel(item.format)}</span>
                      {item.channels.slice(0, 3).map(c => <span key={c} className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${channelMeta(c).color}22`, color: channelMeta(c).color }}>{channelMeta(c).label}</span>)}
                    </div>
                    <BrandChips tags={item.brandTags} />
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-1.5 text-[10px] text-white/40">
                        {item.plannedDate && <span className="flex items-center gap-0.5"><CalIcon className="w-3 h-3" />{fmtDate(item.plannedDate)}</span>}
                        <TaskProgress item={item} />
                      </div>
                      <div className="flex -space-x-1.5">
                        {[item.ownerId, item.photographerId, item.videographerId, item.editorId].filter((v, i, a) => v != null && a.indexOf(v) === i).slice(0, 3).map((uid) => <Avatar key={uid} name={memberName(team, uid)} />)}
                      </div>
                    </div>
                  </div>
                ))}
                {!colItems.length && <div className="text-[11px] text-white/20 text-center py-6">Drop here</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ TABLE (dense Monday grid) ════════════════════════════════════════════════
function TableView({ items, team, onItem, onStatus }: { items: ContentItem[]; team: TeamMember[]; onItem: (i: ContentItem) => void; onStatus: (id: number, s: string) => void }) {
  const sorted = [...items].sort((a, b) => { const ad = a.plannedDate || "9999", bd = b.plannedDate || "9999"; return ad < bd ? -1 : ad > bd ? 1 : 0; });
  return (
    <div className="p-4 sm:p-6">
      <div className="rounded-xl border border-white/[0.06] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
              <th className="text-left font-semibold px-3 py-2">Content</th>
              <th className="text-left font-semibold px-3 py-2">Brand</th>
              <th className="text-left font-semibold px-3 py-2">Format</th>
              <th className="text-left font-semibold px-3 py-2">Stage</th>
              <th className="text-left font-semibold px-3 py-2">Owner</th>
              <th className="text-center font-semibold px-2 py-2" title="Photography"><Camera className="w-3.5 h-3.5 inline" /></th>
              <th className="text-center font-semibold px-2 py-2" title="Videography"><Video className="w-3.5 h-3.5 inline" /></th>
              <th className="text-center font-semibold px-2 py-2" title="Editing"><Scissors className="w-3.5 h-3.5 inline" /></th>
              <th className="text-left font-semibold px-3 py-2">Planned</th>
              <th className="text-left font-semibold px-3 py-2">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(i => (
              <tr key={i.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer" onClick={() => onItem(i)}>
                <td className="px-3 py-2">
                  <div className="font-medium flex items-center gap-1.5">{i.title}<TaskProgress item={i} /></div>
                  {!!i.channels.length && <div className="flex gap-1 mt-0.5">{i.channels.slice(0, 4).map(c => <span key={c} className="text-[9px]" style={{ color: channelMeta(c).color }}>{channelMeta(c).label}</span>)}</div>}
                </td>
                <td className="px-3 py-2"><BrandChips tags={i.brandTags} /></td>
                <td className="px-3 py-2 text-white/60 text-xs">{formatLabel(i.format)}</td>
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  <select value={i.status} onChange={e => onStatus(i.id, e.target.value)}
                    className="h-7 rounded-md border-0 px-1.5 text-xs font-semibold cursor-pointer"
                    style={{ background: `${statusMeta(i.status).color}22`, color: statusMeta(i.status).color }}>
                    {CONTENT_STATUSES.map(s => <option key={s.key} value={s.key} className="bg-[#0a0e1a] text-white">{s.label}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2 text-xs text-white/70">{memberName(team, i.ownerId) || "—"}</td>
                <td className="px-2 py-2 text-center">{i.photographerId ? <Avatar name={memberName(team, i.photographerId)} /> : <span className="text-white/20">—</span>}</td>
                <td className="px-2 py-2 text-center">{i.videographerId ? <Avatar name={memberName(team, i.videographerId)} /> : <span className="text-white/20">—</span>}</td>
                <td className="px-2 py-2 text-center">{i.editorId ? <Avatar name={memberName(team, i.editorId)} /> : <span className="text-white/20">—</span>}</td>
                <td className="px-3 py-2 text-xs text-white/60">{i.plannedDate ? fmtDate(i.plannedDate) : "—"}</td>
                <td className="px-3 py-2 text-xs">{i.publishedDate ? <span className="text-emerald-300 flex items-center gap-1"><Check className="w-3 h-3" />{fmtDate(i.publishedDate)}</span> : <span className="text-white/20">—</span>}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan={10} className="text-center text-white/30 py-10 text-sm">No content yet. Hit “New content” to start planning.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══ SESSIONS ═════════════════════════════════════════════════════════════════
function SessionsView({ sessions, team, onSession, onNew }: { sessions: ContentSession[]; team: TeamMember[]; onSession: (s: ContentSession) => void; onNew: () => void }) {
  const now = new Date();
  const upcoming = sessions.filter(s => new Date(s.startAt) >= new Date(now.getFullYear(), now.getMonth(), now.getDate())).sort((a, b) => a.startAt < b.startAt ? -1 : 1);
  const past = sessions.filter(s => new Date(s.startAt) < new Date(now.getFullYear(), now.getMonth(), now.getDate())).sort((a, b) => a.startAt > b.startAt ? -1 : 1);
  const Row = (s: ContentSession) => {
    const m = sessionMeta(s.sessionType);
    return (
      <button key={s.id} onClick={() => onSession(s)} className="w-full text-left rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 p-3 flex items-start gap-3">
        <div className="w-11 text-center shrink-0">
          <div className="text-[10px] uppercase text-white/40">{new Date(s.startAt).toLocaleDateString("en-NZ", { month: "short" })}</div>
          <div className="text-lg font-bold leading-none">{new Date(s.startAt).getDate()}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${m.color}22`, color: m.color }}>{m.label}</span>
            <span className="text-sm font-medium truncate">{s.title}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-white/40 flex-wrap">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{sessionTime(s)}</span>
            {s.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.location}</span>}
            {s.leadId && <span>Lead: {memberName(team, s.leadId)}</span>}
            {!!s.attendeeIds.length && <span className="flex items-center gap-1"><Users className="w-3 h-3" />{s.attendeeIds.length}</span>}
          </div>
          <BrandChips tags={s.brandTags} />
        </div>
      </button>
    );
  };
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-3xl">
      <div>
        <div className="text-xs uppercase tracking-wider text-white/30 font-semibold mb-2">Upcoming</div>
        <div className="space-y-2">{upcoming.length ? upcoming.map(Row) : <div className="text-sm text-white/30 py-6 text-center rounded-xl border border-dashed border-white/10">No sessions booked. <button onClick={onNew} className="text-pink-300 hover:underline">Plan one</button> — a shoot, a scripting session, a brainstorm.</div>}</div>
      </div>
      {!!past.length && (
        <div>
          <div className="text-xs uppercase tracking-wider text-white/30 font-semibold mb-2">Past</div>
          <div className="space-y-2 opacity-60">{past.slice(0, 20).map(Row)}</div>
        </div>
      )}
    </div>
  );
}

// ═══ SCOREBOARD (planned vs delivered) ════════════════════════════════════════
function ScoreboardView({ items, team }: { items: ContentItem[]; team: TeamMember[] }) {
  type Period = "week" | "month" | "quarter" | "year";
  const [period, setPeriod] = useState<Period>("month");
  const range = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let start: Date, end: Date;
    if (period === "week") { start = startOfWeek(now); end = new Date(start); end.setDate(start.getDate() + 6); }
    else if (period === "month") { start = new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    else if (period === "quarter") { const q = Math.floor(now.getMonth() / 3); start = new Date(now.getFullYear(), q * 3, 1); end = new Date(now.getFullYear(), q * 3 + 3, 0); }
    else { start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31); }
    return { start: toLocalDateStr(start), end: toLocalDateStr(end) };
  }, [period]);

  const inRange = (d: string | null) => !!d && d >= range.start && d <= range.end;
  // Planned = items with a planned date in the window. Delivered = items published in the window.
  const planned = items.filter(i => inRange(i.plannedDate) && i.status !== "cancelled");
  const deliveredInWindow = items.filter(i => inRange(i.publishedDate));
  const plannedDelivered = planned.filter(isDelivered);
  const onTime = planned.filter(i => i.publishedDate && i.plannedDate && i.publishedDate <= i.plannedDate).length;
  const overdue = planned.filter(i => !isDelivered(i) && i.plannedDate && i.plannedDate < toLocalDateStr(new Date())).length;
  const deliveryRate = planned.length ? Math.round((plannedDelivered.length / planned.length) * 100) : 0;

  // breakdowns over the delivered-in-window set
  const byKey = (keyFn: (i: ContentItem) => string[], labelFn: (k: string) => { label: string; color: string }) => {
    const map: Record<string, { planned: number; delivered: number }> = {};
    for (const i of planned) for (const k of keyFn(i)) { (map[k] ||= { planned: 0, delivered: 0 }).planned++; if (isDelivered(i)) map[k].delivered++; }
    return Object.entries(map).map(([k, v]) => ({ k, ...labelFn(k), ...v })).sort((a, b) => b.planned - a.planned);
  };
  const byBrand = byKey(i => i.brandTags.length ? i.brandTags : ["_none"], k => k === "_none" ? { label: "Untagged", color: "#64748b" } : brandMeta(k));
  const byChannel = byKey(i => i.channels.length ? i.channels : ["_none"], k => k === "_none" ? { label: "—", color: "#64748b" } : channelMeta(k));
  const byPerson = (() => {
    const map: Record<number, { planned: number; delivered: number }> = {};
    for (const i of planned) if (i.ownerId != null) { (map[i.ownerId] ||= { planned: 0, delivered: 0 }).planned++; if (isDelivered(i)) map[i.ownerId].delivered++; }
    return Object.entries(map).map(([id, v]) => ({ id: Number(id), name: memberName(team, Number(id)) || "?", ...v })).sort((a, b) => b.planned - a.planned);
  })();

  const Stat = ({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) => (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold">{label}</div>
      <div className="text-2xl font-bold mt-1" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
    </div>
  );
  const Bar = ({ label, color, planned, delivered }: { label: string; color: string; planned: number; delivered: number }) => (
    <div className="flex items-center gap-3">
      <div className="w-24 text-xs truncate shrink-0" style={{ color }}>{label}</div>
      <div className="flex-1 h-5 rounded bg-white/[0.04] overflow-hidden relative">
        <div className="h-full rounded" style={{ width: `${planned ? (delivered / planned) * 100 : 0}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="w-16 text-right text-xs text-white/60 shrink-0 tabular-nums">{delivered}/{planned}</div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-white/10 overflow-hidden text-xs">
          {(["week", "month", "quarter", "year"] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)} className={`px-3 h-8 capitalize ${period === p ? "bg-pink-500/20 text-pink-100" : "hover:bg-white/[0.06] text-white/60"}`}>This {p}</button>
          ))}
        </div>
        <span className="text-xs text-white/30">{fmtDate(range.start)} – {fmtDate(range.end)}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Planned" value={planned.length} sub="pieces this period" />
        <Stat label="Delivered" value={plannedDelivered.length} sub={`of ${planned.length} planned`} color="#22c55e" />
        <Stat label="Delivery rate" value={`${deliveryRate}%`} color={deliveryRate >= 80 ? "#22c55e" : deliveryRate >= 50 ? "#f59e0b" : "#ef4444"} />
        <Stat label="Overdue" value={overdue} sub="past planned date" color={overdue ? "#ef4444" : undefined} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Published (window)" value={deliveredInWindow.length} sub="actually went out" color="#22c55e" />
        <Stat label="On-time" value={onTime} sub="delivered ≤ planned" />
        <Stat label="In pipeline" value={planned.filter(i => !isDelivered(i)).length} sub="still to deliver" />
        <Stat label="Sessions" value="—" sub="see Sessions tab" />
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-sm font-semibold mb-3">By brand <span className="text-white/30 font-normal text-xs">(delivered / planned)</span></div>
          <div className="space-y-2">{byBrand.length ? byBrand.map(b => <Bar key={b.k} label={b.label} color={b.color} planned={b.planned} delivered={b.delivered} />) : <div className="text-xs text-white/30">No data</div>}</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-sm font-semibold mb-3">By channel</div>
          <div className="space-y-2">{byChannel.length ? byChannel.map(c => <Bar key={c.k} label={c.label} color={c.color} planned={c.planned} delivered={c.delivered} />) : <div className="text-xs text-white/30">No data</div>}</div>
        </div>
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-sm font-semibold mb-3">By owner</div>
        <div className="space-y-2">{byPerson.length ? byPerson.map(p => <Bar key={p.id} label={p.name} color="#8b5cf6" planned={p.planned} delivered={p.delivered} />) : <div className="text-xs text-white/30">Assign owners to see workload here</div>}</div>
      </div>
    </div>
  );
}

// ═══ MODALS ═══════════════════════════════════════════════════════════════════
function ModalShell({ title, color, onClose, children, footer, maxW = "max-w-lg" }: any) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150" onClick={onClose}>
      <div className={`w-full ${maxW} my-4 bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-200`} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between sticky top-0 bg-[#0a0e1a] rounded-t-2xl">
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ background: color }} /><h2 className="text-base font-semibold">{title}</h2></div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-white/[0.06] flex items-center justify-between gap-2">{footer}</div>}
      </div>
    </div>
  );
}
const FieldLabel = ({ children }: any) => <Label className="text-xs text-white/60 mb-1 block">{children}</Label>;
const inputCls = "bg-white/[0.04] border-white/10 text-white";
const selCls = "w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm";

function ChipMulti({ options, selected, onToggle }: { options: { key: string; label: string; color: string }[]; selected: string[]; onToggle: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => { const active = selected.includes(o.key); return (
        <button key={o.key} type="button" onClick={() => onToggle(o.key)} className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
          style={{ borderColor: active ? o.color : "hsl(var(--foreground) / 0.085)", background: active ? `${o.color}25` : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)" }}>{o.label}</button>
      ); })}
    </div>
  );
}

function ItemModal({ mode, item, plannedDate, team, saving, onClose, onSave, onDelete, onAddTask, onToggleTask, onDeleteTask, liveItem }: any) {
  const src: ContentItem | undefined = liveItem || item;
  const [title, setTitle] = useState(item?.title || "");
  const [brief, setBrief] = useState(item?.brief || "");
  const [format, setFormat] = useState(item?.format || "reel");
  const [status, setStatus] = useState(item?.status || "idea");
  const [priority, setPriority] = useState(item?.priority || "medium");
  const [channels, setChannels] = useState<string[]>(item?.channels || []);
  const [brandTags, setBrandTags] = useState<string[]>(item?.brandTags || []);
  const [planned, setPlanned] = useState(item?.plannedDate || plannedDate || "");
  const [published, setPublished] = useState(item?.publishedDate || "");
  const [ownerId, setOwnerId] = useState<string>(item?.ownerId ? String(item.ownerId) : "");
  const [photographerId, setPhotographerId] = useState<string>(item?.photographerId ? String(item.photographerId) : "");
  const [videographerId, setVideographerId] = useState<string>(item?.videographerId ? String(item.videographerId) : "");
  const [editorId, setEditorId] = useState<string>(item?.editorId ? String(item.editorId) : "");
  const [campaign, setCampaign] = useState(item?.campaign || "");
  const [assetUrl, setAssetUrl] = useState(item?.assetUrl || "");
  const [finalUrl, setFinalUrl] = useState(item?.finalUrl || "");
  const [notes, setNotes] = useState(item?.notes || "");
  const [confirmDel, setConfirmDel] = useState(false);
  // new-task draft
  const [ntTitle, setNtTitle] = useState(""); const [ntRole, setNtRole] = useState("videography"); const [ntAssignee, setNtAssignee] = useState("");

  const num = (s: string) => s ? Number(s) : null;
  const submit = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(), brief: brief.trim() || null, format, status, priority,
      channels, brandTags, plannedDate: planned || null, publishedDate: published || null,
      ownerId: num(ownerId), photographerId: num(photographerId), videographerId: num(videographerId), editorId: num(editorId),
      campaign: campaign.trim() || null, assetUrl: assetUrl.trim() || null, finalUrl: finalUrl.trim() || null, notes: notes.trim() || null,
    });
  };
  const PersonSelect = ({ value, onChange, icon: Icon, label }: any) => (
    <div>
      <FieldLabel><span className="flex items-center gap-1">{Icon && <Icon className="w-3 h-3" />}{label}</span></FieldLabel>
      <select value={value} onChange={e => onChange(e.target.value)} className={selCls}>
        <option value="">—</option>
        {team.map((t: TeamMember) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}
      </select>
    </div>
  );
  const tasks: ContentTask[] = src?.tasks || [];

  return (
    <ModalShell title={mode === "create" ? "New content" : "Edit content"} color={statusMeta(status).color} onClose={onClose} maxW="max-w-2xl"
      footer={<>
        <div>{onDelete && (confirmDel
          ? <span className="flex items-center gap-2 text-xs"><span className="text-white/50">Delete?</span><button onClick={onDelete} className="text-red-400 hover:text-red-300 font-semibold">Yes</button><button onClick={() => setConfirmDel(false)} className="text-white/50">No</button></span>
          : <button onClick={() => setConfirmDel(true)} className="text-white/30 hover:text-red-300 flex items-center gap-1 text-xs"><Trash2 className="w-3.5 h-3.5" />Delete</button>)}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!title.trim() || saving} className="bg-pink-600 hover:bg-pink-700 text-white"><Check className="w-3.5 h-3.5 mr-1" />{saving ? "Saving…" : "Save"}</Button>
        </div>
      </>}>
      <div>
        <FieldLabel>Title</FieldLabel>
        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. CIC finals hype reel" autoFocus className={inputCls} />
      </div>
      <div>
        <FieldLabel>Brief / concept</FieldLabel>
        <Textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="What is it, the hook, the message…" className={`${inputCls} min-h-[64px]`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div><FieldLabel>Format</FieldLabel><select value={format} onChange={e => setFormat(e.target.value)} className={selCls}>{CONTENT_FORMATS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select></div>
        <div><FieldLabel>Stage</FieldLabel><select value={status} onChange={e => setStatus(e.target.value)} className={selCls}>{CONTENT_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
        <div><FieldLabel>Priority</FieldLabel><select value={priority} onChange={e => setPriority(e.target.value)} className={selCls}>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select></div>
      </div>
      <div><FieldLabel>Channels</FieldLabel><ChipMulti options={CHANNELS} selected={channels} onToggle={(k) => setChannels(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])} /></div>
      <div><FieldLabel>Brands it serves</FieldLabel><ChipMulti options={BRANDS.map(b => ({ key: b.slug, label: b.label, color: b.color }))} selected={brandTags} onToggle={(k) => setBrandTags(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><FieldLabel><span className="flex items-center gap-1"><CalIcon className="w-3 h-3" />Planned date</span></FieldLabel><DatePickerInput value={planned} onChange={e => setPlanned(e.target.value)} className={`${inputCls} h-9`} /></div>
        <div><FieldLabel><span className="flex items-center gap-1"><Check className="w-3 h-3" />Delivered date</span></FieldLabel><DatePickerInput value={published} onChange={e => setPublished(e.target.value)} className={`${inputCls} h-9`} /></div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <PersonSelect value={ownerId} onChange={setOwnerId} icon={Users} label="Owner" />
        <PersonSelect value={photographerId} onChange={setPhotographerId} icon={Camera} label="Photo" />
        <PersonSelect value={videographerId} onChange={setVideographerId} icon={Video} label="Video" />
        <PersonSelect value={editorId} onChange={setEditorId} icon={Scissors} label="Editor" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div><FieldLabel><span className="flex items-center gap-1"><Megaphone className="w-3 h-3" />Campaign / pillar</span></FieldLabel><Input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="optional" className={inputCls} /></div>
        <div><FieldLabel><span className="flex items-center gap-1"><LinkIcon className="w-3 h-3" />Assets link</span></FieldLabel><Input value={assetUrl} onChange={e => setAssetUrl(e.target.value)} placeholder="Drive / Frame.io" className={inputCls} /></div>
        <div><FieldLabel><span className="flex items-center gap-1"><ExternalLink className="w-3 h-3" />Published link</span></FieldLabel><Input value={finalUrl} onChange={e => setFinalUrl(e.target.value)} placeholder="live post URL" className={inputCls} /></div>
      </div>
      <div><FieldLabel>Notes</FieldLabel><Textarea value={notes} onChange={e => setNotes(e.target.value)} className={`${inputCls} min-h-[48px]`} /></div>

      {/* checklist — divvy up the work */}
      <div className="border-t border-white/[0.06] pt-4">
        <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2">Tasks — divvy up the work</div>
        {mode === "create" ? (
          <div className="text-[11px] text-white/30">Save the content first, then add photography / videography / editing tasks and assign them.</div>
        ) : (
          <div className="space-y-2">
            {tasks.map(t => (
              <div key={t.id} className="flex items-center gap-2 text-sm">
                <button onClick={() => onToggleTask(t)} className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${t.done ? "bg-emerald-500 border-emerald-500" : "border-white/20"}`}>{t.done && <Check className="w-3 h-3 text-white" />}</button>
                <span className={`flex-1 truncate ${t.done ? "line-through text-white/40" : ""}`}>{t.title}</span>
                <span className="text-[10px] text-white/40 bg-white/[0.06] px-1.5 py-0.5 rounded">{roleLabel(t.role)}</span>
                {t.assigneeId && <Avatar name={memberName(team, t.assigneeId)} />}
                {t.dueDate && <span className="text-[10px] text-white/40">{fmtDate(t.dueDate)}</span>}
                <button onClick={() => onDeleteTask(t.id)} className="text-white/20 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Input value={ntTitle} onChange={e => setNtTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && ntTitle.trim()) { onAddTask({ title: ntTitle.trim(), role: ntRole, assigneeId: ntAssignee || null }); setNtTitle(""); } }} placeholder="Add a task…" className={`${inputCls} h-8 flex-1`} />
              <select value={ntRole} onChange={e => setNtRole(e.target.value)} className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-1.5 text-xs">{PRODUCTION_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
              <select value={ntAssignee} onChange={e => setNtAssignee(e.target.value)} className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-1.5 text-xs max-w-[110px]"><option value="">Anyone</option>{team.map((t: TeamMember) => <option key={t.id} value={t.id}>{t.first_name}</option>)}</select>
              <button onClick={() => { if (ntTitle.trim()) { onAddTask({ title: ntTitle.trim(), role: ntRole, assigneeId: ntAssignee || null }); setNtTitle(""); } }} className="w-8 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function SessionModal({ mode, session, day, team, saving, onClose, onSave, onDelete }: any) {
  const initDay = session ? sessionDay(session) : (day || toLocalDateStr(new Date()));
  const initStart = session && !session.allDay ? new Date(session.startAt).toTimeString().slice(0, 5) : "10:00";
  const initEnd = session?.endAt ? new Date(session.endAt).toTimeString().slice(0, 5) : "11:00";
  const [title, setTitle] = useState(session?.title || "");
  const [sessionType, setSessionType] = useState(session?.sessionType || "shoot");
  const [dateStr, setDateStr] = useState(initDay);
  const [allDay, setAllDay] = useState(session?.allDay || false);
  const [startT, setStartT] = useState(initStart);
  const [endT, setEndT] = useState(initEnd);
  const [location, setLocation] = useState(session?.location || "");
  const [leadId, setLeadId] = useState<string>(session?.leadId ? String(session.leadId) : "");
  const [attendeeIds, setAttendeeIds] = useState<number[]>(session?.attendeeIds || []);
  const [brandTags, setBrandTags] = useState<string[]>(session?.brandTags || []);
  const [notes, setNotes] = useState(session?.notes || "");
  const [confirmDel, setConfirmDel] = useState(false);

  const submit = () => {
    if (!title.trim() || !dateStr) return;
    const startAt = new Date(`${dateStr}T${allDay ? "00:00" : startT}:00`).toISOString();
    const endAt = allDay ? null : new Date(`${dateStr}T${endT}:00`).toISOString();
    onSave({ title: title.trim(), sessionType, startAt, endAt, allDay, location: location.trim() || null, leadId: leadId ? Number(leadId) : null, attendeeIds, brandTags, notes: notes.trim() || null });
  };
  return (
    <ModalShell title={mode === "create" ? "New session" : "Edit session"} color={sessionMeta(sessionType).color} onClose={onClose}
      footer={<>
        <div>{onDelete && (confirmDel
          ? <span className="flex items-center gap-2 text-xs"><span className="text-white/50">Delete?</span><button onClick={onDelete} className="text-red-400 hover:text-red-300 font-semibold">Yes</button><button onClick={() => setConfirmDel(false)} className="text-white/50">No</button></span>
          : <button onClick={() => setConfirmDel(true)} className="text-white/30 hover:text-red-300 flex items-center gap-1 text-xs"><Trash2 className="w-3.5 h-3.5" />Delete</button>)}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!title.trim() || saving} className="bg-pink-600 hover:bg-pink-700 text-white"><Check className="w-3.5 h-3.5 mr-1" />{saving ? "Saving…" : "Save"}</Button>
        </div>
      </>}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2"><FieldLabel>Title</FieldLabel><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. First-team shoot @ Garrick" autoFocus className={inputCls} /></div>
        <div><FieldLabel>Type</FieldLabel><select value={sessionType} onChange={e => setSessionType(e.target.value)} className={selCls}>{SESSION_TYPES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
        <div><FieldLabel>Date</FieldLabel><DatePickerInput value={dateStr} onChange={e => setDateStr(e.target.value)} className={`${inputCls} h-9`} /></div>
        <div><FieldLabel>Start</FieldLabel><Input type="time" value={startT} onChange={e => setStartT(e.target.value)} disabled={allDay} className={`${inputCls} h-9 ${allDay ? "opacity-40" : ""}`} /></div>
        <div><FieldLabel>End</FieldLabel><Input type="time" value={endT} onChange={e => setEndT(e.target.value)} disabled={allDay} className={`${inputCls} h-9 ${allDay ? "opacity-40" : ""}`} /></div>
        <label className="flex items-center gap-2 text-xs text-white/60 h-9"><input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} className="accent-pink-500 w-4 h-4" />All day</label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><FieldLabel><span className="flex items-center gap-1"><MapPin className="w-3 h-3" />Location</span></FieldLabel><Input value={location} onChange={e => setLocation(e.target.value)} placeholder="optional" className={inputCls} /></div>
        <div><FieldLabel>Lead</FieldLabel><select value={leadId} onChange={e => setLeadId(e.target.value)} className={selCls}><option value="">—</option>{team.map((t: TeamMember) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select></div>
      </div>
      <div>
        <FieldLabel>Who's in</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {team.map((t: TeamMember) => { const active = attendeeIds.includes(t.id); return (
            <button key={t.id} type="button" onClick={() => setAttendeeIds(prev => active ? prev.filter(x => x !== t.id) : [...prev, t.id])}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border transition"
              style={{ borderColor: active ? "#ec4899" : "hsl(var(--foreground) / 0.085)", background: active ? "#ec489925" : "transparent", color: active ? "hsl(var(--foreground) / 1)" : "hsl(var(--foreground) / 0.88)" }}>{t.first_name}</button>
          ); })}
          {!team.length && <span className="text-[11px] text-white/30">No team members yet — add staff in the Team tab.</span>}
        </div>
      </div>
      <div><FieldLabel>Brands</FieldLabel><ChipMulti options={BRANDS.map(b => ({ key: b.slug, label: b.label, color: b.color }))} selected={brandTags} onToggle={(k) => setBrandTags(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])} /></div>
      <div><FieldLabel>Notes</FieldLabel><Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Agenda, shot list, gear…" className={`${inputCls} min-h-[56px]`} /></div>
    </ModalShell>
  );
}
