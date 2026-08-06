// ─────────────────────────────────────────────────────────────────────────────
// Staff Chat — shared pure logic.
//
// The in-house Slack replacement for the club's WhatsApp staff groups. Design
// decisions here come from the 2026-07-22 deep-research run
// (outputs/deep-research/2026-07-22-inhouse-staff-chat/synthesis.md):
//   · channels + DMs, NO threads in v1 (Google Chat shipped topic-threading and
//     had to rip it out; Slack's own designers say even optional threads made
//     channels unreadable — the default matters more than the feature)
//   · quiet by default: badge-everything, but email/push escalation ONLY for
//     @mentions + DMs (+ channels a member explicitly sets to "all")
//   · unread is a POINTER per membership (Campfire's nullable last-read), never
//     per-message receipt rows (Zulip's documented scaling mistake)
//   · no public presence dots, no read receipts — presence is tracked
//     server-side purely to decide "are they away → escalate to email"
//   · quiet hours 20:00–08:00 NZ suppress email escalation (HSWA psychosocial-
//     hazard duty; the always-on buzz is the #1 thing staff hate about WhatsApp)
// ─────────────────────────────────────────────────────────────────────────────

export type StaffChannelKind = "channel" | "dm";
export type StaffPostPolicy = "anyone" | "leadership";
export type StaffNotifyLevel = "all" | "mentions" | "muted";

export const STAFF_NOTIFY_LEVELS: readonly StaffNotifyLevel[] = ["all", "mentions", "muted"];
export const STAFF_POST_POLICIES: readonly StaffPostPolicy[] = ["anyone", "leadership"];

export interface StaffChatAttachment {
  /** object-storage path, e.g. "/objects/uploads/<uuid>.webp" */
  url: string;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "voice" | "file";
  /** voice notes only — recorded duration in whole seconds */
  durationSec?: number;
}

// ── Limits ───────────────────────────────────────────────────────────────────
export const MESSAGE_MAX_LENGTH = 8000;
export const CHANNEL_NAME_MAX = 40;
export const TOPIC_MAX = 250;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_DM_PARTICIPANTS = 9; // author + 8 others
export const EDIT_WINDOW_MS = 60 * 60 * 1000; // own messages editable for 1 hour

// ── Away / escalation rules ──────────────────────────────────────────────────
// "Away" = no chat poll heartbeat for 5 minutes. Only away members are emailed
// (Campfire's connected-members-don't-notify rule); active members see the
// badge in-app within one poll cycle anyway.
export const AWAY_THRESHOLD_MS = 5 * 60 * 1000;
// Never email the same member about the same channel more than once per 15 min.
export const EMAIL_DEBOUNCE_MS = 15 * 60 * 1000;
// Quiet hours (NZ): suppress email escalation 20:00–08:00. Messages still land
// and badge; nobody's phone buzzes at night. (Research: notification fatigue is
// the top driver of people disabling notifications entirely.)
export const QUIET_HOURS_START = 20; // inclusive, 8pm
export const QUIET_HOURS_END = 8; // exclusive, 8am

/** Hour of day (0-23) in New Zealand for a given instant. */
export function nzHour(at: Date): number {
  const h = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    hour12: false,
  }).format(at);
  return parseInt(h, 10) % 24;
}

/** True when email escalation should be suppressed (20:00–08:00 NZ). */
export function isQuietHoursNZ(at: Date): boolean {
  const h = nzHour(at);
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

/** Away = never seen, or last heartbeat older than the threshold. */
export function isAway(lastSeenAt: Date | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() > AWAY_THRESHOLD_MS;
}

/** Email debounce per membership: at most one escalation email per window. */
export function emailDebounced(lastEmailedAt: Date | null | undefined, now: Date): boolean {
  if (!lastEmailedAt) return false;
  return now.getTime() - lastEmailedAt.getTime() < EMAIL_DEBOUNCE_MS;
}

// ── DM identity ──────────────────────────────────────────────────────────────
// A DM "channel" between a fixed set of people exists at most once. The key is
// the sorted user-id list — same participants always resolve to the same row
// (enforced by a partial unique index on staff_channels.dm_key).
export function dmKeyFor(userIds: number[]): string {
  const uniq = Array.from(new Set(userIds)).sort((a, b) => a - b);
  return uniq.join(":");
}

// ── Channel names ────────────────────────────────────────────────────────────
// Slack-style: lowercase, dashes, no '#' stored. "Match Day Ops" → "match-day-ops".
export function normalizeChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[#@]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\-À-ɏЀ-ӿ]/g, "") // keep latin ext + cyrillic (Russian-speaking staff)
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHANNEL_NAME_MAX);
}

// ── Mentions ─────────────────────────────────────────────────────────────────
// User mentions are EXPLICIT: the composer autocompletes a person and sends
// their user id in mentionUserIds[] alongside the plain "@First Last" text.
// The server validates ids against channel membership — free-text parsing of
// multi-word names is fragile and never authoritative.
// @channel / @everyone / @all IS detected textually (single well-known token),
// and is leadership-gated (Slack's un-gated @channel is a documented misery).
const CHANNEL_MENTION_RE = /(^|[\s(])@(channel|everyone|all)\b/i;

export function hasChannelMention(body: string): boolean {
  return CHANNEL_MENTION_RE.test(body);
}

/** Short plain-text excerpt for notification emails and channel previews. */
export function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Display name for a DM from the OTHER participants' point of view. */
export function dmDisplayName(
  memberNames: { userId: number; name: string }[],
  viewerUserId: number,
): string {
  const others = memberNames.filter((m) => m.userId !== viewerUserId);
  if (others.length === 0) return "Just you";
  return others.map((m) => m.name).join(", ");
}

// ── Upload allow-list ────────────────────────────────────────────────────────
// Images are recompressed server-side; voice notes come from MediaRecorder as
// webm/opus (Safari records mp4/m4a); documents pass through. Executables and
// scripts are rejected outright.
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const VOICE_TYPES = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/wav"]);
const FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  // Shared contacts (the WhatsApp "share a contact" flow). Both spellings exist
  // in the wild: text/vcard is the RFC 6350 registration, text/x-vcard is what
  // older exporters and some Android pickers still emit. Reject one and a
  // contact silently fails to send on half the phones.
  "text/vcard",
  "text/x-vcard",
]);

export function classifyUpload(contentType: string): "image" | "voice" | "file" | null {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  if (IMAGE_TYPES.has(ct)) return "image";
  if (VOICE_TYPES.has(ct)) return "voice";
  if (FILE_TYPES.has(ct)) return "file";
  return null;
}

export function extensionFor(contentType: string): string {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "image/heic": "heic", "image/heif": "heif",
    "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/m4a": "m4a",
    "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/wav": "wav",
    "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "text/vcard": "vcf", "text/x-vcard": "vcf",
  };
  return map[ct] ?? "bin";
}
