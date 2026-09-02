// TASK TRACKER — the organisation-wide project & task system.
//
// One shared dataset for the whole organisation, reachable from every
// workspace's sidebar (the Chat / Feedback universal pattern). Brand is a tag
// on the record, never a container, so "everything for MFL" and "all of
// Marketing" are two filters over the same rows and nothing is duplicated.
//
// Conventions match prints-management.tsx / group-content.tsx: native selects,
// hand-rolled modals, apiRequest + react-query, dark-theme tokens. Everything
// derived comes from @shared/task-tracker; `today` always comes from the
// server in NZ time.

import { DatePickerInput } from "@/components/ui/date-picker-input";
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
  Plus, X, Trash2, ListTodo, CalendarRange, FolderKanban, Users, UserCircle2,
  Search, Check,
} from "lucide-react";
import {
  TASK_PRIORITIES, PRIORITY_META, BRAND_SHORT, BRAND_LABEL,
  canEditTask, canDeleteTask, fmtDateFull,
  type TtBootstrap, type TtProjectRow, type TtTaskRow, type TaskPriority,
} from "@/lib/task-tracker";
import {
  MyWorkView, ThisWeekView, ProjectsView, TasksView, TeamView, Avatar,
} from "./task-tracker-views";
import {
  BrandsScreen, BrandScreen, AreaScreen, PageScreen, PageModal,
  navToHash, hashToNav, type Nav, type TtPageRow,
} from "./task-tracker-explorer";

type View = "mywork" | "week" | "projects" | "tasks" | "team";

// Projects leads, and is where the tab opens: it is the way IN to everything
// else — brands → departments → pages. The flat lists come after.
const VIEWS: Array<{ key: View; label: string; icon: any }> = [
  { key: "projects", label: "Projects", icon: FolderKanban },
  { key: "mywork", label: "My Work", icon: UserCircle2 },
  { key: "week", label: "This Week", icon: CalendarRange },
  { key: "tasks", label: "Tasks", icon: ListTodo },
  { key: "team", label: "Team", icon: Users },
];

const QK = {
  pages: ["/api/admin/task-tracker/pages"],
  bootstrap: ["/api/admin/task-tracker/bootstrap"],
  projects: ["/api/admin/task-tracker/projects"],
  tasks: ["/api/admin/task-tracker/tasks"],
};

