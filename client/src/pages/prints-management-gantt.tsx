// MANAGEMENT — the Gantt/timeline view. Hand-rolled to the house doctrine
// (no chart/date/dnd libraries), built on four rules from the implementation
// research (outputs/deep-research/2026-07-22-up-management-platform/C):
//
//   1. ONE scroll container owns both scrollbars; the task list is
//      sticky-left, the time axis sticky-top, the corner above both —
//      zero scroll-sync JS.
//   2. PX_PER_DAY is the whole engine — one number per zoom drives every
//      bar x/width, the today line, and the arrow geometry.
//   3. End dates are INCLUSIVE: width = (daysBetween(start, due) + 1) ×
//      pxPerDay, floored at one day — forgetting the +1 renders same-day
//      tasks invisible.
//   4. During a drag mutate ONLY the bar's transform (no React state);
//      convert pixels back to dates and PATCH exactly once on pointerup.
//
// Dates are bare YYYY-MM-DD strings; "today" comes from the server (NZ).

import { useState, useMemo, useRef, useEffect } from "react";
import { Diamond, ChevronDown, ChevronRight, AlertTriangle, Inbox } from "lucide-react";
import {
  addDaysIso, daysBetween, taskBarRange, parseLocalDate, toLocalDateStr,
  type PlanProjectRow, type PlanTaskRow, type DepRow,
} from "@/lib/management";

const ROW_H = 36;
const BAR_H = 22;
const HEADER_H = 44;
// A 224px frozen column is right on desktop and greedy on a phone — sized
// once at mount (the value feeds layout math, so it can't be a CSS class).
const LEFT_W = typeof window !== "undefined" && window.innerWidth < 640 ? 136 : 224;

type Zoom = "day" | "week" | "month";
const PX: Record<Zoom, number> = { day: 40, week: 20, month: 6 };

type Row =
  | { type: "project"; project: PlanProjectRow; tasks: PlanTaskRow[] }
  | { type: "task"; task: PlanTaskRow; project: PlanProjectRow };

interface BarRect { x1: number; x2: number; mid: number; row: number }

