// Shared vocabulary + types for the USG Work Management system (the group
// "Projects" tab and its Command-Centre views). Kept in one place so the main
// page and the view components (group-work-views.tsx) agree on shapes.

// Brand vocabulary — the slugs of every org so brand_tags filter chips read
// naturally. Stays in sync with organizations.slug values.
export const BRANDS: { slug: string; label: string; color: string }[] = [
  { slug: "cufc",       label: "CUFC",         color: "#3b82f6" },
  { slug: "siu",        label: "SIU",          color: "#8b5cf6" },
  { slug: "mfl",        label: "MFL",          color: "#06b6d4" },
  { slug: "cic",        label: "CIC",          color: "#a855f7" },
  { slug: "usc",        label: "USC",          color: "#22c55e" },
  { slug: "gymnastics", label: "Gymnastics",   color: "#ec4899" },
  { slug: "usg",        label: "USG",          color: "#64748b" },
  { slug: "print",      label: "Print",        color: "#f59e0b" },
  { slug: "sponsorship",label: "Sponsorship",  color: "#ef4444" },
];

export const PRIORITY_COLORS: Record<string, string> = {
  low:    "#64748b",
  medium: "#3b82f6",
  high:   "#f59e0b",
  urgent: "#ef4444",
};

// RAG — the self-reported traffic light leadership reads. Deliberately small.
export type Rag = "none" | "on_track" | "at_risk" | "off_track";
export const RAG_META: Record<Rag, { label: string; color: string }> = {
  none:      { label: "No status", color: "#64748b" },
  on_track:  { label: "On track",  color: "#22c55e" },
  at_risk:   { label: "At risk",   color: "#f59e0b" },
  off_track: { label: "Off track", color: "#ef4444" },
};
export const RAG_ORDER: Rag[] = ["on_track", "at_risk", "off_track", "none"];

export const GOAL_LEVELS = {
  vision:   { label: "Vision",      plural: "Vision",        blurb: "Where we're heading (3-year)" },
  season:   { label: "Season Goal", plural: "Season Goals",  blurb: "3–5 big goals for the year" },
  priority: { label: "Priority",    plural: "Priorities",    blurb: "90-day “Rocks” that ladder up" },
} as const;
export type GoalLevel = keyof typeof GOAL_LEVELS;

export interface ProjectGroup {
  id: number; boardId: number; name: string; color: string; isDone: boolean; displayOrder: number;
}
export interface ProjectBoard {
  id: number; organizationId: number; name: string; description: string | null;
  brandTags: string[]; color: string; archived: boolean; groups: ProjectGroup[];
}
export interface ProjectTask {
  id: number; organizationId: number; boardId: number; groupId: number | null;
  parentId: number | null; title: string; description: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  ownerId: number | null; dueDate: string | null; brandTags: string[];
  displayOrder: number; completedAt: string | null;
  // Work-management additions
  departmentId: number | null; ragStatus: Rag; startDate: string | null;
  nextStep: string | null; isIssue: boolean; helperIds: number[]; goalId: number | null;
}
export interface TeamMember {
  id: number; first_name: string; last_name: string; email: string;
}
export interface Department {
  id: number; organizationId: number; name: string; slug: string; color: string;
  leadUserId: number | null; sortOrder: number; archived: boolean;
}
export interface GoalMeasure {
  id: number; goalId: number; name: string; measureType: "lead" | "lag";
  targetValue: string | null; currentValue: string | null; unit: string | null; sortOrder: number;
}
export interface Goal {
  id: number; organizationId: number; level: GoalLevel; parentId: number | null;
  title: string; description: string | null; ownerId: number | null; departmentId: number | null;
  brandTags: string[]; ragStatus: Rag; period: string | null; targetDate: string | null;
  archived: boolean; sortOrder: number; measures: GoalMeasure[];
}
export interface TaskTemplateItem {
  id: number; templateId: number; title: string; description: string | null;
  offsetDays: number; priority: "low" | "medium" | "high" | "urgent";
  departmentId: number | null; brandTags: string[]; nextStep: string | null; sortOrder: number;
}
export interface TaskTemplate {
  id: number; organizationId: number; name: string; description: string | null;
  anchorLabel: string; departmentId: number | null; brandTags: string[]; color: string;
  archived: boolean; sortOrder: number; items: TaskTemplateItem[];
}

// ── Small shared helpers ─────────────────────────────────────────────────────
export function memberName(team: TeamMember[], id: number | null | undefined): string | null {
  if (id == null) return null;
  const m = team.find(t => t.id === id);
  return m ? `${m.first_name} ${m.last_name}`.trim() : null;
}
export function deptOf(departments: Department[], id: number | null | undefined): Department | null {
  if (id == null) return null;
  return departments.find(d => d.id === id) || null;
}
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}
// Local-midnight day index so bucketing never trips over UTC.
export function dayDiff(dateStr: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}
export function isDoneTask(t: ProjectTask, boards: ProjectBoard[]): boolean {
  if (t.completedAt) return true;
  const b = boards.find(x => x.id === t.boardId);
  const g = b?.groups.find(x => x.id === t.groupId);
  return !!g?.isDone;
}
// Plain-English label for a playbook item's day offset relative to the anchor.
export function offsetLabel(days: number): string {
  if (days === 0) return "On the day";
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days < 0 ? `${n} ${unit} before` : `${n} ${unit} after`;
}
