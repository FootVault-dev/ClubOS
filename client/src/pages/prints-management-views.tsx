// MANAGEMENT — the five "flat" views (Overview / My Work / Board / Table /
// Calendar). The Gantt lives in prints-management-gantt.tsx. All views are
// lenses over the one task dataset passed down from prints-management.tsx —
// no view fetches its own data.

import { useState, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import {
  Plus, X, Check, Diamond, ChevronDown, ChevronRight, MessageSquare,
  Calendar as CalIcon, ChevronLeft, Flag, Inbox, AlertTriangle,
} from "lucide-react";
import {
  PRIORITY_META, TASK_PRIORITIES, addDaysIso, daysBetween, taskBarRange,
  dueBucket, memberName, initials, fmtDate, taskProgress, parseLocalDate,
  toLocalDateStr, dueTone, DUE_TONE_CLASSES, canEdit,
  type PlanProjectRow, type PlanStatusRow, type PlanTaskRow, type TeamMember,
  type TaskPriority, type DueBucket,
} from "@/lib/management";

// ── tiny shared pieces ────────────────────────────────────────────────────────
export function Avatar({ name, title }: { name: string | null; title?: string }) {
  if (!name) return null;
  return <span title={title ? `${title}: ${name}` : name} className="w-6 h-6 rounded-full bg-white/10 text-[9px] font-bold flex items-center justify-center text-white/80 border border-white/10 shrink-0">{initials(name)}</span>;
}

function PriorityFlag({ priority }: { priority: string }) {
  const meta = PRIORITY_META[priority as TaskPriority];
  if (!meta || priority === "medium" || priority === "low") return null;
  return <Flag className="w-3 h-3 shrink-0" style={{ color: meta.color }} aria-label={meta.label} />;
}

function DueBadge({ due, done, today }: { due: string | null; done: boolean; today: string }) {
  const tone = dueTone(due, done, today);
  if (tone === "none") return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${DUE_TONE_CLASSES[tone]}`}>
      <CalIcon className="w-2.5 h-2.5" />{fmtDate(due)}
    </span>
  );
}

function ChecklistChip({ task }: { task: PlanTaskRow }) {
  if (!task.checklist.length) return null;
  const done = task.checklist.filter((c) => c.done).length;
  return <span className="text-[10px] text-white/40 flex items-center gap-0.5"><Check className="w-3 h-3" />{done}/{task.checklist.length}</span>;
}

function statusIn(project: PlanProjectRow | undefined, statusId: number): PlanStatusRow | null {
  return project?.statuses.find((s) => s.id === statusId) ?? null;
}
const isDone = (project: PlanProjectRow | undefined, t: PlanTaskRow) => statusIn(project, t.statusId)?.kind === "done";

/** One task as a compact row (My Work / Overview lists). */
function TaskLine({ t, project, team, today, onTask }: {
  t: PlanTaskRow; project?: PlanProjectRow; team: TeamMember[]; today: string; onTask: (t: PlanTaskRow) => void;
}) {
  const done = isDone(project, t);
  return (
    <button onClick={() => onTask(t)}
      className="w-full flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 px-3 py-2 text-left"
      style={project ? { borderLeft: `2px solid ${project.color}` } : undefined}>
      {t.milestone && <Diamond className="w-3 h-3 text-amber-300 shrink-0" />}
      <span className={`flex-1 min-w-0 truncate text-sm ${done ? "line-through text-white/40" : ""}`}>{t.title}</span>
      <PriorityFlag priority={t.priority} />
      {/* the coloured left border already names the project on phones — the
          text chip only earns its width from sm: up */}
      {project && <span className="hidden sm:inline-flex text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: `${project.color}22`, color: project.color }}>{project.name}</span>}
      <ChecklistChip task={t} />
      <DueBadge due={t.dueDate} done={done} today={today} />
      <Avatar name={memberName(team, t.assigneeId)} />
    </button>
  );
}

// ═══ OVERVIEW ═════════════════════════════════════════════════════════════════
export function OverviewView({ projects, tasks, allTasks, team, today, meId, onTask, onProject }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; allTasks: PlanTaskRow[]; team: TeamMember[];
  today: string; meId?: number;
  onTask: (t: PlanTaskRow) => void; onProject: (id: number) => void;
}) {
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const open = tasks.filter((t) => !isDone(projectById.get(t.projectId), t));
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const dueSoon = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= addDaysIso(today, 7));
  const doneThisMonth = tasks.filter((t) => t.completedAt && toLocalDateStr(new Date(t.completedAt)).slice(0, 7) === today.slice(0, 7));

  const Stat = ({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) => (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold">{label}</div>
      <div className="text-2xl font-bold mt-1" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-5xl">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Open tasks" value={open.length} sub="across all projects" />
        <Stat label="Due this week" value={dueSoon.length} sub="next 7 days" color={dueSoon.length ? "#f59e0b" : undefined} />
        <Stat label="Overdue" value={overdue.length} sub="past their due date" color={overdue.length ? "#ef4444" : undefined} />
        <Stat label="Done this month" value={doneThisMonth.length} color="#22c55e" />
      </div>

      {/* projects */}
      <div>
        <div className="text-xs uppercase tracking-wider text-white/30 font-semibold mb-2">Projects</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((p) => {
            const pt = allTasks.filter((t) => t.projectId === p.id);
            const done = pt.filter((t) => isDone(p, t)).length;
            const pOverdue = pt.filter((t) => !isDone(p, t) && t.dueDate && t.dueDate < today).length;
            const pct = pt.length ? Math.round((done / pt.length) * 100) : 0;
            return (
              <button key={p.id} onClick={() => onProject(p.id)}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 p-4 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: p.color }} />
                  <span className="text-sm font-semibold truncate flex-1">{p.name}</span>
                  {pOverdue > 0 && <span className="text-[10px] text-red-300 bg-red-500/15 px-1.5 py-0.5 rounded shrink-0">{pOverdue} overdue</span>}
                </div>
                <div className="h-1.5 rounded bg-white/[0.06] overflow-hidden mb-2">
                  <div className="h-full rounded" style={{ width: `${pct}%`, background: p.color }} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-white/40">
                  <span>{done}/{pt.length} done</span>
                  {p.targetDate && <span>target {fmtDate(p.targetDate)}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {overdue.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-red-300/80 font-semibold mb-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />Needs attention
          </div>
          <div className="space-y-1.5">
            {overdue.slice(0, 6).map((t) => <TaskLine key={t.id} t={t} project={projectById.get(t.projectId)} team={team} today={today} onTask={onTask} />)}
          </div>
        </div>
      )}

      {dueSoon.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-white/30 font-semibold mb-2">Coming up this week</div>
          <div className="space-y-1.5">
            {dueSoon.sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1)).slice(0, 8)
              .map((t) => <TaskLine key={t.id} t={t} project={projectById.get(t.projectId)} team={team} today={today} onTask={onTask} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ MY WORK ══════════════════════════════════════════════════════════════════
export function MyWorkView({ projects, tasks, team, today, meId, onTask }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; team: TeamMember[]; today: string; meId?: number;
  onTask: (t: PlanTaskRow) => void;
}) {
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const mine = tasks.filter((t) => meId != null && t.assigneeId === meId && !isDone(projectById.get(t.projectId), t));

  const buckets: { key: DueBucket; label: string; color?: string }[] = [
    { key: "overdue", label: "Overdue", color: "#ef4444" },
    { key: "today", label: "Today", color: "#f59e0b" },
    { key: "this_week", label: "This week" },
    { key: "later", label: "Later" },
    { key: "unscheduled", label: "No date" },
  ];
  const grouped = buckets.map((b) => ({
    ...b,
    items: mine.filter((t) => {
      const kind = statusIn(projectById.get(t.projectId), t.statusId)?.kind ?? "todo";
      return dueBucket(t, kind as any, today) === b.key;
    }).sort((a, b2) => (a.dueDate ?? "9999") < (b2.dueDate ?? "9999") ? -1 : 1),
  }));

  if (!mine.length) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <Inbox className="w-10 h-10 text-white/15 mx-auto mb-3" />
          <div className="text-base font-semibold mb-1">Nothing on your plate</div>
          <p className="text-sm text-white/40">Tasks assigned to you show up here, grouped by when they're due.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-3xl">
      {grouped.filter((g) => g.items.length).map((g) => (
        <div key={g.key}>
          <div className="text-xs uppercase tracking-wider font-semibold mb-2" style={{ color: g.color ?? "hsl(var(--foreground) / 0.66)" }}>
            {g.label} <span className="text-white/30">({g.items.length})</span>
          </div>
          <div className="space-y-1.5">
            {g.items.map((t) => <TaskLine key={t.id} t={t} project={projectById.get(t.projectId)} team={team} today={today} onTask={onTask} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══ BOARD (kanban — per-project columns, drag between + within) ══════════════
export function BoardView({ projects, tasks, team, today, selectedProjectId, onTask, onPosition, onQuickAdd }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; team: TeamMember[]; today: string;
  selectedProjectId: number | null;
  onTask: (t: PlanTaskRow) => void;
  onPosition: (id: number, statusId: number, index: number) => void;
  onQuickAdd: (projectId: number, statusId: number, title: string) => void;
}) {
  const boards = selectedProjectId != null ? projects.filter((p) => p.id === selectedProjectId) : projects;
  return (
    <div className="p-4 sm:p-6 space-y-8">
      {boards.map((p) => (
        <ProjectBoard key={p.id} project={p} tasks={tasks.filter((t) => t.projectId === p.id)}
          team={team} today={today} showTitle={boards.length > 1}
          onTask={onTask} onPosition={onPosition} onQuickAdd={onQuickAdd} />
      ))}
    </div>
  );
}

function ProjectBoard({ project, tasks, team, today, showTitle, onTask, onPosition, onQuickAdd }: {
  project: PlanProjectRow; tasks: PlanTaskRow[]; team: TeamMember[]; today: string; showTitle: boolean;
  onTask: (t: PlanTaskRow) => void;
  onPosition: (id: number, statusId: number, index: number) => void;
  onQuickAdd: (projectId: number, statusId: number, title: string) => void;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<{ statusId: number; index: number } | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const editable = canEdit(project);

  const drop = () => {
    if (dragId != null && over) onPosition(dragId, over.statusId, over.index);
    setDragId(null); setOver(null);
  };

  return (
    <div>
      {showTitle && (
        <div className="flex items-center gap-2 mb-2">
          <span className="w-3 h-3 rounded-sm" style={{ background: project.color }} />
          <span className="text-sm font-semibold">{project.name}</span>
          {!editable && <span className="text-[9px] uppercase tracking-wide text-white/30 bg-white/[0.05] px-1.5 py-0.5 rounded">view only</span>}
        </div>
      )}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {project.statuses.map((col) => {
          const colTasks = tasks.filter((t) => t.statusId === col.id)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
          return (
            <div key={col.id}
              onDragOver={editable ? (e) => { e.preventDefault(); if (over?.statusId !== col.id) setOver({ statusId: col.id, index: colTasks.length }); } : undefined}
              onDrop={editable ? (e) => { e.preventDefault(); drop(); } : undefined}
              className={`w-[264px] shrink-0 rounded-xl border flex flex-col ${over?.statusId === col.id ? "border-indigo-500/50 bg-indigo-500/[0.04]" : "border-white/[0.06] bg-white/[0.015]"}`}>
              <div className="px-3 py-2 flex items-center justify-between border-b border-white/[0.06]">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />{col.label}
                </div>
                <span className="text-[10px] text-white/40">{colTasks.length}</span>
              </div>
              <div className="p-2 space-y-2 flex-1 min-h-[80px]">
                {colTasks.map((t, i) => (
                  <div key={t.id} draggable={editable}
                    onDragStart={editable ? () => setDragId(t.id) : undefined}
                    onDragEnd={editable ? () => { setDragId(null); setOver(null); } : undefined}
                    onDragOver={editable ? (e) => { e.preventDefault(); e.stopPropagation(); setOver({ statusId: col.id, index: i }); } : undefined}
                    onDrop={editable ? (e) => { e.preventDefault(); e.stopPropagation(); drop(); } : undefined}
                    onClick={() => onTask(t)}
                    className={`rounded-lg border bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/15 p-2.5 cursor-pointer ${dragId === t.id ? "opacity-40" : ""} ${over?.statusId === col.id && over.index === i && dragId !== t.id ? "border-t-2 border-t-indigo-400 border-white/[0.06]" : "border-white/[0.06]"}`}>
                    <div className="text-[13px] font-medium leading-snug mb-1.5 flex items-start gap-1.5">
                      {t.milestone && <Diamond className="w-3 h-3 text-amber-300 shrink-0 mt-0.5" />}
                      <span className={col.kind === "done" ? "line-through text-white/40" : ""}>{t.title}</span>
                    </div>
                    {!!t.tags.length && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {t.tags.slice(0, 3).map((tag) => <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/50">{tag}</span>)}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <PriorityFlag priority={t.priority} />
                        <DueBadge due={t.dueDate} done={col.kind === "done"} today={today} />
                        <ChecklistChip task={t} />
                        {t.commentCount > 0 && <span className="text-[10px] text-white/40 flex items-center gap-0.5"><MessageSquare className="w-3 h-3" />{t.commentCount}</span>}
                      </div>
                      <Avatar name={memberName(team, t.assigneeId)} />
                    </div>
                  </div>
                ))}
                {!colTasks.length && dragId == null && <div className="text-[11px] text-white/20 text-center py-4">—</div>}
                {dragId != null && !colTasks.length && <div className="text-[11px] text-indigo-300/60 text-center py-4 rounded border border-dashed border-indigo-500/30">Drop here</div>}
              </div>
              <div className="p-2 pt-0">
                {!editable ? null : adding === col.id ? (
                  <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draft.trim()) { onQuickAdd(project.id, col.id, draft.trim()); setDraft(""); }
                      if (e.key === "Escape") { setAdding(null); setDraft(""); }
                    }}
                    onBlur={() => { if (draft.trim()) onQuickAdd(project.id, col.id, draft.trim()); setAdding(null); setDraft(""); }}
                    placeholder="Task title, Enter to add"
                    className="bg-white/[0.04] border-white/10 text-white h-8 text-sm" />
                ) : (
                  <button onClick={() => setAdding(col.id)}
                    className="w-full text-left text-[12px] text-white/30 hover:text-white/70 hover:bg-white/[0.03] rounded-md px-2 py-1.5 flex items-center gap-1">
                    <Plus className="w-3.5 h-3.5" />Add task
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ TABLE (Monday-style grouped grid, inline edit, batch bar) ════════════════
export function TableView({ projects, tasks, team, today, onTask, onPatch, onDelete, onQuickAdd }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; team: TeamMember[]; today: string;
  onTask: (t: PlanTaskRow) => void;
  onPatch: (id: number, body: any) => void;
  onDelete: (id: number) => void;
  onQuickAdd: (projectId: number, title: string) => void;
}) {
  // Collapse state persists per project — a multi-year unresolved Monday
  // complaint that costs one localStorage key to get right.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("upmgmt-collapsed") || "{}"); } catch { return {}; }
  });
  const toggleCollapse = (id: number) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try { localStorage.setItem("upmgmt-collapsed", JSON.stringify(next)); } catch {}
  };

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleSel = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [confirmBatchDel, setConfirmBatchDel] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const batch = (body: any) => { selected.forEach((id) => onPatch(id, body)); setSelected(new Set()); };
  const batchDelete = () => { selected.forEach((id) => onDelete(id)); setSelected(new Set()); setConfirmBatchDel(false); };

  const dateCls = "h-7 rounded-md bg-transparent border border-transparent hover:border-white/15 px-1 text-xs text-white/70 [color-scheme:dark] w-[112px]";

  return (
    <div className="p-4 sm:p-6">
      {selected.size > 0 && (
        <div className="mb-3 rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          <span className="font-semibold text-indigo-200">{selected.size} selected</span>
          <select defaultValue="" onChange={(e) => { if (e.target.value) { batch({ assigneeId: e.target.value === "none" ? null : Number(e.target.value) }); e.target.value = ""; } }}
            className="h-7 rounded-md bg-white/[0.04] border border-white/10 px-1.5">
            <option value="">Assign…</option>
            <option value="none">Nobody</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}
          </select>
          <select defaultValue="" onChange={(e) => { if (e.target.value) { batch({ priority: e.target.value }); e.target.value = ""; } }}
            className="h-7 rounded-md bg-white/[0.04] border border-white/10 px-1.5">
            <option value="">Priority…</option>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
          <input type="date" onChange={(e) => { if (e.target.value) { batch({ dueDate: e.target.value }); e.target.value = ""; } }}
            className="h-7 rounded-md bg-white/[0.04] border border-white/10 px-1.5 [color-scheme:dark]" title="Set due date" />
          {confirmBatchDel
            ? <span className="flex items-center gap-1.5"><span className="text-white/50">Delete {selected.size}?</span><button onClick={batchDelete} className="text-red-300 font-semibold">Yes</button><button onClick={() => setConfirmBatchDel(false)} className="text-white/50">No</button></span>
            : <button onClick={() => setConfirmBatchDel(true)} className="text-red-300/70 hover:text-red-300">Delete</button>}
          <div className="flex-1" />
          <button onClick={() => setSelected(new Set())} className="text-white/40 hover:text-white flex items-center gap-1"><X className="w-3 h-3" />Clear</button>
        </div>
      )}

      <div className="space-y-4">
        {projects.map((p) => {
          const rows = tasks.filter((t) => t.projectId === p.id);
          if (!rows.length && collapsed[p.id]) return null;
          const statusOrder = new Map(p.statuses.map((s, i) => [s.id, i]));
          const sorted = [...rows].sort((a, b) =>
            (statusOrder.get(a.statusId) ?? 0) - (statusOrder.get(b.statusId) ?? 0) || a.sortOrder - b.sortOrder || a.id - b.id);
          const isCollapsed = !!collapsed[p.id];
          const done = rows.filter((t) => statusIn(p, t.statusId)?.kind === "done").length;
          const editable = canEdit(p);
          return (
            <div key={p.id} className="rounded-xl border border-white/[0.06] overflow-hidden">
              <button onClick={() => toggleCollapse(p.id)}
                className="w-full px-3 py-2 flex items-center gap-2 text-left"
                style={{ background: `${p.color}14`, borderLeft: `3px solid ${p.color}` }}>
                {isCollapsed ? <ChevronRight className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
                <span className="text-sm font-semibold" style={{ color: p.color }}>{p.name}</span>
                <span className="text-[11px] text-white/40">{done}/{rows.length} done</span>
                {!editable && <span className="text-[9px] uppercase tracking-wide text-white/30 bg-white/[0.05] px-1.5 py-0.5 rounded">view only</span>}
                {p.targetDate && <span className="text-[10px] text-white/30 ml-auto">target {fmtDate(p.targetDate)}</span>}
              </button>
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[820px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                        <th className="w-8 px-2 py-1.5"></th>
                        <th className="text-left font-semibold px-2 py-1.5">Task</th>
                        <th className="text-left font-semibold px-2 py-1.5 w-[130px]">Column</th>
                        <th className="text-left font-semibold px-2 py-1.5 w-[130px]">Owner</th>
                        <th className="text-left font-semibold px-2 py-1.5 w-[100px]">Priority</th>
                        <th className="text-left font-semibold px-2 py-1.5 w-[120px]">Start</th>
                        <th className="text-left font-semibold px-2 py-1.5 w-[120px]">Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((t) => {
                        const st = statusIn(p, t.statusId);
                        const done2 = st?.kind === "done";
                        const prog = taskProgress(t);
                        return (
                          <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-2 py-1.5 text-center">
                              {editable && <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} className="accent-indigo-500 w-3.5 h-3.5 align-middle" />}
                            </td>
                            <td className="px-2 py-1.5 cursor-pointer" onClick={() => onTask(t)}>
                              <div className={`font-medium flex items-center gap-1.5 ${done2 ? "line-through text-white/40" : ""}`}>
                                {t.milestone && <Diamond className="w-3 h-3 text-amber-300 shrink-0" />}
                                <span className="truncate max-w-[320px]">{t.title}</span>
                                <ChecklistChip task={t} />
                                {t.commentCount > 0 && <span className="text-[10px] text-white/40 flex items-center gap-0.5"><MessageSquare className="w-3 h-3" />{t.commentCount}</span>}
                                {prog != null && prog > 0 && !done2 && <span className="text-[10px] text-white/40">{prog}%</span>}
                              </div>
                              {!!t.tags.length && <div className="flex gap-1 mt-0.5">{t.tags.slice(0, 4).map((tag) => <span key={tag} className="text-[9px] text-white/40 bg-white/[0.05] px-1 rounded">{tag}</span>)}</div>}
                            </td>
                            <td className="px-2 py-1.5">
                              <select value={t.statusId} disabled={!editable} onChange={(e) => onPatch(t.id, { statusId: Number(e.target.value) })}
                                className="h-7 rounded-md border-0 px-1.5 text-xs font-semibold cursor-pointer w-full disabled:cursor-default disabled:appearance-none"
                                style={{ background: `${st?.color ?? "#64748b"}22`, color: st?.color ?? "#94a3b8" }}>
                                {p.statuses.map((s) => <option key={s.id} value={s.id} className="bg-[#0a0e1a] text-white">{s.label}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <select value={t.assigneeId ?? ""} disabled={!editable} onChange={(e) => onPatch(t.id, { assigneeId: e.target.value ? Number(e.target.value) : null })}
                                className="h-7 rounded-md bg-transparent border border-transparent hover:border-white/15 px-1 text-xs text-white/70 w-full cursor-pointer disabled:cursor-default disabled:appearance-none">
                                <option value="" className="bg-[#0a0e1a]">—</option>
                                {team.map((m) => <option key={m.id} value={m.id} className="bg-[#0a0e1a]">{m.first_name} {m.last_name}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <select value={t.priority} disabled={!editable} onChange={(e) => onPatch(t.id, { priority: e.target.value })}
                                className="h-7 rounded-md bg-transparent border border-transparent hover:border-white/15 px-1 text-xs w-full cursor-pointer disabled:cursor-default disabled:appearance-none"
                                style={{ color: PRIORITY_META[t.priority as TaskPriority]?.color }}>
                                {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr} className="bg-[#0a0e1a] text-white">{PRIORITY_META[pr].label}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="date" value={t.startDate ?? ""} max={t.dueDate ?? undefined} disabled={!editable}
                                onChange={(e) => onPatch(t.id, { startDate: e.target.value || null })} className={dateCls} />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="date" value={t.dueDate ?? ""} min={t.startDate ?? undefined} disabled={!editable}
                                onChange={(e) => onPatch(t.id, { dueDate: e.target.value || null })}
                                className={`${dateCls} ${dueTone(t.dueDate, done2, today) === "overdue" ? "!text-red-300" : ""}`} />
                            </td>
                          </tr>
                        );
                      })}
                      {editable && <tr>
                        <td className="px-2 py-1.5"></td>
                        <td colSpan={6} className="px-2 py-1.5">
                          <Input value={drafts[p.id] ?? ""} onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })}
                            onKeyDown={(e) => {
                              const v = (drafts[p.id] ?? "").trim();
                              if (e.key === "Enter" && v) { onQuickAdd(p.id, v); setDrafts({ ...drafts, [p.id]: "" }); }
                            }}
                            placeholder="+ Add task, Enter to save"
                            className="bg-transparent border-transparent hover:border-white/10 focus:border-white/15 text-white h-8 text-sm max-w-[360px]" />
                        </td>
                      </tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ CALENDAR (month grid — Monday-start, spanning bars, unscheduled tray) ════
function startOfWeek(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const off = (x.getDay() + 6) % 7;   // Monday-start (ISO — NZ convention)
  x.setDate(x.getDate() - off);
  return x;
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
  return weeks.filter((week) => week.some((day) => day.getMonth() === m));
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_LANES = 4;

interface WeekSegment {
  task: PlanTaskRow; lane: number;
  startCol: number; span: number;         // 0-based col + inclusive day count
  clipLeft: boolean; clipRight: boolean;  // bar continues into adjacent weeks
}

/** Lay a week's intersecting bars into lanes (first-fit, longest first). */
function layoutWeek(weekStart: string, tasks: { task: PlanTaskRow; start: string; end: string }[]): { segments: WeekSegment[]; overflow: Map<string, number> } {
  const weekEnd = addDaysIso(weekStart, 6);
  const inWeek = tasks
    .filter(({ start, end }) => start <= weekEnd && end >= weekStart)
    .map(({ task, start, end }) => {
      const s = start < weekStart ? weekStart : start;
      const e = end > weekEnd ? weekEnd : end;
      return { task, startCol: daysBetween(weekStart, s), span: daysBetween(s, e) + 1, clipLeft: start < weekStart, clipRight: end > weekEnd };
    })
    .sort((a, b) => a.startCol - b.startCol || b.span - a.span || a.task.id - b.task.id);

  const laneEnds: number[] = [];        // per lane: next free column
  const segments: WeekSegment[] = [];
  const overflow = new Map<string, number>();
  for (const seg of inWeek) {
    let lane = laneEnds.findIndex((end) => end <= seg.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    if (lane >= MAX_LANES) {
      for (let c = seg.startCol; c < seg.startCol + seg.span; c++) {
        const day = addDaysIso(weekStart, c);
        overflow.set(day, (overflow.get(day) ?? 0) + 1);
      }
      continue;
    }
    laneEnds[lane] = seg.startCol + seg.span;
    segments.push({ ...seg, lane });
  }
  return { segments, overflow };
}

export function CalendarView({ projects, tasks, today, onTask, onPatch, onNewOnDay }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; today: string;
  onTask: (t: PlanTaskRow) => void;
  onPatch: (id: number, body: any) => void;
  onNewOnDay: (day: string) => void;
}) {
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const [cursor, setCursor] = useState<Date>(() => today ? parseLocalDate(today) : new Date());
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [dayPanel, setDayPanel] = useState<string | null>(null);
  const editableIds = useMemo(() => new Set(projects.filter(canEdit).map((p) => p.id)), [projects]);
  const canCreate = editableIds.size > 0;

  const dated = useMemo(() => tasks
    .map((t) => ({ task: t, range: taskBarRange(t) }))
    .filter((x): x is { task: PlanTaskRow; range: { start: string; end: string } } => !!x.range)
    .map(({ task, range }) => ({ task, start: range.start, end: range.end })), [tasks]);
  const unscheduled = tasks.filter((t) => !t.startDate && !t.dueDate && !isDone(projectById.get(t.projectId), t));

  const weeks = monthMatrix(cursor);
  const monthLabel = cursor.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });

  /** Drop a task on a day: preserve duration, shift the whole bar. */
  const dropOn = (day: string) => {
    if (dragTaskId == null) return;
    const t = tasks.find((x) => x.id === dragTaskId);
    setDragTaskId(null); setOverDay(null);
    if (!t) return;
    const range = taskBarRange(t);
    if (!range) { onPatch(t.id, { dueDate: day }); return; }          // unscheduled → due that day
    const dur = daysBetween(range.start, range.end);                   // whole-bar shift, duration kept
    if (t.startDate && t.dueDate) onPatch(t.id, { startDate: day, dueDate: addDaysIso(day, dur) });
    else if (t.dueDate) onPatch(t.id, { dueDate: day });
    else onPatch(t.id, { startDate: day });
  };

  const dayTasks = (day: string) => dated.filter(({ start, end }) => start <= day && end >= day).map((x) => x.task);

  return (
    <div className="p-4 sm:p-6 flex flex-col lg:flex-row gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
            <button onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() - 1); setCursor(d); }} className="w-8 h-8 hover:bg-white/[0.06] flex items-center justify-center"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => setCursor(today ? parseLocalDate(today) : new Date())} className="px-3 h-8 text-xs hover:bg-white/[0.06] border-x border-white/10">Today</button>
            <button onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() + 1); setCursor(d); }} className="w-8 h-8 hover:bg-white/[0.06] flex items-center justify-center"><ChevronRight className="w-4 h-4" /></button>
          </div>
          <div className="text-base font-semibold">{monthLabel}</div>
        </div>

        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
          <div className="grid grid-cols-7 border-b border-white/[0.06]">
            {DAY_NAMES.map((d, i) => (
              <div key={d} className={`px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-center ${i >= 5 ? "text-white/20" : "text-white/30"}`}>{d}</div>
            ))}
          </div>
          {weeks.map((week, wi) => {
            const weekStart = toLocalDateStr(week[0]);
            const { segments, overflow } = layoutWeek(weekStart, dated);
            const lanes = Math.max(1, ...segments.map((s) => s.lane + 1));
            return (
              <div key={wi} className="relative border-b border-white/[0.04] last:border-0">
                {/* day cells */}
                <div className="grid grid-cols-7" style={{ minHeight: 34 + lanes * 26 + (overflow.size ? 18 : 0) }}>
                  {week.map((day, di) => {
                    const dayStr = toLocalDateStr(day);
                    const inMonth = day.getMonth() === cursor.getMonth();
                    const isToday = dayStr === today;
                    const weekend = di >= 5;
                    const extra = overflow.get(dayStr) ?? 0;
                    return (
                      <div key={di}
                        onClick={canCreate ? () => onNewOnDay(dayStr) : undefined}
                        onDragOver={(e) => { e.preventDefault(); setOverDay(dayStr); }}
                        onDragLeave={() => setOverDay((d) => (d === dayStr ? null : d))}
                        onDrop={(e) => { e.preventDefault(); dropOn(dayStr); }}
                        className={`relative border-r border-white/[0.04] last:border-0 ${canCreate ? "cursor-pointer" : ""} transition-colors
                          ${inMonth ? "" : "opacity-35"} ${weekend ? "bg-white/[0.015]" : ""}
                          ${overDay === dayStr ? "bg-indigo-500/[0.08]" : "hover:bg-white/[0.02]"}`}>
                        <div className={`text-[11px] m-1 px-1 inline-flex items-center justify-center ${isToday ? "w-5 h-5 rounded-full bg-indigo-600 text-white font-bold" : "text-white/40"}`}>{day.getDate()}</div>
                        {extra > 0 && (
                          <button onClick={(e) => { e.stopPropagation(); setDayPanel(dayStr); }}
                            className="absolute bottom-0.5 left-1 text-[10px] text-white/40 hover:text-white">+{extra} more</button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* spanning bars */}
                {segments.map((seg) => {
                  const p = projectById.get(seg.task.projectId);
                  const done = isDone(p, seg.task);
                  const color = p?.color ?? "#6366f1";
                  const segEditable = editableIds.has(seg.task.projectId);
                  return (
                    <button key={seg.task.id + "-" + seg.lane}
                      draggable={segEditable}
                      onDragStart={segEditable ? () => setDragTaskId(seg.task.id) : undefined}
                      onDragEnd={segEditable ? () => { setDragTaskId(null); setOverDay(null); } : undefined}
                      onClick={(e) => { e.stopPropagation(); onTask(seg.task); }}
                      className={`absolute h-[22px] text-left text-[11px] px-1.5 flex items-center gap-1 truncate hover:brightness-125 ${dragTaskId === seg.task.id ? "opacity-40" : ""} ${seg.clipLeft ? "rounded-l-none" : "rounded-l-md"} ${seg.clipRight ? "rounded-r-none" : "rounded-r-md"}`}
                      style={{
                        top: 30 + seg.lane * 26,
                        left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                        width: `calc(${(seg.span / 7) * 100}% - 4px)`,
                        background: `${color}${done ? "18" : "30"}`,
                        borderLeft: seg.clipLeft ? undefined : `2px solid ${color}`,
                        color: done ? "hsl(var(--foreground) / 0.7)" : "hsl(var(--foreground) / 1)",
                      }}>
                      {seg.task.milestone && <Diamond className="w-2.5 h-2.5 shrink-0 text-amber-300" />}
                      <span className={`truncate ${done ? "line-through" : ""}`}>{seg.task.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-white/25 mt-2">Drag a bar to move it (length kept) · click a day to plan something · drag from the tray to schedule it.</div>
      </div>

      {/* unscheduled tray */}
      <div className="lg:w-60 shrink-0">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.015]">
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center gap-2">
            <Inbox className="w-3.5 h-3.5 text-white/40" />
            <span className="text-xs font-semibold">Unscheduled</span>
            <span className="text-[10px] text-white/40 ml-auto">{unscheduled.length}</span>
          </div>
          <div className="p-2 space-y-1.5 max-h-[420px] overflow-y-auto">
            {unscheduled.map((t) => {
              const p = projectById.get(t.projectId);
              const tEditable = editableIds.has(t.projectId);
              return (
                <div key={t.id} draggable={tEditable}
                  onDragStart={tEditable ? () => setDragTaskId(t.id) : undefined}
                  onDragEnd={tEditable ? () => { setDragTaskId(null); setOverDay(null); } : undefined}
                  onClick={() => onTask(t)}
                  className={`rounded-md border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05] px-2 py-1.5 text-[12px] ${tEditable ? "cursor-grab" : "cursor-pointer"} flex items-center gap-1.5 ${dragTaskId === t.id ? "opacity-40" : ""}`}
                  style={{ borderLeft: `2px solid ${p?.color ?? "#6366f1"}` }}>
                  <span className="truncate flex-1">{t.title}</span>
                  <PriorityFlag priority={t.priority} />
                </div>
              );
            })}
            {!unscheduled.length && <div className="text-[11px] text-white/25 text-center py-4">Everything's scheduled 🎉</div>}
          </div>
        </div>
        <div className="text-[10px] text-white/25 mt-2 px-1">Nothing here needs a fake date — drag it onto a day when it's real.</div>
      </div>

      {/* day panel (the "+N more" escape hatch) */}
      {dayPanel && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setDayPanel(null)}>
          <div className="w-full max-w-sm bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold">{parseLocalDate(dayPanel).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })}</div>
              <button onClick={() => setDayPanel(null)} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {dayTasks(dayPanel).map((t) => {
                const p = projectById.get(t.projectId);
                return (
                  <button key={t.id} onClick={() => { setDayPanel(null); onTask(t); }}
                    className="w-full text-left rounded-md px-2 py-1.5 text-[13px] hover:bg-white/[0.05] flex items-center gap-2"
                    style={{ borderLeft: `2px solid ${p?.color ?? "#6366f1"}` }}>
                    <span className="truncate flex-1">{t.title}</span>
                    {t.dueDate && <span className="text-[10px] text-white/40">{fmtDate(t.dueDate)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
