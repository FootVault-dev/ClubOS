// ─────────────────────────────────────────────────────────────────────────────
// Staff Voice — 1:1 calls, group calls, voice channels and meetings.
//
// Rides on Staff Chat: same universal tab, same requireAuth-only gate, same
// membership. Voice does NOT invent a permission model — voiceAccess() in
// shared/staff-voice.ts is the one decider and it answers from chat's own
// membership rows. If you can read the room you can talk in it.
//
// Media runs on LiveKit. This server never touches audio; it decides who may
// enter a room, mints a scoped token, and keeps the record.
//
// 🔴 THE SELF-HEALING RULE. A phone that dies mid-call never says "I left", so
// left_at would stay NULL forever, the room would look permanently occupied, and
// the one-live-call-per-channel index would block the next call in that channel.
// Every read path therefore reconciles against LiveKit's own participant list
// before it answers. No cron, no public webhook endpoint, no raw-body plumbing —
// and it works on two Fly machines that share no memory.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import crypto from "crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import {
  staffCalls,
  staffCallParticipants,
  staffCallEvents,
  staffChannels,
  staffChannelMembers,
  devicePushTokens,
  users as usersTable,
} from "@shared/schema";
import {
  STAFF_CALL_MODES,
  MAX_CALL_PARTICIPANTS,
  CALL_TITLE_MAX,
  type StaffCallMode,
  type CallRow,
  type CallParticipantRow,
  voiceAccess,
  isCallLive,
  isPresent,
  isRingingFor,
  isStale,
  staleReasonFor,
  outcomeFor,
  durationSeconds,
  makeRoomName,
  participantIdentity,
  userIdFromIdentity,
} from "@shared/staff-voice";
import {
  isLiveKitConfigured,
  liveKitWsUrl,
  mintAccessToken,
  roomParticipants,
  deleteRoom,
} from "./livekit";
import { isVoipConfigured, sendVoipPush } from "./voip-push";
import { sendPushToUsers } from "./notifications";
import { isLeadershipUser, activeMembership } from "./staff-chat-routes";

