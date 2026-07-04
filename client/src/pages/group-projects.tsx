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
import { Plus, X, User, Calendar as CalendarIcon, Flag, Check, Inbox, LayoutGrid, Layers, AlertCircle, ChevronLeft, ChevronRight, Pencil, Trash2, Target, Presentation, Gauge, Users } from "lucide-react";
import {
  BRANDS, PRIORITY_COLORS, RAG_META, RAG_ORDER,
  type Rag, type ProjectGroup, type ProjectBoard, type ProjectTask,
  type TeamMember, type Department, type Goal,
} from "@/lib/work";
import { MyWorkView, GoalsView, StaffMeetingView, LeadershipView } from "./group-work-views";

// Types + brand/RAG vocab live in @/lib/work (shared with the Command-Centre views).

export default function GroupProjectsPage() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;

  const [selectedBoardId, setSelectedBoardId] = useState<number | null>(null);
  const [view, setView] = useState<"board" | "mine" | "calendar" | "goals" | "meeting" | "leadership">("board");
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [taskModal, setTaskModal] = useState<{ mode: "create" | "edit"; task?: ProjectTask; defaultGroupId?: number } | null>(null);
  const [boardModal, setBoardModal] = useState<{ mode: "create" | "edit"; board?: ProjectBoard } | null>(null);

  const { data: me } = useQuery<{ id: number }>({ queryKey: ["/api/auth/me"] });

  const { data: boards = [], isLoading: boardsLoading } = useQuery<ProjectBoard[]>({
    queryKey: ["/api/admin/projects/boards", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/projects/boards?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load boards");
      return r.json();
    },
    enabled: !!orgId,
  });

  // Auto-select first board on load
  const board = useMemo(() => {
    if (selectedBoardId) return boards.find(b => b.id === selectedBoardId) || null;
    return boards[0] || null;
  }, [boards, selectedBoardId]);

  const { data: tasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ["/api/admin/projects/tasks", { boardId: board?.id, orgId, brand: brandFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("organizationId", String(orgId));
      if (board) params.set("boardId", String(board.id));
      if (brandFilter) params.set("brand", brandFilter);
      const r = await fetch(`/api/admin/projects/tasks?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load tasks");
      return r.json();
    },
    enabled: !!orgId && !!board && view === "board",
  });

  const { data: myTasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ["/api/admin/projects/tasks/mine"],
    queryFn: async () => {
      const r = await fetch("/api/admin/projects/tasks/mine", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
    enabled: view === "mine" || view === "calendar",
    // Live-update the personal view during the day.
    refetchInterval: view === "mine" ? 20000 : false,
  });

  // Calendar / meeting / leadership views fetch every task across every board
  // (org-scoped) plus the org-wide events so the customer sees the full
  // alignment picture: their work + the team's work + scheduled events.
  const needsAllTasks = view === "calendar" || view === "meeting" || view === "leadership" || view === "goals";
  const { data: allTasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ["/api/admin/projects/tasks", { all: true, orgId, brand: brandFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("organizationId", String(orgId));
      if (brandFilter) params.set("brand", brandFilter);
      const r = await fetch(`/api/admin/projects/tasks?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!orgId && needsAllTasks,
    // Live-update the big-screen meeting + leadership rollup.
    refetchInterval: (view === "meeting" || view === "leadership") ? 20000 : false,
  });

  // Departments (the second axis) — always loaded; the task editor + views need them.
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/admin/departments", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/departments?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!orgId,
  });

  // Goals ladder — Vision → Season → Priority (+ nested measures).
  const { data: goals = [] } = useQuery<Goal[]>({
    queryKey: ["/api/admin/goals", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/goals?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!orgId,
    refetchInterval: (view === "goals" || view === "meeting" || view === "leadership") ? 25000 : false,
  });

  const { rangeStart, rangeEnd } = useMemo(() => {
    const start = new Date(calendarMonth.year, calendarMonth.month, 1);
    start.setDate(1 - ((start.getDay() + 6) % 7)); // back to Monday
    const end = new Date(start);
    end.setDate(end.getDate() + 42);
    return { rangeStart: start, rangeEnd: end };
  }, [calendarMonth]);

  const { data: orgEvents = [] } = useQuery<Array<{ id: number; title: string; date: string; categorySlug: string | null; allDay: boolean }>>({
    queryKey: ["/api/admin/calendar-events", rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: async () => {
      const r = await fetch(`/api/admin/calendar-events?startDate=${rangeStart.toISOString()}&endDate=${rangeEnd.toISOString()}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: view === "calendar",
  });

  const { data: eventCategories = [] } = useQuery<Array<{ slug: string; label: string; color: string }>>({
    queryKey: ["/api/admin/calendar-categories", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/calendar-categories?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!orgId && view === "calendar",
  });

  const { data: team = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/admin/projects/team", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/projects/team?organizationId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load team");
      return r.json();
    },
    enabled: !!orgId,
  });

  const saveBoard = useMutation({
    mutationFn: async ({ id, payload }: { id?: number; payload: any }) => {
      if (id) {
        const r = await apiRequest("PATCH", `/api/admin/projects/boards/${id}`, payload);
        return r.json();
      }
      const r = await apiRequest("POST", "/api/admin/projects/boards", { ...payload, organizationId: orgId });
      return r.json();
    },
    onSuccess: (board: ProjectBoard, vars) => {
      // Refetch so the new/edited board shows up immediately, and auto-select
      // it so the customer sees their new board open straight away.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/boards"] });
      queryClient.refetchQueries({ queryKey: ["/api/admin/projects/boards", orgId] });
      if (!vars.id && board?.id) {
        setSelectedBoardId(board.id);
        setView("board");
      }
      setBoardModal(null);
      toast({ title: vars.id ? "Board updated" : "Board created" });
    },
    onError: (e: any) => toast({ title: "Couldn't save board", description: e.message, variant: "destructive" }),
  });

  const deleteBoard = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/projects/boards/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/boards"] });
      queryClient.refetchQueries({ queryKey: ["/api/admin/projects/boards", orgId] });
      setSelectedBoardId(null);
      setBoardModal(null);
      toast({ title: "Board deleted" });
    },
  });

  const createTask = useMutation({
    mutationFn: async (payload: any) => {
      const r = await apiRequest("POST", "/api/admin/projects/tasks", payload);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks/mine"] });
      setTaskModal(null);
      toast({ title: "Task created" });
    },
    onError: (e: any) => toast({ title: "Couldn't create task", description: e.message, variant: "destructive" }),
  });

  const updateTask = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/projects/tasks/${id}`, patch);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks/mine"] });
      setTaskModal(null);
    },
  });

  const deleteTask = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/projects/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks/mine"] });
      setTaskModal(null);
      toast({ title: "Task deleted" });
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────
  if (!orgId) return null;
  return (
    <div className="flex h-full">
      {/* Sidebar — boards list */}
      <aside className="w-60 border-r border-white/[0.06] flex flex-col">
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <h1 className="text-base font-semibold">Projects</h1>
          <p className="text-[11px] text-white/40 mt-0.5">Boards across {currentOrg?.name}</p>
        </div>

        {/* Command Centre — cross-cutting saved views over the one dataset */}
        {([
          { key: "mine", label: "My Work", icon: Users, badge: myTasks.length },
          { key: "goals", label: "Goals", icon: Target },
          { key: "meeting", label: "Staff Meeting", icon: Presentation },
          { key: "leadership", label: "Leadership", icon: Gauge },
          { key: "calendar", label: "Calendar", icon: CalendarIcon },
        ] as const).map(item => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setView(item.key as any)}
              data-testid={`button-view-${item.key}`}
              className={`flex items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors border-l-2 ${
                active ? "bg-blue-500/[0.08] text-blue-300 border-blue-500" : "text-white/70 hover:bg-white/[0.03] border-transparent"
              }`}
            >
              <span className="flex items-center gap-2"><Icon className="w-4 h-4" />{item.label}</span>
              {"badge" in item && !!item.badge && item.badge > 0 && !active && (
                <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded">{item.badge}</span>
              )}
            </button>
          );
        })}

        <div className="px-4 pt-4 pb-1.5 text-[10px] uppercase tracking-wider text-white/30 font-semibold flex items-center justify-between">
          <span>Boards</span>
          <button
            onClick={() => setBoardModal({ mode: "create" })}
            data-testid="button-create-board"
            className="w-5 h-5 rounded hover:bg-white/[0.06] flex items-center justify-center text-white/40 hover:text-white transition"
            title="New board"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {boardsLoading ? (
            <div className="px-4 py-2 space-y-2">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          ) : boards.length === 0 ? (
            <button
              onClick={() => setBoardModal({ mode: "create" })}
              data-testid="button-empty-create-board"
              className="mx-3 mt-2 w-[calc(100%-1.5rem)] rounded-lg border border-dashed border-white/10 px-3 py-3 text-[11px] text-white/40 hover:text-white hover:border-white/20 transition"
            >
              + Create your first board
            </button>
          ) : boards.map(b => {
            const active = view === "board" && board?.id === b.id;
            return (
              <div
                key={b.id}
                className={`group relative flex items-center gap-2 transition-colors border-l-2 ${
                  active ? "bg-white/[0.04] border-blue-500" : "hover:bg-white/[0.02] border-transparent"
                }`}
              >
                <button
                  onClick={() => { setView("board"); setSelectedBoardId(b.id); }}
                  data-testid={`button-board-${b.id}`}
                  className={`flex-1 flex items-center gap-2 pl-4 pr-2 py-2 text-sm text-left ${active ? "text-white" : "text-white/60"}`}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color || "#3b82f6" }} />
                  <span className="truncate">{b.name}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setBoardModal({ mode: "edit", board: b }); }}
                  data-testid={`button-edit-board-${b.id}`}
                  className="opacity-0 group-hover:opacity-100 mr-2 w-6 h-6 rounded text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center transition"
                  title="Edit board"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar — board title, brand filter, new task. The Command-Centre
            views (My Work / Goals / Staff Meeting / Leadership) render their own
            headers, so the bar only shows for the board + calendar views. */}
        {(view === "board" || view === "calendar") && (
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold truncate">
              {view === "calendar" ? "Calendar" : board?.name || "Select a board"}
            </h2>
            {view === "board" && board?.description && (
              <p className="text-xs text-white/40 truncate">{board.description}</p>
            )}
          </div>

          {view === "board" && (
            <>
              {/* Brand filter chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {brandFilter && (
                  <button
                    onClick={() => setBrandFilter(null)}
                    data-testid="button-clear-brand-filter"
                    className="text-[10px] px-2 py-1 rounded-md border border-white/10 text-white/50 hover:text-white hover:border-white/20"
                  >
                    Clear filter
                  </button>
                )}
                {BRANDS.map(b => {
                  const active = brandFilter === b.slug;
                  return (
                    <button
                      key={b.slug}
                      onClick={() => setBrandFilter(active ? null : b.slug)}
                      data-testid={`chip-brand-${b.slug}`}
                      className="text-[10px] font-semibold px-2 py-1 rounded-md border transition"
                      style={{
                        borderColor: active ? b.color : "rgba(255,255,255,0.1)",
                        background: active ? `${b.color}25` : "transparent",
                        color: active ? "white" : "rgba(255,255,255,0.5)",
                      }}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>

              {board && (
                <Button
                  size="sm"
                  onClick={() => setTaskModal({ mode: "create", defaultGroupId: board.groups[0]?.id })}
                  data-testid="button-new-task"
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Plus className="w-4 h-4 mr-1" /> New task
                </Button>
              )}
            </>
          )}
        </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {view === "mine" ? (
            <MyWorkView tasks={myTasks} boards={boards} team={team} departments={departments} onEdit={t => setTaskModal({ mode: "edit", task: t })} />
          ) : view === "goals" ? (
            <GoalsView orgId={orgId} goals={goals} departments={departments} team={team} allTasks={allTasks} />
          ) : view === "meeting" ? (
            <StaffMeetingView allTasks={allTasks} boards={boards} goals={goals} departments={departments} team={team} onEdit={t => setTaskModal({ mode: "edit", task: t })} />
          ) : view === "leadership" ? (
            <LeadershipView allTasks={allTasks} boards={boards} goals={goals} departments={departments} team={team} onEdit={t => setTaskModal({ mode: "edit", task: t })} />
          ) : view === "calendar" ? (
            <CalendarView
              year={calendarMonth.year}
              month={calendarMonth.month}
              setMonth={setCalendarMonth}
              tasks={allTasks}
              myTaskIds={new Set(myTasks.map(t => t.id))}
              boards={boards}
              team={team}
              orgEvents={orgEvents}
              eventCategories={eventCategories}
              onEditTask={(t) => setTaskModal({ mode: "edit", task: t })}
              currentUserId={me?.id}
            />
          ) : board ? (
            <KanbanView
              board={board}
              tasks={tasks}
              team={team}
              onCreate={(groupId) => setTaskModal({ mode: "create", defaultGroupId: groupId })}
              onEdit={(t) => setTaskModal({ mode: "edit", task: t })}
              onMoveToGroup={(taskId, groupId) => updateTask.mutate({ id: taskId, patch: { groupId } })}
              currentUserId={me?.id}
            />
          ) : (
            <div className="p-12 text-center text-white/40 text-sm">
              Create a board to get started.
            </div>
          )}
        </div>
      </div>

      {boardModal && (
        <BoardModal
          mode={boardModal.mode}
          board={boardModal.board}
          onClose={() => setBoardModal(null)}
          onSave={(payload) => saveBoard.mutate({ id: boardModal.board?.id, payload })}
          onDelete={boardModal.board ? () => deleteBoard.mutate(boardModal.board!.id) : undefined}
          saving={saveBoard.isPending}
        />
      )}
      {taskModal && board && (
        <TaskModal
          mode={taskModal.mode}
          task={taskModal.task}
          board={board}
          allBoards={boards}
          team={team}
          departments={departments}
          goals={goals}
          defaultGroupId={taskModal.defaultGroupId}
          orgId={orgId}
          onClose={() => setTaskModal(null)}
          onSubmit={(payload) => {
            if (taskModal.mode === "create") createTask.mutate(payload);
            else if (taskModal.task) updateTask.mutate({ id: taskModal.task.id, patch: payload });
          }}
          onDelete={taskModal.task ? () => deleteTask.mutate(taskModal.task!.id) : undefined}
        />
      )}
    </div>
  );
}

// ── Kanban view ──────────────────────────────────────────────────────────────
function KanbanView({
  board, tasks, team, onCreate, onEdit, onMoveToGroup, currentUserId,
}: {
  board: ProjectBoard;
  tasks: ProjectTask[];
  team: TeamMember[];
  onCreate: (groupId: number) => void;
  onEdit: (task: ProjectTask) => void;
  onMoveToGroup: (taskId: number, groupId: number) => void;
  currentUserId?: number;
}) {
  // Kanban shows top-level tasks only — subtasks are accessed by opening the
  // parent. We still hand the full task array down so each card can show its
  // subtask progress (e.g. "2/5") without an extra fetch.
  const subtasksByParent = useMemo(() => {
    const m = new Map<number, ProjectTask[]>();
    for (const t of tasks) {
      if (t.parentId == null) continue;
      const arr = m.get(t.parentId) || [];
      arr.push(t);
      m.set(t.parentId, arr);
    }
    return m;
  }, [tasks]);
  const doneGroupIds = useMemo(() => new Set(board.groups.filter(g => g.isDone).map(g => g.id)), [board.groups]);
  const tasksByGroup = useMemo(() => {
    const m = new Map<number | null, ProjectTask[]>();
    for (const t of tasks) {
      if (t.parentId != null) continue; // skip subtasks
      const arr = m.get(t.groupId) || [];
      arr.push(t);
      m.set(t.groupId, arr);
    }
    return m;
  }, [tasks]);

  return (
    <div className="flex gap-3 p-4 h-full min-w-max">
      {board.groups.map(g => {
        const items = tasksByGroup.get(g.id) || [];
        return (
          <div key={g.id} className="w-72 flex-shrink-0 flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.04]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                <span className="text-sm font-semibold">{g.name}</span>
                <span className="text-[10px] text-white/30">{items.length}</span>
              </div>
              <button
                onClick={() => onCreate(g.id)}
                data-testid={`button-add-task-${g.id}`}
                className="w-6 h-6 rounded text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[120px]">
              {items.length === 0 ? (
                <button
                  onClick={() => onCreate(g.id)}
                  className="w-full text-[11px] text-white/30 hover:text-white/50 italic py-3 rounded border border-dashed border-white/10"
                >
                  + Add a task
                </button>
              ) : items.map(t => {
                const subs = subtasksByParent.get(t.id) || [];
                const subsDone = subs.filter(s => s.groupId != null && doneGroupIds.has(s.groupId)).length;
                return (
                  <TaskCard
                    key={t.id}
                    task={t}
                    team={team}
                    groupIsDone={g.isDone}
                    onClick={() => onEdit(t)}
                    highlightOwner={currentUserId === t.ownerId}
                    subtaskTotal={subs.length}
                    subtaskDone={subsDone}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Task card (used in both kanban and my tasks) ─────────────────────────────
function TaskCard({ task, team, groupIsDone, onClick, highlightOwner, subtaskTotal = 0, subtaskDone = 0 }: {
  task: ProjectTask;
  team: TeamMember[];
  groupIsDone?: boolean;
  onClick: () => void;
  highlightOwner?: boolean;
  subtaskTotal?: number;
  subtaskDone?: number;
}) {
  const owner = team.find(m => m.id === task.ownerId);
  const dueDate = task.dueDate ? new Date(task.dueDate + "T00:00:00") : null;
  const today = new Date(); today.setHours(0,0,0,0);
  const overdue = dueDate && !groupIsDone && dueDate < today;
  const dueSoon = dueDate && !overdue && !groupIsDone && (dueDate.getTime() - today.getTime()) < 1000*60*60*24*3;

  return (
    <button
      onClick={onClick}
      data-testid={`card-task-${task.id}`}
      className={`w-full text-left rounded-lg p-2.5 border transition-all hover:border-white/15 ${
        groupIsDone ? "opacity-60" : ""
      } ${highlightOwner ? "ring-1 ring-blue-500/30" : ""}`}
      style={{
        borderColor: highlightOwner ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.06)",
        background: highlightOwner ? "rgba(59,130,246,0.05)" : "rgba(255,255,255,0.02)",
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className={`text-xs font-medium leading-snug ${groupIsDone ? "line-through text-white/40" : "text-white"}`}>
          {task.title}
        </div>
        {task.priority !== "medium" && (
          <Flag className="w-3 h-3 flex-shrink-0 mt-0.5" style={{ color: PRIORITY_COLORS[task.priority] }} />
        )}
      </div>
      {task.brandTags && task.brandTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {task.brandTags.slice(0, 3).map(slug => {
            const b = BRANDS.find(x => x.slug === slug);
            return (
              <span key={slug} className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{
                background: `${(b?.color || "#64748b")}20`,
                color: b?.color || "#64748b",
              }}>{b?.label || slug}</span>
            );
          })}
          {task.brandTags.length > 3 && <span className="text-[9px] text-white/30">+{task.brandTags.length - 3}</span>}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-white/40">
          {owner ? (
            <span className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full bg-white/[0.08] flex items-center justify-center text-[8px] font-semibold text-white/70">
                {owner.first_name[0]}{owner.last_name[0]}
              </span>
              <span>{owner.first_name}</span>
            </span>
          ) : <span className="italic">Unassigned</span>}
          {subtaskTotal > 0 && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06]"
              title={`${subtaskDone} of ${subtaskTotal} subtasks complete`}
            >
              <Layers className="w-2.5 h-2.5" />
              <span className={subtaskDone === subtaskTotal ? "text-emerald-300" : "text-white/60"}>
                {subtaskDone}/{subtaskTotal}
              </span>
            </span>
          )}
        </div>
        {dueDate && (
          <span className={`text-[10px] flex items-center gap-1 ${overdue ? "text-red-400" : dueSoon ? "text-amber-300" : "text-white/40"}`}>
            <CalendarIcon className="w-2.5 h-2.5" />
            {dueDate.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
          </span>
        )}
      </div>
    </button>
  );
}

// ── My Tasks view (grouped by due bucket) ────────────────────────────────────
function MyTasksView({ tasks, boards, team, onEdit }: {
  tasks: ProjectTask[];
  boards: ProjectBoard[];
  team: TeamMember[];
  onEdit: (t: ProjectTask) => void;
}) {
  const today = new Date(); today.setHours(0,0,0,0);
  const buckets = useMemo(() => {
    const overdue: ProjectTask[] = [];
    const todayList: ProjectTask[] = [];
    const thisWeek: ProjectTask[] = [];
    const later: ProjectTask[] = [];
    const noDate: ProjectTask[] = [];
    for (const t of tasks) {
      if (!t.dueDate) { noDate.push(t); continue; }
      const d = new Date(t.dueDate + "T00:00:00");
      const dt = d.getTime() - today.getTime();
      if (dt < 0) overdue.push(t);
      else if (dt < 1000*60*60*24) todayList.push(t);
      else if (dt < 1000*60*60*24*7) thisWeek.push(t);
      else later.push(t);
    }
    return { overdue, today: todayList, thisWeek, later, noDate };
  }, [tasks]);

  const sections = [
    { label: "Overdue", icon: AlertCircle, items: buckets.overdue, color: "text-red-400" },
    { label: "Today",   icon: CalendarIcon, items: buckets.today, color: "text-blue-300" },
    { label: "This week", icon: CalendarIcon, items: buckets.thisWeek, color: "text-white/70" },
    { label: "Later",   icon: Layers, items: buckets.later, color: "text-white/40" },
    { label: "No due date", icon: Inbox, items: buckets.noDate, color: "text-white/30" },
  ];

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      {tasks.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-12 text-center text-white/40 text-sm">
          No tasks assigned to you. Open any board and assign yourself a task to see it here.
        </div>
      )}
      {sections.filter(s => s.items.length > 0).map(s => {
        const Icon = s.icon;
        return (
          <div key={s.label}>
            <div className={`flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider ${s.color}`}>
              <Icon className="w-3.5 h-3.5" />
              {s.label}
              <span className="text-white/30 normal-case font-normal">· {s.items.length}</span>
            </div>
            <div className="space-y-1.5">
              {s.items.map(t => {
                const board = boards.find(b => b.id === t.boardId);
                const group = board?.groups.find(g => g.id === t.groupId);
                return (
                  <button
                    key={t.id}
                    onClick={() => onEdit(t)}
                    data-testid={`my-task-${t.id}`}
                    className="w-full text-left rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 p-3 flex items-center gap-3 transition-colors"
                  >
                    {t.priority !== "medium" && (
                      <Flag className="w-3.5 h-3.5 flex-shrink-0" style={{ color: PRIORITY_COLORS[t.priority] }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium truncate ${group?.isDone ? "line-through text-white/40" : "text-white"}`}>{t.title}</div>
                      <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-2">
                        {board && <span>{board.name}</span>}
                        {group && <span className="text-white/25">·</span>}
                        {group && <span style={{ color: group.color }}>{group.name}</span>}
                        {t.brandTags.length > 0 && (
                          <>
                            <span className="text-white/25">·</span>
                            <span className="flex gap-1">
                              {t.brandTags.slice(0, 3).map(slug => {
                                const b = BRANDS.find(x => x.slug === slug);
                                return <span key={slug} className="text-[9px] font-semibold px-1 py-0.5 rounded" style={{ background: `${b?.color || "#64748b"}20`, color: b?.color || "#64748b" }}>{b?.label || slug}</span>;
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {t.dueDate && (
                      <span className={`text-xs flex items-center gap-1 ${s.label === "Overdue" ? "text-red-400" : "text-white/50"}`}>
                        <CalendarIcon className="w-3 h-3" />
                        {new Date(t.dueDate + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Task modal (create/edit) ─────────────────────────────────────────────────
function TaskModal({
  mode, task, board, allBoards, team, departments, goals, defaultGroupId, orgId, onClose, onSubmit, onDelete,
}: {
  mode: "create" | "edit";
  task?: ProjectTask;
  board: ProjectBoard;
  allBoards: ProjectBoard[];
  team: TeamMember[];
  departments: Department[];
  goals: Goal[];
  defaultGroupId?: number;
  orgId: number;
  onClose: () => void;
  onSubmit: (payload: any) => void;
  onDelete?: () => void;
}) {
  // Subtasks live in the same task table — fetch every task on this board
  // whose parentId is the one we're editing. We hit the existing tasks
  // endpoint and filter client-side; no extra route needed.
  const { data: allBoardTasks = [] } = useQuery<ProjectTask[]>({
    queryKey: ["/api/admin/projects/tasks", { orgId, boardId: board.id, forSubtasks: true }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("organizationId", String(orgId));
      params.set("boardId", String(board.id));
      const r = await fetch(`/api/admin/projects/tasks?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load subtasks");
      return r.json();
    },
    enabled: mode === "edit" && !!task,
  });
  const subtasks = useMemo(
    () => task ? allBoardTasks.filter(t => t.parentId === task.id).sort((a, b) => a.id - b.id) : [],
    [allBoardTasks, task]
  );

  const createSubtask = useMutation({
    mutationFn: async (payload: { title: string; ownerId: number | null; dueDate: string | null; groupId: number | null }) => {
      const r = await apiRequest("POST", "/api/admin/projects/tasks", {
        organizationId: orgId,
        boardId: board.id,
        parentId: task!.id,
        groupId: payload.groupId ?? task!.groupId,
        title: payload.title,
        ownerId: payload.ownerId,
        dueDate: payload.dueDate,
        priority: "medium",
        brandTags: task!.brandTags,
      });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] }),
  });
  const patchSubtask = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/projects/tasks/${id}`, patch);
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] }),
  });
  const removeSubtask = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/projects/tasks/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/projects/tasks"] }),
  });
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState<ProjectTask["priority"]>(task?.priority || "medium");
  const [groupId, setGroupId] = useState<number | null>(task?.groupId ?? defaultGroupId ?? null);
  const [boardId, setBoardId] = useState<number>(task?.boardId ?? board.id);
  const [ownerId, setOwnerId] = useState<number | null>(task?.ownerId ?? null);
  const [dueDate, setDueDate] = useState(task?.dueDate || "");
  const [brandTags, setBrandTags] = useState<string[]>(task?.brandTags || []);
  // Work-management fields
  const [departmentId, setDepartmentId] = useState<number | null>(task?.departmentId ?? null);
  const [ragStatus, setRagStatus] = useState<Rag>(task?.ragStatus ?? "none");
  const [startDate, setStartDate] = useState(task?.startDate || "");
  const [nextStep, setNextStep] = useState(task?.nextStep || "");
  const [isIssue, setIsIssue] = useState<boolean>(task?.isIssue ?? false);
  const [goalId, setGoalId] = useState<number | null>(task?.goalId ?? null);

  const activeBoard = allBoards.find(b => b.id === boardId) || board;
  const priorities = goals.filter(g => g.level === "priority");

  const submit = () => {
    if (!title.trim()) return;
    const payload: any = {
      title: title.trim(),
      description: description.trim() || null,
      priority,
      groupId,
      ownerId,
      dueDate: dueDate || null,
      brandTags,
      departmentId,
      ragStatus,
      startDate: startDate || null,
      nextStep: nextStep.trim() || null,
      isIssue,
      goalId,
    };
    if (mode === "create") {
      payload.organizationId = orgId;
      payload.boardId = boardId;
    } else if (boardId !== task?.boardId) {
      payload.boardId = boardId;
    }
    onSubmit(payload);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-base font-semibold">{mode === "create" ? "New task" : "Edit task"}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div>
            <Label className="text-xs text-white/60 mb-1 block">Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus className="bg-white/[0.04] border-white/10 text-white" data-testid="input-task-title" />
          </div>
          <div>
            <Label className="text-xs text-white/60 mb-1 block">Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Add detail, links, acceptance criteria…" className="bg-white/[0.04] border-white/10 text-white min-h-[80px]" data-testid="input-task-description" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Board</Label>
              <select value={boardId} onChange={e => { setBoardId(parseInt(e.target.value)); setGroupId(null); }} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                {allBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Status</Label>
              <select value={groupId ?? ""} onChange={e => setGroupId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                <option value="">—</option>
                {activeBoard.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Priority</Label>
              <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                {["low","medium","high","urgent"].map(p => <option key={p} value={p}>{p[0].toUpperCase()+p.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Owner</Label>
              <select value={ownerId ?? ""} onChange={e => setOwnerId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                <option value="">Unassigned</option>
                {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Due date</Label>
              <DatePickerInput value={dueDate} onChange={e => setDueDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9" />
            </div>
          </div>
          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Brands / programmes <span className="text-white/25">(who it serves)</span></Label>
            <div className="flex flex-wrap gap-1.5">
              {BRANDS.map(b => {
                const active = brandTags.includes(b.slug);
                return (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => setBrandTags(prev => active ? prev.filter(x => x !== b.slug) : [...prev, b.slug])}
                    className="text-[11px] font-semibold px-2 py-1 rounded-md border transition"
                    style={{
                      borderColor: active ? b.color : "rgba(255,255,255,0.1)",
                      background: active ? `${b.color}25` : "transparent",
                      color: active ? "white" : "rgba(255,255,255,0.6)",
                    }}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Work-management fields: department = who OWNS it (single), the
              second axis of the matrix; RAG = the meeting/leadership colour. ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Department <span className="text-white/25">(owns it)</span></Label>
              <select value={departmentId ?? ""} onChange={e => setDepartmentId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm" data-testid="select-task-department">
                <option value="">—</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Status (RAG)</Label>
              <select value={ragStatus} onChange={e => setRagStatus(e.target.value as Rag)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm" data-testid="select-task-rag">
                {RAG_ORDER.map(r => <option key={r} value={r}>{RAG_META[r].label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Start by <span className="text-white/25">(optional)</span></Label>
              <DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-white/[0.04] border-white/10 text-white h-9" />
            </div>
            <div>
              <Label className="text-xs text-white/60 mb-1 block">Ladders up to</Label>
              <select value={goalId ?? ""} onChange={e => setGoalId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm" data-testid="select-task-goal">
                <option value="">— no priority —</option>
                {priorities.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs text-white/60 mb-1 block">Next step</Label>
            <Input value={nextStep} onChange={e => setNextStep(e.target.value)} placeholder="The single next action…" className="bg-white/[0.04] border-white/10 text-white" data-testid="input-task-nextstep" />
          </div>
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer select-none">
            <input type="checkbox" checked={isIssue} onChange={e => setIsIssue(e.target.checked)} className="accent-red-500 w-4 h-4" data-testid="checkbox-task-issue" />
            Raise as an issue / blocker for the next staff meeting
          </label>

          {mode === "edit" && task && (
            <SubtasksSection
              parent={task}
              parentDueDate={dueDate}
              subtasks={subtasks}
              team={team}
              groups={activeBoard.groups}
              onCreate={(payload) => createSubtask.mutate(payload)}
              onPatch={(id, patch) => patchSubtask.mutate({ id, patch })}
              onDelete={(id) => removeSubtask.mutate(id)}
            />
          )}
          {mode === "create" && (
            <div className="rounded-lg border border-dashed border-white/10 px-3 py-2.5 text-[11px] text-white/40">
              Save the task first, then add subtasks with their own owner and deadline.
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div>
            {onDelete && (
              <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50">Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!title.trim()} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-task">
              <Check className="w-3.5 h-3.5 mr-1" /> {mode === "create" ? "Create" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Subtasks section (lives inside the task modal) ───────────────────────────
// Monday-style inline subtask list. Each row mirrors the parent's data shape:
// title, owner, status (group), due date — fully independent. Editing happens
// in-place; no nested modal to keep the editing flow fast.
function SubtasksSection({
  parent, parentDueDate, subtasks, team, groups, onCreate, onPatch, onDelete,
}: {
  parent: ProjectTask;
  parentDueDate: string;
  subtasks: ProjectTask[];
  team: TeamMember[];
  groups: ProjectGroup[];
  onCreate: (payload: { title: string; ownerId: number | null; dueDate: string | null; groupId: number | null }) => void;
  onPatch: (id: number, patch: any) => void;
  onDelete: (id: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftOwnerId, setDraftOwnerId] = useState<number | null>(null);
  const [draftDueDate, setDraftDueDate] = useState("");
  const [draftGroupId, setDraftGroupId] = useState<number | null>(parent.groupId);

  const doneIds = useMemo(() => new Set(groups.filter(g => g.isDone).map(g => g.id)), [groups]);
  const completedCount = subtasks.filter(s => s.groupId != null && doneIds.has(s.groupId)).length;

  const submitDraft = () => {
    if (!draftTitle.trim()) return;
    onCreate({
      title: draftTitle.trim(),
      ownerId: draftOwnerId,
      dueDate: draftDueDate || null,
      groupId: draftGroupId,
    });
    setDraftTitle("");
    setDraftOwnerId(null);
    setDraftDueDate("");
    setDraftGroupId(parent.groupId);
    setAdding(false);
  };

  // Warn when a subtask falls after the parent's due date — informational
  // only (we don't block, since teams sometimes intentionally schedule
  // post-deadline cleanup).
  const parentDate = parentDueDate ? new Date(parentDueDate + "T00:00:00") : null;
  const isAfterParent = (s: ProjectTask) => {
    if (!parentDate || !s.dueDate) return false;
    return new Date(s.dueDate + "T00:00:00") > parentDate;
  };

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-white/40" />
          <span className="text-xs font-semibold text-white/80">Subtasks</span>
          {subtasks.length > 0 && (
            <span className="text-[10px] text-white/40">
              {completedCount}/{subtasks.length} done
            </span>
          )}
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            data-testid="button-add-subtask"
            className="text-[11px] flex items-center gap-1 text-blue-300 hover:text-blue-200 px-2 py-1 rounded hover:bg-blue-500/[0.08]"
          >
            <Plus className="w-3 h-3" /> Add subtask
          </button>
        )}
      </div>

      {/* Column header — only show when there are subtasks or we're adding */}
      {(subtasks.length > 0 || adding) && (
        <div className="hidden md:grid grid-cols-[1fr_120px_120px_120px_28px] gap-2 px-3 py-1.5 text-[9px] uppercase tracking-wider text-white/30 border-b border-white/[0.04]">
          <div>Title</div>
          <div>Owner</div>
          <div>Status</div>
          <div>Due</div>
          <div></div>
        </div>
      )}

      {/* Existing subtasks */}
      <div className="divide-y divide-white/[0.04]">
        {subtasks.map(s => (
          <SubtaskRow
            key={s.id}
            subtask={s}
            team={team}
            groups={groups}
            doneIds={doneIds}
            warnAfterParent={isAfterParent(s)}
            onPatch={(patch) => onPatch(s.id, patch)}
            onDelete={() => onDelete(s.id)}
          />
        ))}
        {subtasks.length === 0 && !adding && (
          <div className="px-3 py-3 text-[11px] text-white/30 italic">
            No subtasks yet — break this down into smaller pieces with their own owners and deadlines.
          </div>
        )}
      </div>

      {/* Inline add row */}
      {adding && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_120px_120px_28px] gap-2 px-3 py-2 bg-white/[0.02] border-t border-white/[0.04]">
          <Input
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") submitDraft();
              if (e.key === "Escape") { setAdding(false); setDraftTitle(""); }
            }}
            placeholder="Subtask title…"
            autoFocus
            className="bg-white/[0.04] border-white/10 text-white h-8 text-xs"
            data-testid="input-subtask-title"
          />
          <select
            value={draftOwnerId ?? ""}
            onChange={e => setDraftOwnerId(e.target.value ? parseInt(e.target.value) : null)}
            className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-2 text-[11px]"
          >
            <option value="">Unassigned</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
          </select>
          <select
            value={draftGroupId ?? ""}
            onChange={e => setDraftGroupId(e.target.value ? parseInt(e.target.value) : null)}
            className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-2 text-[11px]"
          >
            <option value="">—</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <DatePickerInput
            value={draftDueDate}
            onChange={e => setDraftDueDate(e.target.value)}
            className="bg-white/[0.04] border-white/10 text-white h-8 text-xs"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={submitDraft}
              disabled={!draftTitle.trim()}
              data-testid="button-save-subtask"
              className="w-7 h-7 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-30 flex items-center justify-center"
              title="Save subtask"
            >
              <Check className="w-3.5 h-3.5 text-white" />
            </button>
          </div>
        </div>
      )}

      {!adding && subtasks.length > 0 && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full text-left px-3 py-2 text-[11px] text-white/30 hover:text-white/60 hover:bg-white/[0.02] border-t border-white/[0.04] flex items-center gap-1.5"
        >
          <Plus className="w-3 h-3" /> Add subtask
        </button>
      )}
    </div>
  );
}

