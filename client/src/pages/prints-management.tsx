// MANAGEMENT — the planning workspace (United Prints' Monday/Asana-grade
// home): projects → per-project workflow columns → tasks, viewed as
// Overview / My Work / Board / Table / Calendar / Gantt over ONE dataset.
//
// Conventions match group-content.tsx: native <select>, hand-rolled modals,
// apiRequest + react-query, dark-theme tokens. Derivation logic (overdue,
// due buckets, bar ranges, cycles) comes from @shared/management via
// lib/management so screen and server never disagree. `today` always comes
// from the server (NZ) — the client never invents a date.

import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, X, Check, Trash2, Calendar as CalIcon, LayoutGrid, Table as TableIcon,
  Gauge, UserCircle2, GanttChart, ClipboardList, Filter, Diamond, Link2,
  MessageSquare, Menu, Pencil,
} from "lucide-react";
import {
  PRIORITY_META, TASK_PRIORITIES, STATUS_COLOR_PRESETS, PROJECT_COLORS,
  initials, fmtDate, wouldCreateCycle,
  type PlanProjectRow, type PlanStatusRow, type PlanTaskRow, type DepRow,
  type CommentRow, type TeamMember,
} from "@/lib/management";
import {
  OverviewView, MyWorkView, BoardView, TableView, CalendarView,
} from "./prints-management-views";
import { GanttView } from "./prints-management-gantt";

export type View = "overview" | "mywork" | "board" | "table" | "calendar" | "gantt";