function fullName(u: { firstName: string | null; lastName: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || "Someone";
}

async function logEvent(
  callId: number,
  kind: string,
  userId: number | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(staffCallEvents).values({ callId, userId, kind, detail: detail ?? null });
  } catch {
    // The log is diagnostic. Never let writing it fail a call.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation + the lazy sweeper
// ─────────────────────────────────────────────────────────────────────────────

async function participantsOf(callId: number): Promise<CallParticipantRow[]> {
  return (await db
    .select()
    .from(staffCallParticipants)
    .where(eq(staffCallParticipants.callId, callId))) as unknown as CallParticipantRow[];
}

/**
 * Ask LiveKit who is really in the room and make our rows agree.
 *
 * Returns the reconciled participants. When LiveKit cannot be reached it returns
 * our rows unchanged — "could not ask" is NOT "nobody is there", and treating it
 * as such would hang up on a room full of people because of one failed request.
 */
async function reconcile(call: CallRow): Promise<CallParticipantRow[]> {
  const rows = await participantsOf(call.id);
  if (!isCallLive(call) || !isLiveKitConfigured()) return rows;

  const live = await roomParticipants(call.roomName);
  if (live == null) return rows;

  const presentIds = new Set(
    live.map((p) => userIdFromIdentity(p.identity)).filter((n): n is number => n != null),
  );

  const now = new Date();
  const ghosts = rows.filter((r) => isPresent(r) && !presentIds.has(r.userId));
  if (ghosts.length) {
    await db
      .update(staffCallParticipants)
      .set({ leftAt: now, leftReason: "media_gone" })
      .where(
        and(
          eq(staffCallParticipants.callId, call.id),
          inArray(
            staffCallParticipants.userId,
            ghosts.map((g) => g.userId),
          ),
          isNull(staffCallParticipants.leftAt),
        ),
      );
    for (const g of ghosts) await logEvent(call.id, "left", g.userId, { reason: "media_gone" });
    return participantsOf(call.id);
  }
  return rows;
}

/**
 * End any live call that nobody can still answer and nobody is in.
 *
 * Lazy rather than scheduled: whoever looks next closes it, which is always
 * sooner than a cron and needs no scheduler on either Fly machine.
 */
async function sweepStale(channelId?: number | null): Promise<void> {
  const where = channelId == null
    ? isNull(staffCalls.endedAt)
    : and(isNull(staffCalls.endedAt), eq(staffCalls.channelId, channelId));

  const live = (await db.select().from(staffCalls).where(where).limit(50)) as unknown as CallRow[];
  const now = new Date();

  for (const call of live) {
    const rows = await reconcile(call);
    if (!isStale(call, rows, now)) continue;
    const reason = staleReasonFor(rows);
    await db
      .update(staffCalls)
      .set({ endedAt: now, endedReason: reason })
      .where(and(eq(staffCalls.id, call.id), isNull(staffCalls.endedAt)));
    await logEvent(call.id, "ended", null, { reason });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ringing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ring the invitees.
 *
 * iOS gets a true VoIP push → CallKit → a full-screen ringing call. Android gets
 * a high-priority notification through the path that already works; Core-Telecom
 * parity lands with the native module.
 *
 * 🔴 A VoIP push is only ever sent for a live, ringing call. Apple kills an app
 * that receives one and does not report a call to CallKit.
 */
async function ringOut(
  call: CallRow,
  inviteeIds: number[],
  callerName: string,
  displayName: string,
  callerAvatarUrl?: string | null,
): Promise<void> {
  if (!inviteeIds.length) return;

  const devices = await db
    .select({
      userId: devicePushTokens.userId,
      voipToken: devicePushTokens.voipToken,
      platform: devicePushTokens.platform,
    })
    .from(devicePushTokens)
    .where(
      and(
        eq(devicePushTokens.app, "clubos-staff"),
        eq(devicePushTokens.disabled, false),
        inArray(devicePushTokens.userId, inviteeIds),
      ),
    );

  const rungViaVoip = new Set<number>();

  if (isVoipConfigured()) {
    const withVoip = devices.filter((d) => d.voipToken && d.userId != null);
    await Promise.all(
      withVoip.map(async (d) => {
        const result = await sendVoipPush(d.voipToken!, {
          // Per device, so two phones do not dedup each other's ring.
          eventId: crypto.randomUUID(),
          serverCallId: String(call.id),
          hasVideo: false,
          startedAt: new Date(call.startedAt).toISOString(),
          caller: {
            id: `u${call.startedBy}`,
            // For a DM this is the caller; for a channel it is the room, which
            // is what the person needs to see on a lock screen.
            displayName: call.mode === "direct" ? callerName : `${callerName} · ${displayName}`,
            ...(callerAvatarUrl ? { avatarUrl: callerAvatarUrl } : {}),
          },
          // Opaque to the module — everything the app needs to join the room.
          metadata: {
            roomName: call.roomName,
            mode: String(call.mode),
            channelId: call.channelId,
          },
        });
        if (result.ok) {
          rungViaVoip.add(d.userId!);
          await logEvent(call.id, "push_sent", d.userId!, { transport: "voip" });
        } else {
          await logEvent(call.id, "push_failed", d.userId!, {
            transport: "voip",
            reason: result.reason,
            status: result.status,
          });
          // A wiped or reinstalled phone: retire the dead token so we stop
          // trying, but never touch the row's ordinary APNs token.
          if (result.unregistered) {
            await db
              .update(devicePushTokens)
              .set({ voipToken: null })
              .where(eq(devicePushTokens.voipToken, d.voipToken!));
          }
        }
      }),
    );
  }

  // Everyone we could not reach by VoIP still deserves to know. This is the
  // ordinary notification path — it will not ring through silent mode, and the
  // client turns it into an in-app incoming call if the app is open.
  const fallback = inviteeIds.filter((id) => !rungViaVoip.has(id));
  if (fallback.length) {
    await sendPushToUsers(
      fallback.map((userId) => ({
        userId,
        payload: {
          title: `${callerName} is calling`,
          body: displayName,
          data: {
            type: "voice_call",
            callId: call.id,
            roomName: call.roomName,
            channelId: call.channelId,
            mode: call.mode,
          },
          // A ring must cut through a mute — it expires in 45 seconds on its own.
          urgent: true,
        },
      })) as any,
    );
    for (const id of fallback) await logEvent(call.id, "push_sent", id, { transport: "alert" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shaping
// ─────────────────────────────────────────────────────────────────────────────

type PersonLite = { id: number; firstName: string | null; lastName: string | null; avatarUrl?: string | null };

async function peopleByIds(ids: number[]): Promise<Map<number, PersonLite>> {
  const unique = Array.from(new Set(ids)).filter((n) => Number.isFinite(n));
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      avatarUrl: usersTable.avatarUrl,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, unique));
  return new Map(rows.map((r) => [r.id, r as PersonLite]));
}

function shapeCall(
  call: CallRow,
  parts: CallParticipantRow[],
  people: Map<number, PersonLite>,
  viewerId: number,
  now: Date,
) {
  const mine = parts.find((p) => p.userId === viewerId);
  return {
    id: call.id,
    mode: call.mode,
    channelId: call.channelId,
    title: call.title,
    startedBy: call.startedBy,
    startedByName: people.get(call.startedBy) ? fullName(people.get(call.startedBy)!) : "Someone",
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    live: isCallLive(call),
    durationSec: durationSeconds(call, now),
    // Derived every time, never read from a column.
    ringingForMe: mine ? isRingingFor(call, mine, now) : false,
    outcomeForMe: mine ? outcomeFor(call, mine, now) : null,
    participants: parts.map((p) => ({
      userId: p.userId,
      name: people.get(p.userId) ? fullName(people.get(p.userId)!) : "Unknown",
      avatarUrl: people.get(p.userId)?.avatarUrl ?? null,
      present: isPresent(p),
      invited: p.invitedAt != null,
      declined: p.declinedAt != null,
      joinedAt: p.joinedAt,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerStaffVoiceRoutes(app: Express) {
  // ── Is voice switched on at all, and where do clients connect? ─────────────
  app.get("/api/admin/voice/config", requireAuth, async (_req, res) => {
    res.json({
      enabled: isLiveKitConfigured(),
      wsUrl: liveKitWsUrl() || null,
      voipReady: isVoipConfigured(),
      maxParticipants: MAX_CALL_PARTICIPANTS,
    });
  });

  // ── The poll. Everything a client needs to know about voice right now. ─────
  app.get("/api/admin/voice/state", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const now = new Date();

      await sweepStale();

      // Every live call I am a row on — ringing, or already in.
      const rows = await db
        .select({ call: staffCalls, part: staffCallParticipants })
        .from(staffCallParticipants)
        .innerJoin(staffCalls, eq(staffCalls.id, staffCallParticipants.callId))
        .where(and(eq(staffCallParticipants.userId, userId), isNull(staffCalls.endedAt)));

      const calls: any[] = [];
      for (const r of rows) {
        const call = r.call as unknown as CallRow;
        const parts = await reconcile(call);
        // Reconciliation may have just ended it.
        const [fresh] = await db.select().from(staffCalls).where(eq(staffCalls.id, call.id));
        if (!fresh || fresh.endedAt != null) continue;
        const people = await peopleByIds([call.startedBy, ...parts.map((p) => p.userId)]);
        calls.push(shapeCall(call, parts, people, userId, now));
      }

      // Occupancy of the voice channels I belong to, so the sidebar can show
      // "3 in here" without opening the room.
      const myChannels = await db
        .select({ channelId: staffChannelMembers.channelId })
        .from(staffChannelMembers)
        .innerJoin(staffChannels, eq(staffChannels.id, staffChannelMembers.channelId))
        .where(
          and(
            eq(staffChannelMembers.userId, userId),
            isNull(staffChannelMembers.leftAt),
            eq(staffChannels.voiceEnabled, true),
          ),
        );

      const voiceChannels: any[] = [];
      for (const c of myChannels) {
        const [live] = (await db
          .select()
          .from(staffCalls)
          .where(and(eq(staffCalls.channelId, c.channelId), isNull(staffCalls.endedAt)))
          .limit(1)) as unknown as CallRow[];
        if (!live) {
          voiceChannels.push({ channelId: c.channelId, callId: null, occupants: [] });
          continue;
        }
        const parts = await reconcile(live);
        const present = parts.filter(isPresent);
        const people = await peopleByIds(present.map((p) => p.userId));
        voiceChannels.push({
          channelId: c.channelId,
          callId: live.id,
          occupants: present.map((p) => ({
            userId: p.userId,
            name: people.get(p.userId) ? fullName(people.get(p.userId)!) : "Unknown",
            avatarUrl: people.get(p.userId)?.avatarUrl ?? null,
          })),
        });
      }

      res.json({ calls, voiceChannels, serverTime: now.toISOString() });
    } catch (err: any) {
      console.error("[voice] state failed", err);
      res.status(500).json({ message: "Could not load voice state" });
    }
  });

  // ── Start a call ───────────────────────────────────────────────────────────
  app.post("/api/admin/voice/calls", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      if (!isLiveKitConfigured()) {
        return res.status(503).json({ message: "Voice calling is not switched on yet", code: "voice_off" });
      }

      const channelId = Number(req.body?.channelId);
      const mode: StaffCallMode = STAFF_CALL_MODES.includes(req.body?.mode) ? req.body.mode : "direct";
      const clientCallId = typeof req.body?.clientCallId === "string" ? req.body.clientCallId.slice(0, 80) : null;
      const title = typeof req.body?.title === "string" ? req.body.title.slice(0, CALL_TITLE_MAX) : null;

      if (!Number.isFinite(channelId)) return res.status(400).json({ message: "channelId is required" });

      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel) return res.status(404).json({ message: "Conversation not found" });

      const membership = await activeMembership(channelId, userId);
      const leadership = await isLeadershipUser(userId);
      const access = voiceAccess(
        { userId, isLeadership: leadership, isActiveMember: Boolean(membership) },
        {
          kind: channel.kind,
          postPolicy: channel.postPolicy,
          archivedAt: channel.archivedAt,
          voiceEnabled: channel.voiceEnabled,
        },
      );
      // 404 rather than 403 for a room you are not in: a 403 confirms it exists.
      if (!membership) return res.status(404).json({ message: "Conversation not found" });
      if (!access.canStartCall) return res.status(403).json({ message: access.reason ?? "Not allowed" });

      await sweepStale(channelId);

      // Idempotent retry — the same client id gets the same call back.
      if (clientCallId) {
        const [existing] = (await db
          .select()
          .from(staffCalls)
          .where(
            and(
              eq(staffCalls.startedBy, userId),
              eq(staffCalls.clientCallId, clientCallId),
              isNull(staffCalls.endedAt),
            ),
          )
          .limit(1)) as unknown as CallRow[];
        if (existing) {
          const parts = await participantsOf(existing.id);
          const people = await peopleByIds([existing.startedBy, ...parts.map((p) => p.userId)]);
          return res.json({ call: shapeCall(existing, parts, people, userId, new Date()), reused: true });
        }
      }

      // Who gets rung. A voice channel rings nobody — people drop in.
      let inviteeIds: number[] = [];
      if (mode !== "channel") {
        const requested: number[] = Array.isArray(req.body?.inviteeIds)
          ? req.body.inviteeIds.map(Number).filter(Number.isFinite)
          : [];
        const members = await db
          .select({ userId: staffChannelMembers.userId })
          .from(staffChannelMembers)
          .where(and(eq(staffChannelMembers.channelId, channelId), isNull(staffChannelMembers.leftAt)));
        const memberIds = new Set(members.map((m) => m.userId));
        // 🔴 An invitee list from the browser is filtered against real
        // membership — a caller must not be able to ring somebody into a room
        // they cannot otherwise reach.
        const chosen = requested.length ? requested.filter((id) => memberIds.has(id)) : Array.from(memberIds);
        inviteeIds = chosen.filter((id) => id !== userId).slice(0, MAX_CALL_PARTICIPANTS - 1);
      }

      const roomName = makeRoomName(mode, crypto.randomBytes(12).toString("hex"));

      let call: CallRow;
      try {
        const [row] = await db
          .insert(staffCalls)
          .values({ mode, channelId, roomName, title, startedBy: userId, clientCallId })
          .returning();
        call = row as unknown as CallRow;
      } catch (err: any) {
        // 🔴 Lost the race for this channel. Somebody else's call is already
        // live — the right answer is to put this person INTO it, not to show
        // them an error and let two people sit in two silent rooms.
        if (String(err?.code) === "23505") {
          const [winner] = (await db
            .select()
            .from(staffCalls)
            .where(and(eq(staffCalls.channelId, channelId), isNull(staffCalls.endedAt)))
            .limit(1)) as unknown as CallRow[];
          if (winner) {
            const parts = await participantsOf(winner.id);
            const people = await peopleByIds([winner.startedBy, ...parts.map((p) => p.userId)]);
            return res.json({
              call: shapeCall(winner, parts, people, userId, new Date()),
              joinedExisting: true,
            });
          }
        }
        throw err;
      }

      const now = new Date();
      await db.insert(staffCallParticipants).values([
        // The caller is in the room, not ringing themselves.
        { callId: call.id, userId, joinedAt: now },
        ...inviteeIds.map((id) => ({ callId: call.id, userId: id, invitedAt: now })),
      ]);
      await logEvent(call.id, "created", userId, { mode, invitees: inviteeIds.length });

      const me = await storage.getUser(userId);
      const callerName = me ? fullName(me as any) : "Someone";
      const displayName =
        channel.kind === "dm" ? callerName : `#${channel.name ?? "channel"}`;

      // Fire and forget — the caller's UI must open immediately, not wait on APNs.
      void ringOut(call, inviteeIds, callerName, displayName, (me as any)?.avatarUrl ?? null).catch((e) =>
        console.error("[voice] ringOut failed", e),
      );

      const parts = await participantsOf(call.id);
      const people = await peopleByIds([call.startedBy, ...parts.map((p) => p.userId)]);
      res.status(201).json({ call: shapeCall(call, parts, people, userId, now) });
    } catch (err: any) {
      console.error("[voice] start failed", err);
      res.status(500).json({ message: "Could not start the call" });
    }
  });

  // ── Join / answer → the media token ────────────────────────────────────────
  app.post("/api/admin/voice/calls/:id/join", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const callId = Number(req.params.id);
      if (!Number.isFinite(callId)) return res.status(400).json({ message: "Bad call" });
      if (!isLiveKitConfigured()) {
        return res.status(503).json({ message: "Voice calling is not switched on yet", code: "voice_off" });
      }

      const [row] = await db.select().from(staffCalls).where(eq(staffCalls.id, callId));
      const call = row as unknown as CallRow | undefined;
      if (!call) return res.status(404).json({ message: "Call not found" });
      if (!isCallLive(call)) return res.status(409).json({ message: "That call has ended", code: "ended" });

      // 🔴 Re-checked at join, not just at start. A call can outlive the
      // membership that authorised it — someone removed from a channel
      // mid-call must not be able to answer the ring still on their phone.
      if (call.channelId != null) {
        const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, call.channelId));
        const membership = await activeMembership(call.channelId, userId);
        if (!channel || !membership) return res.status(404).json({ message: "Call not found" });
        const access = voiceAccess(
          { userId, isLeadership: await isLeadershipUser(userId), isActiveMember: true },
          {
            kind: channel.kind,
            postPolicy: channel.postPolicy,
            archivedAt: channel.archivedAt,
            voiceEnabled: channel.voiceEnabled,
          },
        );
        if (!access.canJoin) return res.status(403).json({ message: access.reason ?? "Not allowed" });
      } else if (!(await db
        .select({ id: staffCallParticipants.id })
        .from(staffCallParticipants)
        .where(and(eq(staffCallParticipants.callId, callId), eq(staffCallParticipants.userId, userId)))
        .then((r) => r.length))) {
        // An ad-hoc meeting has no channel to check, so the invite list is the
        // boundary.
        return res.status(404).json({ message: "Call not found" });
      }

      const present = await participantsOf(callId);
      const already = present.filter(isPresent).length;
      if (already >= MAX_CALL_PARTICIPANTS && !present.some((p) => p.userId === userId && isPresent(p))) {
        return res.status(409).json({ message: "This call is full", code: "full" });
      }

      const now = new Date();
      await db
        .insert(staffCallParticipants)
        .values({ callId, userId, joinedAt: now })
        .onConflictDoUpdate({
          target: [staffCallParticipants.callId, staffCallParticipants.userId],
          // Rejoining after a dropout clears the departure rather than forking
          // this person's history of the call.
          set: { joinedAt: now, leftAt: null, leftReason: null, declinedAt: null },
        });
      await logEvent(callId, "joined", userId);

      const me = await storage.getUser(userId);
      const token = mintAccessToken({
        identity: participantIdentity(userId),
        name: me ? fullName(me as any) : "Staff",
        roomName: call.roomName,
        canPublishScreen: call.mode === "meeting" || call.mode === "channel",
      });

      res.json({ token, wsUrl: liveKitWsUrl(), roomName: call.roomName, callId });
    } catch (err: any) {
      console.error("[voice] join failed", err);
      res.status(500).json({ message: "Could not join the call" });
    }
  });

  // ── Decline ────────────────────────────────────────────────────────────────
  app.post("/api/admin/voice/calls/:id/decline", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const callId = Number(req.params.id);
      const now = new Date();
      await db
        .update(staffCallParticipants)
        .set({ declinedAt: now })
        .where(
          and(
            eq(staffCallParticipants.callId, callId),
            eq(staffCallParticipants.userId, userId),
            isNull(staffCallParticipants.joinedAt),
          ),
        );
      await logEvent(callId, "declined", userId);
      // A 1:1 call where the only other person said no is over — do not leave
      // the caller listening to a room that will never be answered.
      const [row] = await db.select().from(staffCalls).where(eq(staffCalls.id, callId));
      const call = row as unknown as CallRow | undefined;
      if (call && isCallLive(call) && call.mode === "direct") {
        const parts = await participantsOf(callId);
        const anyoneLeft = parts.some((p) => p.userId !== call.startedBy && p.declinedAt == null);
        if (!anyoneLeft) {
          await db
            .update(staffCalls)
            .set({ endedAt: now, endedReason: "declined" })
            .where(and(eq(staffCalls.id, callId), isNull(staffCalls.endedAt)));
          if (isLiveKitConfigured()) void deleteRoom(call.roomName).catch(() => {});
          await logEvent(callId, "ended", userId, { reason: "declined" });
        }
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[voice] decline failed", err);
      res.status(500).json({ message: "Could not decline" });
    }
  });

  // ── Leave ──────────────────────────────────────────────────────────────────
  app.post("/api/admin/voice/calls/:id/leave", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const callId = Number(req.params.id);
      const now = new Date();
      await db
        .update(staffCallParticipants)
        .set({ leftAt: now, leftReason: "hung_up" })
        .where(
          and(
            eq(staffCallParticipants.callId, callId),
            eq(staffCallParticipants.userId, userId),
            isNull(staffCallParticipants.leftAt),
          ),
        );
      await logEvent(callId, "left", userId, { reason: "hung_up" });

      const [row] = await db.select().from(staffCalls).where(eq(staffCalls.id, callId));
      const call = row as unknown as CallRow | undefined;
      if (call && isCallLive(call)) {
        const parts = await participantsOf(callId);
        if (!parts.some(isPresent)) {
          await db
            .update(staffCalls)
            .set({ endedAt: now, endedReason: "empty" })
            .where(and(eq(staffCalls.id, callId), isNull(staffCalls.endedAt)));
          if (isLiveKitConfigured()) void deleteRoom(call.roomName).catch(() => {});
          await logEvent(callId, "ended", null, { reason: "empty" });
        }
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[voice] leave failed", err);
      res.status(500).json({ message: "Could not leave the call" });
    }
  });

  // ── End for everyone (the person who started it, or leadership) ────────────
  app.post("/api/admin/voice/calls/:id/end", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const callId = Number(req.params.id);
      const [row] = await db.select().from(staffCalls).where(eq(staffCalls.id, callId));
      const call = row as unknown as CallRow | undefined;
      if (!call) return res.status(404).json({ message: "Call not found" });
      if (call.startedBy !== userId && !(await isLeadershipUser(userId))) {
        return res.status(403).json({ message: "Only the person who started this call can end it" });
      }
      const now = new Date();
      await db
        .update(staffCalls)
        .set({ endedAt: now, endedReason: "host" })
        .where(and(eq(staffCalls.id, callId), isNull(staffCalls.endedAt)));
      await db
        .update(staffCallParticipants)
        .set({ leftAt: now, leftReason: "host_ended" })
        .where(and(eq(staffCallParticipants.callId, callId), isNull(staffCallParticipants.leftAt)));
      if (isLiveKitConfigured()) void deleteRoom(call.roomName).catch(() => {});
      await logEvent(callId, "ended", userId, { reason: "host" });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[voice] end failed", err);
      res.status(500).json({ message: "Could not end the call" });
    }
  });

  // ── Call history for a conversation ────────────────────────────────────────
  app.get("/api/admin/voice/channels/:id/history", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const channelId = Number(req.params.id);
      if (!(await activeMembership(channelId, userId))) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const rows = (await db
        .select()
        .from(staffCalls)
        .where(eq(staffCalls.channelId, channelId))
        .orderBy(desc(staffCalls.startedAt))
        .limit(limit)) as unknown as CallRow[];

      const now = new Date();
      const out = [];
      for (const call of rows) {
        const parts = await participantsOf(call.id);
        const people = await peopleByIds([call.startedBy, ...parts.map((p) => p.userId)]);
        out.push(shapeCall(call, parts, people, userId, now));
      }
      res.json({ calls: out });
    } catch (err: any) {
      console.error("[voice] history failed", err);
      res.status(500).json({ message: "Could not load call history" });
    }
  });

  // ── Turn a channel's voice room on or off (leadership) ─────────────────────
  app.patch("/api/admin/voice/channels/:id", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const channelId = Number(req.params.id);
      const [channel] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
      if (!channel) return res.status(404).json({ message: "Conversation not found" });

      const membership = await activeMembership(channelId, userId);
      const access = voiceAccess(
        { userId, isLeadership: await isLeadershipUser(userId), isActiveMember: Boolean(membership) },
        {
          kind: channel.kind,
          postPolicy: channel.postPolicy,
          archivedAt: channel.archivedAt,
          voiceEnabled: channel.voiceEnabled,
        },
      );
      if (!access.canToggleVoiceChannel) {
        return res.status(403).json({ message: "Only leadership can add a voice room to a channel" });
      }

      const voiceEnabled = req.body?.voiceEnabled === true;
      await db.update(staffChannels).set({ voiceEnabled }).where(eq(staffChannels.id, channelId));
      res.json({ ok: true, voiceEnabled });
    } catch (err: any) {
      console.error("[voice] toggle failed", err);
      res.status(500).json({ message: "Could not update the channel" });
    }
  });

  // ── Register this device's PushKit token ───────────────────────────────────
  // 🔴 POST-only and separate from /push/register: the VoIP token is a second,
  // different token for the same device, and overwriting the ordinary one with
  // it would silently break every normal notification to that phone.
  app.post("/api/admin/voice/devices/voip", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId as number;
      const voipToken = typeof req.body?.voipToken === "string" ? req.body.voipToken.trim() : "";
      const pushToken = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!voipToken) return res.status(400).json({ message: "voipToken is required" });

      // Same phone may already hold this VoIP token under another account
      // (a shared office iPad). Clear it elsewhere first — a VoIP token points
      // at a device, and only the current signed-in user should be rung on it.
      await db
        .update(devicePushTokens)
        .set({ voipToken: null })
        .where(and(eq(devicePushTokens.voipToken, voipToken), sql`${devicePushTokens.userId} <> ${userId}`));

      const target = pushToken
        ? and(eq(devicePushTokens.token, pushToken), eq(devicePushTokens.userId, userId))
        : and(eq(devicePushTokens.userId, userId), eq(devicePushTokens.app, "clubos-staff"));

      const updated = await db
        .update(devicePushTokens)
        .set({ voipToken, updatedAt: new Date() })
        .where(target)
        .returning({ id: devicePushTokens.id });

      if (!updated.length) {
        return res.status(409).json({
          message: "Register for notifications first",
          code: "no_device_row",
        });
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[voice] voip register failed", err);
      res.status(500).json({ message: "Could not register this device for calls" });
    }
  });
}
