// ─────────────────────────────────────────────────────────────────────────────
// Notifications — the delivery engine.
//
// ONE place decides whether a notification leaves the building (`decideDelivery`
// in shared/notifications.ts), and one place knows how to reach a person
// (`deliverToUser` below). Every feature that wants to notify somebody goes
// through here, so a new feature cannot forget the master switches, quiet hours
// or the "is this person already looking at it" check.
//
// 🔴 THE RULE THAT MATTERS MOST: `staffTokensFor()` filters on
// `app = 'clubos-staff'`. The device_push_tokens table also holds anonymous CIC
// Youth FAN devices. An unfiltered query here would push internal staff chat to
// every parent who installed the tournament app — a data breach with a single
// missing WHERE clause.
// ─────────────────────────────────────────────────────────────────────────────
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "./db";
import { devicePushTokens, notificationPreferences, users as usersTable } from "@shared/schema";
import {
  DEFAULT_PREFERENCES,
  type NotificationPreferences,
  type NotificationEvent,
  decideDelivery,
  normalizePreferences,
  chatPushPresentation,
} from "@shared/notifications";
import { sendExpoPushBatch, disableTokens, type PushPayload } from "./push";

/** The app key that separates staff phones from anonymous CIC fan devices. */
export const STAFF_PUSH_APP = "clubos-staff";

// ── Preferences ──────────────────────────────────────────────────────────────

function rowToPrefs(row: typeof notificationPreferences.$inferSelect | undefined): NotificationPreferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  return normalizePreferences({
    pushEnabled: row.pushEnabled,
    emailEnabled: row.emailEnabled,
    chatDm: row.chatDm as any,
    chatMention: row.chatMention as any,
    chatChannel: row.chatChannel as any,
    taskAssigned: row.taskAssigned as any,
    taskDue: row.taskDue as any,
    showPreview: row.showPreview,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    dailyDigest: row.dailyDigest,
    dailyDigestHour: row.dailyDigestHour,
    weeklyDigest: row.weeklyDigest,
    weeklyDigestDay: row.weeklyDigestDay,
    weeklyDigestHour: row.weeklyDigestHour,
  });
}

/** A person's settings, or the defaults if they've never opened the screen. */
export async function getPreferences(userId: number): Promise<NotificationPreferences> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  return rowToPrefs(row);
}

/**
 * Settings for many people at once — one query, not N.
 *
 * Anyone with no row is returned with defaults rather than omitted, so a caller
 * iterating recipients can never accidentally skip the people who have never
 * touched their settings (which, on day one, is everybody).
 */
export async function getPreferencesBulk(userIds: number[]): Promise<Map<number, NotificationPreferences>> {
  const out = new Map<number, NotificationPreferences>();
  const ids = Array.from(new Set(userIds)).filter((n) => Number.isFinite(n));
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, ids));
  const byId = new Map(rows.map((r) => [r.userId, r]));
  for (const id of ids) out.set(id, rowToPrefs(byId.get(id)));
  return out;
}

/** Upsert a partial change. Absent keys keep their stored (or default) value. */
export async function savePreferences(
  userId: number,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const current = await getPreferences(userId);
  const next = normalizePreferences({ ...current, ...patch });
  const values = {
    userId,
    pushEnabled: next.pushEnabled,
    emailEnabled: next.emailEnabled,
    chatDm: next.chatDm,
    chatMention: next.chatMention,
    chatChannel: next.chatChannel,
    taskAssigned: next.taskAssigned,
    taskDue: next.taskDue,
    showPreview: next.showPreview,
    quietHoursEnabled: next.quietHoursEnabled,
    quietHoursStart: next.quietHoursStart,
    quietHoursEnd: next.quietHoursEnd,
    dailyDigest: next.dailyDigest,
    dailyDigestHour: next.dailyDigestHour,
    weeklyDigest: next.weeklyDigest,
    weeklyDigestDay: next.weeklyDigestDay,
    weeklyDigestHour: next.weeklyDigestHour,
    updatedAt: new Date(),
  };
  await db
    .insert(notificationPreferences)
    .values(values)
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: values });
  return next;
}

// ── Devices ──────────────────────────────────────────────────────────────────

export interface StaffDevice {
  id: number;
  token: string;
  userId: number;
}

/**
 * Live staff push tokens for these people.
 *
 * 🔴 The `app = 'clubos-staff'` filter is load-bearing — see the file header.
 * `isNotNull(userId)` is belt-and-braces: a staff-app row should always carry
 * an owner, and one that somehow doesn't must never be swept into a personal
 * send.
 */
