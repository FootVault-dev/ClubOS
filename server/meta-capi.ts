import { storage } from "./storage";
import { venuePurchaseEventId } from "@shared/meta-events";

const META_PIXEL_ID = process.env.META_PIXEL_ID || "";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
// Meta Graph API version — single source of truth for every CAPI call. Bump this
// one const when Meta releases a new stable major (a version stays valid ~2 years
// after release; older ones are auto-deprecated). HUMAN: confirm this is current
// in the Meta developer dashboard at deploy time. Exported so the Marketing-API
// ad-spend cron (server/ad-spend-cron.ts) shares the exact same version.
export const META_API_VERSION = "v23.0";

interface ServerEvent {
  eventName: string;
  eventId: string;
  eventTime: number;
  userAgent?: string;
  sourceUrl?: string;
  ipAddress?: string;
  fbp?: string;
  fbc?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  customData?: Record<string, any>;
  campId?: number;
  registrationId?: number;
}

function hashSha256(value: string): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function sendServerEvent(event: ServerEvent): Promise<boolean> {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.log("[Meta CAPI] Skipping — META_PIXEL_ID or META_ACCESS_TOKEN not configured");
    return false;
  }

  const userData: Record<string, any> = {};
  if (event.email) userData.em = [hashSha256(event.email)];
  if (event.phone) userData.ph = [hashSha256(event.phone)];
  if (event.firstName) userData.fn = [hashSha256(event.firstName)];
  if (event.lastName) userData.ln = [hashSha256(event.lastName)];
  if (event.fbp) userData.fbp = event.fbp;
  if (event.fbc) userData.fbc = event.fbc;
  if (event.ipAddress) userData.client_ip_address = event.ipAddress;
  if (event.userAgent) userData.client_user_agent = event.userAgent;

  const payload = {
    data: [
      {
        event_name: event.eventName,
        event_time: event.eventTime,
        event_id: event.eventId,
        event_source_url: event.sourceUrl,
        action_source: "website",
        user_data: userData,
        custom_data: event.customData || {},
      },
    ],
  };

  try {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    const success = res.ok;

    try {
      await storage.createMetaEventLog({
        campId: event.campId || null,
        registrationId: event.registrationId || null,
        eventName: event.eventName,
        payloadJson: JSON.stringify(payload),
        success,
      });
    } catch (e) {
      console.error("[Meta CAPI] Failed to log event:", e);
    }

    if (!success) {
      console.error("[Meta CAPI] API error:", JSON.stringify(result));
    }

    return success;
  } catch (error) {
    console.error("[Meta CAPI] Request failed:", error);
    return false;
  }
}

export async function sendPurchaseEvent(params: {
  registrationId: number;
  campId: number;
  totalCents: number;
  currency: string;
  email: string;
  phone?: string;
  firstName: string;
  lastName: string;
  fbp?: string;
  fbc?: string;
  userAgent?: string;
  ipAddress?: string;
  sourceUrl?: string;
  eventId: string;
  /** Override Facebook content_name (e.g. "MFL Term 3 Team Registration") so this offering is distinguishable in Events Manager. */
  contentName?: string;
  /** Override content_ids (defaults to [campId]) — e.g. the program slug for MFL. */
  contentIds?: string[];
}): Promise<boolean> {
  return sendServerEvent({
    eventName: "Purchase",
    eventId: params.eventId,
    eventTime: Math.floor(Date.now() / 1000),
    email: params.email,
    phone: params.phone,
    firstName: params.firstName,
    lastName: params.lastName,
    fbp: params.fbp,
    fbc: params.fbc,
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
    sourceUrl: params.sourceUrl,
    campId: params.campId,
    registrationId: params.registrationId,
    customData: {
      value: params.totalCents / 100,
      currency: params.currency,
      content_type: "product",
      content_ids: params.contentIds ?? [String(params.campId)],
      ...(params.contentName ? { content_name: params.contentName } : {}),
    },
  });
}

/**
 * Server-side Purchase for a VENUE hire (facilityBookings). Venue has no browser
 * pixel of its own, so this is the authoritative Purchase for venue revenue. The
 * event id is the deterministic, namespaced `venuePurchaseEventId(bookingGroupId)`
 * so that if a browser pixel is ever added it deduplicates cleanly, and repeat
 * confirms (webhook + self-heal) never double-count (the caller is idempotent).
 * facilityBookings carries no fbp/fbc (no T3 attribution columns) — match quality
 * comes from the hashed email + phone.
 */
export async function sendVenuePurchaseEvent(params: {
  /** first facilityBookings row id — for the meta_event_log audit only. */
  bookingId: number;
  /** booking-group id (one payment, many rows) — drives the dedup event id. */
  bookingGroupId: string;
  totalCents: number;
  currency: string;
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  userAgent?: string;
  ipAddress?: string;
  sourceUrl?: string;
  facilityName?: string;
}): Promise<boolean> {
  return sendServerEvent({
    eventName: "Purchase",
    eventId: venuePurchaseEventId(params.bookingGroupId),
    eventTime: Math.floor(Date.now() / 1000),
    email: params.email,
    phone: params.phone,
    firstName: params.firstName,
    lastName: params.lastName,
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
    sourceUrl: params.sourceUrl,
    registrationId: params.bookingId,
    customData: {
      value: params.totalCents / 100,
      currency: params.currency,
      content_type: "product",
      content_ids: [params.bookingGroupId],
      content_name: params.facilityName || "Venue Booking",
    },
  });
}

/**
 * Server-side Lead event (e.g. a team captain submitting the MFL registration form
 * before paying). Mirror the client trackEvent('Lead', ...) eventId for dedup.
 */
export async function sendLeadEvent(params: {
  registrationId?: number;
  campId?: number;
  valueCents?: number;
  currency?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  fbp?: string;
  fbc?: string;
  userAgent?: string;
  ipAddress?: string;
  sourceUrl?: string;
  eventId: string;
  contentName?: string;
  contentIds?: string[];
}): Promise<boolean> {
  return sendServerEvent({
    eventName: "Lead",
    eventId: params.eventId,
    eventTime: Math.floor(Date.now() / 1000),
    email: params.email,
    phone: params.phone,
    firstName: params.firstName,
    lastName: params.lastName,
    fbp: params.fbp,
    fbc: params.fbc,
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
    sourceUrl: params.sourceUrl,
    campId: params.campId,
    registrationId: params.registrationId,
    customData: {
      ...(params.valueCents != null ? { value: params.valueCents / 100 } : {}),
      currency: params.currency ?? "NZD",
      content_type: "product",
      ...(params.contentIds ? { content_ids: params.contentIds } : {}),
      ...(params.contentName ? { content_name: params.contentName } : {}),
    },
  });
}
