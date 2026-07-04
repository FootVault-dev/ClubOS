// Command-Centre views for the USG Work Management system. These are saved
// filters/lenses over ONE dataset (tasks + goals) — nothing here duplicates
// data, it just presents it four ways:
//   • MyWorkView       — a person's own tasks, bucketed by when they're due.
//   • GoalsView        — the Vision → Season Goal → Priority ladder (+ measures).
//   • StaffMeetingView — the projectable, run-the-weekly-meeting screen.
//   • LeadershipView   — the RAG rollup across every brand × department.
import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import {
  Plus, X, Check, Trash2, Target, Flag, Calendar as CalendarIcon, AlertCircle,
  ChevronRight, Trophy, Gauge, Users, ArrowUpRight, Circle, Presentation,
} from "lucide-react";
import {
  BRANDS, PRIORITY_COLORS, RAG_META, RAG_ORDER, GOAL_LEVELS,
  type Rag, type GoalLevel, type ProjectTask, type ProjectBoard, type TeamMember,
  type Department, type Goal, type GoalMeasure,
  memberName, deptOf, fmtDate, dayDiff, isDoneTask,
} from "@/lib/work";

// ── Tiny shared bits ─────────────────────────────────────────────────────────
function RagDot({ status, size = 8 }: { status: Rag; size?: number }) {
  return <span className="inline-block rounded-full flex-shrink-0" style={{ width: size, height: size, background: RAG_META[status].color }} />;
}
function RagBadge({ status }: { status: Rag }) {
  const m = RAG_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ background: `${m.color}1f`, color: m.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} /> {m.label}
    </span>
  );
}
function DeptPill({ dept }: { dept: Department | null }) {
  if (!dept) return null;
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${dept.color}22`, color: dept.color }}>
      {dept.name}
    </span>
  );
}
function BrandChips({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags?.length) return null;
  return (
    <span className="flex gap-1 flex-wrap">
      {tags.slice(0, max).map(slug => {
        const b = BRANDS.find(x => x.slug === slug);
        return <span key={slug} className="text-[9px] font-semibold px-1 py-0.5 rounded" style={{ background: `${b?.color || "#64748b"}20`, color: b?.color || "#64748b" }}>{b?.label || slug}</span>;
      })}
    </span>
  );
}

// ── 1. My Work ───────────────────────────────────────────────────────────────
// A person's own tasks, auto-assembled across every board/brand into
// Overdue / Today / This week / Upcoming buckets — the single most-used screen.
export function MyWorkView({ tasks, boards, team, departments, onEdit }: {
  tasks: ProjectTask[]; boards: ProjectBoard[]; team: TeamMember[]; departments: Department[];
  onEdit: (t: ProjectTask) => void;
}) {
  const buckets = useMemo(() => {
    const overdue: ProjectTask[] = [], todayL: ProjectTask[] = [], week: ProjectTask[] = [], later: ProjectTask[] = [], noDate: ProjectTask[] = [];
    for (const t of tasks) {
      if (isDoneTask(t, boards)) continue;
      if (!t.dueDate) { noDate.push(t); continue; }
      const d = dayDiff(t.dueDate);
      if (d < 0) overdue.push(t);
      else if (d === 0) todayL.push(t);
      else if (d <= 7) week.push(t);
      else later.push(t);
    }
    return { overdue, todayL, week, later, noDate };
  }, [tasks, boards]);

  const sections = [
    { key: "overdue", label: "Overdue", items: buckets.overdue, color: "#ef4444" },
    { key: "today", label: "Today", items: buckets.todayL, color: "#3b82f6" },
    { key: "week", label: "This week", items: buckets.week, color: "#e2e8f0" },
    { key: "later", label: "Upcoming", items: buckets.later, color: "#94a3b8" },
    { key: "noDate", label: "No due date", items: buckets.noDate, color: "#64748b" },
  ];
  const openCount = tasks.filter(t => !isDoneTask(t, boards)).length;

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto" data-testid="view-my-work">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
          <Users className="w-5 h-5 text-blue-300" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">My Work</h2>
          <p className="text-xs text-white/40">{openCount} open · {buckets.overdue.length} overdue · {buckets.todayL.length} due today</p>
        </div>
      </div>
      {openCount === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-12 text-center text-white/40 text-sm">
          Nothing on your plate. Assign yourself a task on any board and it shows up here.
        </div>
      )}
      {sections.filter(s => s.items.length > 0).map(s => (
        <div key={s.key}>
          <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: s.color }}>
            {s.label}<span className="text-white/30 normal-case font-normal">· {s.items.length}</span>
          </div>
          <div className="space-y-1.5">
            {s.items.map(t => (
              <TaskRow key={t.id} t={t} boards={boards} departments={departments} team={team} overdue={s.key === "overdue"} onEdit={onEdit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskRow({ t, boards, departments, team, overdue, onEdit, showOwner }: {
  t: ProjectTask; boards: ProjectBoard[]; departments: Department[]; team: TeamMember[];
  overdue?: boolean; onEdit: (t: ProjectTask) => void; showOwner?: boolean;
}) {
  const board = boards.find(b => b.id === t.boardId);
  const group = board?.groups.find(g => g.id === t.groupId);
  const dept = deptOf(departments, t.departmentId);
  const owner = memberName(team, t.ownerId);
  return (
    <button onClick={() => onEdit(t)} data-testid={`work-task-${t.id}`}
      className="w-full text-left rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 p-3 flex items-center gap-3 transition-colors">
      {t.ragStatus !== "none" ? <RagDot status={t.ragStatus} /> :
        t.priority !== "medium" ? <Flag className="w-3.5 h-3.5 flex-shrink-0" style={{ color: PRIORITY_COLORS[t.priority] }} /> :
        <Circle className="w-2 h-2 flex-shrink-0 text-white/20" />}
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium truncate ${group?.isDone ? "line-through text-white/40" : "text-white"}`}>{t.title}</div>
        <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-1.5 flex-wrap">
          {dept && <DeptPill dept={dept} />}
          <BrandChips tags={t.brandTags} />
          {showOwner && owner && <span className="text-white/40">{owner}</span>}
          {t.nextStep && <span className="text-white/40 italic truncate max-w-[220px]">→ {t.nextStep}</span>}
          {t.isIssue && <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-red-500/15 text-red-300">BLOCKER</span>}
        </div>
      </div>
      {t.dueDate && (
        <span className={`text-xs flex items-center gap-1 flex-shrink-0 ${overdue ? "text-red-400" : "text-white/50"}`}>
          <CalendarIcon className="w-3 h-3" />{fmtDate(t.dueDate)}
        </span>
      )}
    </button>
  );
}

