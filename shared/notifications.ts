// ─────────────────────────────────────────────────────────────────────────────
// Notifications — shared pure logic (server + web client + mobile client).
//
// The cross-feature notification layer. Staff Chat already had an escalation
// engine (shared/staff-chat.ts): away-detection, NZ quiet hours, a per-channel
// notify level and a 15-minute email debounce. That engine was right, but it
// was email-only, chat-only and had no per-person settings — every staff member
// got the same behaviour whether they wanted it or not.
//
// This module generalises it:
//   · a DELIVERY setting per event type ('both' | 'push' | 'email' | 'none')
//   · two master switches (push / email) that gate everything beneath them
//   · per-user quiet hours, defaulting to the club-wide 20:00–08:00 NZ
//   · opt-in daily / weekly digests
//
// Two rules that must not be lost:
//   1. A MISSING preferences row is not "notifications off" — it means the
//      person has never opened the settings screen. `DEFAULT_PREFERENCES` is
//      the answer, so nothing needs backfilling and a new staff member works
//      on day one.
//   2. Quiet hours and 'none' suppress PUSH AND EMAIL ONLY. The in-app badge
//      always updates. Somebody who muted their phone overnight must still see
//      the room was busy when they open the app — a preference silences the
//      buzz, never the record.
// ─────────────────────────────────────────────────────────────────────────────

/** How a single event type reaches someone. */
export type DeliveryMode = "both" | "push" | "email" | "none";
export const DELIVERY_MODES: readonly DeliveryMode[] = ["both", "push", "email", "none"];

/**
 * The events a person can be notified about.
 *
 * `chat_channel` is deliberately separate from `chat_mention`: a channel set to
 * "all" is high-volume by nature, so it defaults to push-only (a badge and a
 * buzz) and never fills an inbox. A mention is personal and defaults to both.
 */
export type NotificationEvent =
  | "chat_dm"
  | "chat_mention"
  | "chat_channel"
  | "task_assigned"
  | "task_due";

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  "chat_dm",
  "chat_mention",
  "chat_channel",
  "task_assigned",
  "task_due",
];

export interface NotificationPreferences {
  /** Master switch. Off = no push to any device, whatever the per-event setting. */
  pushEnabled: boolean;
  /** Master switch. Off = no notification email (transactional mail is unaffected). */
  emailEnabled: boolean;

  chatDm: DeliveryMode;
  chatMention: DeliveryMode;
  chatChannel: DeliveryMode;
  taskAssigned: DeliveryMode;
  taskDue: DeliveryMode;

  /**
   * Include the message text on the lock screen. On by default (WhatsApp and
   * Slack both do), but a real choice for staff whose phones show notifications
   * to whoever is standing there — chat can carry a child's name or a parent's
   * number.
   */
  showPreview: boolean;

  quietHoursEnabled: boolean;
  /** Hour 0–23, inclusive. */
  quietHoursStart: number;
  /** Hour 0–23, exclusive. */
  quietHoursEnd: number;

  dailyDigest: boolean;
  /** Hour 0–23 (NZ) the daily digest is sent. */
  dailyDigestHour: number;
  weeklyDigest: boolean;
  /** 1 = Monday … 7 = Sunday (ISO), matching how a work week is spoken about. */
  weeklyDigestDay: number;
  weeklyDigestHour: number;
}

/**
 * What everyone gets until they change something.
 *
 * Chosen to be QUIET — the 2026-07-22 staff-chat research found notification
 * fatigue is the single biggest driver of people turning notifications off
 * entirely, at which point you have no channel to them at all. So: DMs and
 * mentions buzz, ordinary channel traffic does not, digests are opt-in.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  emailEnabled: true,
  chatDm: "both",
  chatMention: "both",
  // A channel the member explicitly set to "all" — push only, never email.
  chatChannel: "push",
  taskAssigned: "both",
  // A due date is not urgent enough to buzz a phone; it belongs in a digest.
  taskDue: "email",
  showPreview: true,
  quietHoursEnabled: true,
  quietHoursStart: 20,
  quietHoursEnd: 8,
  dailyDigest: false,
  dailyDigestHour: 8,
  weeklyDigest: false,
  weeklyDigestDay: 1, // Monday
  weeklyDigestHour: 8,
};

export const NZ_TIMEZONE = "Pacific/Auckland";

/** Hour of day (0–23) in New Zealand for a given instant. */
export function nzHour(at: Date): number {
  const h = new Intl.DateTimeFormat("en-NZ", {
    timeZone: NZ_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).format(at);
  return parseInt(h, 10) % 24;
}

/** ISO weekday in New Zealand: 1 = Monday … 7 = Sunday. */
export function nzWeekday(at: Date): number {
  const name = new Intl.DateTimeFormat("en-NZ", {
    timeZone: NZ_TIMEZONE,
    weekday: "short",
  }).format(at);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name.slice(0, 3)] ?? 1;
}

