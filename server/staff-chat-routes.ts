// ─────────────────────────────────────────────────────────────────────────────
// Staff Chat — the in-house Slack (replaces the WhatsApp staff groups).
//
// Universal tab (System section, every workspace) → gated by requireAuth ONLY,
// never requireTab — same doctrine as the Feedback board. Any logged-in staff
// member can chat; channel creation / archiving / @channel blasts / must-see
// flags are leadership-gated (super_admin, or admin/manager in any workspace).
//
// Design (from outputs/deep-research/2026-07-22-inhouse-staff-chat/synthesis.md):
//   · channels + DMs, NO threads · unread = per-membership pointer (Campfire)
//   · quiet by default — email escalation only for mentions/DMs/opted-in
//     channels, only when AWAY (no heartbeat for 5 min), never in quiet hours
//     (20:00–08:00 NZ), max one email per channel per 15 min
//   · presence is server-side only (away detection) — no green dots
//   · transport = react-query HTTP polling (two Fly machines share no memory;
//     the DB is the bus — the house pattern)
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import multer from "multer";
import { db } from "./db";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import {
  staffChannels,
  staffChannelMembers,
  staffMessages,
  staffMessageMentions,
  staffMessageReactions,
  staffMessageAcks,
  staffChatPresence,
  users as usersTable,
} from "@shared/schema";
import {
  MESSAGE_MAX_LENGTH,
  TOPIC_MAX,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DM_PARTICIPANTS,
  EDIT_WINDOW_MS,
  UPLOAD_MAX_BYTES,
  STAFF_NOTIFY_LEVELS,
  STAFF_POST_POLICIES,
  type StaffChatAttachment,
  type StaffNotifyLevel,
  dmKeyFor,
  normalizeChannelName,
  hasChannelMention,
  excerpt,
  isAway,
  emailDebounced,
  classifyUpload,
  extensionFor,
} from "@shared/staff-chat";
import { sendStaffChatNotification } from "./email";
import {
  getPreferencesBulk,
  planChatDelivery,
  badgeCountsFor,
  sendPushToUsers,
  chatPayloadFor,
} from "./notifications";

const CHAT_APP_URL = (process.env.APP_URL || "https://app.usg.co.nz").replace(/\/+$/, "");

// Leadership = super_admin globally, OR admin/manager in any workspace.
// Mirrors the Feedback board / global-search "isLeadership" notion.
async function isLeadershipUser(userId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  return (orgs as any[]).some((o) => o.userRole === "admin" || o.userRole === "manager");
}

function fullName(u: { firstName: string | null; lastName: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || "Unknown";
}

async function heartbeat(userId: number): Promise<void> {
  await db
    .insert(staffChatPresence)
    .values({ userId, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: staffChatPresence.userId, set: { lastSeenAt: new Date() } });
}

type MembershipRow = typeof staffChannelMembers.$inferSelect;

async function activeMembership(channelId: number, userId: number): Promise<MembershipRow | undefined> {
  const [m] = await db
    .select()
    .from(staffChannelMembers)
    .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.userId, userId)));
  return m && m.leftAt == null ? m : undefined;
}

/** Join (or re-join) a channel. Upserts the membership row, clearing leftAt. */
async function ensureMember(channelId: number, userId: number, role = "member"): Promise<void> {
  await db
    .insert(staffChannelMembers)
    .values({ channelId, userId, role })
    .onConflictDoUpdate({
      target: [staffChannelMembers.channelId, staffChannelMembers.userId],
      set: { leftAt: null },
    });
}

/** Channel access for reading: member, or any staff for public channels. */
async function canRead(channel: typeof staffChannels.$inferSelect, userId: number): Promise<boolean> {
  if (channel.kind === "channel" && !channel.isPrivate) return true;
  return !!(await activeMembership(channel.id, userId));
}

