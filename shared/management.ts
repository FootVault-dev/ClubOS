// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT — the planning workspace (projects → statuses → tasks →
// checklists/dependencies/comments) behind the "Management" tab. First home:
// United Prints; org-scoped and generic by design.
//
// Pure logic only: no DB, no Express, no React. Imported by both
// `server/management-routes.ts` and the client pages so the badge a user
// reads on screen is the badge the server derived — never a client-side
// guess.
//
// The two load-bearing ideas (lifted from the maintenance/housing/vehicles
// precedents):
//
//  1. Task state that depends on TIME is DERIVED, never stored. "Overdue" is
//     due_date < today-in-NZ AND the task is not in a done-kind status,
//     computed fresh on every read. A stored overdue flag is only true until
//     the midnight nobody re-flips it.
//
//  2. Workflow columns are per-project DATA (plan_statuses), but each row
//     carries a machine-readable `kind` (todo|active|done) so renaming
//     "Done" to "Shipped 🚀" never breaks completion logic, progress bars,
//     or the scoreboard.
// ─────────────────────────────────────────────────────────────────────────────

// ── Vocabularies ─────────────────────────────────────────────────────────────
// Stored as TEXT and validated here — never pg enums, never DB CHECK gates.

export const PROJECT_STATUSES = ["active", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const STATUS_KINDS = ["todo", "active", "done"] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const isProjectStatus = (v: unknown): v is ProjectStatus =>
  PROJECT_STATUSES.includes(v as ProjectStatus);
export const isStatusKind = (v: unknown): v is StatusKind =>
  STATUS_KINDS.includes(v as StatusKind);
export const isTaskPriority = (v: unknown): v is TaskPriority =>
  TASK_PRIORITIES.includes(v as TaskPriority);

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string; rank: number }> = {
  urgent: { label: "Urgent", color: "#ef4444", rank: 0 },
  high:   { label: "High",   color: "#f59e0b", rank: 1 },
  medium: { label: "Medium", color: "#3b82f6", rank: 2 },
  low:    { label: "Low",    color: "#64748b", rank: 3 },
};

// The default workflow every new project starts with (Monday/Trello
// convention: three columns, rename/extend freely afterwards).
export const DEFAULT_STATUSES: { label: string; color: string; kind: StatusKind }[] = [
  { label: "To do",       color: "#64748b", kind: "todo" },
  { label: "In progress", color: "#f59e0b", kind: "active" },
  { label: "Done",        color: "#22c55e", kind: "done" },
];

// A curated project-colour wheel (assigned round-robin at creation; always
// user-overridable). Picked for legibility on the dark admin background.
export const PROJECT_COLORS = [
  "#6366f1", "#ec4899", "#f59e0b", "#22c55e", "#06b6d4",
  "#8b5cf6", "#ef4444", "#eab308", "#3b82f6", "#14b8a6",
] as const;

// ── Dates ────────────────────────────────────────────────────────────────────
// Date-only ISO strings end to end. ISO dates compare correctly as strings,
// so no Date round-trip is ever needed (the UTC off-by-one trap).

export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today as YYYY-MM-DD in New Zealand, whatever timezone the server runs in. */
export function nzTodayIso(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" });
}

/** Add N days to a YYYY-MM-DD string, timezone-safe (UTC-noon anchor). */
export function addDaysIso(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Whole days from a → b (positive when b is later). Pure string math in,
 *  UTC-noon anchors inside, so DST can never shift the count. */
export function daysBetween(a: string, b: string): number {
  const toUtcNoon = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };
  return Math.round((toUtcNoon(b) - toUtcNoon(a)) / 86_400_000);
}

// ── Derived task state ───────────────────────────────────────────────────────

export interface TaskDateShape {
  startDate: string | null;
  dueDate: string | null;
}

/** The Gantt bar's inclusive [start, end] for a task. Either date alone gives
 *  a one-day bar; both give the span (server guards start ≤ due on write). */
export function taskBarRange(t: TaskDateShape): { start: string; end: string } | null {
  const start = t.startDate ?? t.dueDate;
  const end = t.dueDate ?? t.startDate;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Overdue = has a due date in the past and is not sitting in a done-kind
 *  column. DERIVED — never stored, computed against today-in-NZ. */
export function isOverdue(t: TaskDateShape, statusKind: StatusKind, today: string): boolean {
  return !!t.dueDate && t.dueDate < today && statusKind !== "done";
}

export type DueBucket = "overdue" | "today" | "this_week" | "later" | "unscheduled";

/** The My-Work grouping (Asana's Today/Upcoming/Later promotion model, plus
 *  an explicit overdue shelf). `today` is the server-sent NZ date. */
export function dueBucket(t: TaskDateShape, statusKind: StatusKind, today: string): DueBucket {
  if (!t.dueDate) return "unscheduled";
  if (isOverdue(t, statusKind, today)) return "overdue";
  if (t.dueDate === today) return "today";
  if (t.dueDate <= addDaysIso(today, 7)) return "this_week";
  return "later";
}

// ── Dependency graph ─────────────────────────────────────────────────────────

/** Would adding predecessor→successor create a cycle? Walks the existing
 *  edges from `successor` looking for a path back to `predecessor`. Used
 *  server-side before insert and client-side to grey out illegal targets. */
export function wouldCreateCycle(
  edges: { predecessorId: number; successorId: number }[],
  predecessorId: number,
  successorId: number,
): boolean {
  if (predecessorId === successorId) return true;
  const out = new Map<number, number[]>();
  for (const e of edges) {
    const list = out.get(e.predecessorId) ?? [];
    list.push(e.successorId);
    out.set(e.predecessorId, list);
  }
  const seen = new Set<number>();
  const stack = [successorId];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === predecessorId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const next of out.get(n) ?? []) stack.push(next);
  }
  return false;
}