/** Calendar date in New Zealand as YYYY-MM-DD — never a UTC `toISOString()`. */
export function nzDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NZ_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * Is this instant inside the person's quiet hours?
 *
 * Handles the overnight wrap (20:00–08:00 spans midnight) and the degenerate
 * start === end, which is treated as "no quiet hours" rather than "silent
 * forever" — the alternative silently swallows every notification a person
 * ever gets, and they would have no way to tell why.
 */
export function isQuietHours(prefs: NotificationPreferences, at: Date): boolean {
  if (!prefs.quietHoursEnabled) return false;
  const start = clampHour(prefs.quietHoursStart);
  const end = clampHour(prefs.quietHoursEnd);
  if (start === end) return false;
  const h = nzHour(at);
  return start > end
    ? h >= start || h < end // wraps midnight
    : h >= start && h < end; // same-day window
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0;
  return Math.min(23, Math.max(0, Math.trunc(h)));
}

/** The delivery mode configured for one event. */
export function modeFor(prefs: NotificationPreferences, event: NotificationEvent): DeliveryMode {
  switch (event) {
    case "chat_dm":
      return prefs.chatDm;
    case "chat_mention":
      return prefs.chatMention;
    case "chat_channel":
      return prefs.chatChannel;
    case "task_assigned":
      return prefs.taskAssigned;
    case "task_due":
      return prefs.taskDue;
    default:
      return "none";
  }
}

export interface DeliveryDecision {
  push: boolean;
  email: boolean;
  /** Set when both channels are off, for logging — never shown to a user. */
  reason?: string;
}

/**
 * The one place that decides whether a notification leaves the building.
 *
 * Every caller goes through this so the master switches and quiet hours cannot
 * be forgotten by a new feature — the mistake pattern this whole module exists
 * to prevent.
 *
 * `urgent` bypasses quiet hours. Reserved for a leadership must-see message;
 * it is NOT a way around someone setting an event to 'none' — an explicit
 * "never tell me about this" is always honoured.
 */
export function decideDelivery(
  prefs: NotificationPreferences,
  event: NotificationEvent,
  at: Date,
  opts: { urgent?: boolean } = {},
): DeliveryDecision {
  const mode = modeFor(prefs, event);
  if (mode === "none") return { push: false, email: false, reason: "event set to none" };

  const quiet = !opts.urgent && isQuietHours(prefs, at);
  if (quiet) return { push: false, email: false, reason: "quiet hours" };

  const push = prefs.pushEnabled && (mode === "both" || mode === "push");
  const email = prefs.emailEnabled && (mode === "both" || mode === "email");
  if (!push && !email) return { push, email, reason: "both channels disabled" };
  return { push, email };
}

/**
 * Is a digest due for this person right now?
 *
 * Called by a sweep that runs far more often than the digest itself, so it must
 * be idempotent: `lastSentAt` is compared on the NZ CALENDAR DAY, not on an
 * elapsed-hours arithmetic. Two sweeps in the same hour must never send twice,
 * and a sweep that is late (server restart, slow queue) must still send rather
 * than skip the day entirely.
 */
export function dailyDigestDue(
  prefs: NotificationPreferences,
  lastSentAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!prefs.dailyDigest) return false;
  if (nzHour(now) < clampHour(prefs.dailyDigestHour)) return false;
  if (!lastSentAt) return true;
  return nzDateKey(lastSentAt) !== nzDateKey(now);
}

export function weeklyDigestDue(
  prefs: NotificationPreferences,
  lastSentAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!prefs.weeklyDigest) return false;
  if (nzWeekday(now) !== clampWeekday(prefs.weeklyDigestDay)) return false;
  if (nzHour(now) < clampHour(prefs.weeklyDigestHour)) return false;
  if (!lastSentAt) return true;
  // Same NZ day → already sent this week's edition.
  return nzDateKey(lastSentAt) !== nzDateKey(now);
}

function clampWeekday(d: number): number {
  if (!Number.isFinite(d)) return 1;
  const n = Math.trunc(d);
  return n < 1 || n > 7 ? 1 : n;
}

// ── Notification presentation ────────────────────────────────────────────────
// iOS renders: [icon] APP NAME · time / **title** / subtitle / body.
// "ClubOS" comes free from the app itself, so title carries WHO and subtitle
// carries WHERE — the shape WhatsApp and Slack both use.

export interface PushPresentation {
  title: string;
  subtitle?: string;
  body: string;
  /** iOS groups notifications sharing a threadId; Android uses `channelId`. */
  threadId?: string;
  androidChannelId: string;
}

/**
 * Build the on-screen shape of a chat push.
 *
 * NOTE: staff chat channels are deliberately NOT org-scoped (one chat across
 * every workspace), so there is no organisation to put in the subtitle — the
 * channel name is the location. A DM says "Direct message" rather than naming
 * the sender twice.
 */