// ── The channel summary every poll returns ───────────────────────────────────
// One aggregate pass: my channels + unread counts (pointer model) + mention
// counts + DM participant names + browsable public channels I haven't joined.
async function channelSummaryFor(userId: number) {
  const rows = await db
    .select({
      channel: staffChannels,
      member: staffChannelMembers,
    })
    .from(staffChannels)
    .leftJoin(
      staffChannelMembers,
      and(eq(staffChannelMembers.channelId, staffChannels.id), eq(staffChannelMembers.userId, userId)),
    )
    .where(
      sql`(${staffChannelMembers.id} IS NOT NULL AND ${staffChannelMembers.leftAt} IS NULL)
          OR (${staffChannels.kind} = 'channel' AND ${staffChannels.isPrivate} = false AND ${staffChannels.archivedAt} IS NULL)`,
    );

  const joinedIds = rows.filter((r) => r.member && r.member.leftAt == null).map((r) => r.channel.id);

  // Unread counts — everything newer than the pointer, not mine, not deleted.
  const unreadByChannel = new Map<number, number>();
  const mentionsByChannel = new Map<number, number>();
  if (joinedIds.length > 0) {
    const unread = await db.execute(sql`
      SELECT cm.channel_id AS channel_id,
             count(m.id)::int AS unread
      FROM staff_channel_members cm
      JOIN staff_messages m
        ON m.channel_id = cm.channel_id
       AND m.created_at > COALESCE(cm.last_read_at, cm.joined_at)
       AND m.author_id <> cm.user_id
       AND m.deleted_at IS NULL
      WHERE cm.user_id = ${userId} AND cm.left_at IS NULL
      GROUP BY cm.channel_id
    `);
    for (const r of unread.rows as any[]) unreadByChannel.set(Number(r.channel_id), Number(r.unread));

    const mentions = await db.execute(sql`
      SELECT mm.channel_id AS channel_id,
             count(*)::int AS mentions
      FROM staff_message_mentions mm
      JOIN staff_channel_members cm
        ON cm.channel_id = mm.channel_id AND cm.user_id = mm.user_id AND cm.left_at IS NULL
      JOIN staff_messages m ON m.id = mm.message_id AND m.deleted_at IS NULL
      WHERE mm.user_id = ${userId}
        AND mm.created_at > COALESCE(cm.last_read_at, cm.joined_at)
      GROUP BY mm.channel_id
    `);
    for (const r of mentions.rows as any[]) mentionsByChannel.set(Number(r.channel_id), Number(r.mentions));
  }

  // Participant names for my DMs (renders "Ryan Edwards" instead of "dm #12").
  const dmIds = rows.filter((r) => r.channel.kind === "dm" && r.member && r.member.leftAt == null).map((r) => r.channel.id);
  const dmMembers = new Map<number, { userId: number; name: string }[]>();
  if (dmIds.length > 0) {
    const mems = await db
      .select({
        channelId: staffChannelMembers.channelId,
        userId: staffChannelMembers.userId,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
      })
      .from(staffChannelMembers)
      .innerJoin(usersTable, eq(usersTable.id, staffChannelMembers.userId))
      .where(and(inArray(staffChannelMembers.channelId, dmIds), isNull(staffChannelMembers.leftAt)));
    for (const m of mems) {
      const list = dmMembers.get(m.channelId) ?? [];
      list.push({ userId: m.userId, name: fullName(m) });
      dmMembers.set(m.channelId, list);
    }
  }

  return rows
    .map((r) => {
      const joined = !!(r.member && r.member.leftAt == null);
      return {
        id: r.channel.id,
        kind: r.channel.kind,
        name: r.channel.name,
        topic: r.channel.topic,
        isPrivate: r.channel.isPrivate,
        isDefault: r.channel.isDefault,
        postPolicy: r.channel.postPolicy,
        archived: r.channel.archivedAt != null,
        lastMessageAt: r.channel.lastMessageAt,
        createdAt: r.channel.createdAt,
        joined,
        notifyLevel: joined ? (r.member!.notifyLevel as StaffNotifyLevel) : null,
        lastReadAt: joined ? r.member!.lastReadAt : null,
        unread: unreadByChannel.get(r.channel.id) ?? 0,
        mentions: mentionsByChannel.get(r.channel.id) ?? 0,
        members: r.channel.kind === "dm" ? (dmMembers.get(r.channel.id) ?? []) : undefined,
      };
    })
    .sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    });
}