export async function staffTokensFor(userIds: number[]): Promise<StaffDevice[]> {
  const ids = Array.from(new Set(userIds)).filter((n) => Number.isFinite(n));
  if (!ids.length) return [];
  const rows = await db
    .select({ id: devicePushTokens.id, token: devicePushTokens.token, userId: devicePushTokens.userId })
    .from(devicePushTokens)
    .where(
      and(
        eq(devicePushTokens.app, STAFF_PUSH_APP),
        eq(devicePushTokens.disabled, false),
        isNotNull(devicePushTokens.userId),
        inArray(devicePushTokens.userId, ids),
      ),
    );
  return rows.filter((r): r is StaffDevice => r.userId !== null);
}

/**
 * Register (or re-claim) a staff device.
 *
 * Upsert on the token because Expo reissues the same token to the same install:
 * re-registering must move ownership rather than fail, or a shared/handed-down
 * phone keeps notifying the previous owner. Also clears `disabled`/`failureCount`
 * — a token we just heard from is alive by definition.
 */
export async function registerStaffDevice(opts: {
  token: string;
  userId: number;
  platform: string;
  deviceName?: string | null;
}): Promise<void> {
  const plat = opts.platform === "ios" || opts.platform === "android" ? opts.platform : "unknown";
  const name = String(opts.deviceName || "").slice(0, 120) || null;
  const set = {
    app: STAFF_PUSH_APP,
    userId: opts.userId,
    platform: plat,
    deviceName: name,
    disabled: false,
    failureCount: 0,
    updatedAt: new Date(),
  };
  await db
    .insert(devicePushTokens)
    .values({ token: opts.token, ...set })
    .onConflictDoUpdate({ target: devicePushTokens.token, set });
}

/** Forget a device — sign-out on a shared phone must stop its notifications. */
export async function unregisterStaffDevice(token: string, userId: number): Promise<void> {
  await db
    .update(devicePushTokens)
    .set({ disabled: true, updatedAt: new Date() })
    .where(and(eq(devicePushTokens.token, token), eq(devicePushTokens.userId, userId)));
}

// ── Badge counts ─────────────────────────────────────────────────────────────

/**
 * The number on the app icon: unread DMs + unread mentions, mirroring
 * `badgeCount()` in the mobile client so the icon and the in-app tab never
 * disagree. Ordinary channel traffic is deliberately excluded — a badge that
 * counts every message in every room is one nobody can ever clear.
 */
export async function badgeCountsFor(userIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = Array.from(new Set(userIds)).filter((n) => Number.isFinite(n));
  if (!ids.length) return out;
  for (const id of ids) out.set(id, 0);

  const rows = await db.execute(sql`
    WITH mem AS (
      SELECT cm.user_id, cm.channel_id, c.kind,
             COALESCE(cm.last_read_at, cm.joined_at) AS since
        FROM staff_channel_members cm
        JOIN staff_channels c ON c.id = cm.channel_id
       WHERE cm.user_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         AND cm.left_at IS NULL
         AND c.archived_at IS NULL
    ),
    dm_unread AS (
      SELECT m.user_id, count(msg.id)::int AS n
        FROM mem m
        JOIN staff_messages msg
          ON msg.channel_id = m.channel_id
         AND msg.created_at > m.since
         AND msg.author_id <> m.user_id
         AND msg.deleted_at IS NULL
       WHERE m.kind = 'dm'
       GROUP BY m.user_id
    ),
    mention_unread AS (
      SELECT m.user_id, count(mn.id)::int AS n
        FROM mem m
        JOIN staff_message_mentions mn
          ON mn.channel_id = m.channel_id
         AND mn.user_id = m.user_id
         AND mn.created_at > m.since
       WHERE m.kind <> 'dm'
       GROUP BY m.user_id
    )
    SELECT u.id AS user_id,
           COALESCE(d.n, 0) + COALESCE(x.n, 0) AS badge
      FROM (SELECT unnest(ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]) AS id) u
      LEFT JOIN dm_unread d ON d.user_id = u.id
      LEFT JOIN mention_unread x ON x.user_id = u.id
  `);

  for (const r of (rows as any).rows ?? []) {
    out.set(Number(r.user_id), Number(r.badge) || 0);
  }
  return out;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface UserPush {
  userId: number;
  payload: PushPayload;
}

/**
 * Fan a per-person payload out to every device those people have.
 *
 * Per-person rather than one shared payload because the badge number differs
 * for each recipient — sending one person's unread count to everybody is how
 * app icons end up showing numbers that mean nothing.
 *
 * Never throws: a notification failing must not fail the action that triggered
 * it. Sending a chat message has to succeed even if Expo is down.
 */
export async function sendPushToUsers(items: UserPush[]): Promise<{ sent: number; failed: number }> {
  if (!items.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  try {
    const devices = await staffTokensFor(items.map((i) => i.userId));
    if (!devices.length) return { sent: 0, failed: 0 };

    const byUser = new Map<number, PushPayload>();
    for (const i of items) byUser.set(i.userId, i.payload);

    const messages = devices
      .map((d) => {
        const payload = byUser.get(d.userId);
        return payload ? { to: d.token, deviceId: d.id, ...payload } : null;
      })
      .filter((m): m is { to: string; deviceId: number } & PushPayload => m !== null);

    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const tickets = await sendExpoPushBatch(
          chunk.map(({ deviceId, ...m }) => m),
        );
        const dead: number[] = [];
        tickets.forEach((t, j) => {
          if (t.status === "ok") sent++;
          else {
            failed++;
            if (t.details?.error === "DeviceNotRegistered") dead.push(chunk[j].deviceId);
          }
        });
        if (dead.length) await disableTokens(dead).catch(() => {});
      } catch (e) {
        failed += chunk.length;
        console.error("[notifications] push batch failed:", e);
      }
    }
  } catch (e) {
    console.error("[notifications] sendPushToUsers failed:", e);
  }
  return { sent, failed };
}

