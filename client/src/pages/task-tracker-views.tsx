// Task Tracker — the five views.
//
//   My Work    — the one screen every staff member lives in
//   This Week  — the screen Travis PROJECTS in the weekly meeting
//   Projects   — the Kerkyra board: projects grouped by status
//   Tasks      — tasks grouped by project, with a COMPLETE n/n footer
//   Team       — the accountability rollup
//
// Everything derived (overdue, buckets, progress, staleness) comes from
// @shared/task-tracker via lib/task-tracker, so a number on screen is computed
// by exactly the code the server would use. `today` always comes from the
// server in NZ time.

import { useMemo } from "react";
import {
  AlertTriangle, CalendarDays, CheckCircle2, CircleSlash, Clock, Inbox,
  UserCircle2, Users, Flag, ChevronRight,
} from "lucide-react";
import {
  PRIORITY_META, BRAND_SHORT, initials, fmtDate, dueLabel,
  isOverdue, isDone, isStale, dueBucket, progressOf, compareTasks,
  daysSinceUpdate, STALE_AFTER_DAYS,
  type TtTaskRow, type TtProjectRow, type TtAreaRow, type TtStatusRow, type TtStaff,
} from "@/lib/task-tracker";

// ═══════════════════════════════════════════════════════════════════════════
// Shared bits
// ═══════════════════════════════════════════════════════════════════════════

