// ─────────────────────────────────────────────────────────────────────────────
// Task Tracker — the organisation-wide project & task system.
//
// Pure logic shared by server and client. No imports from either side, so the
// server can validate with exactly the code the browser used to render.
//
// THE SHAPE (modelled on the Notion setup Travis ran at Kerkyra United):
//   Projects (and Goals) → Tasks. A project carries an OWNER, AREAS (what part
//   of the business) and BRANDS (which club/venture it serves). A task carries
//   one accountable OWNER plus any number of helpers.
//
// WHY IT IS NOT WORKSPACE-SCOPED: this is one shared dataset for the whole
// organisation, reachable from every workspace's sidebar (the Chat / Feedback
// pattern). Brand is a TAG on the record, never a container — so "everything
// for MFL" and "all of Marketing" are two filters over the same rows, and no
// task is ever "in the wrong place". Containers force you to duplicate; tags
// do not.
//
// DERIVED, NEVER STORED: overdue, project progress, staleness, workload. The
// server sends NZ `today` on every list response — the browser must never
// compute today from a JS Date (UTC reads a day behind in New Zealand).
// ─────────────────────────────────────────────────────────────────────────────

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Validated TEXT, never pg enums or CHECK constraints. A stale CHECK is how the
// MFL checkout started 500ing; vocabulary changes must never need a migration.

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Machine-readable status kinds. The LABEL is Travis's to rename ("Done" →
 * "Shipped"); the KIND is what every piece of logic keys on, so renaming a
 * column can never break completion, overdue or progress maths.
 *
 * `blocked` is deliberately its own kind, not a flag. A blocked task is not
 * progressing and not finished — a manager needs to see that state distinctly,
 * and it must never be swept into "in progress" where it looks healthy.
 */
export const STATUS_KINDS = ["todo", "active", "blocked", "done"] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export const PROJECT_KINDS = ["project", "goal"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * How a page renders. Chosen per page, the way a Notion page can be a document
 * or a database view.
 *   doc      — written notes (markdown)
 *   projects — the projects tagged to this brand + area, as a table
 *   tasks    — those projects' tasks, as a list
 *   board    — the same tasks, as a kanban by status
 *   list     — nothing but the pages nested inside this one
 */
export const PAGE_VIEW_TYPES = ["doc", "projects", "tasks", "board", "list"] as const;
export type PageViewType = (typeof PAGE_VIEW_TYPES)[number];

export function isPageViewType(v: unknown): v is PageViewType {
  return typeof v === "string" && (PAGE_VIEW_TYPES as readonly string[]).includes(v);
}

/** Brand keys — who the work SERVES. Matches the ClubOS workspace slugs. */
export const TT_BRANDS = [
  { key: "cufc", label: "Christchurch United" },
  { key: "siu", label: "South Island United" },
  { key: "mfl", label: "Mini Football Leagues" },
  { key: "cic", label: "Christchurch International Cup" },
  { key: "usc", label: "United Sports Centre" },
  { key: "cugc", label: "United Gymnastics" },
  { key: "prints", label: "United Prints" },
  { key: "usg", label: "United Sports Group" },
] as const;

// Annotated as string[] rather than the inferred literal union: these are
// checked against values arriving off the wire, and a literal-union type makes
// every `.includes(userInput)` a compile error at the call site.
export const TT_BRAND_KEYS: string[] = TT_BRANDS.map((b) => b.key);

/**
 * Map a ClubOS workspace slug to its brand key, so the tab opens pre-filtered
 * to the brand you are standing in. Returns null for the group/sandbox
 * workspaces, which see everything.
 */
export const BRAND_KEY_BY_ORG_SLUG: Record<string, string> = {
  "christchurch-united": "cufc",
  "south-island-united": "siu",
  "mini-football-leagues": "mfl",
  "christchurch-international-cup": "cic",
  "united-sports-centre": "usc",
  "united-gymnastics": "cugc",
  "united-prints": "prints",
};

export function brandKeyForOrgSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return BRAND_KEY_BY_ORG_SLUG[slug] ?? null;
}

// ── Validators ───────────────────────────────────────────────────────────────

export function isPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

export function isStatusKind(v: unknown): v is StatusKind {
  return typeof v === "string" && (STATUS_KINDS as readonly string[]).includes(v);
}

