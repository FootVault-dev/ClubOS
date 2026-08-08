// Expo push-notification sender — the push analog of server/email.ts.
// Tokens are Expo push tokens (ExponentPushToken[...]) registered by the CIC
// Youth app via POST /api/public/push/register. Broadcasts fan out through
// Expo's push service, which accepts up to 100 messages per request and
// returns one index-aligned "ticket" per message. A DeviceNotRegistered
// ticket/receipt means the app was uninstalled (or the token rotated) — those
// tokens get disabled so future sends skip them.
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/
import { db } from "./db";
import { devicePushTokens, pushCampaigns } from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const BATCH_SIZE = 100;
const BATCH_SPACING_MS = 500; // Expo allows ~600 notifications/sec — this is well under

export function isExpoPushToken(t: unknown): t is string {
  return typeof t === "string" && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
}

export interface PushPayload {
  title: string;
  /** iOS second line, under the title. Android folds it into the body area. */
  subtitle?: string;
  body: string;
  data?: Record<string, unknown>;
  /** "default" plays the OS notification sound; null delivers silently. */
  sound?: "default" | null;
  /** iOS app-icon badge. Send the recipient's TOTAL unread, not an increment. */
  badge?: number;
  /**
   * Android channel id. The CHANNEL — not this payload — owns the sound,
   * vibration and whether a heads-up banner appears, and it must already exist
   * on the device (the app creates them at startup). Naming one that does not
   * exist delivers silently with no error anywhere.
   */
  channelId?: string;
  /** iOS: notifications sharing a threadId stack together in the shade. */
  threadId?: string;
  priority?: "default" | "normal" | "high";
}

type PushTicket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };

const pushSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Send one batch (≤100 messages). Returns one ticket per message, index-aligned.
// NOTE the spread order: defaults FIRST so a caller can override sound/priority.
// It used to be `{ ...m, sound, priority }`, which silently ignored anything a
// caller set. CIC broadcasts pass neither, so their behaviour is unchanged.
export async function sendExpoPushBatch(messages: Array<{ to: string } & PushPayload>): Promise<PushTicket[]> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages.map((m) => ({ sound: "default" as const, priority: "high" as const, ...m }))),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expo push HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: PushTicket[]; errors?: Array<{ message?: string }> };
  if (!Array.isArray(json.data)) {
    throw new Error(`Expo push: unexpected response — ${json.errors?.[0]?.message || "no data array"}`);
  }
  return json.data;
}

export async function disableTokens(tokenIds: number[]): Promise<void> {
  if (!tokenIds.length) return;
  await db.update(devicePushTokens)
    .set({ disabled: true, updatedAt: new Date() })
    .where(inArray(devicePushTokens.id, tokenIds));
}

// Single send — used by the dashboard's "send test to a device" button.
// Returns the ticket-level error so the admin sees WHY a test failed.
export async function sendSinglePush(token: string, payload: PushPayload): Promise<{ ok: boolean; error?: string }> {
  try {
    const [ticket] = await sendExpoPushBatch([{ to: token, ...payload }]);
    if (ticket?.status === "ok") return { ok: true };
    return { ok: false, error: ticket?.details?.error || ticket?.message || "Unknown push error" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// Broadcast queue — runs AFTER the HTTP response returns (same pattern as the
// mailer's runBroadcastQueue). Chunks of 100, progress written to the campaign
// row after every chunk so the dashboard can poll it. Dead tokens are disabled
// as tickets report them; ~15 min later a best-effort receipt check catches
// the ones APNs/FCM only reject downstream.
export async function runPushBroadcastQueue(
  campaignId: number,
  devices: Array<{ id: number; token: string }>,
  payload: PushPayload,
): Promise<void> {
  let sent = 0, failed = 0;
  const receiptIds: string[] = [];
  const failedTokenIds: number[] = [];

  for (let i = 0; i < devices.length; i += BATCH_SIZE) {
    const chunk = devices.slice(i, i + BATCH_SIZE);
    try {
      const tickets = await sendExpoPushBatch(chunk.map((d) => ({ to: d.token, ...payload })));
      const deadIds: number[] = [];
      tickets.forEach((ticket, j) => {
        if (ticket.status === "ok") {
          sent++;
          if (ticket.id) receiptIds.push(ticket.id);
        } else {
          failed++;
          failedTokenIds.push(chunk[j].id);
          if (ticket.details?.error === "DeviceNotRegistered") deadIds.push(chunk[j].id);
        }
      });
      await disableTokens(deadIds).catch(() => {});
    } catch (e) {
      // Whole-batch failure (network / Expo outage) — count the chunk as failed.
      console.error("[push queue] batch error:", e);
      failed += chunk.length;
    }
    try {
      await db.update(pushCampaigns).set({ sentCount: sent, failedCount: failed })
        .where(eq(pushCampaigns.id, campaignId));
    } catch { /* progress write is best-effort — keep sending */ }
    if (i + BATCH_SIZE < devices.length) await pushSleep(BATCH_SPACING_MS);
  }

  // Bump failure counts on tokens whose tickets errored (non-fatal errors keep
  // the token active; repeated failures are visible in the DB for later pruning).
  if (failedTokenIds.length) {
    await db.update(devicePushTokens)
      .set({ failureCount: sql`${devicePushTokens.failureCount} + 1`, updatedAt: new Date() })
      .where(inArray(devicePushTokens.id, failedTokenIds))
      .catch(() => {});
  }

  await db.update(pushCampaigns)
    .set({ sentCount: sent, failedCount: failed, status: "sent", sentAt: new Date() })
    .where(eq(pushCampaigns.id, campaignId));

  // Best-effort receipt check ~15 min later (Expo's recommended window). Only
  // catches DeviceNotRegistered for pruning — delivery itself is already done.
  // unref() so a pending timer never holds up a Fly machine restart.
  if (receiptIds.length) {
    const timer = setTimeout(() => {
      void checkReceiptsAndPrune(receiptIds).catch((e) => console.error("[push receipts] error:", e));
    }, 15 * 60 * 1000);
    (timer as any).unref?.();
  }
}

async function checkReceiptsAndPrune(receiptIds: string[]): Promise<void> {
  for (let i = 0; i < receiptIds.length; i += 300) {
    const ids = receiptIds.slice(i, i + 300);
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Record<string, { status: string; details?: { error?: string; expoPushToken?: string } }> };
    const deadTokens = Object.values(json.data || {})
      .filter((r) => r.status === "error" && r.details?.error === "DeviceNotRegistered" && r.details?.expoPushToken)
      .map((r) => r.details!.expoPushToken!) ;
    if (deadTokens.length) {
      await db.update(devicePushTokens)
        .set({ disabled: true, updatedAt: new Date() })
        .where(inArray(devicePushTokens.token, deadTokens));
    }
  }
}
