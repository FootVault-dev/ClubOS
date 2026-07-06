// Volunteers tab — reusable across workspaces (CIC tournament, CUFC academy, SIU).
// A full signup → review → allocate → track-hours pipeline:
//   1. Review queue   — new signups from the public /volunteer form, approve/decline
//   2. Roster matrix  — volunteer × day, allocate a task (Car park, Boots, Music…) per cell
//   3. Hours ledger   — logged vs target hours (the academy "20 hours a year" tracker)
//   4. Directory      — manage every volunteer's contact, status, academy flag, notes
// Org-scoped server-side (x-workspace-slug), so each workspace sees only its own
// volunteers. For CIC the matrix defaults to the 5–16 July tournament window.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspace } from "@/lib/workspace-context";
import {
  HeartHandshake, Plus, X, Check, Users, CalendarDays, Clock, CheckCircle2,
  ChevronLeft, ChevronRight, Trash2, Settings2, Phone, Mail, MapPin, Cake,
  GraduationCap, ExternalLink, Inbox, Pencil, AlertTriangle, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

const CIC_SLUG = "christchurch-international-cup";
const CIC_WINDOW = { start: "2026-07-05", days: 12 };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  new:       { label: "New — review",  cls: "text-amber-300 bg-amber-400/10 border-amber-400/25" },
  reviewing: { label: "Reviewing",     cls: "text-sky-300 bg-sky-400/10 border-sky-400/25" },
  approved:  { label: "Approved",      cls: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
  active:    { label: "Active",        cls: "text-emerald-200 bg-emerald-400/15 border-emerald-400/30" },
  declined:  { label: "Declined",      cls: "text-red-300 bg-red-400/10 border-red-400/25" },
  inactive:  { label: "Inactive",      cls: "text-white/40 bg-white/5 border-white/10" },
};
const ALL_STATUSES = ["new", "reviewing", "approved", "active", "declined", "inactive"] as const;

interface Volunteer {
  id: number; firstName: string; lastName: string | null; email: string; phone: string | null;
  dateOfBirth: string | null; location: string | null; status: string;
  isAcademyPlayer: boolean; academyAgeGroup: string | null; hoursTarget: number | null;
  availability: string[]; interests: string[]; emergencyContact: string | null;
  tshirtSize: string | null; notes: string | null; reviewNotes: string | null;
  sourceUrl: string | null; createdAt: string;
}
interface TaskType { id: number; name: string; color: string; active: boolean; sortOrder: number; }
interface Assignment { id: number; volunteerId: number; taskTypeId: number | null; assignmentDate: string; hours: number; completed: boolean; notes: string | null; }

// ── date helpers ──
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function dayList(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  return {
    weekday: dt.toLocaleDateString("en-NZ", { weekday: "short" }),
    day: dt.getDate(),
    month: dt.toLocaleDateString("en-NZ", { month: "short" }),
    weekend: dow === 0 || dow === 6,
  };
}
function ageFrom(dob: string | null): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  return a;
}
const fullName = (v: Volunteer) => `${v.firstName}${v.lastName ? " " + v.lastName : ""}`.trim();
const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function Volunteers() {
  const { toast } = useToast();
  const { currentOrg } = useWorkspace();
  const isCic = currentOrg?.slug === CIC_SLUG;

  const [winStart, setWinStart] = useState<string>(() => (isCic ? CIC_WINDOW.start : todayIso()));
  const winLen = isCic ? CIC_WINDOW.days : 14;
  const days = useMemo(() => dayList(winStart, winLen), [winStart, winLen]);

  const [showAllInMatrix, setShowAllInMatrix] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [detail, setDetail] = useState<Volunteer | null>(null);

  const { data: volunteers = [], isLoading: vLoading } = useQuery<Volunteer[]>({ queryKey: ["/api/admin/volunteers"] });
  const { data: taskTypes = [] } = useQuery<TaskType[]>({ queryKey: ["/api/admin/volunteers/task-types"] });
  const { data: assignments = [], isLoading: aLoading } = useQuery<Assignment[]>({ queryKey: ["/api/admin/volunteers/assignments"] });

  const onErr = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });
  const invalidate = (keys: string[] = ["/api/admin/volunteers", "/api/admin/volunteers/assignments", "/api/admin/volunteers/task-types"]) =>
    keys.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));

  const createVolunteer = useMutation({ mutationFn: (d: any) => apiRequest("POST", "/api/admin/volunteers", d), onSuccess: () => invalidate(["/api/admin/volunteers"]), onError: onErr });
  const patchVolunteer = useMutation({ mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/volunteers/${id}`, data), onSuccess: () => invalidate(["/api/admin/volunteers"]), onError: onErr });
  const deleteVolunteer = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/volunteers/${id}`), onSuccess: () => invalidate(), onError: onErr });
  const upsertAssignment = useMutation({ mutationFn: (d: any) => apiRequest("POST", "/api/admin/volunteers/assignments", d), onSuccess: () => invalidate(["/api/admin/volunteers/assignments"]), onError: onErr });
  const patchAssignment = useMutation({ mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/volunteers/assignments/${id}`, data), onSuccess: () => invalidate(["/api/admin/volunteers/assignments"]), onError: onErr });
  const deleteAssignment = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/volunteers/assignments/${id}`), onSuccess: () => invalidate(["/api/admin/volunteers/assignments"]), onError: onErr });

  const taskById = useMemo(() => new Map(taskTypes.map((t) => [t.id, t])), [taskTypes]);
  const activeTasks = useMemo(() => taskTypes.filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder), [taskTypes]);

  // assignment lookup: "volId|date" -> Assignment
  const asgByKey = useMemo(() => {
    const m = new Map<string, Assignment>();
    for (const a of assignments) m.set(`${a.volunteerId}|${a.assignmentDate}`, a);
    return m;
  }, [assignments]);

  const newVolunteers = useMemo(() => volunteers.filter((v) => v.status === "new"), [volunteers]);
  const rosterVolunteers = useMemo(() => {
    const withAssignments = new Set(assignments.map((a) => a.volunteerId));
    return volunteers
      .filter((v) => showAllInMatrix
        ? v.status !== "declined"
        : v.status === "approved" || v.status === "active" || withAssignments.has(v.id))
      .sort((a, b) => Number(b.isAcademyPlayer) - Number(a.isAcademyPlayer) || fullName(a).localeCompare(fullName(b)));
  }, [volunteers, assignments, showAllInMatrix]);

  // per-day count (over roster volunteers)
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const iso of days) m.set(iso, rosterVolunteers.filter((v) => asgByKey.has(`${v.id}|${iso}`)).length);
    return m;
  }, [days, rosterVolunteers, asgByKey]);

  const stats = useMemo(() => {
    const active = volunteers.filter((v) => v.status === "approved" || v.status === "active").length;
    const daysCovered = days.filter((iso) => (perDay.get(iso) || 0) > 0).length;
    const loggedHours = assignments.filter((a) => a.completed).reduce((s, a) => s + (a.hours || 0), 0);
    const plannedHours = assignments.reduce((s, a) => s + (a.hours || 0), 0);
    return { total: volunteers.length, active, daysCovered, loggedHours, plannedHours };
  }, [volunteers, days, perDay, assignments]);

  const setCell = (volunteerId: number, iso: string, taskTypeId: number | null) =>
    upsertAssignment.mutate({ volunteerId, assignmentDate: iso, taskTypeId });

  const loading = vLoading || aLoading;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <HeartHandshake className="w-6 h-6 text-amber-400" />
            Volunteers
          </h1>
          <p className="text-sm text-white/40 mt-1 max-w-2xl">
            {isCic
              ? "Everyone helping across the CIC · 5–16 July. Review new signups, allocate a task per day, and track volunteer hours."
              : "Your volunteer roster — review signups, allocate tasks per day, and track volunteer hours (incl. academy hours)."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isCic && (
            <a href="https://cicyouth.com/volunteer" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-white/10 bg-white/[0.03] text-white/70 text-sm hover:text-white hover:border-white/20 transition">
              <ExternalLink className="w-3.5 h-3.5" /> Signup page
            </a>
          )}
          <Button variant="outline" className="gap-1.5 h-9" onClick={() => setTasksOpen(true)}>
            <Settings2 className="w-4 h-4" /> Tasks
          </Button>
          <Button className="gap-1.5 h-9" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" /> Add volunteer
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Volunteers", value: stats.total, icon: Users },
          { label: "Approved / active", value: stats.active, icon: CheckCircle2 },
          { label: isCic ? "Days covered" : "Days covered (window)", value: `${stats.daysCovered}/${days.length}`, icon: CalendarDays },
          { label: "Hours logged", value: hrs(stats.loggedHours), icon: Clock },
        ].map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5"><s.icon className="w-3.5 h-3.5" /> {s.label}</div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-white/30 py-16">Loading volunteers…</div>
      ) : (
        <>
          {/* Review queue */}
          {newVolunteers.length > 0 && (
            <section className="bg-amber-400/[0.04] border border-amber-400/20 rounded-2xl p-5">
              <h2 className="text-sm font-semibold text-amber-300 uppercase tracking-wide mb-3 flex items-center gap-2">
                <Inbox className="w-4 h-4" /> New signups to review ({newVolunteers.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {newVolunteers.map((v) => (
                  <ReviewCard key={v.id} v={v}
                    onApprove={() => patchVolunteer.mutate({ id: v.id, data: { status: "approved" } })}
                    onDecline={() => patchVolunteer.mutate({ id: v.id, data: { status: "declined" } })}
                    onOpen={() => setDetail(v)} />
                ))}
              </div>
            </section>
          )}

          {/* Roster matrix */}
          <section className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Roster — who's on, and doing what</h2>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-white/45 cursor-pointer select-none">
                  <Switch checked={showAllInMatrix} onCheckedChange={setShowAllInMatrix} /> Show everyone
                </label>
                <div className="flex items-center gap-1">
                  <button onClick={() => setWinStart(addDays(winStart, -winLen))} className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.03] text-white/60 hover:text-white flex items-center justify-center" title="Earlier"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setWinStart(addDays(winStart, winLen))} className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.03] text-white/60 hover:text-white flex items-center justify-center" title="Later"><ChevronRight className="w-4 h-4" /></button>
                  {isCic && winStart !== CIC_WINDOW.start && (
                    <button onClick={() => setWinStart(CIC_WINDOW.start)} className="ml-1 h-8 px-2.5 rounded-lg border border-white/10 bg-white/[0.03] text-white/60 hover:text-white text-xs">Tournament</button>
                  )}
                </div>
              </div>
            </div>

            {activeTasks.length > 0 && (
              <div className="flex items-center gap-3 flex-wrap text-xs text-white/45">
                {activeTasks.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded" style={{ background: t.color }} /> {t.name}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-dashed border-white/25" /> Rostered, task TBD</span>
              </div>
            )}

            <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-20 bg-[#15171c] text-left px-4 py-3 min-w-[180px] border-b border-r border-white/5 text-white/50 font-medium text-xs uppercase tracking-wide">Volunteer</th>
                      {days.map((iso) => {
                        const f = fmtDay(iso);
                        const count = perDay.get(iso) || 0;
                        return (
                          <th key={iso} className={`px-2 py-2 border-b border-white/5 text-center min-w-[70px] ${f.weekend ? "bg-amber-400/[0.04]" : ""}`}>
                            <div className="text-white/45 text-[10px] uppercase">{f.weekday}</div>
                            <div className="text-white font-bold leading-tight">{f.day}</div>
                            <div className="text-white/35 text-[10px]">{f.month}</div>
                            <div className={`mt-1 text-[10px] font-bold tabular-nums ${count > 0 ? "text-emerald-400" : "text-white/25"}`} title={`${count} volunteers`}>
                              <Users className="w-2.5 h-2.5 inline -mt-0.5" /> {count}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rosterVolunteers.length === 0 ? (
                      <tr><td colSpan={days.length + 1} className="text-center text-white/30 py-12">
                        No volunteers to roster yet. Approve a signup above, add one, or toggle "Show everyone".
                      </td></tr>
                    ) : rosterVolunteers.map((v) => (
                      <tr key={v.id} className="group">
                        <td className="sticky left-0 z-10 bg-[#15171c] px-4 py-2.5 border-b border-r border-white/5 min-w-[180px]">
                          <button onClick={() => setDetail(v)} className="text-left w-full">
                            <div className="text-white font-medium truncate flex items-center gap-1.5">
                              {fullName(v)}
                              {v.isAcademyPlayer && <GraduationCap className="w-3.5 h-3.5 text-amber-300 shrink-0" />}
                            </div>
                            <div className="text-white/35 text-[11px] flex items-center gap-1.5">
                              {v.status !== "approved" && v.status !== "active" && <span className={`px-1.5 py-0.5 rounded text-[9px] border ${STATUS_META[v.status]?.cls}`}>{STATUS_META[v.status]?.label}</span>}
                              {(() => { const a = ageFrom(v.dateOfBirth); return a != null ? <span className={a < 18 ? "text-amber-300/80" : ""}>{a}y{a < 18 ? " ·U18" : ""}</span> : null; })()}
                            </div>
                          </button>
                        </td>
                        {days.map((iso) => (
                          <MatrixCell
                            key={iso}
                            iso={iso}
                            weekend={fmtDay(iso).weekend}
                            assignment={asgByKey.get(`${v.id}|${iso}`)}
                            task={(() => { const a = asgByKey.get(`${v.id}|${iso}`); return a?.taskTypeId != null ? taskById.get(a.taskTypeId) : undefined; })()}
                            tasks={activeTasks}
                            onPick={(taskTypeId) => setCell(v.id, iso, taskTypeId)}
                            onHours={(h, id) => patchAssignment.mutate({ id, data: { hours: h } })}
                            onCompleted={(c, id) => patchAssignment.mutate({ id, data: { completed: c } })}
                            onRemove={(id) => deleteAssignment.mutate(id)}
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {activeTasks.length === 0 && (
              <p className="text-xs text-amber-300/70 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> No tasks defined yet — add some under "Tasks" to start allocating.</p>
            )}
          </section>

          {/* Hours ledger */}
          <HoursLedger volunteers={volunteers} assignments={assignments} onOpen={setDetail} />

          {/* Directory */}
          <section>
            <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide mb-3">Directory ({volunteers.length})</h2>
            {volunteers.length === 0 ? (
              <div className="text-center text-white/30 py-10 border border-dashed border-white/10 rounded-2xl">
                No volunteers yet. Share the signup page or add one manually.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {volunteers.map((v) => (
                  <DirectoryCard key={v.id} v={v}
                    assignedDays={assignments.filter((a) => a.volunteerId === v.id).length}
                    onOpen={() => setDetail(v)}
                    onStatus={(status) => patchVolunteer.mutate({ id: v.id, data: { status } })} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <AddVolunteerDialog open={addOpen} onOpenChange={setAddOpen} onCreate={(d) => createVolunteer.mutate(d, { onSuccess: () => setAddOpen(false) })} pending={createVolunteer.isPending} />
      <TaskManagerDialog open={tasksOpen} onOpenChange={setTasksOpen} tasks={taskTypes} onRefresh={() => invalidate(["/api/admin/volunteers/task-types"])} />
      {detail && (
        <VolunteerDetailDialog
          v={detail}
          onOpenChange={(o) => !o && setDetail(null)}
          onSave={(data) => patchVolunteer.mutate({ id: detail.id, data }, { onSuccess: (_r: any) => setDetail((prev) => prev ? { ...prev, ...data } : prev) })}
          onDelete={() => { deleteVolunteer.mutate(detail.id); setDetail(null); }}
          saving={patchVolunteer.isPending}
        />
      )}
    </div>
  );
}

// ── Matrix cell — a Popover to pick task / hours / completed / remove ──
function MatrixCell({ iso, weekend, assignment, task, tasks, onPick, onHours, onCompleted, onRemove }: {
  iso: string; weekend: boolean; assignment?: Assignment; task?: TaskType; tasks: TaskType[];
  onPick: (taskTypeId: number | null) => void; onHours: (h: number, id: number) => void;
  onCompleted: (c: boolean, id: number) => void; onRemove: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const booked = !!assignment;
  const color = task?.color;
  const short = task ? task.name : booked ? "TBD" : "";

  return (
    <td className={`p-1 border-b border-white/5 text-center ${weekend ? "bg-amber-400/[0.02]" : ""}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="w-full h-10 rounded-md flex flex-col items-center justify-center transition-all overflow-hidden px-0.5"
            title={booked ? `${task ? task.name : "Task TBD"} · ${hrs(assignment!.hours)}h${assignment!.completed ? " · done" : ""}` : "Add"}
            style={booked
              ? { background: color ? `${color}26` : "rgba(255,255,255,0.05)", boxShadow: `inset 0 0 0 1px ${color || "rgba(255,255,255,0.18)"}` }
              : { background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.10)" }}
          >
            {booked ? (
              <>
                <span className="text-[10px] font-bold leading-tight truncate max-w-full" style={{ color: color || "#ffffff" }}>{short}</span>
                <span className="text-[9px] text-white/45 leading-tight flex items-center gap-0.5">
                  {assignment!.completed && <Check className="w-2.5 h-2.5 text-emerald-400" strokeWidth={3} />}{hrs(assignment!.hours)}h
                </span>
              </>
            ) : (
              <Plus className="w-3.5 h-3.5 text-white/15 group-hover:text-white/30" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2 bg-[#15171c] border-white/10" align="center">
          <div className="text-[11px] text-white/40 px-1 pb-1.5">{fmtDay(iso).weekday} {fmtDay(iso).day} {fmtDay(iso).month}</div>
          <div className="max-h-52 overflow-y-auto space-y-0.5">
            <button onClick={() => { onPick(null); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-white/5 ${assignment && assignment.taskTypeId == null ? "bg-white/5" : ""}`}>
              <span className="w-3 h-3 rounded border border-dashed border-white/30 shrink-0" />
              <span className="text-white/70 flex-1">Rostered (task TBD)</span>
              {assignment && assignment.taskTypeId == null && <Check className="w-3.5 h-3.5 text-emerald-400" />}
            </button>
            {tasks.map((t) => (
              <button key={t.id} onClick={() => { onPick(t.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-white/5 ${assignment?.taskTypeId === t.id ? "bg-white/5" : ""}`}>
                <span className="w-3 h-3 rounded shrink-0" style={{ background: t.color }} />
                <span className="text-white/85 flex-1 truncate">{t.name}</span>
                {assignment?.taskTypeId === t.id && <Check className="w-3.5 h-3.5 text-emerald-400" />}
              </button>
            ))}
          </div>
          {assignment && (
            <div className="border-t border-white/10 mt-2 pt-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-white/50">Hours</span>
                <input type="number" min={0} max={24} step={0.5} defaultValue={assignment.hours}
                  onBlur={(e) => { const h = Math.max(0, Math.min(24, Number(e.target.value) || 0)); if (h !== assignment.hours) onHours(h, assignment.id); }}
                  className="w-16 h-7 rounded-md bg-white/5 border border-white/10 text-white text-xs px-2 text-right" />
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-xs text-white/50">Hours served (counts)</span>
                <Switch checked={assignment.completed} onCheckedChange={(c) => onCompleted(c, assignment.id)} />
              </label>
              <button onClick={() => { onRemove(assignment.id); setOpen(false); }}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs text-red-300/80 hover:text-red-300 hover:bg-red-400/10">
                <Trash2 className="w-3.5 h-3.5" /> Remove from this day
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </td>
  );
}

// ── Review card (new signup) ──
function ReviewCard({ v, onApprove, onDecline, onOpen }: { v: Volunteer; onApprove: () => void; onDecline: () => void; onOpen: () => void }) {
  const age = ageFrom(v.dateOfBirth);
  return (
    <div className="bg-[#15171c] border border-white/8 rounded-xl p-3.5 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="text-left min-w-0">
          <div className="text-white font-semibold truncate flex items-center gap-1.5">
            {fullName(v)}
            {v.isAcademyPlayer && <span className="text-[9px] font-bold uppercase text-amber-300 bg-amber-400/15 px-1.5 py-0.5 rounded shrink-0">Academy{v.academyAgeGroup ? ` ${v.academyAgeGroup}` : ""}</span>}
          </div>
          <div className="text-white/40 text-xs mt-0.5">{age != null ? `${age} yrs` : ""}{age != null && age < 18 ? " · under 18" : ""}</div>
        </button>
      </div>
      <div className="space-y-1 text-xs text-white/55">
        {v.phone && <div className="flex items-center gap-1.5"><Phone className="w-3 h-3 shrink-0" /> {v.phone}</div>}
        <div className="flex items-center gap-1.5 truncate"><Mail className="w-3 h-3 shrink-0" /> {v.email}</div>
        {v.location && <div className="flex items-center gap-1.5"><MapPin className="w-3 h-3 shrink-0" /> {v.location}</div>}
      </div>
      {v.interests.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {v.interests.slice(0, 5).map((i) => <span key={i} className="text-[10px] text-white/60 bg-white/5 px-1.5 py-0.5 rounded">{i}</span>)}
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" className="h-8 flex-1 gap-1" onClick={onApprove}><Check className="w-3.5 h-3.5" /> Approve</Button>
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={onDecline}><X className="w-3.5 h-3.5" /> Decline</Button>
      </div>
    </div>
  );
}

// ── Hours ledger ──
function HoursLedger({ volunteers, assignments, onOpen }: { volunteers: Volunteer[]; assignments: Assignment[]; onOpen: (v: Volunteer) => void }) {
  const rows = useMemo(() => {
    const planned = new Map<number, number>();
    const logged = new Map<number, number>();
    for (const a of assignments) {
      planned.set(a.volunteerId, (planned.get(a.volunteerId) || 0) + (a.hours || 0));
      if (a.completed) logged.set(a.volunteerId, (logged.get(a.volunteerId) || 0) + (a.hours || 0));
    }
    return volunteers
      .map((v) => ({ v, planned: planned.get(v.id) || 0, logged: logged.get(v.id) || 0 }))
      .filter((r) => r.planned > 0 || r.logged > 0 || r.v.hoursTarget != null)
      .sort((a, b) => Number(b.v.isAcademyPlayer) - Number(a.v.isAcademyPlayer) || b.logged - a.logged);
  }, [volunteers, assignments]);

  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide mb-3 flex items-center gap-2">
        <Clock className="w-4 h-4" /> Volunteer hours
      </h2>
      <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-white/40 text-xs uppercase tracking-wide border-b border-white/5">
                <th className="px-4 py-2.5 font-medium">Volunteer</th>
                <th className="px-3 py-2.5 font-medium text-right">Logged</th>
                <th className="px-3 py-2.5 font-medium text-right">Planned</th>
                <th className="px-3 py-2.5 font-medium text-right">Target</th>
                <th className="px-4 py-2.5 font-medium w-40">Progress</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ v, planned, logged }) => {
                const target = v.hoursTarget ?? null;
                const pct = target ? Math.min(100, Math.round((logged / target) * 100)) : null;
                const done = target != null && logged >= target;
                return (
                  <tr key={v.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <button onClick={() => onOpen(v)} className="text-white/90 hover:text-white flex items-center gap-1.5">
                        {fullName(v)}
                        {v.isAcademyPlayer && <GraduationCap className="w-3.5 h-3.5 text-amber-300" />}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-white">{hrs(logged)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/50">{hrs(planned)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/50">{target != null ? hrs(target) : "—"}</td>
                    <td className="px-4 py-2.5">
                      {target != null ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div className={`h-full rounded-full ${done ? "bg-emerald-400" : "bg-amber-400"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`text-[11px] tabular-nums ${done ? "text-emerald-400" : "text-white/50"}`}>{pct}%</span>
                        </div>
                      ) : <span className="text-white/25 text-xs">no target</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ── Directory card ──
function DirectoryCard({ v, assignedDays, onOpen, onStatus }: { v: Volunteer; assignedDays: number; onOpen: () => void; onStatus: (s: string) => void }) {
  const age = ageFrom(v.dateOfBirth);
  const meta = STATUS_META[v.status] ?? STATUS_META.new;
  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="text-left min-w-0">
          <div className="text-white font-semibold truncate flex items-center gap-1.5">
            {fullName(v)}
            {v.isAcademyPlayer && <GraduationCap className="w-3.5 h-3.5 text-amber-300 shrink-0" />}
          </div>
          <div className="text-white/35 text-xs mt-0.5">
            {assignedDays} day{assignedDays === 1 ? "" : "s"}{age != null ? ` · ${age}y${age < 18 ? " ·U18" : ""}` : ""}
          </div>
        </button>
        <button onClick={onOpen} className="text-white/25 hover:text-white/60 shrink-0" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
      </div>
      <div className="space-y-1 text-xs text-white/55">
        {v.phone && <div className="flex items-center gap-1.5"><Phone className="w-3 h-3 shrink-0" /> {v.phone}</div>}
        <div className="flex items-center gap-1.5 truncate"><Mail className="w-3 h-3 shrink-0" /> {v.email}</div>
      </div>
      <select value={v.status} onChange={(e) => onStatus(e.target.value)}
        className={`w-full h-8 rounded-md border text-xs px-2 ${meta.cls}`}>
        {ALL_STATUSES.map((s) => <option key={s} value={s} className="bg-[#15171c] text-white">{STATUS_META[s].label}</option>)}
      </select>
    </div>
  );
}

// ── Add volunteer dialog ──
function AddVolunteerDialog({ open, onOpenChange, onCreate, pending }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: any) => void; pending: boolean }) {
  const [f, setF] = useState<any>({ firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", location: "", status: "approved", isAcademyPlayer: false, academyAgeGroup: "", hoursTarget: "" });
  const set = (k: string) => (e: any) => setF((p: any) => ({ ...p, [k]: e.target.value }));
  const submit = () => {
    if (!f.firstName.trim()) return;
    if (!/.+@.+\..+/.test(f.email)) return;
    onCreate({ ...f, hoursTarget: f.hoursTarget === "" ? null : Number(f.hoursTarget) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#15171c] border-white/10 text-white max-w-md">
        <DialogHeader><DialogTitle>Add a volunteer</DialogTitle>
          <DialogDescription className="text-white/40">Manually add someone to the roster. Signups from the public form arrive automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="First name *" value={f.firstName} onChange={set("firstName")} />
            <Input placeholder="Last name" value={f.lastName} onChange={set("lastName")} />
          </div>
          <Input type="email" placeholder="Email *" value={f.email} onChange={set("email")} />
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Phone" value={f.phone} onChange={set("phone")} />
            <Input placeholder="City" value={f.location} onChange={set("location")} />
          </div>
          <div>
            <Label className="text-xs text-white/50">Date of birth</Label>
            <Input type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} className="mt-1" />
          </div>
          <label className="flex items-center justify-between gap-2 py-1">
            <span className="text-sm text-white/70 flex items-center gap-1.5"><GraduationCap className="w-4 h-4 text-amber-300" /> Academy player (volunteer hours)</span>
            <Switch checked={f.isAcademyPlayer} onCheckedChange={(c) => setF((p: any) => ({ ...p, isAcademyPlayer: c, hoursTarget: c && !p.hoursTarget ? 20 : p.hoursTarget }))} />
          </label>
          {f.isAcademyPlayer && (
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Age group (e.g. U14)" value={f.academyAgeGroup} onChange={set("academyAgeGroup")} />
              <Input type="number" placeholder="Hours target" value={f.hoursTarget} onChange={set("hoursTarget")} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending || !f.firstName.trim() || !/.+@.+\..+/.test(f.email)}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />} Add volunteer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Task types manager ──
function TaskManagerDialog({ open, onOpenChange, tasks, onRefresh }: { open: boolean; onOpenChange: (o: boolean) => void; tasks: TaskType[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#60a5fa");
  const onErr = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });
  const create = useMutation({ mutationFn: (d: any) => apiRequest("POST", "/api/admin/volunteers/task-types", d), onSuccess: () => { setName(""); onRefresh(); }, onError: onErr });
  const patch = useMutation({ mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/volunteers/task-types/${id}`, data), onSuccess: onRefresh, onError: onErr });
  const del = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/volunteers/task-types/${id}`), onSuccess: onRefresh, onError: onErr });
  const sorted = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#15171c] border-white/10 text-white max-w-md">
        <DialogHeader><DialogTitle>Volunteer tasks</DialogTitle>
          <DialogDescription className="text-white/40">The jobs you allocate to volunteers on the roster (Car park, Boots, Music…).</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {sorted.map((t) => (
            <div key={t.id} className="flex items-center gap-2 bg-white/[0.03] border border-white/5 rounded-lg px-2.5 py-1.5">
              <input type="color" value={t.color} onChange={(e) => patch.mutate({ id: t.id, data: { color: e.target.value } })} className="w-6 h-6 rounded cursor-pointer bg-transparent border-0 p-0" title="Colour" />
              <span className={`flex-1 text-sm ${t.active ? "text-white/90" : "text-white/35 line-through"}`}>{t.name}</span>
              <button onClick={() => patch.mutate({ id: t.id, data: { active: !t.active } })} className="text-[11px] text-white/40 hover:text-white/70 px-1.5">{t.active ? "Hide" : "Show"}</button>
              <button onClick={() => del.mutate(t.id)} className="text-white/25 hover:text-red-400" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {sorted.length === 0 && <p className="text-sm text-white/30 py-4 text-center">No tasks yet.</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 pt-3">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-9 h-9 rounded cursor-pointer bg-transparent border-0 p-0" />
          <Input placeholder="New task name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create.mutate({ name: name.trim(), color }); }} className="flex-1" />
          <Button onClick={() => name.trim() && create.mutate({ name: name.trim(), color })} disabled={!name.trim() || create.isPending}>Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Volunteer detail / edit dialog ──
function VolunteerDetailDialog({ v, onOpenChange, onSave, onDelete, saving }: {
  v: Volunteer; onOpenChange: (o: boolean) => void; onSave: (d: any) => void; onDelete: () => void; saving: boolean;
}) {
  const [f, setF] = useState<any>({
    firstName: v.firstName, lastName: v.lastName ?? "", email: v.email, phone: v.phone ?? "",
    dateOfBirth: v.dateOfBirth ?? "", location: v.location ?? "", status: v.status,
    isAcademyPlayer: v.isAcademyPlayer, academyAgeGroup: v.academyAgeGroup ?? "",
    hoursTarget: v.hoursTarget ?? "", emergencyContact: v.emergencyContact ?? "",
    interests: (v.interests || []).join(", "), availability: (v.availability || []).join(", "),
    notes: v.notes ?? "", reviewNotes: v.reviewNotes ?? "",
  });
  const set = (k: string) => (e: any) => setF((p: any) => ({ ...p, [k]: e.target.value }));
  const age = ageFrom(v.dateOfBirth);
  const save = () => onSave({
    firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim(),
    dateOfBirth: f.dateOfBirth || null, location: f.location.trim(), status: f.status,
    isAcademyPlayer: f.isAcademyPlayer, academyAgeGroup: f.academyAgeGroup.trim(),
    hoursTarget: f.hoursTarget === "" ? null : Number(f.hoursTarget), emergencyContact: f.emergencyContact.trim(),
    interests: f.interests.split(",").map((s: string) => s.trim()).filter(Boolean),
    availability: f.availability.split(",").map((s: string) => s.trim()).filter(Boolean),
    notes: f.notes.trim(), reviewNotes: f.reviewNotes.trim(),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#15171c] border-white/10 text-white max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {fullName(v)}
            {age != null && <span className={`text-xs font-normal ${age < 18 ? "text-amber-300" : "text-white/40"}`}>{age} yrs{age < 18 ? " · under 18" : ""}</span>}
          </DialogTitle>
          {v.sourceUrl && <DialogDescription className="text-white/35 text-xs">Signed up via {v.sourceUrl}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="First name" value={f.firstName} onChange={set("firstName")} />
            <Input placeholder="Last name" value={f.lastName} onChange={set("lastName")} />
          </div>
          <Input type="email" placeholder="Email" value={f.email} onChange={set("email")} />
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Phone" value={f.phone} onChange={set("phone")} />
            <Input placeholder="City" value={f.location} onChange={set("location")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs text-white/50 flex items-center gap-1"><Cake className="w-3 h-3" /> Date of birth</Label><Input type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} className="mt-1" /></div>
            <div><Label className="text-xs text-white/50">Status</Label>
              <select value={f.status} onChange={set("status")} className="mt-1 w-full h-10 rounded-md bg-white/5 border border-white/10 text-white text-sm px-2">
                {ALL_STATUSES.map((s) => <option key={s} value={s} className="bg-[#15171c]">{STATUS_META[s].label}</option>)}
              </select>
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 py-1">
            <span className="text-sm text-white/70 flex items-center gap-1.5"><GraduationCap className="w-4 h-4 text-amber-300" /> Academy player (needs volunteer hours)</span>
            <Switch checked={f.isAcademyPlayer} onCheckedChange={(c) => setF((p: any) => ({ ...p, isAcademyPlayer: c, hoursTarget: c && p.hoursTarget === "" ? 20 : p.hoursTarget }))} />
          </label>
          {f.isAcademyPlayer && (
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Age group (e.g. U14)" value={f.academyAgeGroup} onChange={set("academyAgeGroup")} />
              <div><Label className="text-xs text-white/50">Hours target</Label><Input type="number" value={f.hoursTarget} onChange={set("hoursTarget")} className="mt-1" /></div>
            </div>
          )}
          <div><Label className="text-xs text-white/50">Keen to help with (comma-separated)</Label><Input value={f.interests} onChange={set("interests")} className="mt-1" placeholder="Car park, Music…" /></div>
          <div><Label className="text-xs text-white/50">Availability (comma-separated)</Label><Input value={f.availability} onChange={set("availability")} className="mt-1" placeholder="Weekends, 11–13 Jul…" /></div>
          <Input placeholder="Emergency contact" value={f.emergencyContact} onChange={set("emergencyContact")} />
          {v.notes && <div><Label className="text-xs text-white/50">Their note</Label><Textarea value={f.notes} onChange={set("notes")} className="mt-1" rows={2} /></div>}
          <div><Label className="text-xs text-white/50">Internal notes</Label><Textarea value={f.reviewNotes} onChange={set("reviewNotes")} className="mt-1" rows={2} placeholder="Staff-only notes…" /></div>
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="ghost" onClick={onDelete} className="text-red-300/80 hover:text-red-300 hover:bg-red-400/10 gap-1.5"><Trash2 className="w-4 h-4" /> Delete</Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={save} disabled={saving}>{saving && <Loader2 className="w-4 h-4 animate-spin" />} Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