export interface TaskDraft {
  projectId?: number; statusId?: number; dueDate?: string; startDate?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
const VIEW_KEYS: View[] = ["overview", "mywork", "board", "table", "calendar", "gantt"];

export default function PrintsManagement() {
  const { toast } = useToast();

  // #board / #gantt etc. deep-link a view (and survive a refresh)
  const [view, setViewState] = useState<View>(() => {
    const h = window.location.hash.replace("#", "") as View;
    return VIEW_KEYS.includes(h) ? h : "overview";
  });
  const setView = (v: View) => {
    setViewState(v);
    try { history.replaceState(null, "", `#${v}`); } catch {}
  };
  const [navOpen, setNavOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  // filters
  const [fAssignee, setFAssignee] = useState<number | "">("");
  const [fPriority, setFPriority] = useState("");
  const [fTag, setFTag] = useState("");
  const [hideDone, setHideDone] = useState(false);

  const [taskModal, setTaskModal] = useState<{ mode: "create" | "edit"; task?: PlanTaskRow; draft?: TaskDraft } | null>(null);
  const [projectModal, setProjectModal] = useState<{ mode: "create" | "edit"; project?: PlanProjectRow } | null>(null);

  // ── data ───────────────────────────────────────────────────────────────────
  const { data: me } = useQuery<{ id: number }>({ queryKey: ["/api/auth/me"] });
  const { data: projData, isLoading: projectsLoading } = useQuery<{ today: string; projects: PlanProjectRow[] }>({
    queryKey: ["/api/admin/management/projects"],
  });
  const { data: taskData, isLoading: tasksLoading } = useQuery<{ today: string; tasks: PlanTaskRow[]; deps: DepRow[] }>({
    queryKey: ["/api/admin/management/tasks"],
    refetchInterval: 30_000, // small team, shared board — keep it live
  });
  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/admin/management/team"] });

  const projects = projData?.projects ?? [];
  const activeProjects = projects.filter((p) => p.status !== "archived");
  const allTasks = useMemo(() => taskData?.tasks ?? [], [taskData]);
  const deps = useMemo(() => taskData?.deps ?? [], [taskData]);
  const today = taskData?.today || projData?.today || "";

  // ?task=<id> deep-links straight into a task's modal (shareable with staff;
  // also how the preflight gate exercises the modal at every viewport).
  const [openedFromUrl, setOpenedFromUrl] = useState(false);
  useEffect(() => {
    if (openedFromUrl || !allTasks.length) return;
    const id = Number(new URLSearchParams(window.location.search).get("task"));
    if (Number.isInteger(id) && id > 0) {
      const t = allTasks.find((x) => x.id === id);
      if (t) setTaskModal({ mode: "edit", task: t });
    }
    setOpenedFromUrl(true);
  }, [allTasks, openedFromUrl]);

  const invProjects = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/management/projects"] });
  const invTasks = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/management/tasks"] });

  // ── mutations ────────────────────────────────────────────────────────────────
  const saveTask = useMutation({
    mutationFn: async ({ id, body }: { id?: number; body: any }) => {
      const r = id
        ? await apiRequest("PATCH", `/api/admin/management/tasks/${id}`, body)
        : await apiRequest("POST", "/api/admin/management/tasks", body);
      return r.json();
    },
    onSuccess: (row, vars) => {
      invTasks();
      if (taskModal?.mode === "create" && !vars.id) setTaskModal({ mode: "edit", task: { ...row, checklist: row.checklist ?? [], commentCount: row.commentCount ?? 0 } });
      toast({ title: "Saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });
  const patchTask = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/management/tasks/${id}`, body);
      return r.json();
    },
    onSuccess: () => invTasks(),
    onError: (e: any) => { invTasks(); toast({ title: "Couldn't update", description: e.message, variant: "destructive" }); },
  });
  const positionTask = useMutation({
    mutationFn: async ({ id, statusId, index }: { id: number; statusId: number; index: number }) => {
      const r = await apiRequest("POST", `/api/admin/management/tasks/${id}/position`, { statusId, index });
      return r.json();
    },
    onSuccess: () => invTasks(),
    onError: (e: any) => { invTasks(); toast({ title: "Couldn't move task", description: e.message, variant: "destructive" }); },
  });
  const deleteTask = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/management/tasks/${id}`),
    onSuccess: () => { invTasks(); setTaskModal(null); toast({ title: "Task deleted" }); },
    onError: (e: any) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  /** Quick-add (the <10s capture loop): title + wherever you are. */
  const quickCreate = (body: { projectId: number; title: string; statusId?: number; dueDate?: string; assigneeId?: number | null }) =>
    saveTaskDirect(body);
  const saveTaskDirect = async (body: any) => {
    try {
      const r = await apiRequest("POST", "/api/admin/management/tasks", body);
      await r.json();
      invTasks();
    } catch (e: any) {
      toast({ title: "Couldn't add task", description: e.message, variant: "destructive" });
    }
  };

  // ── filtering ────────────────────────────────────────────────────────────────
  const statusById = useMemo(() => {
    const m = new Map<number, PlanStatusRow>();
    for (const p of projects) for (const st of p.statuses) m.set(st.id, st);
    return m;
  }, [projects]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTasks) for (const tag of t.tags) s.add(tag);
    return Array.from(s).sort();
  }, [allTasks]);

  const filtered = useMemo(() => allTasks.filter((t) => {
    if (selectedProjectId != null && t.projectId !== selectedProjectId) return false;
    if (fAssignee !== "" && t.assigneeId !== fAssignee) return false;
    if (fPriority && t.priority !== fPriority) return false;
    if (fTag && !t.tags.includes(fTag)) return false;
    if (hideDone && statusById.get(t.statusId)?.kind === "done") return false;
    return true;
  }), [allTasks, selectedProjectId, fAssignee, fPriority, fTag, hideDone, statusById]);

  const anyFilter = fAssignee !== "" || fPriority || fTag || hideDone;
  const clearFilters = () => { setFAssignee(""); setFPriority(""); setFTag(""); setHideDone(false); };

  const openCountFor = (projectId: number) =>
    allTasks.filter((t) => t.projectId === projectId && statusById.get(t.statusId)?.kind !== "done").length;

  const NAV: { key: View; label: string; icon: any }[] = [
    { key: "overview", label: "Overview", icon: Gauge },
    { key: "mywork", label: "My Work", icon: UserCircle2 },
    { key: "board", label: "Board", icon: LayoutGrid },
    { key: "table", label: "Table", icon: TableIcon },
    { key: "calendar", label: "Calendar", icon: CalIcon },
    { key: "gantt", label: "Gantt", icon: GanttChart },
  ];

  const loading = projectsLoading || tasksLoading;

  return (
    <div className="flex h-full relative">
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 sm:hidden" onClick={() => setNavOpen(false)} />}

      {/* left sub-sidebar: views + projects */}
      <aside className={`w-60 border-r border-white/[0.06] flex flex-col bg-[#0a0e1a] sm:bg-transparent fixed sm:static inset-y-0 left-0 z-40 transition-transform ${navOpen ? "translate-x-0" : "-translate-x-full sm:translate-x-0"}`}>
        <div className="px-4 py-4 border-b border-white/[0.06] flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-indigo-400" />
          <div>
            <div className="text-sm font-semibold">Management</div>
            <div className="text-[11px] text-white/40">Plan the work, see it land</div>
          </div>
        </div>
        <nav className="py-2 border-b border-white/[0.06]">
          {NAV.map((item) => {
            const Icon = item.icon; const active = view === item.key;
            return (
              <button key={item.key} onClick={() => { setView(item.key); setNavOpen(false); }}
                className={`w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors border-l-2 ${active ? "bg-indigo-500/[0.08] text-indigo-200 border-indigo-500" : "text-white/70 hover:bg-white/[0.03] border-transparent"}`}>
                <Icon className="w-4 h-4" />{item.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-4 flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-white/30 font-semibold">Projects</span>
            <button onClick={() => setProjectModal({ mode: "create" })} className="text-white/30 hover:text-white" title="New project">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <button onClick={() => setSelectedProjectId(null)}
            className={`w-full flex items-center gap-2 px-4 py-1.5 text-[13px] border-l-2 ${selectedProjectId == null ? "bg-white/[0.04] text-white border-indigo-500" : "text-white/60 hover:bg-white/[0.03] border-transparent"}`}>
            <span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-br from-indigo-400 to-pink-400" />
            All projects
            <span className="ml-auto text-[10px] text-white/30">{allTasks.filter((t) => statusById.get(t.statusId)?.kind !== "done").length}</span>
          </button>
          {activeProjects.map((p) => (
            <div key={p.id} className={`group flex items-center border-l-2 ${selectedProjectId === p.id ? "bg-white/[0.04] border-indigo-500" : "border-transparent hover:bg-white/[0.03]"}`}>
              <button onClick={() => { setSelectedProjectId(p.id); if (view === "overview") setView("board"); setNavOpen(false); }}
                className={`flex-1 min-w-0 flex items-center gap-2 px-4 py-1.5 text-[13px] text-left ${selectedProjectId === p.id ? "text-white" : "text-white/60"}`}>
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: p.color }} />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto text-[10px] text-white/30 shrink-0">{openCountFor(p.id)}</span>
              </button>
              <button onClick={() => setProjectModal({ mode: "edit", project: p })}
                className="pr-3 text-white/0 group-hover:text-white/40 hover:!text-white shrink-0" title="Project settings">
                <Pencil className="w-3 h-3" />
              </button>
            </div>
          ))}
          {!activeProjects.length && !projectsLoading && (
            <div className="px-4 py-2 text-[11px] text-white/30">No projects yet.</div>
          )}
        </div>
      </aside>

      {/* main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-4 sm:px-6 py-3 border-b border-white/[0.06] flex items-center gap-3 flex-wrap">
          <button className="sm:hidden w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center" onClick={() => setNavOpen(true)}>
            <Menu className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-semibold">
            {selectedProjectId != null
              ? activeProjects.find((p) => p.id === selectedProjectId)?.name ?? "Project"
              : NAV.find((n) => n.key === view)?.label}
          </h1>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="text-white/70 hover:text-white" onClick={() => setProjectModal({ mode: "create" })}>
            <Plus className="w-4 h-4 mr-1" />Project
          </Button>
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white"
            onClick={() => setTaskModal({ mode: "create", draft: { projectId: selectedProjectId ?? activeProjects[0]?.id } })}
            disabled={!activeProjects.length}>
            <Plus className="w-4 h-4 mr-1" />New task
          </Button>
        </div>

        {/* filters */}
        <div className="px-4 sm:px-6 py-2 border-b border-white/[0.04] flex items-center gap-2 flex-wrap text-xs">
          <span className="flex items-center gap-1 text-white/30"><Filter className="w-3.5 h-3.5" /></span>
          <FilterSelect value={fAssignee === "" ? "" : String(fAssignee)} onChange={(v) => setFAssignee(v ? Number(v) : "")} placeholder="Anyone"
            options={team.map((t) => ({ value: String(t.id), label: `${t.first_name} ${t.last_name}` }))} />
          <FilterSelect value={fPriority} onChange={setFPriority} placeholder="Any priority"
            options={TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }))} />
          {allTags.length > 0 && (
            <FilterSelect value={fTag} onChange={setFTag} placeholder="Any tag"
              options={allTags.map((t) => ({ value: t, label: t }))} />
          )}
          <button onClick={() => setHideDone(!hideDone)}
            className={`h-7 rounded-md border px-2 ${hideDone ? "bg-indigo-500/10 border-indigo-500/40 text-indigo-100" : "bg-white/[0.04] border-white/10 text-white/70"}`}>
            Hide done
          </button>
          {anyFilter && <button onClick={clearFilters} className="text-white/40 hover:text-white flex items-center gap-1"><X className="w-3 h-3" />Clear</button>}
          <div className="flex-1" />
          <span className="text-white/30">{filtered.length} task{filtered.length === 1 ? "" : "s"}</span>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto min-h-0">
          {loading ? (
            <div className="p-6 space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full bg-white/[0.04]" />)}</div>
          ) : !activeProjects.length ? (
            <EmptyState onNewProject={() => setProjectModal({ mode: "create" })} />
          ) : (
            <>
              {view === "overview" && (
                <OverviewView projects={activeProjects} tasks={filtered} allTasks={allTasks} team={team} today={today} meId={me?.id}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })}
                  onProject={(id) => { setSelectedProjectId(id); setView("board"); }} />
              )}
              {view === "mywork" && (
                <MyWorkView projects={activeProjects} tasks={allTasks} team={team} today={today} meId={me?.id}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })} />
              )}
              {view === "board" && (
                <BoardView projects={activeProjects} tasks={filtered} team={team} today={today}
                  selectedProjectId={selectedProjectId}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })}
                  onPosition={(id, statusId, index) => positionTask.mutate({ id, statusId, index })}
                  onQuickAdd={(projectId, statusId, title) => quickCreate({ projectId, statusId, title })} />
              )}
              {view === "table" && (
                <TableView projects={activeProjects} tasks={filtered} team={team} today={today}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })}
                  onPatch={(id, body) => patchTask.mutate({ id, body })}
                  onDelete={(id) => deleteTask.mutate(id)}
                  onQuickAdd={(projectId, title) => quickCreate({ projectId, title })} />
              )}
              {view === "calendar" && (
                <CalendarView projects={activeProjects} tasks={filtered} today={today}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })}
                  onPatch={(id, body) => patchTask.mutate({ id, body })}
                  onNewOnDay={(day) => setTaskModal({ mode: "create", draft: { projectId: selectedProjectId ?? activeProjects[0]?.id, dueDate: day } })} />
              )}
              {view === "gantt" && (
                <GanttView projects={activeProjects} tasks={filtered} deps={deps} today={today}
                  onTask={(t) => setTaskModal({ mode: "edit", task: t })}
                  onPatch={(id, body) => patchTask.mutate({ id, body })}
                  onAddDep={async (successorId, predecessorId) => {
                    try {
                      const r = await apiRequest("POST", `/api/admin/management/tasks/${successorId}/deps`, { predecessorId });
                      await r.json(); invTasks();
                    } catch (e: any) { toast({ title: "Couldn't link tasks", description: e.message, variant: "destructive" }); }
                  }} />
              )}
            </>
          )}
        </div>
      </div>

      {taskModal && (
        <TaskModal
          key={taskModal.task?.id ?? "new"}
          mode={taskModal.mode} task={taskModal.task} draft={taskModal.draft}
          projects={activeProjects} allTasks={allTasks} deps={deps} team={team} today={today}
          saving={saveTask.isPending}
          liveTask={allTasks.find((t) => t.id === taskModal.task?.id)}
          onClose={() => setTaskModal(null)}
          onSave={(body: any) => saveTask.mutate({ id: taskModal.task?.id, body })}
          onDelete={taskModal.task ? () => deleteTask.mutate(taskModal.task!.id) : undefined}
          invTasks={invTasks}
        />
      )}
      {projectModal && (
        <ProjectModal
          key={projectModal.project?.id ?? "new"}
          mode={projectModal.mode} project={projectModal.project}
          liveProject={projects.find((p) => p.id === projectModal.project?.id)}
          taskCountByStatus={(statusId) => allTasks.filter((t) => t.statusId === statusId).length}
          onClose={() => setProjectModal(null)}
          onDone={() => { invProjects(); invTasks(); }}
          onDeleted={(id) => { if (selectedProjectId === id) setSelectedProjectId(null); setProjectModal(null); invProjects(); invTasks(); }}
        />
      )}
    </div>
  );
}

