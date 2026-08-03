// Task Tracker — client-side types and presentation helpers.
//
// All derivation logic (overdue, due buckets, progress, staleness, access)
// comes from @shared/task-tracker so the screen and the server can never
// disagree. `today` always arrives from the server in NZ time — the client
// never invents a date, because `new Date()` in a browser is UTC-anchored and
// reads a day behind here for most of the working day.

export {
  TASK_PRIORITIES,
  STATUS_KINDS,
  TT_BRANDS,
  isOverdue,
  isDueToday,
  isDone,
  isStale,
  dueBucket,
  daysBetween,
  daysSinceUpdate,
  progressOf,
  compareTasks,
  canEditTask,
  canDeleteTask,
  STALE_AFTER_DAYS,
  type TaskPriority,
  type StatusKind,
  type DueBucket,
} from "@shared/task-tracker";

import { TT_BRANDS, type TaskPriority, type StatusKind } from "@shared/task-tracker";

// ── Row shapes returned by /api/admin/task-tracker/* ─────────────────────────

export interface TtStaff {
  id: number;
  name: string | null;
}

export interface TtAreaRow {
  id: number;
  key: string;
  label: string;
  color: string;
  sortOrder: number;
}

export interface TtStatusRow {
  id: number;
  label: string;
  kind: StatusKind;
  color: string;
  sortOrder: number;
}

export interface TtProjectRow {
  id: number;
  name: string;
  emoji: string | null;
  description: string | null;
  kind: "project" | "goal";
  statusId: number;
  statusLabel: string;
  statusKind: StatusKind;
  statusColor: string;
  ownerId: number | null;
  ownerName: string | null;
  areas: string[];
  brands: string[];
  startDate: string | null;
  targetDate: string | null;
  targetNote: string | null;
  sortOrder: number;
  archived: boolean;
  taskTotal: number;
  taskDone: number;
  taskOverdue: number;
}

export interface TtTaskRow {
  id: number;
  projectId: number | null;
  statusId: number;
  statusLabel: string;
  statusKind: StatusKind;
  statusColor: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  ownerId: number | null;
  ownerName: string | null;
  assignees: Array<{ id: number; name: string | null }>;
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
  sortOrder: number;
  completedAt: string | null;
  statusChangedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  checklistDone: number;
  checklistTotal: number;
}

export interface TtBootstrap {
  today: string;
  me: { id: number; isManager: boolean };
  defaultBrand: string | null;
  areas: TtAreaRow[];
  projectStatuses: TtStatusRow[];
  taskStatuses: TtStatusRow[];
  brands: string[];
  staff: TtStaff[];
}

// ── Presentation ─────────────────────────────────────────────────────────────

export const PRIORITY_META: Record<TaskPriority, { label: string; className: string; dot: string }> = {
  urgent: { label: "Urgent", className: "text-red-300 bg-red-500/15 border-red-500/30", dot: "#ef4444" },
  high: { label: "High", className: "text-orange-300 bg-orange-500/15 border-orange-500/30", dot: "#f97316" },
  medium: { label: "Medium", className: "text-blue-300 bg-blue-500/15 border-blue-500/25", dot: "#3b82f6" },
  low: { label: "Low", className: "text-white/50 bg-white/5 border-white/10", dot: "#64748b" },
};

export const BRAND_LABEL: Record<string, string> = Object.fromEntries(
  TT_BRANDS.map((b) => [b.key, b.label]),
);

/** Short brand label for a chip — the full names are far too long on a phone. */
export const BRAND_SHORT: Record<string, string> = {
  cufc: "CUFC",
  siu: "SIU",
  mfl: "MFL",
  cic: "CIC",
  usc: "USC",
  cugc: "Gymnastics",
  prints: "Prints",
  usg: "Group",
};

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * Format a bare YYYY-MM-DD for display WITHOUT constructing a Date.
 * `new Date("2026-08-03").toLocaleDateString()` renders "2 August" in New
 * Zealand — this exact bug printed the wrong due date on a live invoice once.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function fmtDateFull(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A relative, human due label: "3 days late", "Today", "in 5 days". */
export function dueLabel(due: string | null | undefined, today: string): string {
  if (!due) return "";
  const [ty, tm, td] = today.split("-").map(Number);
  const [dy, dm, dd] = due.split("-").map(Number);
  const diff = Math.round(
    (Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "1 day late";
  if (diff < 0) return `${-diff} days late`;
  if (diff <= 7) return `in ${diff} days`;
  return fmtDate(due);
}

export const AREA_FALLBACK_COLOR = "#6366f1";
