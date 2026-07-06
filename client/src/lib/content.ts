// Shared vocabulary + client types for the USG Content Calendar / Media
// Production system (the group "Content" tab). Kept in one place so the page and
// its view components agree on shapes. Reuses BRANDS + PRIORITY_COLORS from the
// work-management vocab so a content item's brand chips read identically to a task's.

import { BRANDS, PRIORITY_COLORS, type TeamMember } from "@/lib/work";
export { BRANDS, PRIORITY_COLORS };
export type { TeamMember };

// ── Production pipeline (the Monday-style status column) ─────────────────────
// Order matters: this is the left→right flow of the board and the sort order
// everywhere. `done` marks the terminal delivered stage. `terminal` stages sit
// at the end (published/cancelled) and are dimmed in the backlog.
export interface StatusMeta { key: string; label: string; color: string; done?: boolean; terminal?: boolean; }
export const CONTENT_STATUSES: StatusMeta[] = [
  { key: "idea",      label: "Ideas",      color: "#64748b" },
  { key: "scripting", label: "Scripting",  color: "#8b5cf6" },
  { key: "to_shoot",  label: "To Shoot",   color: "#f59e0b" },
  { key: "editing",   label: "Editing",    color: "#06b6d4" },
  { key: "review",    label: "Review",     color: "#eab308" },
  { key: "scheduled", label: "Scheduled",  color: "#3b82f6" },
  { key: "published", label: "Published",  color: "#22c55e", done: true, terminal: true },
  { key: "cancelled", label: "Cancelled",  color: "#ef4444", terminal: true },
];
export const statusMeta = (key: string): StatusMeta =>
  CONTENT_STATUSES.find(s => s.key === key) || CONTENT_STATUSES[0];

// ── Content format (what the piece IS) ───────────────────────────────────────
export const CONTENT_FORMATS: { key: string; label: string }[] = [
  { key: "reel",       label: "Reel" },
  { key: "short",      label: "Short" },
  { key: "long_video", label: "Long-form video" },
  { key: "photo",      label: "Photo" },
  { key: "carousel",   label: "Carousel" },
  { key: "story",      label: "Story" },
  { key: "graphic",    label: "Graphic" },
  { key: "blog",       label: "Blog / Article" },
  { key: "email",      label: "Email" },
  { key: "podcast",    label: "Podcast" },
  { key: "other",      label: "Other" },
];
export const formatLabel = (key: string): string =>
  CONTENT_FORMATS.find(f => f.key === key)?.label || key;

// ── Channels / platforms (where it goes) ─────────────────────────────────────
export const CHANNELS: { key: string; label: string; color: string }[] = [
  { key: "instagram", label: "Instagram", color: "#e1306c" },
  { key: "tiktok",    label: "TikTok",    color: "#22d3ee" },
  { key: "youtube",   label: "YouTube",   color: "#ff0000" },
  { key: "facebook",  label: "Facebook",  color: "#1877f2" },
  { key: "linkedin",  label: "LinkedIn",  color: "#0a66c2" },
  { key: "x",         label: "X",         color: "#94a3b8" },
  { key: "website",   label: "Website",   color: "#6366f1" },
  { key: "email",     label: "Email",     color: "#f59e0b" },
  { key: "other",     label: "Other",     color: "#94a3b8" },
];
export const channelMeta = (key: string) =>
  CHANNELS.find(c => c.key === key) || { key, label: key, color: "#94a3b8" };

// ── Session types (production activities on the calendar) ────────────────────
export const SESSION_TYPES: { key: string; label: string; color: string }[] = [
  { key: "meeting",    label: "Meeting",      color: "#3b82f6" },
  { key: "planning",   label: "Planning",     color: "#8b5cf6" },
  { key: "scripting",  label: "Scripting",    color: "#a855f7" },
  { key: "storyboard", label: "Storyboard",   color: "#06b6d4" },
  { key: "brainstorm", label: "Brainstorm",   color: "#eab308" },
  { key: "shoot",      label: "Shoot",        color: "#f59e0b" },
  { key: "edit",       label: "Edit session", color: "#0ea5e9" },
  { key: "review",     label: "Review",       color: "#22c55e" },
  { key: "other",      label: "Other",        color: "#94a3b8" },
];
export const sessionMeta = (key: string) =>
  SESSION_TYPES.find(s => s.key === key) || { key, label: key, color: "#94a3b8" };

// ── Production roles (how the work is divvied up) ────────────────────────────
export const PRODUCTION_ROLES: { key: string; label: string }[] = [
  { key: "photography", label: "Photography" },
  { key: "videography", label: "Videography" },
  { key: "editing",     label: "Editing" },
  { key: "scripting",   label: "Scripting / Copy" },
  { key: "design",      label: "Design" },
  { key: "publishing",  label: "Publishing" },
  { key: "other",       label: "Other" },
];
export const roleLabel = (key: string): string =>
  PRODUCTION_ROLES.find(r => r.key === key)?.label || key;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

// ── Client-facing types (dates as ISO strings, matching JSON over the wire) ──
export interface ContentItem {
  id: number; organizationId: number;
  title: string; brief: string | null;
  format: string; channels: string[]; brandTags: string[];
  status: string; priority: string;
  plannedDate: string | null; publishedDate: string | null;
  ownerId: number | null; photographerId: number | null;
  videographerId: number | null; editorId: number | null;
  campaign: string | null; assetUrl: string | null; finalUrl: string | null;
  sessionId: number | null; notes: string | null;
  sortOrder: number; archived: boolean;
  createdBy: number | null; createdAt: string; updatedAt: string;
  tasks?: ContentTask[];   // nested on the detail fetch
}
export interface ContentSession {
  id: number; organizationId: number;
  title: string; sessionType: string;
  startAt: string; endAt: string | null; allDay: boolean;
  location: string | null; brandTags: string[]; attendeeIds: number[];
  leadId: number | null; notes: string | null;
  sortOrder: number; archived: boolean;
  createdBy: number | null; createdAt: string; updatedAt: string;
}
export interface ContentTask {
  id: number; organizationId: number; contentItemId: number;
  title: string; role: string; assigneeId: number | null;
  dueDate: string | null; done: boolean; sortOrder: number; createdAt: string;
}

// ── Small shared helpers ─────────────────────────────────────────────────────
export function memberName(team: TeamMember[], id: number | null | undefined): string | null {
  if (id == null) return null;
  const m = team.find(t => t.id === id);
  return m ? `${m.first_name} ${m.last_name}`.trim() : null;
}
export function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() || "").join("") || "?";
}
export function isDelivered(i: ContentItem): boolean {
  return i.status === "published" || !!i.publishedDate;
}
export function brandMeta(slug: string) {
  return BRANDS.find(b => b.slug === slug) || { slug, label: slug, color: "#64748b" };
}
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d.length <= 10 ? d + "T00:00:00" : d).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}
// Local-midnight day index so date bucketing never trips over UTC.
export function dayDiff(dateStr: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr.length <= 10 ? dateStr + "T00:00:00" : dateStr);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}
export function toLocalDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
