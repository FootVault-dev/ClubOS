// Staff Voice — pure logic shared by the server, the web client and the app.
//
// Everything here is a function of rows and a clock. No database, no network, no
// Date.now() hidden inside a helper: the caller passes `now`, so the same code
// answers the same question on a phone in a tunnel and on the server.
//
// See migrations/2026-08-17_staff_voice.sql for why almost nothing is stored.

export type StaffCallMode = "direct" | "group" | "channel" | "meeting";

export const STAFF_CALL_MODES: readonly StaffCallMode[] = ["direct", "group", "channel", "meeting"];

// How long an unanswered call rings before it counts as missed.
// 45s: long enough to get a phone out of a pocket, short enough that a missed
// call does not sit "ringing" on someone's screen for a minute.
export const RING_TIMEOUT_MS = 45 * 1000;

// A media token is a bearer credential for a room. Short TTL so a token lifted
// from a log or a revoked staff account cannot be replayed into tomorrow's call.
// This is time-to-JOIN, not call length — LiveKit keeps a connection open once
// established, so a two-hour meeting is unaffected.
export const MEDIA_TOKEN_TTL_SECONDS = 10 * 60;

// Not a technical limit — LiveKit handles far more. A staff call with 30 people
// in it is a meeting that should have been an announcement.
export const MAX_CALL_PARTICIPANTS = 30;

export const CALL_TITLE_MAX = 120;

// ─────────────────────────────────────────────────────────────────────────────
// The row shapes this module reasons about. Deliberately structural rather than
// imported from the schema, so the app can use them without pulling in drizzle.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallRow {
  id: number;
  mode: StaffCallMode | string;
  channelId: number | null;
  roomName: string;
  title: string | null;
  startedBy: number;
  startedAt: Date | string;
  endedAt: Date | string | null;
  endedReason?: string | null;
}

export interface CallParticipantRow {
  userId: number;
  invitedAt: Date | string | null;
  joinedAt: Date | string | null;
  leftAt: Date | string | null;
  declinedAt: Date | string | null;
}

function ms(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivations
// ─────────────────────────────────────────────────────────────────────────────

/** Live = never ended. There is no is_live column and there must not be one. */
export function isCallLive(call: Pick<CallRow, "endedAt">): boolean {
  return call.endedAt == null;
}

/** In the room right now: answered and hasn't left. */
export function isPresent(p: CallParticipantRow): boolean {
  return p.joinedAt != null && p.leftAt == null;
}

export function presentCount(participants: CallParticipantRow[]): number {
  return participants.filter(isPresent).length;
}

/**
 * Still ringing for this person: they were invited, haven't answered, haven't
 * declined, the call is live, and it started less than RING_TIMEOUT_MS ago.
 *
 * Derived rather than stored precisely because the thing that would clear a
 * stored 'ringing' flag is a client that may never come back.
 */
export function isRingingFor(
  call: Pick<CallRow, "startedAt" | "endedAt">,
  p: CallParticipantRow,
  now: Date,
): boolean {
  if (!isCallLive(call)) return false;
  if (p.invitedAt == null) return false;
  if (p.joinedAt != null || p.declinedAt != null) return false;
  const started = ms(call.startedAt);
  if (started == null) return false;
  return now.getTime() - started < RING_TIMEOUT_MS;
}

/**
 * A call nobody can still answer and nobody is in. The lazy sweeper uses this
 * instead of a cron: an unanswered call is closed by the next person who looks,
 * which is always sooner than a scheduled job and needs no scheduler.
 *
 * A 'channel' room with nobody in it is also stale — an empty voice channel is
 * simply a room that stops existing until the next person drops in.
 */
export function isStale(call: CallRow, participants: CallParticipantRow[], now: Date): boolean {
  if (!isCallLive(call)) return false;
  if (participants.some(isPresent)) return false;
  const started = ms(call.startedAt);
  if (started == null) return true;
  const everJoined = participants.some((p) => p.joinedAt != null);
  // Nobody ever picked up → it is stale the moment ringing stops.
  // Somebody joined and then everyone left → stale immediately (empty room).
  return everJoined || now.getTime() - started >= RING_TIMEOUT_MS;
}

export function staleReasonFor(participants: CallParticipantRow[]): "empty" | "unanswered" {
  return participants.some((p) => p.joinedAt != null) ? "empty" : "unanswered";
}

export type CallOutcome = "answered" | "missed" | "declined" | "ringing" | "in_progress";

/** What this call was, from one person's point of view — for the call history list. */
export function outcomeFor(call: CallRow, p: CallParticipantRow, now: Date): CallOutcome {
  if (p.declinedAt != null) return "declined";
  if (p.joinedAt != null) return isCallLive(call) && p.leftAt == null ? "in_progress" : "answered";
  if (isRingingFor(call, p, now)) return "ringing";
  return "missed";
}

export function durationSeconds(call: Pick<CallRow, "startedAt" | "endedAt">, now: Date): number {
  const started = ms(call.startedAt);
  if (started == null) return 0;
  const ended = ms(call.endedAt) ?? now.getTime();
  return Math.max(0, Math.round((ended - started) / 1000));
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions — ONE decider
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceViewer {
  userId: number;
  isLeadership: boolean;
  /** Undefined when the person is not an active member of the channel. */
  isActiveMember: boolean;
}

export interface VoiceChannelFacts {
  kind: "channel" | "dm" | string;
  postPolicy: "anyone" | "leadership" | string;
  archivedAt: Date | string | null;
  voiceEnabled: boolean;
}

export interface VoiceAccess {
  canJoin: boolean;
  canStartCall: boolean;
  canToggleVoiceChannel: boolean;
  reason: string | null;
}

/**
 * 🔴 THE decider. Voice inherits chat membership exactly — if you can read the
 * room you can talk in it, and if you cannot, you cannot. No second permission
 * model, and deliberately no super-admin bypass: a super admin who is not in a
 * DM has no business dialling into it, and `canAccessTab` already fails open for
 * admin/manager roles, which is exactly the hole this must not reproduce.
 */
export function voiceAccess(viewer: VoiceViewer, channel: VoiceChannelFacts): VoiceAccess {
  const deny = (reason: string): VoiceAccess => ({
    canJoin: false,
    canStartCall: false,
    canToggleVoiceChannel: false,
    reason,
  });

  if (!viewer.isActiveMember) return deny("You are not a member of this conversation");
  if (channel.archivedAt != null) return deny("This conversation is archived");

  // An announcements-style channel is broadcast-only. Someone opening a call in
  // it would hand every member a live microphone in a room built for one voice.
  const mayStart = channel.postPolicy !== "leadership" || viewer.isLeadership;

  return {
    canJoin: true,
    canStartCall: mayStart,
    // Same gate as creating a channel: sprawl is governed from day one.
    canToggleVoiceChannel: channel.kind === "channel" && viewer.isLeadership,
    reason: mayStart ? null : "Only leadership can start a call in this channel",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Room naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 The room name IS the access boundary at the media server — LiveKit checks
 * the grant in the token and nothing else. So it is random and server-minted,
 * never derived from the channel id. A guessable room name plus any valid staff
 * token is an open door into a conversation you were not invited to.
 */
export function makeRoomName(mode: StaffCallMode, randomHex: string): string {
  return `usg-${mode}-${randomHex}`;
}

/** The display identity LiveKit shows other participants. Never an email. */
export function participantIdentity(userId: number): string {
  return `u${userId}`;
}

export function userIdFromIdentity(identity: string): number | null {
  const m = /^u(\d+)$/.exec(identity || "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