export function isProjectKind(v: unknown): v is ProjectKind {
  return typeof v === "string" && (PROJECT_KINDS as readonly string[]).includes(v);
}

/** Bare YYYY-MM-DD only. Never accept a full ISO timestamp into a date column. */
export function isDateOnly(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Coerce whatever arrived into a clean date-only string or null. Deliberately
 * REFUSES a timestamp rather than truncating it — truncating a UTC timestamp
 * silently shifts the date by one day for half of every New Zealand day.
 */
export function cleanDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  return isDateOnly(v) ? v : null;
}

export function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Normalise a tag/area/brand list: trimmed, de-duped, order preserved. */
export function cleanKeyList(v: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const k = raw.trim();
    if (!k || seen.has(k)) continue;
    if (allowed && !allowed.includes(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// ── Dates ────────────────────────────────────────────────────────────────────
// Everything here is string maths on YYYY-MM-DD. Nothing round-trips through a
// JS Date, because `new Date("2026-08-03")` is midnight UTC — which is still
// 2 August in Christchurch.

/** Today in New Zealand, as YYYY-MM-DD. Server-side source of truth. */
export function nzToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Whole days from `a` to `b` (b - a). Both bare YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  // Date.UTC on the calendar parts only — no timezone can shift a pure count.
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// ── Derived state ────────────────────────────────────────────────────────────

export interface TaskLike {
  dueDate?: string | null;
  statusKind?: StatusKind | string | null;
  updatedAt?: string | Date | null;
}

/** Finished — the only state that exempts a task from chasing. */
export function isDone(kind: StatusKind | string | null | undefined): boolean {
  return kind === "done";
}

/**
 * Overdue is DERIVED on every read, never stored. A task due yesterday that
 * nobody touched is overdue today whether or not anything wrote to the row.
 */
export function isOverdue(task: TaskLike, today: string): boolean {
  if (!task.dueDate || isDone(task.statusKind)) return false;
  return task.dueDate < today;
}

export function isDueToday(task: TaskLike, today: string): boolean {
  return !!task.dueDate && !isDone(task.statusKind) && task.dueDate === today;
}

export type DueBucket = "overdue" | "today" | "this_week" | "upcoming" | "someday";

/**
 * The buckets My Work is built from. "This week" runs to the end of the current
 * week (Sunday), not "within 7 days" — people plan in calendar weeks, and a
 * rolling window makes Friday's list change meaning every day.
 */
export function dueBucket(task: TaskLike, today: string): DueBucket {
  if (!task.dueDate) return "someday";
  if (isOverdue(task, today)) return "overdue";
  if (task.dueDate === today) return "today";
  const daysToSunday = 7 - isoWeekday(today); // Mon=1 … Sun=7
  return daysBetween(today, task.dueDate) <= daysToSunday ? "this_week" : "upcoming";
}

/** ISO weekday for a bare date: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sun = 0
  return dow === 0 ? 7 : dow;
}

/**
 * Days a task has sat untouched. The staleness signal a manager reads: a task
 * "in progress" for three weeks with no update is the single most common way a
 * board quietly stops telling the truth.
 */
export function daysSinceUpdate(updatedAt: string | Date | null | undefined, today: string): number | null {
  if (!updatedAt) return null;
  const iso = typeof updatedAt === "string" ? updatedAt.slice(0, 10) : nzTodayFrom(updatedAt);
  if (!isDateOnly(iso)) return null;
  return Math.max(0, daysBetween(iso, today));
}

function nzTodayFrom(d: Date): string {
  return nzToday(d);
}

/** A task is stale if it is actively in play but nothing has moved for a while. */
export const STALE_AFTER_DAYS = 14;

export function isStale(task: TaskLike, today: string): boolean {
  if (isDone(task.statusKind)) return false;
  if (task.statusKind !== "active" && task.statusKind !== "blocked") return false;
  const age = daysSinceUpdate(task.updatedAt, today);
  return age != null && age >= STALE_AFTER_DAYS;
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface Progress {
  done: number;
  total: number;
  /** 0–100, integer. 0 when there is nothing to count — never NaN. */
  percent: number;
  /** True only when there is at least one task and all of them are done. */
  complete: boolean;
}

/**
 * Project progress, computed from its tasks — the "COMPLETE 29/29" line.
 * Never stored: a stored percentage is wrong the moment anyone ticks anything,
 * and it is the classic source of a board that flatters itself.
 */
export function progressOf(tasks: Array<{ statusKind?: StatusKind | string | null }>): Progress {
  const total = tasks.length;
  const done = tasks.reduce((n, t) => n + (isDone(t.statusKind) ? 1 : 0), 0);
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done === total,
  };
}

// ── Access ───────────────────────────────────────────────────────────────────
// The tab is universal (any signed-in staff member), so the gate is about WHAT
// you may change, not whether you may look.
//
//   • Anyone can create a task, and edit a task they own, help on, or created.
//   • Managers can edit anything, and are the only ones who shape STRUCTURE
//     (projects, areas, status columns). Structure discipline is what stops a
//     tracker sprawling into the mess this replaces.

export interface ActorContext {
  userId: number;
  isManager: boolean;
}

export interface TaskOwnership {
  ownerId?: number | null;
  createdBy?: number | null;
  assigneeIds?: number[];
}

export function canEditTask(actor: ActorContext, task: TaskOwnership): boolean {
  if (actor.isManager) return true;
  if (task.ownerId === actor.userId) return true;
  if (task.createdBy === actor.userId) return true;
  return (task.assigneeIds ?? []).includes(actor.userId);
}

/** Deleting is narrower than editing — losing someone's record is not undoable. */
export function canDeleteTask(actor: ActorContext, task: TaskOwnership): boolean {
  return actor.isManager || task.createdBy === actor.userId;
}

/** Projects, areas and status columns are the skeleton. Managers only. */
export function canEditStructure(actor: ActorContext): boolean {
  return actor.isManager;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * The default order everywhere a flat task list is shown: overdue first, then
 * by due date, then priority, then the manual order. Tasks with no due date
 * sink below dated ones — an undated task is not more urgent than a dated one.
 */
export function compareTasks(
  a: { dueDate?: string | null; priority?: string | null; sortOrder?: number | null },
  b: { dueDate?: string | null; priority?: string | null; sortOrder?: number | null },
): number {
  if (a.dueDate && b.dueDate) {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  } else if (a.dueDate !== b.dueDate) {
    return a.dueDate ? -1 : 1;
  }
  const pa = PRIORITY_RANK[(a.priority as TaskPriority) ?? "medium"] ?? 2;
  const pb = PRIORITY_RANK[(b.priority as TaskPriority) ?? "medium"] ?? 2;
  if (pa !== pb) return pa - pb;
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}

// ── Seed vocabulary ──────────────────────────────────────────────────────────
// The starting areas and columns. Areas are DATA (editable in the app, no
// deploy) — these are only what the tracker opens with.

export const SEED_AREAS: Array<{ key: string; label: string; color: string }> = [
  { key: "operations", label: "Operations", color: "#8b5cf6" },
  { key: "commercial", label: "Commercial & Sponsorship", color: "#f59e0b" },
  { key: "marketing", label: "Marketing & Content", color: "#ec4899" },
  { key: "football", label: "Football & Academy", color: "#22c55e" },
  { key: "events", label: "Events & Tournaments", color: "#06b6d4" },
  { key: "facilities", label: "Facilities & Venue", color: "#64748b" },
  { key: "finance", label: "Finance & Admin", color: "#0ea5e9" },
  { key: "technology", label: "Technology", color: "#6366f1" },
  { key: "merchandise", label: "Merchandise & Retail", color: "#ef4444" },
  { key: "people", label: "People & Culture", color: "#14b8a6" },
];

export const SEED_PROJECT_STATUSES: Array<{ label: string; kind: StatusKind; color: string }> = [
  { label: "Backlog", kind: "todo", color: "#64748b" },
  { label: "Planning", kind: "todo", color: "#3b82f6" },
  { label: "In progress", kind: "active", color: "#f59e0b" },
  { label: "On hold", kind: "blocked", color: "#a855f7" },
  { label: "Done", kind: "done", color: "#22c55e" },
];

export const SEED_TASK_STATUSES: Array<{ label: string; kind: StatusKind; color: string }> = [
  { label: "To do", kind: "todo", color: "#64748b" },
  { label: "In progress", kind: "active", color: "#f59e0b" },
  { label: "Blocked", kind: "blocked", color: "#ef4444" },
  { label: "Done", kind: "done", color: "#22c55e" },
];