// ── The chat delivery decision, per recipient ────────────────────────────────

export interface ChatRecipient {
  userId: number;
  /** Explicitly @mentioned in this message. */
  mentioned: boolean;
  /** Their notify level for this channel: 'all' | 'mentions' | 'muted'. */
  notifyLevel: string;
  /** Away = no chat heartbeat for 5 minutes. */
  away: boolean;
  /** True when an escalation email was already sent for this channel recently. */
  emailDebounced: boolean;
  email: string | null;
}

export interface ChatDeliveryPlan {
  userId: number;
  push: boolean;
  email: boolean;
  event: NotificationEvent;
}

/**
 * Work out, for one message, who gets a push and who gets an email.
 *
 * The ladder (unchanged from the original chat design, now per-person):
 *   · a MENTION or a DM reaches you wherever you are
 *   · ordinary channel traffic reaches you only if you set that channel to 'all'
 *   · a mention cuts through a MUTED channel — muting a room is not the same as
 *     telling a colleague you don't want to be asked a direct question
 *   · PUSH goes out immediately; EMAIL is the away-escalation only, so somebody
 *     with the app open gets one buzz, not a buzz and an inbox item
 */
export function planChatDelivery(
  recipients: ChatRecipient[],
  prefs: Map<number, NotificationPreferences>,
  isDm: boolean,
  now: Date,
  opts: { urgent?: boolean } = {},
): ChatDeliveryPlan[] {
  const plans: ChatDeliveryPlan[] = [];
  for (const r of recipients) {
    const level = r.notifyLevel;
    const wants = r.mentioned || (isDm && level !== "muted") || (!isDm && level === "all");
    if (!wants) continue;

    const event: NotificationEvent = isDm
      ? "chat_dm"
      : r.mentioned
        ? "chat_mention"
        : "chat_channel";

    const p = prefs.get(r.userId) ?? DEFAULT_PREFERENCES;
    const decision = decideDelivery(p, event, now, opts);
    if (!decision.push && !decision.email) continue;

    // Email is the AWAY escalation — someone actively looking at the app has
    // already seen it. And never twice for the same room inside the debounce.
    const email = decision.email && r.away && !r.emailDebounced && !!r.email;

    if (!decision.push && !email) continue;
    plans.push({ userId: r.userId, push: decision.push, email, event });
  }
  return plans;
}

/** Build the Expo payload for one chat recipient. */
export function chatPayloadFor(opts: {
  senderName: string;
  channelKind: "channel" | "dm";
  channelName: string | null;
  channelId: number;
  messageId: number;
  body: string;
  mentioned: boolean;
  showPreview: boolean;
  badge: number;
}): PushPayload {
  const p = chatPushPresentation({
    senderName: opts.senderName,
    channelKind: opts.channelKind,
    channelName: opts.channelName,
    channelId: opts.channelId,
    body: opts.body,
    showPreview: opts.showPreview,
    mentioned: opts.mentioned,
  });
  return {
    title: p.title,
    subtitle: p.subtitle,
    body: p.body,
    sound: "default",
    badge: opts.badge,
    channelId: p.androidChannelId,
    threadId: p.threadId,
    priority: "high",
    // `url` is what the app's notification-response handler routes on — tapping
    // the banner must land in the conversation, not on the home screen.
    data: {
      kind: "chat",
      url: `/chat/${opts.channelId}`,
      channelId: opts.channelId,
      messageId: opts.messageId,
    },
  };
}

/** Convenience for one-off sends (task assignment, digests, tests). */
export async function notifyUser(
  userId: number,
  event: NotificationEvent,
  payload: Omit<PushPayload, "badge">,
  opts: { urgent?: boolean } = {},
): Promise<{ push: boolean; email: boolean }> {
  const prefs = await getPreferences(userId);
  const decision = decideDelivery(prefs, event, new Date(), opts);
  if (decision.push) {
    const badges = await badgeCountsFor([userId]);
    await sendPushToUsers([
      { userId, payload: { ...payload, badge: badges.get(userId) ?? 0 } },
    ]);
  }
  return { push: decision.push, email: decision.email };
}
