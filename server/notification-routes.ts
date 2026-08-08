// ─────────────────────────────────────────────────────────────────────────────
// Notification preferences + staff device registration.
//
// Universal, like Chat and Feedback: `requireAuth` ONLY, never `requireTab`.
// Notification settings belong to a PERSON, not to a workspace — the same
// settings must answer identically whichever workspace they happen to be
// standing in, on web or on the phone. That is the whole point of "set them
// from anywhere".
//
// 🔴 Device registration is deliberately NOT on the existing public route.
// `POST /api/public/push/register` is unauthenticated and hardcodes
// app:"cic-youth" for anonymous fan devices. Making it conditionally
// authenticated would put staff identity on a public endpoint and risk the
// live CIC broadcast path. A separate authenticated route takes the user id
// from the SESSION — a caller can never claim to be somebody else.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { isExpoPushToken } from "./push";
import {
  getPreferences,
  savePreferences,
  registerStaffDevice,
  unregisterStaffDevice,
  staffTokensFor,
  badgeCountsFor,
  sendPushToUsers,
} from "./notifications";
import {
  DELIVERY_MODES,
  type DeliveryMode,
  type NotificationPreferences,
} from "@shared/notifications";

function mode(v: unknown): DeliveryMode | undefined {
  return DELIVERY_MODES.includes(v as DeliveryMode) ? (v as DeliveryMode) : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function hour(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.trunc(n) : undefined;
}

function weekday(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 7 ? Math.trunc(n) : undefined;
}

/**
 * Whitelist the writable fields.
 *
 * Never spread `req.body` into an update — the academy roll shipped with
 * exactly that bug, where a staff-authenticated call could move a roll line
 * onto another child. Here an unknown key is simply dropped.
 */
function readPatch(body: any): Partial<NotificationPreferences> {
  const p: Partial<NotificationPreferences> = {};
  const set = <K extends keyof NotificationPreferences>(k: K, v: NotificationPreferences[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set("pushEnabled", bool(body?.pushEnabled));
  set("emailEnabled", bool(body?.emailEnabled));
  set("chatDm", mode(body?.chatDm));
  set("chatMention", mode(body?.chatMention));
  set("chatChannel", mode(body?.chatChannel));
  set("taskAssigned", mode(body?.taskAssigned));
  set("taskDue", mode(body?.taskDue));
  set("showPreview", bool(body?.showPreview));
  set("quietHoursEnabled", bool(body?.quietHoursEnabled));
  set("quietHoursStart", hour(body?.quietHoursStart));
  set("quietHoursEnd", hour(body?.quietHoursEnd));
  set("dailyDigest", bool(body?.dailyDigest));
  set("dailyDigestHour", hour(body?.dailyDigestHour));
  set("weeklyDigest", bool(body?.weeklyDigest));
  set("weeklyDigestDay", weekday(body?.weeklyDigestDay));
  set("weeklyDigestHour", hour(body?.weeklyDigestHour));
  return p;
}

export function registerNotificationRoutes(app: Express): void {
  // ── Preferences ───────────────────────────────────────────────────────────

  app.get("/api/admin/notifications/preferences", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const prefs = await getPreferences(userId);
      const devices = await staffTokensFor([userId]);
      res.json({
        preferences: prefs,
        // So the settings screen can say "this phone is registered" honestly
        // instead of claiming push works when no token was ever stored.
        deviceCount: devices.length,
      });
    } catch (e: any) {
      console.error("[notifications] load preferences failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/notifications/preferences", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const patch = readPatch(req.body);
      const prefs = await savePreferences(userId, patch);
      res.json({ preferences: prefs });
    } catch (e: any) {
      console.error("[notifications] save preferences failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Staff device registration ─────────────────────────────────────────────

  app.post("/api/admin/push/register", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { token, platform, deviceName } = req.body || {};
      if (!isExpoPushToken(token)) {
        return res.status(400).json({ message: "A valid Expo push token is required" });
      }
      await registerStaffDevice({
        token,
        userId,
        platform: String(platform || "unknown"),
        deviceName: deviceName ?? null,
      });
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[notifications] device register failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/push/unregister", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { token } = req.body || {};
      if (!isExpoPushToken(token)) {
        return res.status(400).json({ message: "A valid Expo push token is required" });
      }
      // Scoped to the caller's own token: signing out must never let one person
      // silence another person's phone.
      await unregisterStaffDevice(token, userId);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[notifications] device unregister failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Send yourself a test ──────────────────────────────────────────────────
  // The honest way to answer "are notifications actually working on my phone?".
  // Only ever sends to the CALLER's own devices, and deliberately ignores quiet
  // hours and the master switch — you asked for it, right now, by pressing a
  // button. It reports how many devices it reached so a silent phone can be
  // told apart from a phone that was never registered.
  app.post("/api/admin/notifications/test", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const devices = await staffTokensFor([userId]);
      if (!devices.length) {
        return res.json({
          ok: false,
          deviceCount: 0,
          message:
            "No phone is registered yet. Open the ClubOS app on your phone, sign in, and allow notifications — then try again.",
        });
      }
      const me = await storage.getUser(userId);
      const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ") || "there";
      const badges = await badgeCountsFor([userId]);
      const result = await sendPushToUsers([
        {
          userId,
          payload: {
            title: "ClubOS",
            subtitle: "Test notification",
            body: `Hi ${me?.firstName || name} — notifications are working.`,
            sound: "default",
            badge: badges.get(userId) ?? 0,
            channelId: "chat",
            priority: "high",
            data: { kind: "test", url: "/profile" },
          },
        },
      ]);
      res.json({ ok: result.sent > 0, deviceCount: devices.length, ...result });
    } catch (e: any) {
      console.error("[notifications] test send failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