// ── shared little pieces ──────────────────────────────────────────────────────
function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`h-7 rounded-md border px-2 text-xs ${value ? "bg-indigo-500/10 border-indigo-500/40 text-indigo-100" : "bg-white/[0.04] border-white/10 text-white/70"}`}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function EmptyState({ onNewProject }: { onNewProject: () => void }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <ClipboardList className="w-10 h-10 text-white/15 mx-auto mb-3" />
        <div className="text-base font-semibold mb-1">Plan the first project</div>
        <p className="text-sm text-white/40 mb-4">
          A project holds its own board columns, tasks, dates and dependencies —
          equipment purchases, campaigns, trade shows, shop upgrades.
        </p>
        <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={onNewProject}>
          <Plus className="w-4 h-4 mr-1" />New project
        </Button>
      </div>
    </div>
  );
}

const FieldLabel = ({ children }: any) => <Label className="text-xs text-white/60 mb-1 block">{children}</Label>;
const inputCls = "bg-white/[0.04] border-white/10 text-white";
const selCls = "w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm";

// Short-viewport safety (Dima's Windows laptop, 2026-07-22): NEVER
// `items-center` a modal that can outgrow the screen — a centred flex child
// that overflows a scrollable overlay clips its TOP off-screen, unreachable
// by scrolling. `m-auto` on the card centres it when it fits and degrades to
// normal top-anchored scrolling when it doesn't. The footer is sticky so
// Save/Cancel stay on screen however short the laptop.
function ModalShell({ title, color, onClose, children, footer, maxW = "max-w-lg" }: any) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150" onClick={onClose}>
      <div className={`w-full ${maxW} m-auto bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-200`} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between sticky top-0 bg-[#0a0e1a] rounded-t-2xl z-10">
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} /><h2 className="text-base font-semibold">{title}</h2></div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-white/[0.06] flex items-center justify-between gap-2 sticky bottom-0 bg-[#0a0e1a] rounded-b-2xl z-10">{footer}</div>}
      </div>
    </div>
  );
}