// ── Escalation: push + away-email ────────────────────────────────────────────
// Fire-and-forget after a send. Recipients: explicitly mentioned members +
// everyone in a DM + members who opted a channel to 'all'. Mentions cut through
// a muted channel (a personal ping is personal); plain 'all' traffic doesn't.
//
// The ladder, now that phones are in play:
//   PUSH  — immediate, to everyone whose preferences allow it. This is the
//           primary channel; it is what makes the app usable as staff comms.
//   EMAIL — the AWAY escalation only (no chat heartbeat for 5 min), one per
//           channel per 15 min. Somebody with the app open gets a single buzz,
//           never a buzz AND an inbox item.
//
// 🔴 Quiet hours are now PER PERSON (server default 20:00–08:00 NZ, the club-
// wide rule this used to hard-code for everybody). The early global return is
// gone deliberately — decideDelivery() applies each recipient's own window, so
// a night-shift staffer can opt in without lifting the curfew for the club.
// In-app badges are never suppressed by any of this.
async function escalateMessage(opts: {
  channel: typeof staffChannels.$inferSelect;
  messageId: number;
  authorId: number;
  authorName: string;
  body: string;
  mentionedUserIds: Set<number>;
  /**
   * Leadership "must-see" message. The ONLY thing that overrides quiet hours —
   * and it still cannot override someone setting an event to 'none', because an
   * explicit "never tell me about this" is a decision, not a preference to
   * route around.
   */
  requiresAck?: boolean;
}): Promise<void> {
  try {
    const now = new Date();

    const members = await db
      .select({ member: staffChannelMembers, user: usersTable, presence: staffChatPresence })
      .from(staffChannelMembers)
      .innerJoin(usersTable, eq(usersTable.id, staffChannelMembers.userId))
      .leftJoin(staffChatPresence, eq(staffChatPresence.userId, staffChannelMembers.userId))
      .where(and(eq(staffChannelMembers.channelId, opts.channel.id), isNull(staffChannelMembers.leftAt)));

    const isDm = opts.channel.kind === "dm";
    const context = isDm ? `a direct message` : `#${opts.channel.name}`;

    // Candidates: everyone in the room except the author and inactive accounts.
    // A member with no email address can still receive PUSH — the old code
    // skipped them entirely because email was the only channel that existed.
    const candidates = members.filter(
      (r) => r.user.id !== opts.authorId && r.user.active,
    );
    if (!candidates.length) return;

    const prefs = await getPreferencesBulk(candidates.map((r) => r.user.id));
    const plans = planChatDelivery(
      candidates.map((r) => ({
        userId: r.user.id,
        mentioned: opts.mentionedUserIds.has(r.user.id),
        notifyLevel: r.member.notifyLevel as StaffNotifyLevel,
        away: isAway(r.presence?.lastSeenAt ?? null, now),
        emailDebounced: emailDebounced(r.member.lastEmailedAt, now),
        email: r.user.email ?? null,
      })),
      prefs,
      isDm,
      now,
      { urgent: opts.requiresAck },
    );
    if (!plans.length) return;

    const byId = new Map(candidates.map((r) => [r.user.id, r]));

    // ── Push ────────────────────────────────────────────────────────────────
    // Badges are fetched for all push recipients in one query, then each person
    // gets THEIR OWN number — one shared count would show everybody the same
    // meaningless figure.
    const pushIds = plans.filter((p) => p.push).map((p) => p.userId);
    if (pushIds.length) {
      const badges = await badgeCountsFor(pushIds);
      await sendPushToUsers(
        pushIds.map((userId) => ({
          userId,
          payload: chatPayloadFor({
            senderName: opts.authorName,
            channelKind: isDm ? "dm" : "channel",
            channelName: opts.channel.name,
            channelId: opts.channel.id,
            messageId: opts.messageId,
            body: opts.body,
            mentioned: opts.mentionedUserIds.has(userId),
            showPreview: prefs.get(userId)?.showPreview ?? true,
            // The message being delivered is not in the badge query's result
            // yet only if the read pointer moved between the two — counting it
            // explicitly would double it. Trust the query.
            badge: badges.get(userId) ?? 0,
          }),
        })),
      );
    }

    // ── Away email ──────────────────────────────────────────────────────────
    for (const plan of plans) {
      if (!plan.email) continue;
      const row = byId.get(plan.userId);
      if (!row?.user.email) continue;
      const sent = await sendStaffChatNotification({
        to: row.user.email,
        recipientName: row.user.firstName || fullName(row.user),
        senderName: opts.authorName,
        context,
        messageExcerpt: excerpt(opts.body, 200),
        mentioned: opts.mentionedUserIds.has(plan.userId) && !isDm,
        chatUrl: `${CHAT_APP_URL}/admin/chat?c=${opts.channel.id}`,
      }).catch((e) => {
        console.error("[staff-chat] escalation email failed:", e);
        return false;
      });
      if (sent) {
        await db
          .update(staffChannelMembers)
          .set({ lastEmailedAt: now })
          .where(eq(staffChannelMembers.id, row.member.id));
      }
    }
  } catch (e) {
    console.error("[staff-chat] escalation failed:", e);
  }
}

// ── Message page hydration (reactions / acks / mentions, batched) ────────────
async function hydrateMessages(msgIds: number[], viewerId: number) {
  const reactions = new Map<number, { emoji: string; userIds: number[] }[]>();
  const ackCounts = new Map<number, number>();
  const myAcks = new Set<number>();
  const mentionIds = new Map<number, number[]>();
  if (msgIds.length === 0) return { reactions, ackCounts, myAcks, mentionIds };

  const rx = await db
    .select()
    .from(staffMessageReactions)
    .where(inArray(staffMessageReactions.messageId, msgIds))
    .orderBy(asc(staffMessageReactions.id));
  for (const r of rx) {
    const list = reactions.get(r.messageId) ?? [];
    const found = list.find((x) => x.emoji === r.emoji);
    if (found) found.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
    reactions.set(r.messageId, list);
  }

  const acks = await db
    .select({ messageId: staffMessageAcks.messageId, userId: staffMessageAcks.userId })
    .from(staffMessageAcks)
    .where(inArray(staffMessageAcks.messageId, msgIds));
  for (const a of acks) {
    ackCounts.set(a.messageId, (ackCounts.get(a.messageId) ?? 0) + 1);
    if (a.userId === viewerId) myAcks.add(a.messageId);
  }

  const mens = await db
    .select({ messageId: staffMessageMentions.messageId, userId: staffMessageMentions.userId })
    .from(staffMessageMentions)
    .where(inArray(staffMessageMentions.messageId, msgIds));
  for (const m of mens) {
    const list = mentionIds.get(m.messageId) ?? [];
    list.push(m.userId);
    mentionIds.set(m.messageId, list);
  }

  return { reactions, ackCounts, myAcks, mentionIds };
}