export function Avatar({ name, size = 22 }: { name: string | null; size?: number }) {
  return (
    <span
      title={name ?? "Unassigned"}
      className="inline-flex items-center justify-center rounded-full bg-blue-500/20 text-blue-200 border border-blue-400/25 font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * The people on a task: the accountable owner first (ringed), then helpers.
 *
 * These sit SIDE BY SIDE rather than in the usual overlapping stack. Preflight
 * showed why: overlapped 20px circles turn four sets of initials into one smear
 * ("TGDMZB"), and giving the owner a z-index to fix its edge simply hid the
 * next person underneath instead. Two helpers are shown, the rest become "+N" —
 * on a task row, who is accountable is the thing that has to be readable.
 */
export function People({ task }: { task: TtTaskRow }) {
  const helpers = task.assignees.filter((a) => a.id !== task.ownerId);
  if (!task.ownerName && helpers.length === 0) {
    return <span className="text-[11px] text-amber-300/70 whitespace-nowrap">Nobody yet</span>;
  }
  const SHOWN = 2;
  return (
    <span className="inline-flex items-center gap-1">
      {task.ownerName && (
        <span className="rounded-full ring-2 ring-blue-400/50" title={`${task.ownerName} — accountable`}>
          <Avatar name={task.ownerName} />
        </span>
      )}
      {helpers.slice(0, SHOWN).map((h) => (
        <span key={h.id} title={`${h.name} — helping`}>
          <Avatar name={h.name} size={20} />
        </span>
      ))}
      {helpers.length > SHOWN && (
        <span className="text-[10px] text-white/40 whitespace-nowrap">+{helpers.length - SHOWN}</span>
      )}
    </span>
  );
}

export function AreaChips({ keys, areas }: { keys: string[]; areas: TtAreaRow[] }) {
  if (!keys?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {keys.map((k) => {
        const a = areas.find((x) => x.key === k);
        return (
          <span
            key={k}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap"
            style={{
              color: a?.color ?? "#a5b4fc",
              borderColor: `${a?.color ?? "#6366f1"}40`,
              background: `${a?.color ?? "#6366f1"}14`,
            }}
          >
            {a?.label ?? k}
          </span>
        );
      })}
    </span>
  );
}

export function BrandChips({ keys }: { keys: string[] }) {
  if (!keys?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {keys.map((k) => (
        <span key={k} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] text-white/55 border border-white/10 whitespace-nowrap">
          {BRAND_SHORT[k] ?? k}
        </span>
      ))}
    </span>
  );
}

export function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap"
      style={{ color, borderColor: `${color}45`, background: `${color}18` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const p = progressOf(Array.from({ length: total }, (_, i) => ({ statusKind: i < done ? "done" : "todo" })));
  return (
    <span className="inline-flex items-center gap-2 min-w-[92px]">
      <span className="h-1.5 flex-1 rounded-full bg-white/[0.08] overflow-hidden">
        <span
          className={`block h-full rounded-full ${p.complete ? "bg-emerald-400" : "bg-blue-400"}`}
          style={{ width: `${p.percent}%` }}
        />
      </span>
      <span className={`text-[10px] tabular-nums ${p.complete ? "text-emerald-300" : "text-white/45"}`}>
        {done}/{total}
      </span>
    </span>
  );
}

/** One task row — used by My Work, Tasks and This Week. */
export function TaskRow({
  task, today, onOpen, showProject, projects,
}: {
  task: TtTaskRow;
  today: string;
  onOpen: (t: TtTaskRow) => void;
  showProject?: boolean;
  projects?: TtProjectRow[];
}) {
  const overdue = isOverdue(task, today);
  const done = isDone(task.statusKind);
  const stale = isStale(task, today);
  const project = showProject ? projects?.find((p) => p.id === task.projectId) : undefined;

  return (
    <button
      onClick={() => onOpen(task)}
      className="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.045] hover:border-white/[0.12] transition-colors"
      data-testid={`row-task-${task.id}`}
    >
      <span
        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
        style={{ background: task.statusColor }}
        title={task.statusLabel}
      />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className={`text-[13px] font-medium ${done ? "text-white/40 line-through" : "text-white/85"}`}>
            {task.title}
          </span>
          {task.priority !== "medium" && (
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${PRIORITY_META[task.priority].className}`}>
              {PRIORITY_META[task.priority].label}
            </span>
          )}
          {stale && (
            <span
              className="px-1.5 py-0.5 rounded text-[9px] font-semibold border text-amber-300 bg-amber-500/12 border-amber-500/30"
              title={`Nothing has changed on this for ${daysSinceUpdate(task.updatedAt, today)} days`}
            >
              Stale
            </span>
          )}
        </span>
        <span className="flex items-center gap-2.5 mt-1 flex-wrap text-[11px] text-white/40">
          {project && (
            <span className="inline-flex items-center gap-1 min-w-0">
              {project.emoji && <span>{project.emoji}</span>}
              <span className="truncate max-w-[180px]">{project.name}</span>
            </span>
          )}
          {task.dueDate && (
            <span className={overdue ? "text-red-300 font-medium" : done ? "text-white/30" : "text-white/50"}>
              {dueLabel(task.dueDate, today)}
            </span>
          )}
          {task.checklistTotal > 0 && (
            <span className="tabular-nums">{task.checklistDone}/{task.checklistTotal}</span>
          )}
          {task.statusKind === "blocked" && (
            <span className="text-red-300 font-medium">Blocked</span>
          )}
        </span>
      </span>
      <span className="shrink-0 pt-0.5"><People task={task} /></span>
    </button>
  );
}

function Empty({ icon: Icon, title, hint }: { icon: any; title: string; hint?: string }) {
  return (
    <div className="text-center py-10 px-4">
      <Icon className="w-7 h-7 mx-auto text-white/15 mb-2" />
      <p className="text-[13px] text-white/45">{title}</p>
      {hint && <p className="text-[11px] text-white/25 mt-1">{hint}</p>}
    </div>
  );
}

function Section({ title, count, tone, children }: {
  title: string; count: number; tone?: "danger" | "warn" | "normal"; children: React.ReactNode;
}) {
  if (count === 0) return null;
  const color =
    tone === "danger" ? "text-red-300" : tone === "warn" ? "text-amber-300" : "text-white/55";
  return (
    <div className="space-y-1.5">
      <h3 className={`text-[11px] font-semibold uppercase tracking-wider ${color} px-1`}>
        {title} <span className="text-white/25 tabular-nums">({count})</span>
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// My Work
// ═══════════════════════════════════════════════════════════════════════════

export function MyWorkView({
  tasks, projects, today, meId, onOpen,
}: {
  tasks: TtTaskRow[]; projects: TtProjectRow[]; today: string; meId: number;
  onOpen: (t: TtTaskRow) => void;
}) {
  const mine = useMemo(
    () =>
      tasks
        .filter((t) => t.ownerId === meId || t.assignees.some((a) => a.id === meId))
        .sort(compareTasks),
    [tasks, meId],
  );

  const open = mine.filter((t) => !isDone(t.statusKind));
  const buckets = {
    overdue: open.filter((t) => dueBucket(t, today) === "overdue"),
    today: open.filter((t) => dueBucket(t, today) === "today"),
    this_week: open.filter((t) => dueBucket(t, today) === "this_week"),
    upcoming: open.filter((t) => dueBucket(t, today) === "upcoming"),
    someday: open.filter((t) => dueBucket(t, today) === "someday"),
  };
  const recentlyDone = mine
    .filter((t) => isDone(t.statusKind) && t.completedAt)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, 8);

  if (mine.length === 0) {
    return <Empty icon={Inbox} title="Nothing is assigned to you yet." hint="Tasks you own or help with land here." />;
  }

  const row = (t: TtTaskRow) => (
    <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject projects={projects} />
  );

  return (
    <div className="space-y-5">
      <Section title="Overdue" count={buckets.overdue.length} tone="danger">{buckets.overdue.map(row)}</Section>
      <Section title="Today" count={buckets.today.length} tone="warn">{buckets.today.map(row)}</Section>
      <Section title="This week" count={buckets.this_week.length}>{buckets.this_week.map(row)}</Section>
      <Section title="Upcoming" count={buckets.upcoming.length}>{buckets.upcoming.map(row)}</Section>
      <Section title="No date set" count={buckets.someday.length}>{buckets.someday.map(row)}</Section>
      <Section title="Recently completed" count={recentlyDone.length}>{recentlyDone.map(row)}</Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// This Week — the screen the weekly meeting runs off
//
// The research was blunt: accountability is not a database feature, it is a
// fixed weekly meeting with a glanceable artefact. If nobody projects a screen
// on a Monday, the manager becomes the only person who ever opens the tool.
// This view is that artefact: a scoreboard, this week's commitments grouped by
// person, and everything blocked — nothing else competing for attention.
// ═══════════════════════════════════════════════════════════════════════════

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" | "good" }) {
  const color =
    tone === "danger" ? "text-red-300" : tone === "warn" ? "text-amber-300" :
    tone === "good" ? "text-emerald-300" : "text-white/85";
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-center">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-white/35 mt-0.5">{label}</div>
    </div>
  );
}

export function ThisWeekView({
  tasks, projects, today, staff, onOpen,
}: {
  tasks: TtTaskRow[]; projects: TtProjectRow[]; today: string; staff: TtStaff[];
  onOpen: (t: TtTaskRow) => void;
}) {
  const live = tasks.filter((t) => !isDone(t.statusKind));
  const overdue = live.filter((t) => isOverdue(t, today));
  const dueThisWeek = live.filter((t) => {
    const b = dueBucket(t, today);
    return b === "today" || b === "this_week";
  });
  const blocked = live.filter((t) => t.statusKind === "blocked");
  const stale = live.filter((t) => isStale(t, today));
  const doneRecently = tasks.filter((t) => {
    if (!t.completedAt) return false;
    const d = String(t.completedAt).slice(0, 10);
    return daysSinceUpdate(d, today) !== null && daysSinceUpdate(d, today)! <= 7;
  });

  // Commitments grouped by the accountable person. Sorted so the person with
  // the most overdue work is at the top — that is the conversation to have.
  const commitments = useMemo(() => {
    const byPerson = new Map<number | null, TtTaskRow[]>();
    for (const t of [...overdue, ...dueThisWeek]) {
      const key = t.ownerId ?? null;
      const list = byPerson.get(key) ?? [];
      if (!list.find((x) => x.id === t.id)) list.push(t);
      byPerson.set(key, list);
    }
    return Array.from(byPerson.entries())
      .map(([userId, list]) => ({
        userId,
        name: userId == null ? null : (staff.find((s) => s.id === userId)?.name ?? list[0]?.ownerName ?? null),
        tasks: list.sort(compareTasks),
        overdue: list.filter((t) => isOverdue(t, today)).length,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.tasks.length - a.tasks.length);
  }, [overdue, dueThisWeek, staff, today]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? "danger" : "good"} />
        <Stat label="Due this week" value={dueThisWeek.length} />
        <Stat label="Blocked" value={blocked.length} tone={blocked.length ? "warn" : undefined} />
        <Stat label={`Stale ${STALE_AFTER_DAYS}d+`} value={stale.length} tone={stale.length ? "warn" : undefined} />
        <Stat label="Done last 7 days" value={doneRecently.length} tone="good" />
      </div>

      {blocked.length > 0 && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.05] p-3 sm:p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-red-300 mb-2 flex items-center gap-1.5">
            <CircleSlash className="w-3.5 h-3.5" /> Blocked — needs a decision
          </h3>
          <div className="space-y-1.5">
            {blocked.sort(compareTasks).map((t) => (
              <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject projects={projects} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/55 mb-2.5 px-1 flex items-center gap-1.5">
          <Flag className="w-3.5 h-3.5" /> This week, by person
        </h3>
        {commitments.length === 0 ? (
          <Empty icon={CheckCircle2} title="Nothing is due this week." hint="Either the week is clear or nothing has a date on it." />
        ) : (
          <div className="space-y-4">
            {commitments.map((c) => (
              <div key={String(c.userId)} className="rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <div className="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.06] bg-white/[0.02]">
                  <Avatar name={c.name} size={24} />
                  <span className="text-[13px] font-medium text-white/80">
                    {c.name ?? "Nobody assigned"}
                  </span>
                  <span className="text-[11px] text-white/35 tabular-nums">{c.tasks.length}</span>
                  {c.overdue > 0 && (
                    <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold text-red-300 bg-red-500/12 border border-red-500/25">
                      {c.overdue} overdue
                    </span>
                  )}
                </div>
                <div className="p-2 space-y-1.5">
                  {c.tasks.map((t) => (
                    <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject projects={projects} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Projects — grouped by status, the Kerkyra layout
// ═══════════════════════════════════════════════════════════════════════════

export function ProjectsView({
  projects, statuses, areas, today, onOpen,
}: {
  projects: TtProjectRow[]; statuses: TtStatusRow[]; areas: TtAreaRow[]; today: string;
  onOpen: (p: TtProjectRow) => void;
}) {
  if (projects.length === 0) {
    return <Empty icon={Inbox} title="No projects yet." hint="A manager can add the first one with “New project”." />;
  }
  return (
    <div className="space-y-6">
      {statuses.map((st) => {
        const rows = projects.filter((p) => p.statusId === st.id);
        if (rows.length === 0) return null;
        return (
          <div key={st.id}>
            <div className="flex items-center gap-2 mb-2 px-1">
              <StatusPill label={st.label} color={st.color} />
              <span className="text-[11px] text-white/30 tabular-nums">{rows.length}</span>
            </div>
            {/* Horizontal scroll lives on this wrapper so the PAGE never scrolls
                sideways on a phone — the house containment rule. */}
            <div className="rounded-xl border border-white/[0.07] overflow-x-auto">
              <table className="w-full min-w-[720px] text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    <th className="font-medium px-3 py-2">Name</th>
                    <th className="font-medium px-3 py-2">Area</th>
                    <th className="font-medium px-3 py-2">Brand</th>
                    <th className="font-medium px-3 py-2">Owner</th>
                    <th className="font-medium px-3 py-2">Dates</th>
                    <th className="font-medium px-3 py-2">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => onOpen(p)}
                      className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer"
                      data-testid={`row-project-${p.id}`}
                    >
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="text-base leading-none">{p.emoji || (p.kind === "goal" ? "🎯" : "📁")}</span>
                          <span className="min-w-0">
                            <span className="block text-[13px] text-white/85 font-medium truncate max-w-[260px]">{p.name}</span>
                            {p.kind === "goal" && p.targetNote && (
                              <span className="block text-[10px] text-amber-300/70 truncate max-w-[260px]">{p.targetNote}</span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5"><AreaChips keys={p.areas} areas={areas} /></td>
                      <td className="px-3 py-2.5"><BrandChips keys={p.brands} /></td>
                      <td className="px-3 py-2.5">
                        {p.ownerName ? (
                          <span className="flex items-center gap-1.5">
                            <Avatar name={p.ownerName} size={20} />
                            <span className="text-[11px] text-white/55 truncate max-w-[110px]">{p.ownerName}</span>
                          </span>
                        ) : (
                          <span className="text-[11px] text-amber-300/70">No owner</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[11px] text-white/45 whitespace-nowrap">
                        {p.startDate && p.targetDate
                          ? `${fmtDate(p.startDate)} → ${fmtDate(p.targetDate)}`
                          : fmtDate(p.targetDate ?? p.startDate) || "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <ProgressBar done={p.taskDone} total={p.taskTotal} />
                          {p.taskOverdue > 0 && (
                            <span className="text-[10px] text-red-300 whitespace-nowrap">{p.taskOverdue} late</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tasks — grouped by project, with the COMPLETE n/n footer
// ═══════════════════════════════════════════════════════════════════════════

export function TasksView({
  tasks, projects, today, onOpen, onQuickAdd,
}: {
  tasks: TtTaskRow[]; projects: TtProjectRow[]; today: string;
  onOpen: (t: TtTaskRow) => void;
  onQuickAdd: (projectId: number | null) => void;
}) {
  const groups = useMemo(() => {
    const out: Array<{ project: TtProjectRow | null; tasks: TtTaskRow[] }> = [];
    for (const p of projects) {
      const list = tasks.filter((t) => t.projectId === p.id).sort(compareTasks);
      if (list.length > 0) out.push({ project: p, tasks: list });
    }
    const orphans = tasks.filter((t) => t.projectId == null).sort(compareTasks);
    if (orphans.length > 0) out.push({ project: null, tasks: orphans });
    return out;
  }, [tasks, projects]);

  if (groups.length === 0) {
    return <Empty icon={Inbox} title="No tasks yet." hint="Add the first one with “New task”." />;
  }

  return (
    <div className="space-y-6">
      {groups.map(({ project, tasks: list }) => {
        const p = progressOf(list);
        return (
          <div key={project?.id ?? "none"} className="rounded-xl border border-white/[0.07] bg-white/[0.015] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06] bg-white/[0.02] flex-wrap">
              <span className="text-base leading-none">{project?.emoji || (project ? "📁" : "📥")}</span>
              <span className="text-[13px] font-medium text-white/80 truncate max-w-[300px]">
                {project?.name ?? "No project"}
              </span>
              <span className="text-[11px] text-white/30 tabular-nums">{list.length}</span>
              {project && <AreaChips keys={project.areas} areas={[]} />}
              <button
                onClick={() => onQuickAdd(project?.id ?? null)}
                className="ml-auto text-[11px] text-blue-300/70 hover:text-blue-300 whitespace-nowrap"
                data-testid={`button-quickadd-${project?.id ?? "none"}`}
              >
                + Add task
              </button>
            </div>
            <div className="p-2 space-y-1.5">
              {list.map((t) => (
                <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} />
              ))}
            </div>
            <div className={`px-3 py-1.5 text-[10px] uppercase tracking-wider border-t border-white/[0.05] ${
              p.complete ? "text-emerald-300 bg-emerald-500/[0.05]" : "text-white/30"
            }`}>
              {p.complete ? "Complete" : "Progress"} {p.done}/{p.total}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Team — the accountability rollup
//
// Counts, never hours: nobody here is going to maintain time estimates, and a
// capacity model nobody feeds is worse than none. Sorted by overdue, because
// that is the conversation to have first.
// ═══════════════════════════════════════════════════════════════════════════

export function TeamView({
  tasks, staff, today, onSelectPerson,
}: {
  tasks: TtTaskRow[]; staff: TtStaff[]; today: string;
  onSelectPerson: (userId: number | null) => void;
}) {
  const rows = useMemo(() => {
    // The endpoint already excludes archived rows, so everything here is live.
    const live = tasks;
    const ids = new Set<number | null>();
    for (const t of live) if (t.ownerId != null) ids.add(t.ownerId);

    const out = Array.from(ids).map((id) => {
      const mine = live.filter((t) => t.ownerId === id);
      const open = mine.filter((t) => !isDone(t.statusKind));
      return {
        userId: id as number,
        name: staff.find((s) => s.id === id)?.name ?? mine[0]?.ownerName ?? "Unknown",
        open: open.length,
        overdue: open.filter((t) => isOverdue(t, today)).length,
        dueThisWeek: open.filter((t) => ["today", "this_week"].includes(dueBucket(t, today))).length,
        blocked: open.filter((t) => t.statusKind === "blocked").length,
        stale: open.filter((t) => isStale(t, today)).length,
        doneRecently: mine.filter((t) => {
          if (!t.completedAt) return false;
          const age = daysSinceUpdate(String(t.completedAt).slice(0, 10), today);
          return age != null && age <= 7;
        }).length,
      };
    });

    out.sort((a, b) => b.overdue - a.overdue || b.open - a.open);
    return out;
  }, [tasks, staff, today]);

  const unowned = tasks.filter((t) => !isDone(t.statusKind) && t.ownerId == null);

  return (
    <div className="space-y-4">
      {unowned.length > 0 && (
        <button
          onClick={() => onSelectPerson(null)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-left hover:bg-amber-500/[0.1] transition-colors"
          data-testid="button-unowned"
        >
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" />
          <span className="text-[12px] text-amber-200/90">
            <span className="font-semibold tabular-nums">{unowned.length}</span> open{" "}
            {unowned.length === 1 ? "task has" : "tasks have"} nobody accountable
          </span>
          <ChevronRight className="w-4 h-4 text-amber-300/50 ml-auto shrink-0" />
        </button>
      )}

      {rows.length === 0 ? (
        <Empty icon={Users} title="Nothing is assigned to anyone yet." />
      ) : (
        <div className="rounded-xl border border-white/[0.07] overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                <th className="font-medium px-3 py-2">Person</th>
                <th className="font-medium px-3 py-2 text-right">Open</th>
                <th className="font-medium px-3 py-2 text-right">Overdue</th>
                <th className="font-medium px-3 py-2 text-right">This week</th>
                <th className="font-medium px-3 py-2 text-right">Blocked</th>
                <th className="font-medium px-3 py-2 text-right">Stale</th>
                <th className="font-medium px-3 py-2 text-right">Done 7d</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.userId}
                  onClick={() => onSelectPerson(r.userId)}
                  className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer"
                  data-testid={`row-person-${r.userId}`}
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <Avatar name={r.name} size={22} />
                      <span className="text-[12px] text-white/80 truncate max-w-[160px]">{r.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-white/70">{r.open}</td>
                  <td className={`px-3 py-2.5 text-right text-[12px] tabular-nums font-medium ${r.overdue ? "text-red-300" : "text-white/25"}`}>{r.overdue}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-white/55">{r.dueThisWeek}</td>
                  <td className={`px-3 py-2.5 text-right text-[12px] tabular-nums ${r.blocked ? "text-amber-300" : "text-white/25"}`}>{r.blocked}</td>
                  <td className={`px-3 py-2.5 text-right text-[12px] tabular-nums ${r.stale ? "text-amber-300" : "text-white/25"}`}>{r.stale}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-emerald-300/80">{r.doneRecently}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-white/25 px-1 leading-relaxed">
        Counts are of tasks, not hours — and every column here is computed from dates and status,
        never typed in by hand. “Stale” means nothing has changed on an in-progress or blocked task
        for {STALE_AFTER_DAYS} days.
      </p>
    </div>
  );
}