export default function TaskTracker() {
  const { toast } = useToast();

  // The hash carries either a plain view key (#mywork) or a position in the
  // Projects hierarchy (#projects/cufc/marketing, #page/12), so any screen in
  // the tree can be linked to and survives a refresh.
  const initialNav = hashToNav(window.location.hash);
  const [view, setViewState] = useState<View>(() => {
    if (initialNav) return "projects";
    const h = window.location.hash.replace("#", "") as View;
    return VIEWS.some((v) => v.key === h) ? h : "projects";
  });
  const [nav, setNavState] = useState<Nav>(initialNav ?? { level: "brands" });

  const setView = (v: View) => {
    setViewState(v);
    if (v === "projects") {
      setNavState({ level: "brands" });
      window.history.replaceState(null, "", "#projects");
    } else {
      window.history.replaceState(null, "", `#${v}`);
    }
  };
  const setNav = (n: Nav) => {
    setNavState(n);
    window.history.replaceState(null, "", `#${navToHash(n)}`);
  };

  // Filters — saved lenses over the one dataset.
  const [brand, setBrand] = useState<string>("");
  const [area, setArea] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [q, setQ] = useState("");

  const [taskModal, setTaskModal] = useState<{ task?: TtTaskRow; projectId?: number | null } | null>(null);
  const [projectModal, setProjectModal] = useState<{ project?: TtProjectRow } | null>(null);
  const [pageModal, setPageModal] = useState<
    { page?: TtPageRow; defaults?: { brand: string; areaKey: string | null; parentId?: number } } | null
  >(null);

  const { data: boot, isLoading: bootLoading } = useQuery<TtBootstrap>({ queryKey: QK.bootstrap });
  const { data: projectsData } = useQuery<{ today: string; projects: TtProjectRow[] }>({ queryKey: QK.projects });
  const { data: tasksData } = useQuery<{ today: string; tasks: TtTaskRow[] }>({
    queryKey: QK.tasks,
    refetchInterval: 60_000,
  });
  const { data: pagesData } = useQuery<{ pages: TtPageRow[] }>({ queryKey: QK.pages });

  // Open pre-filtered to the brand whose workspace you are standing in. A
  // default, not a cage — the picker still reaches everything.
  useEffect(() => {
    if (boot?.defaultBrand && brand === "") setBrand(boot.defaultBrand);
  }, [boot?.defaultBrand]);

  const today = tasksData?.today ?? boot?.today ?? "";
  const allProjects = projectsData?.projects ?? [];
  const allTasks = tasksData?.tasks ?? [];
  const pages = pagesData?.pages ?? [];
  const staff = boot?.staff ?? [];
  const areas = boot?.areas ?? [];

  // A task inherits its project's brand/area for filtering — the tag lives on
  // the project, and a task without a project simply has none to inherit.
  const projectById = useMemo(() => new Map(allProjects.map((p) => [p.id, p])), [allProjects]);

  const filteredProjects = useMemo(
    () =>
      allProjects.filter((p) => {
        if (brand && !p.brands.includes(brand)) return false;
        if (area && !p.areas.includes(area)) return false;
        if (owner && String(p.ownerId ?? "") !== owner) return false;
        if (q && !`${p.name} ${p.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      }),
    [allProjects, brand, area, owner, q],
  );

  const filteredTasks = useMemo(
    () =>
      allTasks.filter((t) => {
        const p = t.projectId != null ? projectById.get(t.projectId) : undefined;
        if (brand && !(p?.brands ?? []).includes(brand)) return false;
        if (area && !(p?.areas ?? []).includes(area)) return false;
        if (owner) {
          const o = String(t.ownerId ?? "");
          const helping = t.assignees.some((a) => String(a.id) === owner);
          if (o !== owner && !helping) return false;
        }
        if (q && !`${t.title} ${t.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      }),
    [allTasks, projectById, brand, area, owner, q],
  );

  const filtersActive = !!(brand || area || owner || q);

  if (bootLoading || !boot) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-white/90 tracking-tight">Task Tracker</h1>
          <p className="text-[12px] text-white/40 mt-0.5">
            Every project and task across the organisation, in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {boot.me.isManager && (
            <Button
              variant="outline"
              onClick={() => setProjectModal({})}
              className="h-9 text-[12px]"
              data-testid="button-new-project"
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> New project
            </Button>
          )}
          <Button onClick={() => setTaskModal({})} className="h-9 text-[12px]" data-testid="button-new-task">
            <Plus className="w-3.5 h-3.5 mr-1" /> New task
          </Button>
        </div>
      </div>

      {/* ── View tabs ──────────────────────────────────────────────────── */}
      <div className="flex gap-1 overflow-x-auto pb-1 mb-3 -mx-1 px-1">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] font-medium whitespace-nowrap transition-colors border ${
              view === v.key
                ? "bg-blue-500/15 text-blue-300 border-blue-500/25"
                : "text-white/45 border-transparent hover:text-white/70 hover:bg-white/[0.04]"
            }`}
            data-testid={`tab-${v.key}`}
          >
            <v.icon className="w-3.5 h-3.5" /> {v.label}
          </button>
        ))}
      </div>

      {/* ── Filters — flat views only ─────────────────────────────────── */}
      {view !== "projects" && (
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative w-full sm:flex-1 sm:w-auto sm:min-w-[160px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/25" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-8 pl-8 text-[12px]"
            data-testid="input-search"
          />
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} className={selectCls} data-testid="select-brand">
          <option value="">All brands</option>
          {(boot.brands ?? []).map((b) => (
            <option key={b} value={b}>{BRAND_LABEL[b] ?? b}</option>
          ))}
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value)} className={selectCls} data-testid="select-area">
          <option value="">All areas</option>
          {areas.map((a) => (
            <option key={a.key} value={a.key}>{a.label}</option>
          ))}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className={selectCls} data-testid="select-owner">
          <option value="">Anyone</option>
          {staff.map((s) => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={() => { setBrand(""); setArea(""); setOwner(""); setQ(""); }}
            className="text-[11px] text-white/40 hover:text-white/70 px-2 h-8"
            data-testid="button-clear-filters"
          >
            Clear
          </button>
        )}
      </div>
      )}

      {/* ── The view ───────────────────────────────────────────────────── */}
      {view === "mywork" && (
        <MyWorkView
          tasks={filteredTasks} projects={allProjects} today={today} meId={boot.me.id}
          onOpen={(t) => setTaskModal({ task: t })}
        />
      )}
      {view === "week" && (
        <ThisWeekView
          tasks={filteredTasks} projects={allProjects} today={today} staff={staff}
          onOpen={(t) => setTaskModal({ task: t })}
        />
      )}
      {view === "projects" && (() => {
        const openProject = (p: TtProjectRow) => setProjectModal({ project: p });
        const openTask = (t: TtTaskRow) => setTaskModal({ task: t });
        const addPage = (brandKey: string, areaKey: string | null, parentId?: number) =>
          setPageModal({ defaults: { brand: brandKey, areaKey, parentId } });

        if (nav.level === "brands") {
          return (
            <BrandsScreen
              boot={boot} projects={allProjects} tasks={allTasks} pages={pages} today={today}
              onOpen={(b) => setNav({ level: "brand", brand: b })}
            />
          );
        }
        if (nav.level === "brand") {
          return (
            <BrandScreen
              brand={nav.brand} boot={boot} projects={allProjects} tasks={allTasks} pages={pages} today={today}
              onBack={() => setNav({ level: "brands" })}
              onOpenArea={(a) => setNav({ level: "area", brand: nav.brand, area: a })}
              onOpenPage={(id) => setNav({ level: "page", pageId: id })}
              onAddPage={addPage}
            />
          );
        }
        if (nav.level === "area") {
          const area = areas.find((a) => a.key === nav.area);
          if (!area) return <p className="text-[13px] text-white/40">That department no longer exists.</p>;
          return (
            <AreaScreen
              brand={nav.brand} area={area} boot={boot}
              projects={allProjects} tasks={allTasks} pages={pages} today={today}
              onBack={() => setNav({ level: "brands" })}
              onBackBrand={() => setNav({ level: "brand", brand: nav.brand })}
              onOpenPage={(id) => setNav({ level: "page", pageId: id })}
              onAddPage={addPage}
              onOpenProject={openProject}
              onOpenTask={openTask}
            />
          );
        }
        const page = pages.find((p) => p.id === nav.pageId);
        if (!page) {
          return (
            <div className="text-center py-12">
              <p className="text-[13px] text-white/40 mb-3">That page has been deleted or archived.</p>
              <Button onClick={() => setNav({ level: "brands" })} className="h-8 text-[12px]">Back to Projects</Button>
            </div>
          );
        }
        return (
          <PageScreen
            page={page} boot={boot} pages={pages}
            projects={allProjects} tasks={allTasks} today={today}
            onBack={() => setNav({ level: "brands" })}
            onBackBrand={() => setNav({ level: "brand", brand: page.brand })}
            onBackArea={() => page.areaKey
              ? setNav({ level: "area", brand: page.brand, area: page.areaKey })
              : setNav({ level: "brand", brand: page.brand })}
            onOpenPage={(id) => setNav({ level: "page", pageId: id })}
            onAddPage={addPage}
            onOpenProject={openProject}
            onOpenTask={openTask}
            onEdit={() => setPageModal({ page })}
          />
        );
      })()}
      {view === "tasks" && (
        <TasksView
          tasks={filteredTasks} projects={filteredProjects} today={today}
          onOpen={(t) => setTaskModal({ task: t })}
          onQuickAdd={(projectId) => setTaskModal({ projectId })}
        />
      )}
      {view === "team" && (
        <TeamView
          tasks={filteredTasks} staff={staff} today={today}
          onSelectPerson={(id) => { setOwner(id == null ? "" : String(id)); setView("tasks"); }}
        />
      )}

      {taskModal && (
        <TaskModal
          boot={boot}
          projects={allProjects}
          initial={taskModal.task}
          defaultProjectId={taskModal.projectId}
          onClose={() => setTaskModal(null)}
          toast={toast}
        />
      )}
      {pageModal && (
        <PageModal
          boot={boot}
          initial={pageModal.page}
          defaults={pageModal.defaults}
          onClose={() => setPageModal(null)}
          onSaved={(p, deleted) => {
            if (deleted) setNav({ level: "brand", brand: p.brand });
            else if (!pageModal.page) setNav({ level: "page", pageId: p.id });
          }}
          toast={toast}
        />
      )}
      {projectModal && (
        <ProjectModal
          boot={boot}
          initial={projectModal.project}
          onClose={() => setProjectModal(null)}
          toast={toast}
        />
      )}
    </div>
  );
}

const selectCls =
  "h-8 flex-1 min-w-[104px] sm:flex-none rounded-md bg-white/[0.04] border border-white/10 text-[12px] text-white/70 px-2 outline-none focus:border-blue-500/40";

// ═════════════════════════════════════════════════════════════════════════════
// Task modal
// ═════════════════════════════════════════════════════════════════════════════

function TaskModal({
  boot, projects, initial, defaultProjectId, onClose, toast,
}: {
  boot: TtBootstrap;
  projects: TtProjectRow[];
  initial?: TtTaskRow;
  defaultProjectId?: number | null;
  onClose: () => void;
  toast: any;
}) {
  const editing = !!initial;
  const todoStatus = boot.taskStatuses.find((s) => s.kind === "todo") ?? boot.taskStatuses[0];

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [projectId, setProjectId] = useState<string>(
    String(initial?.projectId ?? defaultProjectId ?? ""),
  );
  const [statusId, setStatusId] = useState<string>(String(initial?.statusId ?? todoStatus?.id ?? ""));
  const [priority, setPriority] = useState<TaskPriority>(initial?.priority ?? "medium");
  const [ownerId, setOwnerId] = useState<string>(String(initial?.ownerId ?? ""));
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [helpers, setHelpers] = useState<number[]>(
    (initial?.assignees ?? []).map((a) => a.id).filter((id) => id !== initial?.ownerId),
  );

  const canEdit = !editing || canEditTask(
    { userId: boot.me.id, isManager: boot.me.isManager },
    { ownerId: initial!.ownerId, createdBy: initial!.createdBy, assigneeIds: (initial!.assignees ?? []).map((a) => a.id) },
  );
  const canDelete = editing && canDeleteTask(
    { userId: boot.me.id, isManager: boot.me.isManager },
    { createdBy: initial!.createdBy },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QK.tasks });
    queryClient.invalidateQueries({ queryKey: QK.projects });
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        title,
        description,
        projectId: projectId === "" ? null : Number(projectId),
        statusId: Number(statusId),
        priority,
        ownerId: ownerId === "" ? null : Number(ownerId),
        dueDate: dueDate || null,
        assigneeIds: helpers,
      };
      const res = editing
        ? await apiRequest("PATCH", `/api/admin/task-tracker/tasks/${initial!.id}`, body)
        : await apiRequest("POST", "/api/admin/task-tracker/tasks", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not save");
      return res.json();
    },
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: any) => toast({ title: "Not saved", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/admin/task-tracker/tasks/${initial!.id}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not delete");
    },
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: any) => toast({ title: "Not deleted", description: e.message, variant: "destructive" }),
  });

  return (
    <Modal onClose={onClose} title={editing ? "Task" : "New task"}>
      <fieldset disabled={!canEdit} className="space-y-3">
        <div>
          <Label className={labelCls}>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            className="text-[13px]"
            autoFocus={!editing}
            data-testid="input-task-title"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className={labelCls}>Project</Label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={fullSelectCls} data-testid="select-task-project">
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.emoji ? `${p.emoji} ` : ""}{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className={labelCls}>Status</Label>
            <select value={statusId} onChange={(e) => setStatusId(e.target.value)} className={fullSelectCls} data-testid="select-task-status">
              {boot.taskStatuses.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className={labelCls}>
              Accountable
              <span className="text-white/25 font-normal ml-1">(one person)</span>
            </Label>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={fullSelectCls} data-testid="select-task-owner">
              <option value="">Nobody yet</option>
              {boot.staff.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className={labelCls}>Due</Label>
            <DatePickerInput value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="text-[13px]" data-testid="input-task-due" />
          </div>
          <div>
            <Label className={labelCls}>Priority</Label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={fullSelectCls} data-testid="select-task-priority">
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_META[p].label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Helpers. The accountable person above is deliberately separate: two
            people accountable means nobody is. */}
        <div>
          <Label className={labelCls}>
            Others helping
            <span className="text-white/25 font-normal ml-1">(optional)</span>
          </Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {boot.staff
              .filter((s) => String(s.id) !== ownerId)
              .map((s) => {
                const on = helpers.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setHelpers((h) => (on ? h.filter((x) => x !== s.id) : [...h, s.id]))}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border transition-colors ${
                      on
                        ? "bg-blue-500/15 text-blue-200 border-blue-500/30"
                        : "bg-white/[0.03] text-white/45 border-white/10 hover:text-white/70"
                    }`}
                    data-testid={`chip-helper-${s.id}`}
                  >
                    {on && <Check className="w-3 h-3" />}
                    {s.name}
                  </button>
                );
              })}
          </div>
        </div>

        <div>
          <Label className={labelCls}>Notes</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Anything the person picking this up needs to know."
            className="text-[13px]"
            data-testid="input-task-description"
          />
        </div>
      </fieldset>

      {!canEdit && (
        <p className="text-[11px] text-amber-300/70 mt-2">
          View only — you can change tasks you own, help with, or created.
        </p>
      )}

      <div className="flex items-center gap-2 mt-5">
        <Button
          onClick={() => save.mutate()}
          disabled={!canEdit || !title.trim() || save.isPending}
          className="h-9 text-[12px]"
          data-testid="button-save-task"
        >
          {save.isPending ? "Saving…" : editing ? "Save" : "Add task"}
        </Button>
        <Button variant="ghost" onClick={onClose} className="h-9 text-[12px]">Cancel</Button>
        {canDelete && (
          <Button
            variant="ghost"
            onClick={() => remove.mutate()}
            className="h-9 text-[12px] text-red-300/70 hover:text-red-300 ml-auto"
            data-testid="button-delete-task"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {editing && (
        <p className="text-[10px] text-white/25 mt-3">
          Created {fmtDateFull(String(initial!.createdAt).slice(0, 10))}
          {initial!.completedAt && ` · completed ${fmtDateFull(String(initial!.completedAt).slice(0, 10))}`}
        </p>
      )}
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Project modal — managers only
// ═════════════════════════════════════════════════════════════════════════════

function ProjectModal({
  boot, initial, onClose, toast,
}: {
  boot: TtBootstrap; initial?: TtProjectRow; onClose: () => void; toast: any;
}) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [kind, setKind] = useState<"project" | "goal">(initial?.kind ?? "project");
  const [statusId, setStatusId] = useState<string>(String(initial?.statusId ?? boot.projectStatuses[0]?.id ?? ""));
  const [ownerId, setOwnerId] = useState<string>(String(initial?.ownerId ?? ""));
  const [areas, setAreas] = useState<string[]>(initial?.areas ?? []);
  const [brands, setBrands] = useState<string[]>(initial?.brands ?? []);
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [targetDate, setTargetDate] = useState(initial?.targetDate ?? "");
  const [targetNote, setTargetNote] = useState(initial?.targetNote ?? "");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QK.projects });
    queryClient.invalidateQueries({ queryKey: QK.tasks });
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name, emoji, description, kind, statusId: Number(statusId),
        ownerId: ownerId === "" ? null : Number(ownerId),
        areas, brands,
        startDate: startDate || null,
        targetDate: targetDate || null,
        targetNote: targetNote || null,
      };
      const res = editing
        ? await apiRequest("PATCH", `/api/admin/task-tracker/projects/${initial!.id}`, body)
        : await apiRequest("POST", "/api/admin/task-tracker/projects", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not save");
      return res.json();
    },
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: any) => toast({ title: "Not saved", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/admin/task-tracker/projects/${initial!.id}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not delete");
      return res.json();
    },
    onSuccess: (r: any) => {
      invalidate();
      if (r?.archived) {
        toast({
          title: "Archived instead of deleted",
          description: `This still holds ${r.taskCount} task${r.taskCount === 1 ? "" : "s"}, so the record was kept.`,
        });
      }
      onClose();
    },
    onError: (e: any) => toast({ title: "Not deleted", description: e.message, variant: "destructive" }),
  });

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);

  return (
    <Modal onClose={onClose} title={editing ? "Project" : "New project"}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="w-16 shrink-0">
            <Label className={labelCls}>Icon</Label>
            <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🎯" className="text-center text-[15px]" maxLength={4} data-testid="input-project-emoji" />
          </div>
          <div className="flex-1 min-w-0">
            <Label className={labelCls}>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="What is this?" className="text-[13px]" autoFocus={!editing} data-testid="input-project-name" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className={labelCls}>Type</Label>
            <select value={kind} onChange={(e) => setKind(e.target.value as any)} className={fullSelectCls} data-testid="select-project-kind">
              <option value="project">Project</option>
              <option value="goal">Goal / KPI</option>
            </select>
          </div>
          <div>
            <Label className={labelCls}>Status</Label>
            <select value={statusId} onChange={(e) => setStatusId(e.target.value)} className={fullSelectCls} data-testid="select-project-status">
              {boot.projectStatuses.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className={labelCls}>Owner</Label>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={fullSelectCls} data-testid="select-project-owner">
              <option value="">Nobody yet</option>
              {boot.staff.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        {kind === "goal" && (
          <div>
            <Label className={labelCls}>The target, in plain words</Label>
            <Input value={targetNote} onChange={(e) => setTargetNote(e.target.value)} placeholder="e.g. $100,000 of new sponsorship revenue" className="text-[13px]" data-testid="input-project-target" />
          </div>
        )}

        <div>
          <Label className={labelCls}>Area <span className="text-white/25 font-normal">— what part of the business</span></Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {boot.areas.map((a) => {
              const on = areas.includes(a.key);
              return (
                <button
                  key={a.key} type="button" onClick={() => toggle(areas, setAreas, a.key)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border transition-colors"
                  style={on
                    ? { color: a.color, borderColor: `${a.color}55`, background: `${a.color}1f` }
                    : { color: "rgba(255,255,255,0.45)", borderColor: "rgba(255,255,255,0.1)" }}
                  data-testid={`chip-area-${a.key}`}
                >
                  {on && <Check className="w-3 h-3" />}{a.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label className={labelCls}>Brand <span className="text-white/25 font-normal">— who it serves</span></Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {boot.brands.map((b) => {
              const on = brands.includes(b);
              return (
                <button
                  key={b} type="button" onClick={() => toggle(brands, setBrands, b)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border transition-colors ${
                    on ? "bg-blue-500/15 text-blue-200 border-blue-500/30" : "bg-white/[0.03] text-white/45 border-white/10 hover:text-white/70"
                  }`}
                  data-testid={`chip-brand-${b}`}
                >
                  {on && <Check className="w-3 h-3" />}{BRAND_SHORT[b] ?? b}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className={labelCls}>Start</Label>
            <DatePickerInput value={startDate} onChange={(e) => setStartDate(e.target.value)} className="text-[13px]" data-testid="input-project-start" />
          </div>
          <div>
            <Label className={labelCls}>Target</Label>
            <DatePickerInput value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="text-[13px]" data-testid="input-project-target-date" />
          </div>
        </div>

        <div>
          <Label className={labelCls}>Notes</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="text-[13px]" data-testid="input-project-description" />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-5">
        <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="h-9 text-[12px]" data-testid="button-save-project">
          {save.isPending ? "Saving…" : editing ? "Save" : "Add project"}
        </Button>
        <Button variant="ghost" onClick={onClose} className="h-9 text-[12px]">Cancel</Button>
        {editing && (
          <Button
            variant="ghost"
            onClick={() => remove.mutate()}
            className="h-9 text-[12px] text-red-300/70 hover:text-red-300 ml-auto"
            data-testid="button-delete-project"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════

const labelCls = "text-[11px] text-white/45 mb-1 block";
const fullSelectCls =
  "w-full h-9 rounded-md bg-white/[0.04] border border-white/10 text-[13px] text-white/80 px-2 outline-none focus:border-blue-500/40 disabled:opacity-50";

/**
 * Hand-rolled modal, matching the house pattern. `m-auto` inside a flex
 * container rather than a translate-centred absolute box — the translate
 * version is what clipped the Management modal off the top of a 1366×768
 * laptop screen.
 */
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div
        className="m-auto w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/[0.07]">
          <h2 className="text-[14px] font-semibold text-white/85">{title}</h2>
          <button onClick={onClose} className="text-white/35 hover:text-white/70 p-1" data-testid="button-close-modal">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 sm:px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