export function chatPushPresentation(opts: {
  senderName: string;
  channelKind: "channel" | "dm";
  channelName: string | null;
  channelId: number;
  body: string;
  showPreview: boolean;
  mentioned: boolean;
}): PushPresentation {
  const isDm = opts.channelKind === "dm";
  const where = isDm ? "Direct message" : `#${opts.channelName ?? "channel"}`;
  const subtitle = opts.mentioned && !isDm ? `${where} · mentioned you` : where;
  return {
    title: opts.senderName,
    subtitle,
    // Preview off still tells them something arrived and from where — a silent
    // badge with no text is the thing people find most annoying about a locked
    // phone, and it is what makes them turn notifications off entirely.
    body: opts.showPreview ? truncateForPush(opts.body) : "New message",
    threadId: `chat-${opts.channelId}`,
    androidChannelId: isDm ? "chat-dm" : "chat",
  };
}

/**
 * Push bodies are truncated by the OS anyway, but sending 8,000 characters to
 * Expo for a two-line banner wastes the payload budget (Expo caps at 4KB).
 */
export function truncateForPush(body: string, max = 178): string {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New message";
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

// ── Android notification channels ────────────────────────────────────────────
// Android routes every notification through a channel, and the channel — not
// the payload — owns the sound, the vibration and whether it appears as a
// heads-up banner. Get these wrong and notifications arrive silently with no
// error anywhere. They are created once, on the device, at app start.
export interface AndroidChannelSpec {
  id: string;
  name: string;
  description: string;
  /** MAX shows a heads-up banner; DEFAULT only lands in the shade. */
  importance: "max" | "high" | "default";
  sound: boolean;
  vibrate: boolean;
}

export const ANDROID_CHANNELS: readonly AndroidChannelSpec[] = [
  {
    id: "chat-dm",
    name: "Direct messages",
    description: "Someone messages you directly.",
    importance: "max",
    sound: true,
    vibrate: true,
  },
  {
    id: "chat",
    name: "Channel messages",
    description: "Mentions, and channels you've set to notify on every message.",
    importance: "high",
    sound: true,
    vibrate: true,
  },
  {
    id: "tasks",
    name: "Tasks",
    description: "Work assigned to you, and due-date reminders.",
    importance: "high",
    sound: true,
    vibrate: false,
  },
  {
    id: "digest",
    name: "Digests",
    description: "Your daily and weekly summaries.",
    importance: "default",
    sound: false,
    vibrate: false,
  },
];

// ── Labels for the settings UI (shared web + mobile so they never drift) ──────
export const EVENT_LABELS: Record<NotificationEvent, { title: string; help: string }> = {
  chat_dm: {
    title: "Direct messages",
    help: "When someone messages you one-to-one.",
  },
  chat_mention: {
    title: "Mentions",
    help: "When someone @mentions you in a channel.",
  },
  chat_channel: {
    title: "Channels set to 'all'",
    help: "Every message in a channel you've chosen to follow closely.",
  },
  task_assigned: {
    title: "Tasks assigned to me",
    help: "When someone makes you the owner of a task.",
  },
  task_due: {
    title: "Task reminders",
    help: "When something you own is due or overdue.",
  },
};

export const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  both: "Push + email",
  push: "Push only",
  email: "Email only",
  none: "Off",
};

/** Coerce anything off the wire into a valid preferences object. */
export function normalizePreferences(raw: Partial<NotificationPreferences> | null | undefined): NotificationPreferences {
  const p = { ...DEFAULT_PREFERENCES, ...(raw ?? {}) };
  const mode = (v: unknown, fallback: DeliveryMode): DeliveryMode =>
    DELIVERY_MODES.includes(v as DeliveryMode) ? (v as DeliveryMode) : fallback;
  return {
    pushEnabled: !!p.pushEnabled,
    emailEnabled: !!p.emailEnabled,
    chatDm: mode(p.chatDm, DEFAULT_PREFERENCES.chatDm),
    chatMention: mode(p.chatMention, DEFAULT_PREFERENCES.chatMention),
    chatChannel: mode(p.chatChannel, DEFAULT_PREFERENCES.chatChannel),
    taskAssigned: mode(p.taskAssigned, DEFAULT_PREFERENCES.taskAssigned),
    taskDue: mode(p.taskDue, DEFAULT_PREFERENCES.taskDue),
    showPreview: !!p.showPreview,
    quietHoursEnabled: !!p.quietHoursEnabled,
    quietHoursStart: clampHour(p.quietHoursStart),
    quietHoursEnd: clampHour(p.quietHoursEnd),
    dailyDigest: !!p.dailyDigest,
    dailyDigestHour: clampHour(p.dailyDigestHour),
    weeklyDigest: !!p.weeklyDigest,
    weeklyDigestDay: clampWeekday(p.weeklyDigestDay),
    weeklyDigestHour: clampHour(p.weeklyDigestHour),
  };
}