export function GanttView({ projects, tasks, deps, today, onTask, onPatch, onAddDep }: {
  projects: PlanProjectRow[]; tasks: PlanTaskRow[]; deps: DepRow[]; today: string;
  onTask: (t: PlanTaskRow) => void;
  onPatch: (id: number, body: any) => void;
  onAddDep: (successorId: number, predecessorId: number) => void;
}) {
  const [zoom, setZoom] = useState<Zoom>("week");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const rubberRef = useRef<SVGLineElement>(null);
  const chartBodyRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);

  const ppd = PX[zoom];

  const dated = useMemo(() => tasks
    .map((t) => ({ task: t, range: taskBarRange(t) }))
    .filter((x): x is { task: PlanTaskRow; range: { start: string; end: string } } => !!x.range), [tasks]);
  const unscheduled = tasks.filter((t) => !t.startDate && !t.dueDate);

  // ── time range: everything scheduled ±padding, always including today ──────
  const { origin, totalDays } = useMemo(() => {
    const t = today || toLocalDateStr(new Date());
    let min = addDaysIso(t, -7), max = addDaysIso(t, 30);
    for (const { range } of dated) {
      if (range.start < min) min = range.start;
      if (range.end > max) max = range.end;
    }
    min = addDaysIso(min, -7); max = addDaysIso(max, 14);
    // round the origin DOWN to a Monday so the weekend stripe pattern aligns
    const d = parseLocalDate(min);
    const back = (d.getDay() + 6) % 7;
    const originIso = addDaysIso(min, -back);
    return { origin: originIso, totalDays: daysBetween(originIso, max) + 1 };
  }, [dated, today]);

  const x = (iso: string) => daysBetween(origin, iso) * ppd;
  const chartW = totalDays * ppd;

  // ── rows (project header + its tasks, collapsible) ──────────────────────────
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const p of projects) {
      const pt = tasks.filter((t) => t.projectId === p.id)
        .sort((a, b) => {
          const ar = taskBarRange(a), br = taskBarRange(b);
          if (!!ar !== !!br) return ar ? -1 : 1;
          if (ar && br && ar.start !== br.start) return ar.start < br.start ? -1 : 1;
          return a.sortOrder - b.sortOrder || a.id - b.id;
        });
      if (!pt.length) continue;
      out.push({ type: "project", project: p, tasks: pt });
      if (!collapsed.has(p.id)) for (const t of pt) out.push({ type: "task", task: t, project: p });
    }
    return out;
  }, [projects, tasks, collapsed]);

  const bodyH = rows.length * ROW_H;

  // bar rectangles by task id (for arrows + drop targeting)
  const rects = useMemo(() => {
    const m = new Map<number, BarRect>();
    rows.forEach((r, i) => {
      if (r.type !== "task") return;
      const range = taskBarRange(r.task);
      if (!range) return;
      const x1 = x(range.start);
      const w = Math.max((daysBetween(range.start, range.end) + 1) * ppd, ppd);
      m.set(r.task.id, { x1, x2: x1 + w, mid: i * ROW_H + ROW_H / 2, row: i });
    });
    return m;
  }, [rows, ppd, origin]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── dependency conflicts (finish-to-start: successor must start after) ─────
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const conflicts = useMemo(() => deps.filter((d) => {
    const pr = taskBarRange(taskById.get(d.predecessorId) ?? { startDate: null, dueDate: null } as any);
    const sr = taskBarRange(taskById.get(d.successorId) ?? { startDate: null, dueDate: null } as any);
    return !!pr && !!sr && sr.start <= pr.end;
  }), [deps, taskById]);

  /** One-click fix: walk conflicted edges, shifting each successor to start
   *  the day after its predecessor ends (duration kept), cascading downstream
   *  on local copies, then PATCH each changed task once. */
  const fixConflicts = () => {
    const local = new Map<number, { start: string; end: string; hasStart: boolean; hasDue: boolean }>();
    for (const t of tasks) {
      const r = taskBarRange(t);
      if (r) local.set(t.id, { ...r, hasStart: !!t.startDate, hasDue: !!t.dueDate });
    }
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (const d of deps) {
        const pr = local.get(d.predecessorId), sr = local.get(d.successorId);
        if (!pr || !sr || sr.start > pr.end) continue;
        const shift = daysBetween(sr.start, addDaysIso(pr.end, 1));
        local.set(d.successorId, { ...sr, start: addDaysIso(sr.start, shift), end: addDaysIso(sr.end, shift) });
        moved = true;
      }
      if (!moved) break;
    }
    for (const t of tasks) {
      const orig = taskBarRange(t); const next = local.get(t.id);
      if (!orig || !next || (orig.start === next.start && orig.end === next.end)) continue;
      const body: any = {};
      if (next.hasStart) body.startDate = next.start;
      if (next.hasDue) body.dueDate = next.end;
      onPatch(t.id, body);
    }
  };

  // scroll to put today ~1/4 in on first paint
  useEffect(() => {
    if (didInitialScroll.current || !scrollRef.current || !today) return;
    didInitialScroll.current = true;
    scrollRef.current.scrollLeft = Math.max(0, x(today) - 220);
  }, [today, origin, ppd]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── drag: move / resize, transform-only during, one PATCH on release ────────
  const dragTask = (e: React.PointerEvent, t: PlanTaskRow, kind: "move" | "resize-start" | "resize-end") => {
    const range = taskBarRange(t);
    if (!range) return;
    e.preventDefault(); e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest("[data-gantt-bar]") as HTMLElement;
    if (!el) return;
    el.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const origLeft = x(range.start);
    const origW = Math.max((daysBetween(range.start, range.end) + 1) * ppd, ppd);
    let dDays = 0;

    const onMove = (ev: PointerEvent) => {
      dDays = Math.round((ev.clientX - startX) / ppd);
      const dpx = dDays * ppd;
      if (kind === "move") {
        el.style.transform = `translateX(${origLeft + dpx}px)`;
      } else if (kind === "resize-end") {
        el.style.width = `${Math.max(origW + dpx, ppd)}px`;
      } else {
        const right = origLeft + origW;
        const w = Math.max(origW - dpx, ppd);
        el.style.transform = `translateX(${right - w}px)`;
        el.style.width = `${w}px`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dDays === 0) return;
      const body: any = {};
      if (kind === "move") {
        if (t.startDate) body.startDate = addDaysIso(t.startDate, dDays);
        if (t.dueDate) body.dueDate = addDaysIso(t.dueDate, dDays);
      } else if (kind === "resize-end") {
        body.dueDate = addDaysIso(range.end, dDays);
        if (!t.startDate) body.startDate = range.start;   // resizing implies a real span now
        if (body.dueDate < range.start) body.dueDate = range.start;
      } else {
        body.startDate = addDaysIso(range.start, dDays);
        if (!t.dueDate) body.dueDate = range.end;
        if (body.startDate > range.end) body.startDate = range.end;
      }
      onPatch(t.id, body);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── drag: create a dependency from a bar's end-dot ──────────────────────────
  const dragLink = (e: React.PointerEvent, fromTask: PlanTaskRow) => {
    e.preventDefault(); e.stopPropagation();
    const chart = chartBodyRef.current, rubber = rubberRef.current;
    const rect = rects.get(fromTask.id);
    if (!chart || !rubber || !rect) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    rubber.setAttribute("x1", String(rect.x2));
    rubber.setAttribute("y1", String(rect.mid));
    rubber.style.display = "block";

    const onMove = (ev: PointerEvent) => {
      const r = chart.getBoundingClientRect();
      rubber.setAttribute("x2", String(ev.clientX - r.left));
      rubber.setAttribute("y2", String(ev.clientY - r.top));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      rubber.style.display = "none";
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-gantt-bar]") as HTMLElement | null;
      const targetId = target ? Number(target.dataset.taskId) : NaN;
      if (Number.isInteger(targetId) && targetId !== fromTask.id) onAddDep(targetId, fromTask.id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── axis segments ────────────────────────────────────────────────────────────
  const axis = useMemo(() => {
    const months: { label: string; left: number; width: number }[] = [];
    const ticks: { label: string; left: number; width: number }[] = [];
    let mStart = 0;
    let cur = parseLocalDate(origin);
    let curKey = `${cur.getFullYear()}-${cur.getMonth()}`;
    for (let i = 0; i <= totalDays; i++) {
      const d = parseLocalDate(addDaysIso(origin, i));
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== curKey || i === totalDays) {
        const ref = parseLocalDate(addDaysIso(origin, mStart));
        months.push({ label: ref.toLocaleDateString("en-NZ", { month: zoom === "month" ? "short" : "long", year: "numeric" }), left: mStart * ppd, width: (i - mStart) * ppd });
        mStart = i; curKey = key;
      }
    }
    if (zoom === "day") {
      for (let i = 0; i < totalDays; i++) {
        const d = parseLocalDate(addDaysIso(origin, i));
        ticks.push({ label: String(d.getDate()), left: i * ppd, width: ppd });
      }
    } else if (zoom === "week") {
      for (let i = 0; i < totalDays; i += 7) {
        const d = parseLocalDate(addDaysIso(origin, i));
        ticks.push({ label: d.toLocaleDateString("en-NZ", { day: "numeric", month: "short" }), left: i * ppd, width: 7 * ppd });
      }
    } else {
      for (const m of months) ticks.push({ label: m.label.split(" ")[0], left: m.left, width: m.width });
    }
    return { months, ticks };
  }, [origin, totalDays, ppd, zoom]);

  // ── arrows (single SVG overlay, elbow paths) ────────────────────────────────
  const arrows = useMemo(() => deps.map((d) => {
    const from = rects.get(d.predecessorId), to = rects.get(d.successorId);
    if (!from || !to) return null;
    const conflict = conflicts.some((c) => c.id === d.id);
    const IND = 12;
    let path: string;
    if (to.x1 >= from.x2 + IND * 2) {
      path = `M ${from.x2} ${from.mid} h ${IND} V ${to.mid} H ${to.x1}`;
    } else {
      const dir = to.mid > from.mid ? 1 : -1;
      path = `M ${from.x2} ${from.mid} h ${IND} v ${dir * (ROW_H / 2)} H ${to.x1 - IND} V ${to.mid} H ${to.x1}`;
    }
    path += ` m -5 -4 l 5 4 l -5 4`;
    return { id: d.id, path, conflict };
  }).filter(Boolean) as { id: number; path: string; conflict: boolean }[], [deps, rects, conflicts]);

  const todayX = today ? x(today) : null;
  const weekendStripe = `repeating-linear-gradient(90deg, transparent 0px, transparent ${5 * ppd}px, rgba(255,255,255,0.025) ${5 * ppd}px, rgba(255,255,255,0.025) ${7 * ppd}px)`;

  return (
    <div className="h-full flex flex-col">
      {/* toolbar */}
      <div className="px-4 sm:px-6 py-2 flex items-center gap-2 flex-wrap border-b border-white/[0.04]">
        <div className="flex items-center rounded-lg border border-white/10 overflow-hidden text-xs">
          {(["day", "week", "month"] as Zoom[]).map((z) => (
            <button key={z} onClick={() => setZoom(z)} className={`px-3 h-8 capitalize ${zoom === z ? "bg-indigo-500/20 text-indigo-100" : "hover:bg-white/[0.06] text-white/60"}`}>{z}</button>
          ))}
        </div>
        <button onClick={() => { if (scrollRef.current && todayX != null) scrollRef.current.scrollLeft = Math.max(0, todayX - 220); }}
          className="h-8 px-3 rounded-lg border border-white/10 text-xs hover:bg-white/[0.06] text-white/60">Today</button>
        <div className="flex-1" />
        {conflicts.length > 0 && (
          <div className="flex items-center gap-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
            <span className="text-amber-200">{conflicts.length} dependency conflict{conflicts.length === 1 ? "" : "s"}</span>
            <button onClick={fixConflicts} className="font-semibold text-amber-100 hover:text-white underline underline-offset-2">Shift dependents</button>
          </div>
        )}
        <span className="text-[10px] text-white/25 hidden sm:block">Drag bars to reschedule · edges to resize · dot → bar to link</span>
      </div>

      {/* unscheduled strip */}
      {unscheduled.length > 0 && (
        <div className="px-4 sm:px-6 py-2 border-b border-white/[0.04] flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-white/40 flex items-center gap-1"><Inbox className="w-3.5 h-3.5" />Unscheduled:</span>
          {unscheduled.slice(0, 8).map((t) => (
            <button key={t.id} onClick={() => onTask(t)}
              className="text-[11px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.07] truncate max-w-[180px]">
              {t.title}
            </button>
          ))}
          {unscheduled.length > 8 && <span className="text-[11px] text-white/30">+{unscheduled.length - 8} more</span>}
          <span className="text-[10px] text-white/25">— set dates to place them on the timeline</span>
        </div>
      )}

      {/* the one scroll container */}
      <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-white/30">No scheduled tasks match the filters — add dates to tasks (or clear filters) and they appear here.</div>
        ) : (
          <div style={{ width: LEFT_W + chartW, minWidth: "100%" }}>
            {/* header */}
            <div className="sticky top-0 z-30 flex" style={{ height: HEADER_H }}>
              <div className="sticky left-0 z-10 shrink-0 bg-[#0d1120] border-r border-b border-white/[0.08] flex items-end px-3 pb-1.5"
                style={{ width: LEFT_W }}>
                <span className="text-[10px] uppercase tracking-wider text-white/30 font-semibold">Task</span>
              </div>
              <div className="relative bg-[#0d1120] border-b border-white/[0.08]" style={{ width: chartW }}>
                {axis.months.map((m, i) => (
                  <div key={i} className="absolute top-0 h-[22px] border-r border-white/[0.05] text-[10px] font-semibold text-white/50 px-2 flex items-center justify-center overflow-hidden whitespace-nowrap"
                    style={{ left: m.left, width: m.width }}>{m.width > 60 ? m.label : ""}</div>
                ))}
                {axis.ticks.map((tk, i) => (
                  <div key={i} className="absolute bottom-0 h-[22px] border-r border-white/[0.04] text-[10px] text-white/35 flex items-center justify-center overflow-hidden"
                    style={{ left: tk.left, width: tk.width }}>{tk.width >= 18 ? tk.label : ""}</div>
                ))}
              </div>
            </div>

            {/* body */}
            <div className="flex">
              {/* left task list (sticky) */}
              <div className="sticky left-0 z-20 shrink-0 bg-[#0a0e1a] border-r border-white/[0.08]" style={{ width: LEFT_W }}>
                {rows.map((r, i) => r.type === "project" ? (
                  <button key={"p" + r.project.id} onClick={() => setCollapsed((prev) => { const n = new Set(prev); n.has(r.project.id) ? n.delete(r.project.id) : n.add(r.project.id); return n; })}
                    className="w-full flex items-center gap-1.5 px-2 text-left border-b border-white/[0.03]"
                    style={{ height: ROW_H, background: `${r.project.color}10` }}>
                    {collapsed.has(r.project.id) ? <ChevronRight className="w-3.5 h-3.5 text-white/40 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-white/40 shrink-0" />}
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: r.project.color }} />
                    <span className="text-xs font-semibold truncate" style={{ color: r.project.color }}>{r.project.name}</span>
                    <span className="text-[10px] text-white/30 ml-auto shrink-0">{r.tasks.length}</span>
                  </button>
                ) : (
                  <button key={"t" + r.task.id} onClick={() => onTask(r.task)}
                    className="w-full flex items-center gap-1.5 pl-6 pr-2 text-left border-b border-white/[0.03] hover:bg-white/[0.03]"
                    style={{ height: ROW_H }}>
                    {r.task.milestone && <Diamond className="w-3 h-3 text-amber-300 shrink-0" />}
                    <span className="text-[12px] text-white/75 truncate">{r.task.title}</span>
                  </button>
                ))}
              </div>

              {/* chart */}
              <div ref={chartBodyRef} className="relative" style={{ width: chartW, height: bodyH, background: weekendStripe }}>
                {/* row separators + project bands */}
                {rows.map((r, i) => (
                  <div key={i} className="absolute left-0 right-0 border-b border-white/[0.03]"
                    style={{ top: i * ROW_H, height: ROW_H, background: r.type === "project" ? `${r.project.color}08` : undefined }} />
                ))}

                {/* today line */}
                {todayX != null && todayX >= 0 && todayX <= chartW && (
                  <div className="absolute top-0 bottom-0 w-[2px] bg-indigo-400/60 z-[1]" style={{ left: todayX + ppd / 2 }} />
                )}

                {/* project summary bars */}
                {rows.map((r, i) => {
                  if (r.type !== "project") return null;
                  const ranges = r.tasks.map((t) => taskBarRange(t)).filter(Boolean) as { start: string; end: string }[];
                  if (!ranges.length) return null;
                  const s = ranges.reduce((a, b) => (a.start < b.start ? a : b)).start;
                  const e = ranges.reduce((a, b) => (a.end > b.end ? a : b)).end;
                  const left = x(s), w = Math.max((daysBetween(s, e) + 1) * ppd, ppd);
                  return (
                    <div key={"sum" + r.project.id} className="absolute rounded-sm opacity-40"
                      style={{ top: i * ROW_H + ROW_H / 2 - 3, height: 6, transform: `translateX(${left}px)`, width: w, background: r.project.color }} />
                  );
                })}

                {/* dependency arrows */}
                <svg className="absolute inset-0 z-[2] pointer-events-none" width={chartW} height={bodyH}>
                  {arrows.map((a) => (
                    <path key={a.id} d={a.path} fill="none"
                      stroke={a.conflict ? "#f87171" : "rgba(255,255,255,0.28)"} strokeWidth={a.conflict ? 1.6 : 1.2} />
                  ))}
                  <line ref={rubberRef} style={{ display: "none" }} stroke="#818cf8" strokeWidth={1.5} strokeDasharray="4 3" />
                </svg>

                {/* bars + milestones */}
                {rows.map((r, i) => {
                  if (r.type !== "task") return null;
                  const t = r.task;
                  const range = taskBarRange(t);
                  if (!range) return null;
                  const left = x(range.start);
                  const w = Math.max((daysBetween(range.start, range.end) + 1) * ppd, ppd);
                  const done = r.project.statuses.find((s) => s.id === t.statusId)?.kind === "done";
                  const prog = t.checklist.length
                    ? Math.round((t.checklist.filter((c) => c.done).length / t.checklist.length) * 100)
                    : t.progress ?? (done ? 100 : 0);
                  const labelInside = w > t.title.length * 6 + 16;

                  if (t.milestone) {
                    return (
                      <div key={t.id} data-gantt-bar data-task-id={t.id}
                        className="absolute z-[3] cursor-grab group touch-none"
                        style={{ top: i * ROW_H + ROW_H / 2 - 7, transform: `translateX(${left + ppd / 2 - 7}px)`, width: 14, height: 14 }}
                        onPointerDown={(e) => dragTask(e, t, "move")}
                        onClick={() => onTask(t)}>
                        <div className="w-[14px] h-[14px] rotate-45 rounded-[2px] border border-amber-300/70 bg-amber-400/80 group-hover:bg-amber-300" />
                        <span className="absolute left-5 top-0 text-[10px] text-amber-200/80 whitespace-nowrap">{t.title}</span>
                      </div>
                    );
                  }

                  return (
                    <div key={t.id} data-gantt-bar data-task-id={t.id}
                      className={`absolute z-[3] rounded-md cursor-grab group touch-none ${done ? "opacity-50" : ""}`}
                      style={{ top: i * ROW_H + (ROW_H - BAR_H) / 2, height: BAR_H, transform: `translateX(${left}px)`, width: w, background: `${r.project.color}38`, border: `1px solid ${r.project.color}70` }}
                      onPointerDown={(e) => dragTask(e, t, "move")}
                      onClick={() => onTask(t)}>
                      <div className="absolute inset-y-0 left-0 rounded-l-md" style={{ width: `${prog}%`, background: `${r.project.color}55` }} />
                      {labelInside && (
                        <span className={`absolute inset-0 px-2 flex items-center text-[11px] text-white/90 truncate ${done ? "line-through" : ""}`}>{t.title}</span>
                      )}
                      {!labelInside && (
                        <span className="absolute left-full ml-1.5 top-1/2 -translate-y-1/2 text-[10px] text-white/50 whitespace-nowrap pointer-events-none">{t.title}</span>
                      )}
                      {/* resize handles */}
                      <div className="absolute inset-y-0 left-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/20 rounded-l-md"
                        onPointerDown={(e) => dragTask(e, t, "resize-start")} />
                      <div className="absolute inset-y-0 right-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/20 rounded-r-md"
                        onPointerDown={(e) => dragTask(e, t, "resize-end")} />
                      {/* dependency dot */}
                      <button title="Drag to another bar to link (finish → start)"
                        className="absolute -right-2.5 top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full border border-indigo-300 bg-[#0a0e1a] opacity-0 group-hover:opacity-100 cursor-crosshair z-[4]"
                        onPointerDown={(e) => dragLink(e, t)} onClick={(e) => e.stopPropagation()} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