// ── 2. Goals ladder ──────────────────────────────────────────────────────────
export function GoalsView({ orgId, goals, departments, team, allTasks }: {
  orgId: number; goals: Goal[]; departments: Department[]; team: TeamMember[]; allTasks: ProjectTask[];
}) {
  const [modal, setModal] = useState<{ level: GoalLevel; parentId: number | null; goal?: Goal } | null>(null);
  const byParent = useMemo(() => {
    const m = new Map<number | null, Goal[]>();
    for (const g of goals) { const a = m.get(g.parentId) || []; a.push(g); m.set(g.parentId, a); }
    return m;
  }, [goals]);
  const vision = goals.filter(g => g.level === "vision");
  const seasons = goals.filter(g => g.level === "season");
  const linkedCount = (goalId: number) => allTasks.filter(t => t.goalId === goalId).length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="view-goals">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
            <Target className="w-5 h-5 text-purple-300" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Goals</h2>
            <p className="text-xs text-white/40">Vision → Season Goals → Priorities. Every task ladders up.</p>
          </div>
        </div>
      </div>

      {/* Vision */}
      <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-white/40 font-semibold flex items-center gap-1.5"><Trophy className="w-3 h-3" /> {GOAL_LEVELS.vision.blurb}</span>
          {vision.length === 0 && <AddBtn label="Set vision" onClick={() => setModal({ level: "vision", parentId: null })} />}
        </div>
        {vision.length === 0
          ? <p className="text-sm text-white/30">Your 3-year north star. What does winning look like?</p>
          : vision.map(v => (
              <button key={v.id} onClick={() => setModal({ level: "vision", parentId: null, goal: v })} className="block text-left w-full group">
                <p className="text-xl font-semibold text-white leading-snug group-hover:text-white/90">{v.title}</p>
                {v.description && <p className="text-sm text-white/50 mt-1">{v.description}</p>}
              </button>
            ))}
      </div>

      {/* Season goals → priorities */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">{GOAL_LEVELS.season.plural}</span>
        <AddBtn label="Add season goal" onClick={() => setModal({ level: "season", parentId: vision[0]?.id ?? null })} />
      </div>
      {seasons.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-white/30">
          No season goals yet. Add 3–5 big goals for the year (e.g. “Cut the deficit to $350k”).
        </div>
      )}
      <div className="space-y-4">
        {seasons.map(sg => {
          const priorities = (byParent.get(sg.id) || []).filter(g => g.level === "priority");
          const dept = deptOf(departments, sg.departmentId);
          return (
            <div key={sg.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
              <button onClick={() => setModal({ level: "season", parentId: sg.parentId, goal: sg })} className="w-full text-left px-5 py-4 flex items-start gap-3 hover:bg-white/[0.02]">
                <RagDot status={sg.ragStatus} size={10} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-semibold text-white">{sg.title}</span>
                    {sg.period && <span className="text-[10px] text-white/40 px-1.5 py-0.5 rounded bg-white/[0.05]">{sg.period}</span>}
                  </div>
                  {sg.description && <p className="text-xs text-white/45 mt-0.5">{sg.description}</p>}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {dept && <DeptPill dept={dept} />}
                    <BrandChips tags={sg.brandTags} />
                    {memberName(team, sg.ownerId) && <span className="text-[10px] text-white/40">{memberName(team, sg.ownerId)}</span>}
                  </div>
                </div>
                <RagBadge status={sg.ragStatus} />
              </button>
              {/* Priorities under this season goal */}
              <div className="border-t border-white/[0.06] px-5 py-3 space-y-2">
                {priorities.map(p => (
                  <GoalPriorityRow key={p.id} goal={p} departments={departments} team={team} linked={linkedCount(p.id)} onClick={() => setModal({ level: "priority", parentId: sg.id, goal: p })} />
                ))}
                <button onClick={() => setModal({ level: "priority", parentId: sg.id })} data-testid={`button-add-priority-${sg.id}`}
                  className="text-[11px] text-white/40 hover:text-white flex items-center gap-1 pt-1">
                  <Plus className="w-3 h-3" /> Add priority (Rock)
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <GoalModal orgId={orgId} level={modal.level} parentId={modal.parentId} goal={modal.goal}
          goals={goals} departments={departments} team={team} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function GoalPriorityRow({ goal, departments, team, linked, onClick }: {
  goal: Goal; departments: Department[]; team: TeamMember[]; linked: number; onClick: () => void;
}) {
  const dept = deptOf(departments, goal.departmentId);
  return (
    <div className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2.5">
      <button onClick={onClick} className="w-full text-left flex items-center gap-2.5">
        <RagDot status={goal.ragStatus} />
        <span className="flex-1 min-w-0 text-sm text-white truncate">{goal.title}</span>
        {dept && <DeptPill dept={dept} />}
        {goal.ownerId != null && <span className="text-[10px] text-white/40">{memberName(team, goal.ownerId)}</span>}
        {linked > 0 && <span className="text-[10px] text-white/40 flex items-center gap-0.5"><Check className="w-3 h-3" />{linked}</span>}
      </button>
      {goal.measures?.length > 0 && (
        <div className="mt-2 pl-6 space-y-1">
          {goal.measures.map(m => <MeasureBar key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

function MeasureBar({ m }: { m: GoalMeasure }) {
  const cur = parseFloat(m.currentValue || "0");
  const tgt = parseFloat(m.targetValue || "0");
  const pct = tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : 0;
  const isLead = m.measureType === "lead";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded" style={{ background: isLead ? "#3b82f622" : "#a855f722", color: isLead ? "#93c5fd" : "#d8b4fe" }}>{isLead ? "LEAD" : "LAG"}</span>
      <span className="text-[11px] text-white/60 flex-1 min-w-0 truncate">{m.name}</span>
      <div className="w-24 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: isLead ? "#3b82f6" : "#a855f7" }} />
      </div>
      <span className="text-[10px] text-white/40 tabular-nums w-16 text-right">{m.unit === "$" ? "$" : ""}{cur}{m.unit && m.unit !== "$" ? m.unit : ""}/{m.unit === "$" ? "$" : ""}{tgt}{m.unit && m.unit !== "$" ? m.unit : ""}</span>
    </div>
  );
}

function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-[11px] font-medium text-blue-300 hover:text-blue-200 flex items-center gap-1 px-2 py-1 rounded-md hover:bg-blue-500/10 transition" data-testid={`button-add-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      <Plus className="w-3 h-3" /> {label}
    </button>
  );
}

// ── Goal create/edit modal ───────────────────────────────────────────────────
function GoalModal({ orgId, level, parentId, goal, goals, departments, team, onClose }: {
  orgId: number; level: GoalLevel; parentId: number | null; goal?: Goal;
  goals: Goal[]; departments: Department[]; team: TeamMember[]; onClose: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!goal;
  const [title, setTitle] = useState(goal?.title || "");
  const [description, setDescription] = useState(goal?.description || "");
  const [ownerId, setOwnerId] = useState<number | null>(goal?.ownerId ?? null);
  const [departmentId, setDepartmentId] = useState<number | null>(goal?.departmentId ?? null);
  const [brandTags, setBrandTags] = useState<string[]>(goal?.brandTags || []);
  const [ragStatus, setRagStatus] = useState<Rag>(goal?.ragStatus || "on_track");
  const [period, setPeriod] = useState(goal?.period || "");
  const [targetDate, setTargetDate] = useState(goal?.targetDate || "");
  const [parent, setParent] = useState<number | null>(parentId);

  const parentOptions = level === "priority" ? goals.filter(g => g.level === "season")
    : level === "season" ? goals.filter(g => g.level === "vision") : [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/goals"] });
  const save = useMutation({
    mutationFn: async () => {
      const body: any = { organizationId: orgId, level, parentId: parent, title: title.trim(), description: description.trim() || null, ownerId, departmentId, brandTags, ragStatus, period: period.trim() || null, targetDate: targetDate || null };
      if (isEdit) { const r = await apiRequest("PATCH", `/api/admin/goals/${goal!.id}`, body); return r.json(); }
      const r = await apiRequest("POST", "/api/admin/goals", body); return r.json();
    },
    onSuccess: () => { invalidate(); toast({ title: isEdit ? "Goal updated" : `${GOAL_LEVELS[level].label} added` }); onClose(); },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/goals/${goal!.id}`),
    onSuccess: () => { invalidate(); toast({ title: "Goal removed" }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-[#0a0e1a] border border-white/10 rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-base font-semibold">{isEdit ? "Edit" : "New"} {GOAL_LEVELS[level].label}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div>
            <Label className="text-xs text-white/60 mb-1 block">{level === "vision" ? "Vision statement" : "Title"}</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} autoFocus placeholder={level === "priority" ? "e.g. Sign 3 new cash sponsors" : level === "season" ? "e.g. Cut the deficit to $350k" : "Where we're heading…"} className="bg-white/[0.04] border-white/10 text-white" data-testid="input-goal-title" />
          </div>
          <div>
            <Label className="text-xs text-white/60 mb-1 block">Detail <span className="text-white/25">(optional)</span></Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} className="bg-white/[0.04] border-white/10 text-white min-h-[60px]" />
          </div>
          {level !== "vision" && (
            <>
              {parentOptions.length > 0 && (
                <div>
                  <Label className="text-xs text-white/60 mb-1 block">Ladders up to</Label>
                  <select value={parent ?? ""} onChange={e => setParent(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                    <option value="">— none —</option>
                    {parentOptions.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-white/60 mb-1 block">Owner</Label>
                  <select value={ownerId ?? ""} onChange={e => setOwnerId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                    <option value="">Unassigned</option>
                    {team.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-white/60 mb-1 block">Department</Label>
                  <select value={departmentId ?? ""} onChange={e => setDepartmentId(e.target.value ? parseInt(e.target.value) : null)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                    <option value="">—</option>
                    {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-white/60 mb-1 block">Status</Label>
                  <select value={ragStatus} onChange={e => setRagStatus(e.target.value as Rag)} className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm">
                    {RAG_ORDER.map(r => <option key={r} value={r}>{RAG_META[r].label}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-white/60 mb-1 block">{level === "priority" ? "Quarter" : "Period"}</Label>
                  <Input value={period} onChange={e => setPeriod(e.target.value)} placeholder={level === "priority" ? "2026-Q3" : "2026"} className="bg-white/[0.04] border-white/10 text-white h-9" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-white/60 mb-1.5 block">Brands / programmes</Label>
                <div className="flex flex-wrap gap-1.5">
                  {BRANDS.map(b => {
                    const active = brandTags.includes(b.slug);
                    return <button key={b.slug} type="button" onClick={() => setBrandTags(prev => active ? prev.filter(x => x !== b.slug) : [...prev, b.slug])} className="text-[11px] font-semibold px-2 py-1 rounded-md border transition" style={{ borderColor: active ? b.color : "rgba(255,255,255,0.1)", background: active ? `${b.color}25` : "transparent", color: active ? "white" : "rgba(255,255,255,0.6)" }}>{b.label}</button>;
                  })}
                </div>
              </div>
            </>
          )}
          {isEdit && level === "priority" && <MeasuresEditor goal={goal!} onChanged={invalidate} />}
        </div>
        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div>{isEdit && <Button variant="ghost" size="sm" onClick={() => remove.mutate()} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">Delete</Button>}</div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50">Cancel</Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={!title.trim() || save.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-goal">
              <Check className="w-3.5 h-3.5 mr-1" /> {isEdit ? "Save" : "Add"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MeasuresEditor({ goal, onChanged }: { goal: Goal; onChanged: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(""); const [type, setType] = useState<"lead" | "lag">("lead");
  const [target, setTarget] = useState(""); const [unit, setUnit] = useState("");
  const add = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", `/api/admin/goals/${goal.id}/measures`, { name: name.trim(), measureType: type, targetValue: target || null, currentValue: 0, unit: unit || null }); return r.json(); },
    onSuccess: () => { setName(""); setTarget(""); setUnit(""); onChanged(); },
    onError: (e: any) => toast({ title: "Couldn't add measure", description: e.message, variant: "destructive" }),
  });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => { const r = await apiRequest("PATCH", `/api/admin/goal-measures/${id}`, body); return r.json(); },
    onSuccess: onChanged,
  });
  const del = useMutation({ mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/goal-measures/${id}`), onSuccess: onChanged });

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold flex items-center gap-1.5"><Gauge className="w-3 h-3" /> Measures (lead / lag)</div>
      {goal.measures?.map(m => (
        <div key={m.id} className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded" style={{ background: m.measureType === "lead" ? "#3b82f622" : "#a855f722", color: m.measureType === "lead" ? "#93c5fd" : "#d8b4fe" }}>{m.measureType}</span>
          <span className="flex-1 min-w-0 text-xs text-white/70 truncate">{m.name}</span>
          <Input defaultValue={m.currentValue || "0"} onBlur={e => patch.mutate({ id: m.id, body: { currentValue: e.target.value } })} className="w-16 h-7 bg-white/[0.04] border-white/10 text-white text-xs" title="Current" />
          <span className="text-[10px] text-white/30">/ {m.unit === "$" ? "$" : ""}{m.targetValue}{m.unit && m.unit !== "$" ? m.unit : ""}</span>
          <button onClick={() => del.mutate(m.id)} className="text-white/30 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1">
        <select value={type} onChange={e => setType(e.target.value as any)} className="h-7 rounded bg-white/[0.04] border border-white/10 px-1 text-[11px]"><option value="lead">Lead</option><option value="lag">Lag</option></select>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sponsor calls made" className="flex-1 h-7 bg-white/[0.04] border-white/10 text-white text-xs" />
        <Input value={target} onChange={e => setTarget(e.target.value)} placeholder="target" className="w-16 h-7 bg-white/[0.04] border-white/10 text-white text-xs" />
        <Input value={unit} onChange={e => setUnit(e.target.value)} placeholder="unit" className="w-14 h-7 bg-white/[0.04] border-white/10 text-white text-xs" />
        <button onClick={() => name.trim() && add.mutate()} className="w-7 h-7 rounded bg-blue-600 hover:bg-blue-700 flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

// ── 3. Staff Meeting view (projectable) ──────────────────────────────────────
export function StaffMeetingView({ allTasks, boards, goals, departments, team, onEdit }: {
  allTasks: ProjectTask[]; boards: ProjectBoard[]; goals: Goal[]; departments: Department[]; team: TeamMember[];
  onEdit: (t: ProjectTask) => void;
}) {
  const now = new Date();
  const data = useMemo(() => {
    const open = allTasks.filter(t => !isDoneTask(t, boards));
    const doneLastWeek = allTasks.filter(t => {
      if (!t.completedAt) return false;
      const diff = (now.getTime() - new Date(t.completedAt).getTime()) / 86400000;
      return diff >= 0 && diff <= 7;
    });
    const dueThisWeek = open.filter(t => t.dueDate && dayDiff(t.dueDate) >= 0 && dayDiff(t.dueDate) <= 7);
    const overdue = open.filter(t => t.dueDate && dayDiff(t.dueDate) < 0);
    const next14 = open.filter(t => t.dueDate && dayDiff(t.dueDate) > 7 && dayDiff(t.dueDate) <= 14);
    const thisMonth = open.filter(t => t.dueDate && dayDiff(t.dueDate) > 14 && dayDiff(t.dueDate) <= 31);
    const issues = open.filter(t => t.isIssue || t.ragStatus === "off_track");
    const priorities = goals.filter(g => g.level === "priority");
    const measures = priorities.flatMap(p => p.measures.map(m => ({ ...m, goal: p })));
    return { open, doneLastWeek, dueThisWeek, overdue, next14, thisMonth, issues, priorities, measures };
  }, [allTasks, boards, goals]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5" data-testid="view-staff-meeting">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center"><Presentation className="w-5 h-5 text-emerald-300" /></div>
        <div>
          <h2 className="text-lg font-semibold">Staff Meeting</h2>
          <p className="text-xs text-white/40">Run top-to-bottom · {now.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
      </div>

      <MeetingBlock n={1} title="Wins — done last week" count={data.doneLastWeek.length} accent="#22c55e">
        {data.doneLastWeek.length === 0 ? <Empty text="Log completed tasks to celebrate them here." /> :
          <div className="space-y-1">{data.doneLastWeek.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} done />)}</div>}
      </MeetingBlock>

      <MeetingBlock n={2} title="Scorecard — lead & lag measures" count={data.measures.length} accent="#3b82f6">
        {data.measures.length === 0 ? <Empty text="Add measures to your Priorities to build the weekly scorecard." /> :
          <div className="space-y-1.5">{data.measures.map(m => (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <RagDot status={m.goal.ragStatus} />
              <span className="flex-1 min-w-0 truncate text-white/80">{m.name}</span>
              <MeasureBar m={m} />
            </div>
          ))}</div>}
      </MeetingBlock>

      <MeetingBlock n={3} title="Quarterly Priorities" count={data.priorities.length} accent="#a855f7">
        {data.priorities.length === 0 ? <Empty text="Set your 90-day Priorities in the Goals tab." /> :
          <div className="space-y-1.5">{data.priorities.map(p => (
            <div key={p.id} className="flex items-center gap-2.5 text-sm rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2">
              <RagDot status={p.ragStatus} size={10} />
              <span className="flex-1 min-w-0 truncate text-white">{p.title}</span>
              <DeptPill dept={deptOf(departments, p.departmentId)} />
              {p.ownerId != null && <span className="text-[11px] text-white/45">{memberName(team, p.ownerId)}</span>}
              <RagBadge status={p.ragStatus} />
            </div>
          ))}</div>}
      </MeetingBlock>

      <div className="grid md:grid-cols-2 gap-5">
        <MeetingBlock n={4} title="Due this week" count={data.dueThisWeek.length + data.overdue.length} accent="#e2e8f0">
          {data.overdue.length + data.dueThisWeek.length === 0 ? <Empty text="Nothing due this week." /> :
            <div className="space-y-1">
              {data.overdue.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} overdue />)}
              {data.dueThisWeek.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} />)}
            </div>}
        </MeetingBlock>

        <MeetingBlock n={5} title="Lookahead — next 2 weeks & month" count={data.next14.length + data.thisMonth.length} accent="#94a3b8">
          {data.next14.length + data.thisMonth.length === 0 ? <Empty text="Clear horizon." /> :
            <div className="space-y-1">
              {data.next14.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} />)}
              {data.thisMonth.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} muted />)}
            </div>}
        </MeetingBlock>
      </div>

      <MeetingBlock n={6} title="Issues & blockers (IDS)" count={data.issues.length} accent="#ef4444">
        {data.issues.length === 0 ? <Empty text="No blockers raised. Tick “raise as issue” on a task to surface it here." /> :
          <div className="space-y-1">{data.issues.map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} issue />)}</div>}
      </MeetingBlock>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3 text-center text-xs text-white/40">
        <span className="font-semibold text-white/60">Conclude</span> — recap the new to-dos, cascade messages to the team, rate the meeting 1–10.
      </div>
    </div>
  );
}

function MeetingBlock({ n, title, count, accent, children }: { n: number; title: string; count: number; accent: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02]">
      <div className="px-5 py-3 border-b border-white/[0.05] flex items-center gap-3">
        <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold" style={{ background: `${accent}1f`, color: accent }}>{n}</span>
        <h3 className="text-sm font-semibold flex-1">{title}</h3>
        <span className="text-[11px] text-white/35 tabular-nums">{count}</span>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}
function Empty({ text }: { text: string }) { return <p className="text-xs text-white/30 px-2 py-1.5">{text}</p>; }
function MiniTask({ t, departments, team, onEdit, done, overdue, muted, issue }: {
  t: ProjectTask; departments: Department[]; team: TeamMember[]; onEdit: (t: ProjectTask) => void;
  done?: boolean; overdue?: boolean; muted?: boolean; issue?: boolean;
}) {
  return (
    <button onClick={() => onEdit(t)} className={`w-full text-left rounded-lg px-3 py-2 flex items-center gap-2.5 hover:bg-white/[0.03] transition ${muted ? "opacity-60" : ""}`}>
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" /> : issue ? <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" /> : <RagDot status={t.ragStatus} />}
      <span className={`flex-1 min-w-0 text-sm truncate ${done ? "text-white/50 line-through" : "text-white/85"}`}>{t.title}</span>
      <DeptPill dept={deptOf(departments, t.departmentId)} />
      {t.ownerId != null && <span className="text-[10px] text-white/40">{memberName(team, t.ownerId)}</span>}
      {t.dueDate && <span className={`text-[11px] flex-shrink-0 ${overdue ? "text-red-400" : "text-white/40"}`}>{fmtDate(t.dueDate)}</span>}
    </button>
  );
}

// ── 4. Leadership rollup (brand × department, RAG) ───────────────────────────
export function LeadershipView({ allTasks, boards, goals, departments, team, onEdit }: {
  allTasks: ProjectTask[]; boards: ProjectBoard[]; goals: Goal[]; departments: Department[]; team: TeamMember[];
  onEdit: (t: ProjectTask) => void;
}) {
  const stats = useMemo(() => {
    const open = allTasks.filter(t => !isDoneTask(t, boards));
    const overdue = open.filter(t => t.dueDate && dayDiff(t.dueDate) < 0);
    const dueWeek = open.filter(t => t.dueDate && dayDiff(t.dueDate) >= 0 && dayDiff(t.dueDate) <= 7);
    const doneWeek = allTasks.filter(t => t.completedAt && (Date.now() - new Date(t.completedAt).getTime()) / 86400000 <= 7);
    const atRisk = open.filter(t => t.ragStatus === "at_risk" || t.ragStatus === "off_track");
    const priorities = goals.filter(g => g.level === "priority");
    const seasons = goals.filter(g => g.level === "season");
    // department × open count + overdue
    const perDept = departments.map(d => {
      const dt = open.filter(t => t.departmentId === d.id);
      return { d, open: dt.length, overdue: dt.filter(t => t.dueDate && dayDiff(t.dueDate) < 0).length, atRisk: dt.filter(t => t.ragStatus === "at_risk" || t.ragStatus === "off_track").length };
    });
    const perBrand = BRANDS.map(b => {
      const bt = open.filter(t => t.brandTags?.includes(b.slug));
      return { b, open: bt.length, overdue: bt.filter(t => t.dueDate && dayDiff(t.dueDate) < 0).length };
    }).filter(x => x.open > 0);
    return { open, overdue, dueWeek, doneWeek, atRisk, priorities, seasons, perDept, perBrand };
  }, [allTasks, boards, goals, departments]);

  const ragCount = (level: "season" | "priority", r: Rag) => (level === "season" ? stats.seasons : stats.priorities).filter(g => g.ragStatus === r).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" data-testid="view-leadership">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center"><Gauge className="w-5 h-5 text-amber-300" /></div>
        <div>
          <h2 className="text-lg font-semibold">Leadership Overview</h2>
          <p className="text-xs text-white/40">Read the colour. Dive into amber & red.</p>
        </div>
      </div>

      {/* Top tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Open tasks" value={stats.open.length} />
        <Tile label="Overdue" value={stats.overdue.length} tone={stats.overdue.length ? "red" : undefined} />
        <Tile label="Due this week" value={stats.dueWeek.length} tone="blue" />
        <Tile label="Done last week" value={stats.doneWeek.length} tone="green" />
      </div>

      {/* Goals RAG */}
      <div className="grid md:grid-cols-2 gap-4">
        <RagRollup title="Season Goals" counts={RAG_ORDER.map(r => ({ r, n: ragCount("season", r) }))} total={stats.seasons.length} />
        <RagRollup title="Priorities (Rocks)" counts={RAG_ORDER.map(r => ({ r, n: ragCount("priority", r) }))} total={stats.priorities.length} />
      </div>

      {/* Department rollup */}
      <div>
        <h3 className="text-[10px] uppercase tracking-widest text-white/40 font-semibold mb-2">By department</h3>
        <div className="rounded-2xl border border-white/[0.07] overflow-hidden">
          {stats.perDept.map((row, i) => (
            <div key={row.d.id} className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-white/[0.05]" : ""}`}>
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: row.d.color }} />
              <span className="flex-1 min-w-0 text-sm text-white/85 truncate">{row.d.name}</span>
              {row.atRisk > 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{row.atRisk} at risk</span>}
              {row.overdue > 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">{row.overdue} overdue</span>}
              <span className="text-xs text-white/40 tabular-nums w-14 text-right">{row.open} open</span>
            </div>
          ))}
          {stats.perDept.every(r => r.open === 0) && <div className="px-4 py-6 text-center text-xs text-white/30">No open tasks tagged to departments yet.</div>}
        </div>
      </div>

      {/* Brand rollup */}
      {stats.perBrand.length > 0 && (
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 font-semibold mb-2">By brand</h3>
          <div className="flex flex-wrap gap-2">
            {stats.perBrand.map(row => (
              <div key={row.b.slug} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: row.b.color }} />
                <span className="text-sm text-white/85">{row.b.label}</span>
                <span className="text-xs text-white/40 tabular-nums">{row.open}</span>
                {row.overdue > 0 && <span className="text-[10px] font-semibold px-1 py-0.5 rounded bg-red-500/15 text-red-300">{row.overdue}!</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attention list */}
      {stats.atRisk.length > 0 && (
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 font-semibold mb-2">Needs attention</h3>
          <div className="space-y-1">{stats.atRisk.slice(0, 12).map(t => <MiniTask key={t.id} t={t} departments={departments} team={team} onEdit={onEdit} issue={t.ragStatus === "off_track"} />)}</div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "red" | "green" | "blue" }) {
  const color = tone === "red" ? "#ef4444" : tone === "green" ? "#22c55e" : tone === "blue" ? "#3b82f6" : "#e2e8f0";
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[11px] text-white/40 mt-0.5">{label}</div>
    </div>
  );
}
function RagRollup({ title, counts, total }: { title: string; counts: { r: Rag; n: number }[]; total: number }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold">{title}</h3><span className="text-xs text-white/35">{total}</span></div>
      {total === 0 ? <p className="text-xs text-white/30">None set yet.</p> :
        <>
          <div className="h-2 rounded-full overflow-hidden flex bg-white/[0.05] mb-2">
            {counts.filter(c => c.n > 0).map(c => <div key={c.r} style={{ width: `${(c.n / total) * 100}%`, background: RAG_META[c.r].color }} />)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {counts.filter(c => c.n > 0).map(c => (
              <span key={c.r} className="flex items-center gap-1.5 text-[11px] text-white/60"><span className="w-2 h-2 rounded-full" style={{ background: RAG_META[c.r].color }} />{RAG_META[c.r].label} · {c.n}</span>
            ))}
          </div>
        </>}
    </div>
  );
}