// One inline row — title is editable on click, owner/status/date are
// quick-edit dropdowns. Everything writes via PATCH so the parent and
// surrounding state refresh together.
function SubtaskRow({
  subtask, team, groups, doneIds, warnAfterParent, onPatch, onDelete,
}: {
  subtask: ProjectTask;
  team: TeamMember[];
  groups: ProjectGroup[];
  doneIds: Set<number>;
  warnAfterParent: boolean;
  onPatch: (patch: any) => void;
  onDelete: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);
  const isDone = subtask.groupId != null && doneIds.has(subtask.groupId);
  const today = new Date(); today.setHours(0,0,0,0);
  const dueDate = subtask.dueDate ? new Date(subtask.dueDate + "T00:00:00") : null;
  const overdue = dueDate && !isDone && dueDate < today;

  const commitTitle = () => {
    const t = titleDraft.trim();
    if (t && t !== subtask.title) onPatch({ title: t });
    else setTitleDraft(subtask.title);
    setEditingTitle(false);
  };

  // Quick toggle: clicking the checkbox flips between the first non-done
  // group and the first done group. If neither exists we just no-op.
  const firstDone = groups.find(g => g.isDone);
  const firstActive = groups.find(g => !g.isDone);
  const toggleDone = () => {
    if (isDone && firstActive) onPatch({ groupId: firstActive.id });
    else if (!isDone && firstDone) onPatch({ groupId: firstDone.id });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_120px_120px_28px] gap-2 px-3 py-1.5 items-center hover:bg-white/[0.02]">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={toggleDone}
          data-testid={`toggle-subtask-${subtask.id}`}
          className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition ${
            isDone ? "bg-emerald-500/80 border-emerald-400" : "border-white/20 hover:border-white/40"
          }`}
          title={isDone ? "Mark not done" : "Mark done"}
        >
          {isDone && <Check className="w-3 h-3 text-white" />}
        </button>
        {editingTitle ? (
          <input
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") { setTitleDraft(subtask.title); setEditingTitle(false); }
            }}
            autoFocus
            className="flex-1 min-w-0 bg-white/[0.04] border border-white/10 rounded px-1.5 py-0.5 text-xs text-white outline-none focus:border-blue-500/50"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            data-testid={`subtask-title-${subtask.id}`}
            className={`flex-1 min-w-0 text-left text-xs truncate ${isDone ? "line-through text-white/40" : "text-white/85"} hover:text-white`}
          >
            {subtask.title}
          </button>
        )}
      </div>
      <select
        value={subtask.ownerId ?? ""}
        onChange={e => onPatch({ ownerId: e.target.value ? parseInt(e.target.value) : null })}
        className="h-7 rounded-md bg-transparent border border-white/[0.06] hover:border-white/15 px-1.5 text-[10px] text-white/70"
      >
        <option value="">Unassigned</option>
        {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
      </select>
      <select
        value={subtask.groupId ?? ""}
        onChange={e => onPatch({ groupId: e.target.value ? parseInt(e.target.value) : null })}
        className="h-7 rounded-md bg-transparent border border-white/[0.06] hover:border-white/15 px-1.5 text-[10px]"
        style={{
          color: groups.find(g => g.id === subtask.groupId)?.color || "rgba(255,255,255,0.6)",
        }}
      >
        <option value="">—</option>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <DatePickerInput
        value={subtask.dueDate || ""}
        onChange={e => onPatch({ dueDate: e.target.value || null })}
        className={`h-7 text-[10px] bg-transparent border-white/[0.06] hover:border-white/15 ${
          overdue ? "text-red-400 border-red-500/30" : warnAfterParent ? "text-amber-300 border-amber-500/30" : "text-white/60"
        }`}
      />
      <button
        type="button"
        onClick={onDelete}
        data-testid={`delete-subtask-${subtask.id}`}
        className="w-7 h-7 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center"
        title="Delete subtask"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Calendar view — month grid showing tasks (mine vs others) + org events ──
// The headline alignment view: "how do my deadlines line up with what
// everyone else is doing across the brands". Personal tasks render solid
// and prominent; org-wide tasks render as muted bars; calendar events
// render in their category colour.
function CalendarView({
  year, month, setMonth, tasks, myTaskIds, boards, team, orgEvents, eventCategories, onEditTask, currentUserId,
}: {
  year: number;
  month: number;
  setMonth: (m: { year: number; month: number }) => void;
  tasks: ProjectTask[];
  myTaskIds: Set<number>;
  boards: ProjectBoard[];
  team: TeamMember[];
  orgEvents: Array<{ id: number; title: string; date: string; categorySlug: string | null; allDay: boolean }>;
  eventCategories: Array<{ slug: string; label: string; color: string }>;
  onEditTask: (t: ProjectTask) => void;
  currentUserId?: number;
}) {
  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
  const todayStr = new Date().toISOString().slice(0, 10);

  // Build a 6×7 grid starting on Monday containing the requested month
  const cells: Date[] = useMemo(() => {
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - startOffset);
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [year, month]);

  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const tasksByDate = useMemo(() => {
    const m = new Map<string, ProjectTask[]>();
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const arr = m.get(t.dueDate) || [];
      arr.push(t);
      m.set(t.dueDate, arr);
    }
    return m;
  }, [tasks]);
  const eventsByDate = useMemo(() => {
    const m = new Map<string, typeof orgEvents>();
    for (const e of orgEvents) {
      const day = e.date?.slice(0, 10);
      if (!day) continue;
      const arr = m.get(day) || [];
      arr.push(e);
      m.set(day, arr);
    }
    return m;
  }, [orgEvents]);
  const catColor = (slug: string | null) => slug ? (eventCategories.find(c => c.slug === slug)?.color || "#64748b") : "#64748b";

  return (
    <div className="p-4 space-y-3">
      {/* Header — month nav + legend */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonth(month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 })}
            data-testid="button-cal-prev"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          ><ChevronLeft className="w-4 h-4" /></button>
          <div className="text-base font-semibold w-44 text-center">{monthLabel}</div>
          <button
            onClick={() => setMonth(month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 })}
            data-testid="button-cal-next"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          ><ChevronRight className="w-4 h-4" /></button>
          <button
            onClick={() => { const d = new Date(); setMonth({ year: d.getFullYear(), month: d.getMonth() }); }}
            data-testid="button-cal-today"
            className="ml-2 text-[11px] px-2.5 py-1 rounded-md border border-white/10 text-white/60 hover:text-white hover:border-white/20"
          >Today</button>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: "#3b82f6" }} />Your tasks</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-white/20" />Team tasks</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: "#22c55e" }} />Org events</span>
        </div>
      </div>

      {/* Day-of-week header */}
      <div className="grid grid-cols-7 gap-1">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
          <div key={d} className="text-[10px] uppercase tracking-wider text-white/30 font-semibold text-center pb-1">{d}</div>
        ))}
      </div>

      {/* Month grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map(d => {
          const dStr = ymd(d);
          const inMonth = d.getMonth() === month;
          const isToday = dStr === todayStr;
          const dayTasks = tasksByDate.get(dStr) || [];
          const dayEvents = eventsByDate.get(dStr) || [];
          // Personal tasks first so they jump out
          const sortedTasks = [...dayTasks].sort((a, b) =>
            (myTaskIds.has(b.id) ? 1 : 0) - (myTaskIds.has(a.id) ? 1 : 0)
          );
          const totalItems = sortedTasks.length + dayEvents.length;
          const visibleTasks = sortedTasks.slice(0, 3);
          const visibleEvents = dayEvents.slice(0, Math.max(0, 4 - visibleTasks.length));
          const hidden = totalItems - visibleTasks.length - visibleEvents.length;

          return (
            <div
              key={dStr}
              className={`min-h-[110px] rounded-lg border p-1.5 transition-colors ${
                isToday ? "border-blue-500/40 bg-blue-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]"
              } ${inMonth ? "" : "opacity-40"}`}
              data-testid={`cal-day-${dStr}`}
            >
              <div className={`text-[11px] font-semibold mb-1 ${isToday ? "text-blue-300" : "text-white/60"}`}>
                {d.getDate()}
              </div>
              <div className="space-y-0.5">
                {visibleTasks.map(t => {
                  const mine = myTaskIds.has(t.id);
                  const owner = team.find(m => m.id === t.ownerId);
                  const board = boards.find(b => b.id === t.boardId);
                  return (
                    <button
                      key={`t${t.id}`}
                      onClick={() => onEditTask(t)}
                      data-testid={`cal-task-${t.id}`}
                      className={`w-full text-left rounded px-1.5 py-0.5 text-[10px] truncate transition border ${
                        mine
                          ? "border-blue-500/50 text-white font-semibold"
                          : "border-transparent text-white/55"
                      }`}
                      style={{
                        background: mine ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.04)",
                      }}
                      title={`${t.title} · ${owner ? owner.first_name + " " + owner.last_name : "unassigned"} · ${board?.name || ""}`}
                    >
                      {t.title}
                    </button>
                  );
                })}
                {visibleEvents.map(e => {
                  const color = catColor(e.categorySlug);
                  return (
                    <div
                      key={`e${e.id}`}
                      className="w-full text-left rounded px-1.5 py-0.5 text-[10px] truncate border"
                      style={{
                        borderColor: `${color}55`,
                        background: `${color}15`,
                        color,
                      }}
                      title={e.title}
                    >
                      {e.title}
                    </div>
                  );
                })}
                {hidden > 0 && (
                  <div className="text-[9px] text-white/30 px-1">+{hidden} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer summary — what's coming up for me this month */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] text-white/50">
        {(() => {
          const monthMineCount = tasks.filter(t =>
            t.dueDate &&
            myTaskIds.has(t.id) &&
            new Date(t.dueDate + "T00:00:00").getMonth() === month &&
            new Date(t.dueDate + "T00:00:00").getFullYear() === year
          ).length;
          const monthTeamCount = tasks.filter(t =>
            t.dueDate &&
            !myTaskIds.has(t.id) &&
            new Date(t.dueDate + "T00:00:00").getMonth() === month &&
            new Date(t.dueDate + "T00:00:00").getFullYear() === year
          ).length;
          return (
            <>
              <span className="text-blue-300 font-semibold">{monthMineCount}</span> task{monthMineCount === 1 ? "" : "s"} on you
              {" · "}
              <span className="text-white/70 font-semibold">{monthTeamCount}</span> across the team
              {" · "}
              <span className="text-green-300/70 font-semibold">{orgEvents.length}</span> org event{orgEvents.length === 1 ? "" : "s"} this view
            </>
          );
        })()}
      </div>
    </div>
  );
}

// ── Board create/edit modal ──────────────────────────────────────────────────
function BoardModal({
  mode, board, onClose, onSave, onDelete, saving,
}: {
  mode: "create" | "edit";
  board?: ProjectBoard;
  onClose: () => void;
  onSave: (payload: any) => void;
  onDelete?: () => void;
  saving?: boolean;
}) {
  const [name, setName] = useState(board?.name || "");
  const [description, setDescription] = useState(board?.description || "");
  const [color, setColor] = useState(board?.color || "#3b82f6");
  const [brandTags, setBrandTags] = useState<string[]>(board?.brandTags || []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const PRESET_COLORS = [
    "#3b82f6", "#06b6d4", "#22c55e", "#84cc16", "#eab308",
    "#f97316", "#ef4444", "#ec4899", "#a855f7", "#8b5cf6",
    "#64748b", "#14b8a6",
  ];

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      description: description.trim() || null,
      color,
      brandTags,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in duration-150" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: color }} />
            <h2 className="text-base font-semibold">{mode === "create" ? "New board" : "Edit board"}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center" data-testid="button-close-board-modal">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <Label className="text-xs text-white/60 mb-1 block">Board name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && name.trim()) submit(); }}
              placeholder="e.g. CIC July Tournament Ops"
              autoFocus
              className="bg-white/[0.04] border-white/10 text-white"
              data-testid="input-board-name"
            />
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1 block">Description <span className="text-white/30">(optional)</span></Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What's this board for?"
              className="bg-white/[0.04] border-white/10 text-white min-h-[60px]"
              data-testid="input-board-description"
            />
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Colour</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_COLORS.map(c => {
                const active = color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    data-testid={`board-color-${c}`}
                    className={`w-7 h-7 rounded-lg transition-all ${active ? "ring-2 ring-white/80 scale-110" : "hover:scale-105"}`}
                    style={{ background: c }}
                    title={c}
                  />
                );
              })}
            </div>
          </div>

          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Default brand tags <span className="text-white/30">(optional)</span></Label>
            <div className="flex flex-wrap gap-1.5">
              {BRANDS.map(b => {
                const active = brandTags.includes(b.slug);
                return (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => setBrandTags(prev => active ? prev.filter(x => x !== b.slug) : [...prev, b.slug])}
                    data-testid={`board-brand-${b.slug}`}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
                    style={{
                      borderColor: active ? b.color : "rgba(255,255,255,0.1)",
                      background: active ? `${b.color}25` : "transparent",
                      color: active ? "white" : "rgba(255,255,255,0.6)",
                    }}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-white/30 mt-1.5">Pre-populates new tasks created in this board.</p>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div>
            {onDelete && (
              <>
                {confirmDelete ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-white/60">Delete and all its tasks?</span>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} className="text-white/50 h-7 text-xs px-2">Cancel</Button>
                    <Button size="sm" onClick={onDelete} className="bg-red-600 hover:bg-red-700 text-white h-7 text-xs px-2" data-testid="button-confirm-delete-board">
                      <Trash2 className="w-3 h-3 mr-1" /> Delete
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} className="text-red-400 hover:text-red-300 hover:bg-red-500/10" data-testid="button-delete-board">
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
                )}
              </>
            )}
          </div>
          {!confirmDelete && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50">Cancel</Button>
              <Button size="sm" onClick={submit} disabled={!name.trim() || saving} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-board">
                <Check className="w-3.5 h-3.5 mr-1" /> {mode === "create" ? "Create board" : "Save changes"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