// ═══ TASK MODAL — fields + checklist + dependencies + comments in one place ══
function TaskModal({ mode, task, draft, projects, allTasks, deps, team, today, saving, liveTask, onClose, onSave, onDelete, invTasks }: {
  mode: "create" | "edit"; task?: PlanTaskRow; draft?: TaskDraft;
  projects: PlanProjectRow[]; allTasks: PlanTaskRow[]; deps: DepRow[]; team: TeamMember[]; today: string;
  saving: boolean; liveTask?: PlanTaskRow;
  onClose: () => void; onSave: (body: any) => void; onDelete?: () => void; invTasks: () => void;
}) {
  const { toast } = useToast();
  const src = liveTask || task;

  const [projectId, setProjectId] = useState<number>(task?.projectId ?? draft?.projectId ?? projects[0]?.id);
  const project = projects.find((p) => p.id === projectId);
  const [statusId, setStatusId] = useState<number | undefined>(task?.statusId ?? draft?.statusId);
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState(task?.priority || "medium");
  const [assigneeId, setAssigneeId] = useState<string>(task?.assigneeId ? String(task.assigneeId) : "");
  const [startDate, setStartDate] = useState(task?.startDate || draft?.startDate || "");
  const [dueDate, setDueDate] = useState(task?.dueDate || draft?.dueDate || "");
  const [milestone, setMilestone] = useState(task?.milestone || false);
  const [progress, setProgress] = useState<number | null>(task?.progress ?? null);
  const [tags, setTags] = useState<string[]>(task?.tags || []);
  const [tagDraft, setTagDraft] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [ciTitle, setCiTitle] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [depPick, setDepPick] = useState("");

  // when the project changes on a NEW task, the status must follow it
  useEffect(() => {
    if (mode === "create" && project && (statusId == null || !project.statuses.some((s) => s.id === statusId))) {
      setStatusId(project.statuses[0]?.id);
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const statuses = project?.statuses ?? [];
  const currentStatus = statuses.find((s) => s.id === (statusId ?? src?.statusId));
  const dateInvalid = !!startDate && !!dueDate && startDate > dueDate;

  const submit = () => {
    if (!title.trim() || !projectId || dateInvalid) return;
    onSave({
      projectId, statusId: statusId ?? undefined,
      title: title.trim(), description: description.trim() || null,
      priority, assigneeId: assigneeId ? Number(assigneeId) : null,
      startDate: startDate || null, dueDate: dueDate || null,
      milestone, progress, tags,
    });
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  };

  // checklist / comments / deps — live against the saved task
  const checklist = src?.checklist ?? [];
  const addChecklist = async () => {
    if (!src || !ciTitle.trim()) return;
    try { await apiRequest("POST", `/api/admin/management/tasks/${src.id}/checklist`, { title: ciTitle.trim() }); setCiTitle(""); invTasks(); }
    catch (e: any) { toast({ title: "Couldn't add item", description: e.message, variant: "destructive" }); }
  };
  const toggleChecklist = async (id: number, done: boolean) => {
    try { await apiRequest("PATCH", `/api/admin/management/checklist/${id}`, { done }); invTasks(); } catch {}
  };
  const delChecklist = async (id: number) => {
    try { await apiRequest("DELETE", `/api/admin/management/checklist/${id}`); invTasks(); } catch {}
  };

  const { data: commentData, refetch: refetchComments } = useQuery<{ today: string; comments: CommentRow[] }>({
    queryKey: [`/api/admin/management/tasks/${src?.id}/comments`],
    enabled: mode === "edit" && !!src,
  });
  const comments = commentData?.comments ?? [];
  const postComment = async () => {
    if (!src || !commentDraft.trim()) return;
    try { await apiRequest("POST", `/api/admin/management/tasks/${src.id}/comments`, { body: commentDraft.trim() }); setCommentDraft(""); refetchComments(); invTasks(); }
    catch (e: any) { toast({ title: "Couldn't comment", description: e.message, variant: "destructive" }); }
  };

  const myDeps = src ? deps.filter((d) => d.successorId === src.id) : [];
  const blockedBy = myDeps.map((d) => ({ dep: d, task: allTasks.find((t) => t.id === d.predecessorId) }));
  const blocking = src ? deps.filter((d) => d.predecessorId === src.id).map((d) => allTasks.find((t) => t.id === d.successorId)).filter(Boolean) : [];
  const depCandidates = src
    ? allTasks.filter((t) => t.id !== src.id && !myDeps.some((d) => d.predecessorId === t.id) && !wouldCreateCycle(deps, t.id, src.id))
    : [];
  const addDep = async () => {
    if (!src || !depPick) return;
    try { await apiRequest("POST", `/api/admin/management/tasks/${src.id}/deps`, { predecessorId: Number(depPick) }); setDepPick(""); invTasks(); }
    catch (e: any) { toast({ title: "Couldn't link", description: e.message, variant: "destructive" }); }
  };
  const removeDep = async (id: number) => {
    try { await apiRequest("DELETE", `/api/admin/management/deps/${id}`); invTasks(); } catch {}
  };

  return (
    <ModalShell title={mode === "create" ? "New task" : "Edit task"} color={currentStatus?.color ?? project?.color ?? "#6366f1"} onClose={onClose} maxW="max-w-2xl"
      footer={<>
        <div>{onDelete && (confirmDel
          ? <span className="flex items-center gap-2 text-xs"><span className="text-white/50">Delete?</span><button onClick={onDelete} className="text-red-400 hover:text-red-300 font-semibold">Yes</button><button onClick={() => setConfirmDel(false)} className="text-white/50">No</button></span>
          : <button onClick={() => setConfirmDel(true)} className="text-white/30 hover:text-red-300 flex items-center gap-1 text-xs"><Trash2 className="w-3.5 h-3.5" />Delete</button>)}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!title.trim() || !projectId || dateInvalid || saving} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Check className="w-3.5 h-3.5 mr-1" />{saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </>}>
      <div>
        <FieldLabel>Task</FieldLabel>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Confirm real per-m² rates with Dima" autoFocus className={inputCls}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <FieldLabel>Project</FieldLabel>
          <select value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))} className={selCls} disabled={mode === "edit"}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Column</FieldLabel>
          <select value={statusId ?? src?.statusId ?? ""} onChange={(e) => setStatusId(Number(e.target.value))} className={selCls}>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Priority</FieldLabel>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
        <div>
          <FieldLabel>Owner</FieldLabel>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={selCls}>
            <option value="">—</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Start</FieldLabel>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${inputCls} h-9`} />
        </div>
        <div>
          <FieldLabel>Due</FieldLabel>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`${inputCls} h-9 ${dateInvalid ? "border-red-500/60" : ""}`} />
        </div>
        <label className="flex items-center gap-2 text-xs text-white/60 h-9 cursor-pointer">
          <input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} className="accent-indigo-500 w-4 h-4" />
          <Diamond className="w-3 h-3 text-amber-300" />Milestone
        </label>
      </div>
      {dateInvalid && <div className="text-[11px] text-red-300">Start date must be on or before the due date.</div>}
      <div>
        <FieldLabel>Notes</FieldLabel>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details, links, context…" className={`${inputCls} min-h-[56px]`} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel>Tags</FieldLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <span key={t} className="text-[11px] px-2 py-0.5 rounded-md bg-white/[0.06] text-white/70 flex items-center gap-1">
                {t}<button onClick={() => setTags(tags.filter((x) => x !== t))} className="text-white/30 hover:text-white"><X className="w-3 h-3" /></button>
              </span>
            ))}
            <Input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              onBlur={addTag} placeholder="+ tag" className={`${inputCls} h-7 w-24 text-xs`} />
          </div>
        </div>
        {!checklist.length && (
          <div>
            <FieldLabel>Progress {progress != null ? `— ${progress}%` : ""}</FieldLabel>
            <div className="flex items-center gap-2 h-9">
              <input type="range" min={0} max={100} step={5} value={progress ?? 0}
                onChange={(e) => setProgress(Number(e.target.value))} className="flex-1 accent-indigo-500" />
              {progress != null && <button onClick={() => setProgress(null)} className="text-white/30 hover:text-white text-[10px]">clear</button>}
            </div>
          </div>
        )}
      </div>

      {/* checklist */}
      <div className="border-t border-white/[0.06] pt-4">
        <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2">
          Checklist{checklist.length ? ` — ${checklist.filter((c) => c.done).length}/${checklist.length}` : ""}
        </div>
        {mode === "create" ? (
          <div className="text-[11px] text-white/30">Save the task first, then break it into steps.</div>
        ) : (
          <div className="space-y-1.5">
            {checklist.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm">
                <button onClick={() => toggleChecklist(c.id, !c.done)} className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${c.done ? "bg-emerald-500 border-emerald-500" : "border-white/20"}`}>
                  {c.done && <Check className="w-3 h-3 text-white" />}
                </button>
                <span className={`flex-1 truncate ${c.done ? "line-through text-white/40" : ""}`}>{c.title}</span>
                <button onClick={() => delChecklist(c.id)} className="text-white/20 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Input value={ciTitle} onChange={(e) => setCiTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addChecklist(); }}
                placeholder="Add a step…" className={`${inputCls} h-8 flex-1`} />
              <button onClick={addChecklist} className="w-8 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center shrink-0"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>

      {/* dependencies */}
      {mode === "edit" && src && (
        <div className="border-t border-white/[0.06] pt-4">
          <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5" />Dependencies
          </div>
          <div className="space-y-1.5">
            {blockedBy.map(({ dep, task: t }) => t && (
              <div key={dep.id} className="flex items-center gap-2 text-[13px]">
                <span className="text-white/40 text-[11px] w-16 shrink-0">Waits on</span>
                <span className="flex-1 truncate">{t.title}</span>
                {t.dueDate && <span className="text-[10px] text-white/40">{fmtDate(t.dueDate)}</span>}
                <button onClick={() => removeDep(dep.id)} className="text-white/20 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            {blocking.map((t) => t && (
              <div key={t.id} className="flex items-center gap-2 text-[13px] text-white/50">
                <span className="text-white/40 text-[11px] w-16 shrink-0">Blocks</span>
                <span className="flex-1 truncate">{t.title}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <select value={depPick} onChange={(e) => setDepPick(e.target.value)} className={`${selCls} h-8 text-xs flex-1`}>
                <option value="">This task waits on…</option>
                {depCandidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <button onClick={addDep} disabled={!depPick} className="w-8 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center shrink-0 disabled:opacity-30"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      )}

      {/* comments */}
      {mode === "edit" && src && (
        <div className="border-t border-white/[0.06] pt-4">
          <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" />Comments
          </div>
          <div className="space-y-2.5">
            {comments.map((c) => (
              <div key={c.id} className="flex items-start gap-2">
                <span className="w-6 h-6 rounded-full bg-white/10 text-[9px] font-bold flex items-center justify-center text-white/80 border border-white/10 shrink-0">{initials(c.authorName)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-white/40">{c.authorName || "Someone"} · {new Date(c.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</div>
                  <div className="text-sm whitespace-pre-wrap break-words">{c.body}</div>
                </div>
              </div>
            ))}
            {!comments.length && <div className="text-[11px] text-white/30">No comments yet.</div>}
            <div className="flex items-center gap-2 pt-1">
              <Input value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") postComment(); }}
                placeholder="Write a comment…" className={`${inputCls} h-8 flex-1`} />
              <button onClick={postComment} className="w-8 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center shrink-0"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ═══ PROJECT MODAL — details + workflow-column manager ═══════════════════════
function ProjectModal({ mode, project, liveProject, taskCountByStatus, onClose, onDone, onDeleted }: {
  mode: "create" | "edit"; project?: PlanProjectRow; liveProject?: PlanProjectRow;
  taskCountByStatus: (statusId: number) => number;
  onClose: () => void; onDone: () => void; onDeleted: (id: number) => void;
}) {
  const { toast } = useToast();
  const src = liveProject || project;

  const [name, setName] = useState(project?.name || "");
  const [description, setDescription] = useState(project?.description || "");
  const [color, setColor] = useState(project?.color || PROJECT_COLORS[0]);
  const [startDate, setStartDate] = useState(project?.startDate || "");
  const [targetDate, setTargetDate] = useState(project?.targetDate || "");
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [colTitle, setColTitle] = useState("");
  const [colKind, setColKind] = useState("todo");
  const [moveTargets, setMoveTargets] = useState<Record<number, string>>({});
  const dateInvalid = !!startDate && !!targetDate && startDate > targetDate;

  const submit = async () => {
    if (!name.trim() || dateInvalid) return;
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, color, startDate: startDate || null, targetDate: targetDate || null };
      if (mode === "create") await (await apiRequest("POST", "/api/admin/management/projects", body)).json();
      else await (await apiRequest("PATCH", `/api/admin/management/projects/${src!.id}`, body)).json();
      onDone(); onClose();
      toast({ title: mode === "create" ? "Project created" : "Project saved" });
    } catch (e: any) {
      toast({ title: "Couldn't save project", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const removeProject = async () => {
    if (!src) return;
    try {
      const r = await (await apiRequest("DELETE", `/api/admin/management/projects/${src.id}`)).json();
      toast({ title: r.archived ? "Project archived" : "Project deleted", description: r.reason });
      onDeleted(src.id);
    } catch (e: any) { toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }); }
  };

  const addColumn = async () => {
    if (!src || !colTitle.trim()) return;
    try {
      await (await apiRequest("POST", `/api/admin/management/projects/${src.id}/statuses`, { label: colTitle.trim(), kind: colKind })).json();
      setColTitle(""); onDone();
    } catch (e: any) { toast({ title: "Couldn't add column", description: e.message, variant: "destructive" }); }
  };
  const patchColumn = async (id: number, body: any) => {
    try { await (await apiRequest("PATCH", `/api/admin/management/statuses/${id}`, body)).json(); onDone(); }
    catch (e: any) { toast({ title: "Couldn't update column", description: e.message, variant: "destructive" }); }
  };
  const deleteColumn = async (id: number) => {
    const moveTo = moveTargets[id];
    const qs = moveTo ? `?moveTo=${moveTo}` : "";
    try {
      await (await apiRequest("DELETE", `/api/admin/management/statuses/${id}${qs}`)).json();
      onDone();
    } catch (e: any) { toast({ title: "Couldn't delete column", description: e.message, variant: "destructive" }); }
  };

  const statuses = src?.statuses ?? [];

  return (
    <ModalShell title={mode === "create" ? "New project" : "Project settings"} color={color} onClose={onClose} maxW="max-w-xl"
      footer={<>
        <div>{mode === "edit" && (confirmDel
          ? <span className="flex items-center gap-2 text-xs"><span className="text-white/50">{statuses.some((st) => taskCountByStatus(st.id) > 0) ? "Archive it (tasks kept)?" : "Delete?"}</span><button onClick={removeProject} className="text-red-400 hover:text-red-300 font-semibold">Yes</button><button onClick={() => setConfirmDel(false)} className="text-white/50">No</button></span>
          : <button onClick={() => setConfirmDel(true)} className="text-white/30 hover:text-red-300 flex items-center gap-1 text-xs"><Trash2 className="w-3.5 h-3.5" />Delete project</button>)}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!name.trim() || dateInvalid || saving} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Check className="w-3.5 h-3.5 mr-1" />{saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </>}>
      <div>
        <FieldLabel>Project name</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Trade show prep" autoFocus className={inputCls} />
      </div>
      <div>
        <FieldLabel>Description</FieldLabel>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project, what does done look like…" className={`${inputCls} min-h-[48px]`} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Start</FieldLabel>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${inputCls} h-9`} />
        </div>
        <div>
          <FieldLabel>Target</FieldLabel>
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={`${inputCls} h-9 ${dateInvalid ? "border-red-500/60" : ""}`} />
        </div>
      </div>
      {dateInvalid && <div className="text-[11px] text-red-300">Start must be on or before the target date.</div>}
      <div>
        <FieldLabel>Colour</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {PROJECT_COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} className={`w-7 h-7 rounded-lg border-2 ${color === c ? "border-white" : "border-transparent"}`} style={{ background: c }} />
          ))}
        </div>
      </div>

      {mode === "edit" && src && (
        <div className="border-t border-white/[0.06] pt-4">
          <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2">Board columns</div>
          <div className="space-y-2">
            {statuses.map((st) => {
              const n = taskCountByStatus(st.id);
              const others = statuses.filter((o) => o.id !== st.id);
              return (
                <div key={st.id} className="flex items-center gap-2">
                  <ColorDot color={st.color} onPick={(c) => patchColumn(st.id, { color: c })} />
                  <Input defaultValue={st.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== st.label) patchColumn(st.id, { label: v }); }}
                    className={`${inputCls} h-8 flex-1 text-sm`} />
                  <select value={st.kind} onChange={(e) => patchColumn(st.id, { kind: e.target.value })}
                    className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-1.5 text-xs">
                    <option value="todo">To do</option>
                    <option value="active">In progress</option>
                    <option value="done">Done</option>
                  </select>
                  {n > 0 && (
                    <select value={moveTargets[st.id] ?? ""} onChange={(e) => setMoveTargets({ ...moveTargets, [st.id]: e.target.value })}
                      className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-1.5 text-xs max-w-[110px]" title={`${n} task(s) — pick where they go if you delete this column`}>
                      <option value="">{n} task{n === 1 ? "" : "s"} →</option>
                      {others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  )}
                  <button onClick={() => deleteColumn(st.id)} disabled={statuses.length <= 1 || (n > 0 && !moveTargets[st.id])}
                    className="text-white/20 hover:text-red-300 disabled:opacity-20 shrink-0" title={n > 0 && !moveTargets[st.id] ? "Pick a column for its tasks first" : "Delete column"}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
            <div className="flex items-center gap-2 pt-1">
              <Input value={colTitle} onChange={(e) => setColTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addColumn(); }}
                placeholder="Add a column…" className={`${inputCls} h-8 flex-1`} />
              <select value={colKind} onChange={(e) => setColKind(e.target.value)} className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-1.5 text-xs">
                <option value="todo">To do</option>
                <option value="active">In progress</option>
                <option value="done">Done</option>
              </select>
              <button onClick={addColumn} className="w-8 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center shrink-0"><Plus className="w-4 h-4" /></button>
            </div>
            <div className="text-[10px] text-white/30">The “kind” keeps Done logic working however you name a column.</div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ColorDot({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(!open)} className="w-6 h-6 rounded-md border border-white/10" style={{ background: color }} />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-7 z-20 bg-[#131829] border border-white/10 rounded-lg p-2 flex flex-wrap gap-1.5 w-[136px] shadow-xl">
            {STATUS_COLOR_PRESETS.map((c) => (
              <button key={c} onClick={() => { onPick(c); setOpen(false); }} className={`w-5 h-5 rounded border ${c === color ? "border-white" : "border-transparent"}`} style={{ background: c }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