function shapeMessage(
  m: typeof staffMessages.$inferSelect,
  author: { firstName: string | null; lastName: string | null } | null,
  h: Awaited<ReturnType<typeof hydrateMessages>>,
) {
  const deleted = m.deletedAt != null;
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorId,
    authorName: author ? fullName(author) : "Unknown",
    body: deleted ? "" : m.body,
    attachments: deleted ? null : (m.attachments as StaffChatAttachment[] | null),
    clientMessageId: m.clientMessageId,
    requiresAck: m.requiresAck,
    editedAt: m.editedAt,
    deleted,
    createdAt: m.createdAt,
    reactions: h.reactions.get(m.id) ?? [],
    ackCount: h.ackCounts.get(m.id) ?? 0,
    ackedByMe: h.myAcks.has(m.id),
    mentionedUserIds: h.mentionIds.get(m.id) ?? [],
  };
}

const chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });

export function registerStaffChatRoutes(app: Express) {
  // ── Bootstrap: viewer + directory + channels. Also lazily auto-joins the
  //    default channels so day one needs zero setup. ─────────────────────────
  app.get("/api/admin/chat/bootstrap", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const [leadership] = await Promise.all([isLeadershipUser(userId), heartbeat(userId)]);

      const defaults = await db
        .select({ id: staffChannels.id })
        .from(staffChannels)
        .where(and(eq(staffChannels.isDefault, true), isNull(staffChannels.archivedAt)));
      for (const d of defaults) {
        await db
          .insert(staffChannelMembers)
          .values({ channelId: d.id, userId })
          .onConflictDoNothing();
      }

      const directory = await db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
          role: usersTable.role,
        })
        .from(usersTable)
        .where(eq(usersTable.active, true))
        .orderBy(asc(usersTable.firstName));

      const channels = await channelSummaryFor(userId);
      res.json({
        viewer: { userId, isLeadership: leadership },
        users: directory.map((u) => ({ ...u, name: fullName(u) })),
        channels,
      });
    } catch (e: any) {
      console.error("[staff-chat] bootstrap failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Sync poll: channel list + unread/mention counts. Doubles as the
  //    presence heartbeat ("active" = polled within 5 min). ──────────────────
  app.get("/api/admin/chat/sync", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      await heartbeat(userId);
      res.json({ channels: await channelSummaryFor(userId) });
    } catch (e: any) {
      console.error("[staff-chat] sync failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Message history: keyset-paginated, newest page first. ──────────────────
  app.get("/api/admin/chat/channels/:id/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Bad channel id" });
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel) return res.status(404).json({ message: "Channel not found" });
      if (!(await canRead(channel, userId))) return res.status(403).json({ message: "Not a member of this conversation" });

      const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);

      const where = before
        ? and(eq(staffMessages.channelId, channelId), sql`${staffMessages.id} < ${before}`)
        : eq(staffMessages.channelId, channelId);
      const page = await db
        .select({ message: staffMessages, author: { firstName: usersTable.firstName, lastName: usersTable.lastName } })
        .from(staffMessages)
        .leftJoin(usersTable, eq(usersTable.id, staffMessages.authorId))
        .where(where)
        .orderBy(desc(staffMessages.id))
        .limit(limit);

      const h = await hydrateMessages(page.map((p) => p.message.id), userId);
      const messages = page.map((p) => shapeMessage(p.message, p.author, h)).reverse();

      const members = await db
        .select({
          userId: staffChannelMembers.userId,
          role: staffChannelMembers.role,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
        })
        .from(staffChannelMembers)
        .innerJoin(usersTable, eq(usersTable.id, staffChannelMembers.userId))
        .where(and(eq(staffChannelMembers.channelId, channelId), isNull(staffChannelMembers.leftAt)));

      res.json({
        channel: {
          id: channel.id,
          kind: channel.kind,
          name: channel.name,
          topic: channel.topic,
          isPrivate: channel.isPrivate,
          isDefault: channel.isDefault,
          postPolicy: channel.postPolicy,
          archived: channel.archivedAt != null,
        },
        members: members.map((m) => ({ userId: m.userId, role: m.role, name: fullName(m) })),
        messages,
        hasMore: page.length === limit,
      });
    } catch (e: any) {
      console.error("[staff-chat] history failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Send. Idempotent on (channel, author, clientMessageId). ────────────────
  app.post("/api/admin/chat/channels/:id/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Bad channel id" });
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel) return res.status(404).json({ message: "Channel not found" });
      if (channel.archivedAt) return res.status(400).json({ message: "This channel is archived" });

      let membership = await activeMembership(channelId, userId);
      if (!membership) {
        if (channel.kind === "channel" && !channel.isPrivate) {
          await ensureMember(channelId, userId); // posting in a public channel joins it
          membership = await activeMembership(channelId, userId);
        } else {
          return res.status(403).json({ message: "Not a member of this conversation" });
        }
      }

      const leadership = await isLeadershipUser(userId);
      if (channel.postPolicy === "leadership" && !leadership) {
        return res.status(403).json({ message: "Only leadership can post in this channel" });
      }

      const body = typeof req.body?.body === "string" ? req.body.body.slice(0, MESSAGE_MAX_LENGTH).trimEnd() : "";
      const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      const attachments: StaffChatAttachment[] = rawAttachments
        .filter(
          (a: any) =>
            a && typeof a.url === "string" && a.url.startsWith("/objects/") &&
            typeof a.name === "string" && typeof a.contentType === "string" &&
            ["image", "voice", "file"].includes(a.kind),
        )
        .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
        .map((a: any) => ({
          url: a.url,
          name: String(a.name).slice(0, 200),
          contentType: String(a.contentType).slice(0, 100),
          size: Number(a.size) || 0,
          kind: a.kind,
          ...(a.kind === "voice" && Number.isFinite(a.durationSec) ? { durationSec: Math.round(a.durationSec) } : {}),
        }));
      if (!body && attachments.length === 0) return res.status(400).json({ message: "Empty message" });

      const clientMessageId =
        typeof req.body?.clientMessageId === "string" && req.body.clientMessageId.trim()
          ? req.body.clientMessageId.trim().slice(0, 64)
          : null;
      const requiresAck = req.body?.requiresAck === true && leadership && channel.kind === "channel";

      let [created] = await db
        .insert(staffMessages)
        .values({
          channelId,
          authorId: userId,
          body,
          attachments: attachments.length ? attachments : null,
          clientMessageId,
          requiresAck,
        })
        .onConflictDoNothing()
        .returning();

      let isRetry = false;
      if (!created && clientMessageId) {
        // Retry of a send that already landed — return the original (idempotent).
        isRetry = true;
        [created] = await db
          .select()
          .from(staffMessages)
          .where(
            and(
              eq(staffMessages.channelId, channelId),
              eq(staffMessages.authorId, userId),
              eq(staffMessages.clientMessageId, clientMessageId),
            ),
          );
      }
      if (!created) return res.status(500).json({ message: "Send failed" });

      if (!isRetry) {
        await db.update(staffChannels).set({ lastMessageAt: created.createdAt }).where(eq(staffChannels.id, channelId));
        // Sending implies having read the room.
        await db
          .update(staffChannelMembers)
          .set({ lastReadAt: created.createdAt })
          .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.userId, userId)));

        // Mentions: explicit ids from the composer, validated against current
        // members; @channel (leadership only) fans out to the whole room.
        const memberRows = await db
          .select({ userId: staffChannelMembers.userId })
          .from(staffChannelMembers)
          .where(and(eq(staffChannelMembers.channelId, channelId), isNull(staffChannelMembers.leftAt)));
        const memberIds = new Set(memberRows.map((m) => m.userId));

        const explicit: number[] = Array.isArray(req.body?.mentionUserIds)
          ? req.body.mentionUserIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
          : [];
        const mentioned = new Set<number>(explicit.filter((id) => memberIds.has(id) && id !== userId));
        let channelBlast = false;
        if (body && hasChannelMention(body) && leadership && channel.kind === "channel") {
          channelBlast = true;
          Array.from(memberIds).forEach((id) => id !== userId && mentioned.add(id));
        }
        if (mentioned.size > 0) {
          await db
            .insert(staffMessageMentions)
            .values(
              Array.from(mentioned).map((id) => ({
                messageId: created.id,
                channelId,
                userId: id,
                kind: channelBlast && !explicit.includes(id) ? "channel" : "user",
              })),
            )
            .onConflictDoNothing();
        }

        const me = await storage.getUser(userId);
        const authorName = me ? fullName(me) : "Someone";
        setImmediate(() =>
          escalateMessage({
            channel,
            messageId: created.id,
            authorId: userId,
            authorName,
            body: body || (attachments[0]?.kind === "voice" ? "🎤 Voice note" : `📎 ${attachments[0]?.name ?? "Attachment"}`),
            mentionedUserIds: mentioned,
            requiresAck,
          }),
        );
      }

      const me = await storage.getUser(userId);
      const h = await hydrateMessages([created.id], userId);
      res.status(isRetry ? 200 : 201).json(shapeMessage(created, me ?? null, h));
    } catch (e: any) {
      console.error("[staff-chat] send failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Mark a conversation read (advance the pointer). ────────────────────────
  app.post("/api/admin/chat/channels/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Bad channel id" });
      await db
        .update(staffChannelMembers)
        .set({ lastReadAt: new Date() })
        .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.userId, userId)));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Create a channel (leadership — channel sprawl is governed from day one).
  app.post("/api/admin/chat/channels", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      if (!(await isLeadershipUser(userId))) {
        return res.status(403).json({ message: "Ask a manager to create new channels" });
      }
      const name = normalizeChannelName(String(req.body?.name ?? ""));
      if (!name) return res.status(400).json({ message: "Channel needs a name" });
      const topic = typeof req.body?.topic === "string" ? req.body.topic.slice(0, TOPIC_MAX).trim() || null : null;
      const isPrivate = req.body?.isPrivate === true;
      const postPolicy = STAFF_POST_POLICIES.includes(req.body?.postPolicy) ? req.body.postPolicy : "anyone";

      const [dupe] = await db
        .select({ id: staffChannels.id })
        .from(staffChannels)
        .where(
          and(
            eq(staffChannels.kind, "channel"),
            isNull(staffChannels.archivedAt),
            sql`lower(${staffChannels.name}) = ${name}`,
          ),
        );
      if (dupe) return res.status(409).json({ message: `#${name} already exists` });

      const [channel] = await db
        .insert(staffChannels)
        .values({ kind: "channel", name, topic, isPrivate, postPolicy, createdBy: userId })
        .returning();
      await ensureMember(channel.id, userId, "owner");
      res.status(201).json({ id: channel.id });
    } catch (e: any) {
      console.error("[staff-chat] create channel failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Edit channel details / archive / unarchive (leadership). ───────────────
  app.patch("/api/admin/chat/channels/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Bad channel id" });
      if (!(await isLeadershipUser(userId))) return res.status(403).json({ message: "Managers only" });
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel || channel.kind !== "channel") return res.status(404).json({ message: "Channel not found" });

      const patch: Record<string, any> = {};
      if (req.body.topic !== undefined)
        patch.topic = typeof req.body.topic === "string" ? req.body.topic.slice(0, TOPIC_MAX).trim() || null : null;
      if (req.body.name !== undefined) {
        const name = normalizeChannelName(String(req.body.name));
        if (!name) return res.status(400).json({ message: "Channel needs a name" });
        patch.name = name;
      }
      if (req.body.postPolicy !== undefined && STAFF_POST_POLICIES.includes(req.body.postPolicy))
        patch.postPolicy = req.body.postPolicy;
      if (req.body.archived === true) patch.archivedAt = new Date();
      if (req.body.archived === false) patch.archivedAt = null;
      if (Object.keys(patch).length === 0) return res.status(400).json({ message: "Nothing to change" });

      await db.update(staffChannels).set(patch).where(eq(staffChannels.id, channelId));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Join / leave a public channel. ─────────────────────────────────────────
  app.post("/api/admin/chat/channels/:id/join", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel || channel.kind !== "channel" || channel.archivedAt)
        return res.status(404).json({ message: "Channel not found" });
      if (channel.isPrivate) return res.status(403).json({ message: "This channel is invite-only" });
      await ensureMember(channelId, userId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/chat/channels/:id/leave", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel) return res.status(404).json({ message: "Channel not found" });
      if (channel.isDefault) return res.status(400).json({ message: "Everyone stays in the default channels" });
      await db
        .update(staffChannelMembers)
        .set({ leftAt: new Date() })
        .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.userId, userId)));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Add members (any current member can bring people in). ──────────────────
  app.post("/api/admin/chat/channels/:id/members", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel || channel.kind !== "channel") return res.status(404).json({ message: "Channel not found" });
      const isMember = !!(await activeMembership(channelId, userId));
      if (!isMember && !(await isLeadershipUser(userId))) return res.status(403).json({ message: "Members only" });

      const ids: number[] = Array.isArray(req.body?.userIds)
        ? req.body.userIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
        : [];
      if (ids.length === 0) return res.status(400).json({ message: "Pick at least one person" });
      const valid = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(inArray(usersTable.id, ids), eq(usersTable.active, true)));
      for (const u of valid) await ensureMember(channelId, u.id);
      res.json({ ok: true, added: valid.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Per-channel notification level (own membership). ───────────────────────
  app.post("/api/admin/chat/channels/:id/notify", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const channelId = parseInt(String(req.params.id), 10);
      const level = req.body?.level;
      if (!STAFF_NOTIFY_LEVELS.includes(level)) return res.status(400).json({ message: "Bad level" });
      await db
        .update(staffChannelMembers)
        .set({ notifyLevel: level })
        .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.userId, userId)));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Open (find-or-create) a DM. Same people → same conversation, always. ───
  app.post("/api/admin/chat/dms", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const others: number[] = Array.isArray(req.body?.userIds)
        ? Array.from(
            new Set(req.body.userIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n !== userId)),
          )
        : [];
      if (others.length === 0) return res.status(400).json({ message: "Pick at least one person" });
      if (others.length > MAX_DM_PARTICIPANTS - 1)
        return res.status(400).json({ message: `A group message tops out at ${MAX_DM_PARTICIPANTS} people` });

      const valid = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(inArray(usersTable.id, others), eq(usersTable.active, true)));
      if (valid.length !== others.length) return res.status(400).json({ message: "Unknown person in the list" });

      const key = dmKeyFor([userId, ...others]);
      let [dm] = await db.select().from(staffChannels).where(eq(staffChannels.dmKey, key));
      if (!dm) {
        [dm] = await db
          .insert(staffChannels)
          .values({ kind: "dm", dmKey: key, createdBy: userId })
          .onConflictDoNothing()
          .returning();
        if (!dm) [dm] = await db.select().from(staffChannels).where(eq(staffChannels.dmKey, key)); // lost a race — fine
      }
      for (const id of [userId, ...others]) await ensureMember(dm.id, id);
      res.status(201).json({ id: dm.id });
    } catch (e: any) {
      console.error("[staff-chat] dm open failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Edit own message (1-hour window). ──────────────────────────────────────
  app.patch("/api/admin/chat/messages/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      const [msg] = await db.select().from(staffMessages).where(eq(staffMessages.id, id));
      if (!msg || msg.deletedAt) return res.status(404).json({ message: "Message not found" });
      if (msg.authorId !== userId) return res.status(403).json({ message: "You can only edit your own messages" });
      if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS)
        return res.status(400).json({ message: "Edit window has closed (1 hour)" });
      const body = typeof req.body?.body === "string" ? req.body.body.slice(0, MESSAGE_MAX_LENGTH).trimEnd() : "";
      if (!body && !msg.attachments) return res.status(400).json({ message: "Message can't be empty" });
      await db.update(staffMessages).set({ body, editedAt: new Date() }).where(eq(staffMessages.id, id));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Delete (soft): author, or leadership moderating. Body is blanked so the
  //    content is really gone; the stub keeps history honest. ─────────────────
  app.delete("/api/admin/chat/messages/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      const [msg] = await db.select().from(staffMessages).where(eq(staffMessages.id, id));
      if (!msg || msg.deletedAt) return res.status(404).json({ message: "Message not found" });
      if (msg.authorId !== userId && !(await isLeadershipUser(userId)))
        return res.status(403).json({ message: "You can only delete your own messages" });
      await db
        .update(staffMessages)
        .set({ deletedAt: new Date(), body: "", attachments: null })
        .where(eq(staffMessages.id, id));
      await db.delete(staffMessageMentions).where(eq(staffMessageMentions.messageId, id)); // no ghost badges
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Toggle an emoji reaction. ──────────────────────────────────────────────
  app.post("/api/admin/chat/messages/:id/reactions", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.slice(0, 16) : "";
      if (!emoji) return res.status(400).json({ message: "Bad emoji" });
      const [msg] = await db.select().from(staffMessages).where(eq(staffMessages.id, id));
      if (!msg || msg.deletedAt) return res.status(404).json({ message: "Message not found" });
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, msg.channelId));
      if (!channel || !(await canRead(channel, userId))) return res.status(403).json({ message: "Not your conversation" });

      const existing = await db
        .select({ id: staffMessageReactions.id })
        .from(staffMessageReactions)
        .where(
          and(
            eq(staffMessageReactions.messageId, id),
            eq(staffMessageReactions.userId, userId),
            eq(staffMessageReactions.emoji, emoji),
          ),
        );
      if (existing.length > 0) {
        await db.delete(staffMessageReactions).where(eq(staffMessageReactions.id, existing[0].id));
      } else {
        await db.insert(staffMessageReactions).values({ messageId: id, userId, emoji }).onConflictDoNothing();
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Acknowledge a must-see message ("Confirm you've seen this"). ───────────
  app.post("/api/admin/chat/messages/:id/ack", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      const [msg] = await db.select().from(staffMessages).where(eq(staffMessages.id, id));
      if (!msg || msg.deletedAt || !msg.requiresAck) return res.status(404).json({ message: "Message not found" });
      await db.insert(staffMessageAcks).values({ messageId: id, userId }).onConflictDoNothing();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Who has (and hasn't) confirmed — the roster view WhatsApp can't do. ────
  app.get("/api/admin/chat/messages/:id/acks", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      const [msg] = await db.select().from(staffMessages).where(eq(staffMessages.id, id));
      if (!msg || !msg.requiresAck) return res.status(404).json({ message: "Message not found" });
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, msg.channelId));
      if (!channel || !(await canRead(channel, userId))) return res.status(403).json({ message: "Not your conversation" });

      const members = await db
        .select({ userId: staffChannelMembers.userId, firstName: usersTable.firstName, lastName: usersTable.lastName })
        .from(staffChannelMembers)
        .innerJoin(usersTable, eq(usersTable.id, staffChannelMembers.userId))
        .where(and(eq(staffChannelMembers.channelId, msg.channelId), isNull(staffChannelMembers.leftAt)));
      const acks = await db
        .select({ userId: staffMessageAcks.userId, ackedAt: staffMessageAcks.ackedAt })
        .from(staffMessageAcks)
        .where(eq(staffMessageAcks.messageId, id));
      const ackedMap = new Map(acks.map((a) => [a.userId, a.ackedAt]));

      res.json({
        acked: members
          .filter((m) => ackedMap.has(m.userId))
          .map((m) => ({ userId: m.userId, name: fullName(m), ackedAt: ackedMap.get(m.userId) })),
        pending: members
          .filter((m) => !ackedMap.has(m.userId) && m.userId !== msg.authorId)
          .map((m) => ({ userId: m.userId, name: fullName(m) })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Full-text search across everything the viewer can access. ──────────────
  app.get("/api/admin/chat/search", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const q = String(req.query.q ?? "").trim().slice(0, 100);
      if (q.length < 2) return res.json({ results: [] });

      const found = await db.execute(sql`
        SELECT m.id, m.channel_id, m.body, m.created_at, m.author_id,
               u.first_name, u.last_name, c.name AS channel_name, c.kind AS channel_kind
        FROM staff_messages m
        JOIN staff_channels c ON c.id = m.channel_id
        LEFT JOIN users u ON u.id = m.author_id
        WHERE m.deleted_at IS NULL
          AND to_tsvector('english', m.body) @@ plainto_tsquery('english', ${q})
          AND (
            (c.kind = 'channel' AND c.is_private = false)
            OR EXISTS (
              SELECT 1 FROM staff_channel_members cm
              WHERE cm.channel_id = c.id AND cm.user_id = ${userId} AND cm.left_at IS NULL
            )
          )
        ORDER BY m.id DESC
        LIMIT 30
      `);
      res.json({
        results: (found.rows as any[]).map((r) => ({
          id: Number(r.id),
          channelId: Number(r.channel_id),
          channelName: r.channel_name,
          channelKind: r.channel_kind,
          authorName: [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown",
          body: excerpt(String(r.body), 180),
          createdAt: r.created_at,
        })),
      });
    } catch (e: any) {
      console.error("[staff-chat] search failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Upload an attachment (image / voice note / document). Images are
  //    recompressed; everything else passes through. 25MB cap. ────────────────
  app.post(
    "/api/admin/chat/upload",
    requireAuth,
    (req, res, next) =>
      chatUpload.single("file")(req, res, (err: any) =>
        err ? res.status(400).json({ message: err.message ?? "Upload failed" }) : next(),
      ),
    async (req, res) => {
      try {
        const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined;
        if (!file) return res.status(400).json({ message: "No file" });
        const kind = classifyUpload(file.mimetype);
        if (!kind) return res.status(400).json({ message: "That file type isn't allowed here" });

        let buf = file.buffer;
        let contentType = file.mimetype.split(";")[0];
        let ext = extensionFor(contentType);
        if (kind === "image" && contentType !== "image/gif") {
          const sharp = (await import("sharp")).default;
          buf = await sharp(file.buffer)
            .rotate()
            .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer();
          contentType = "image/webp";
          ext = "webp";
        }

        const { ObjectStorageService } = await import("./replit_integrations/object_storage/objectStorage");
        const { setObjectAclPolicy } = await import("./replit_integrations/object_storage/objectAcl");
        const svc = new ObjectStorageService();
        const upload = await svc.uploadBufferToUploads(buf, contentType, ext);
        await setObjectAclPolicy(upload.file, {
          owner: String(req.session.userId),
          visibility: "public",
        });

        const durationSec = Number(req.body?.durationSec);
        res.json({
          url: upload.objectPath,
          name: file.originalname?.slice(0, 200) || `attachment.${ext}`,
          contentType,
          size: buf.length,
          kind,
          ...(kind === "voice" && Number.isFinite(durationSec) ? { durationSec: Math.round(durationSec) } : {}),
        });
      } catch (e: any) {
        console.error("[staff-chat] upload failed:", e);
        res.status(500).json({ message: e.message });
      }
    },
  );
}
