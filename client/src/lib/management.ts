// Shared client vocabulary + types for the Management tab (the planning
// workspace: projects → statuses → tasks, over Board / Table / Calendar /
// Gantt / My Work views). Derivation logic (overdue, due buckets, bar ranges,
// cycle checks) lives in @shared/management so the server and this client can
// never disagree; this file adds the client-only shapes and date/format
// helpers the views share.

export {
  PROJECT_STATUSES, STATUS_KINDS, TASK_PRIORITIES,
  PRIORITY_META, DEFAULT_STATUSES, PROJECT_COLORS,
  isIsoDate, addDaysIso, daysBetween,
  taskBarRange, isOverdue, dueBucket, wouldCreateCycle,
  type ProjectStatus, type StatusKind, type TaskPriority, type DueBucket,
} from "@shared/management";
import { addDaysIso as _addDays } from "@shared/management";

// ── Wire types (dates as ISO strings, matching JSON) ─────────────────────────
export interface TeamMember {
  id: number; first_name: string; last_name: string; email: string;
}

export interface PlanStatusRow {
  id: number; organizationId: number; projectId: number;
  label: string; color: string; kind: string; sortOrder: number; createdAt: string;
}

export interface PlanProjectRow {
  id: number; organizationId: number;
  name: string; description: string | null; color: string; status: string;
  startDate: string | null; targetDate: string | null;
  sortOrder: number; createdBy: number | null; createdAt: string; updatedAt: string;
  statuses: PlanStatusRow[];
}

export interface ChecklistRow {
  id: number; organizationId: number; taskId: number;
  title: string; done: boolean; assigneeId: number | null;
  sortOrder: number; createdAt: string;
}

export interface PlanTaskRow {
  id: number; organizationId: number; projectId: number; statusId: number;
  title: string; description: string | null; priority: string;
  assigneeId: number | null;
  startDate: string | null; dueDate: string | null;
  milestone: boolean; progress: number | null; tags: string[];
  sortOrder: number; completedAt: string | null; archived: boolean;
  createdBy: number | null; createdAt: string; updatedAt: string;
  checklist: ChecklistRow[];
  commentCount: number;
}

export interface DepRow {
  id: number; organizationId: number;
  predecessorId: number; successorId: number; createdAt: string;
}

export interface CommentRow {
  id: number; organizationId: number; taskId: number;
  authorId: number | null; authorName: string | null;
  body: string; createdAt: string;
}

// ── Lookup helpers ────────────────────────────────────────────────────────────
export function statusOf(projects: PlanProjectRow[], task: PlanTaskRow): PlanStatusRow | null {
  const p = projects.find((pr) => pr.id === task.projectId);
  return p?.statuses.find((st) => st.id === task.statusId) ?? null;
}
export function projectOf(projects: PlanProjectRow[], task: PlanTaskRow): PlanProjectRow | null {
  return projects.find((pr) => pr.id === task.projectId) ?? null;
}
export function memberName(team: TeamMember[], id: number | null | undefined): string | null {
  if (id == null) return null;
  const m = team.find((t) => t.id === id);
  return m ? `${m.first_name} ${m.last_name}`.trim() : null;
}
export function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

/** Checklist progress when a checklist exists; else the manual estimate. */
export function taskProgress(t: PlanTaskRow): number | null {
  if (t.checklist.length) return Math.round((t.checklist.filter((c) => c.done).length / t.checklist.length) * 100);
  return t.progress;
}

// ── Dates (local, never UTC — the off-by-one trap) ───────────────────────────
/** Parse a bare YYYY-MM-DD to LOCAL midnight. `new Date("YYYY-MM-DD")` parses
 *  UTC midnight and reads a day early in NZ — never use it for date-only. */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function toLocalDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  return parseLocalDate(d.slice(0, 10)).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}
export function fmtDateFull(d: string | null | undefined): string {
  if (!d) return "";
  return parseLocalDate(d.slice(0, 10)).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Due-date chip state — the Trello badge convention: red past-due, amber
 *  today/tomorrow, quiet otherwise; green once done. */
export function dueTone(due: string | null, done: boolean, today: string): "done" | "overdue" | "soon" | "normal" | "none" {
  if (!due) return "none";
  if (done) return "done";
  if (due < today) return "overdue";
  if (due <= _addDays(today, 1)) return "soon";
  return "normal";
}
export const DUE_TONE_CLASSES: Record<ReturnType<typeof dueTone>, string> = {
  done: "text-emerald-300 bg-emerald-500/10",
  overdue: "text-red-300 bg-red-500/15",
  soon: "text-amber-300 bg-amber-500/10",
  normal: "text-white/50 bg-white/[0.06]",
  none: "",
};

// ── Status-column colour presets (the Monday label-picker wheel) ─────────────
export const STATUS_COLOR_PRESETS = [
  "#64748b", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6",
  "#ec4899", "#ef4444", "#06b6d4", "#eab308", "#14b8a6",
] as const;
