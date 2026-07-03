// AttributionOS — conversion stamping (T8).
//
// One entry point every public conversion/lead endpoint calls to stamp the first-party
// attribution spine onto the row it's about to write, and (when an email is present) to
// resolve the converting parent/payer onto a durable `persons` row + bind their visitor
// id + retroactively stitch their anonymous analytics history.
//
// Sources, in priority order, for the visitor/click/fbp/fbc ids:
//   1. the server-owned first-party cookies (usg_vid / usg_cid) + Meta's _fbp/_fbc — the
//      most trustworthy, since the T4 middleware / Meta pixel set them, and
//   2. the request body (analytics-captured fields threaded by the funnel form) — the
//      fallback, and the ONLY source for cross-origin posts (cic7s.com etc.) where our
//      SameSite=Lax cookies aren't sent.
//
// HARD RULES honoured here:
//   - Never blocks a conversion: EVERY path is wrapped so a failure returns a safe
//     (mostly-null) stamp and the caller's insert proceeds unchanged (Hard Rule 5).
//   - No child PII: the person is the payer's EMAIL only — callers pass the parent's
//     email/name/phone, never a child's (Hard Rule 4).
//
// Reuses the pinned classifier (shared/attribution.ts) and identity service
// (server/identity.ts) — nothing here re-implements that logic.

import type { Request } from "express";
import {
  parseCookieHeader,
  isValidVisitorId,
  isValidClickId,
  VID_COOKIE,
  CID_COOKIE,
} from "./attribution-cookies";
import { classifyTouch, validExternalId, cleanMacroValue, type TouchInput } from "@shared/attribution";
import { getOrCreatePersonByEmail, bindVisitorToPerson } from "./identity";

/** The exact set of AttributionOS columns present on every conversion table (T3). */
export interface ConversionAttribution {
  visitorId: string | null;
  clickId: string | null;
  personId: number | null;
  fbp: string | null;
  fbc: string | null;
  metaAdId: string | null;
  metaAdsetId: string | null;
  metaCampaignId: string | null;
  metaPlatform: string | null;
  attributionChannel: string | null;
}

type StampOnly = Omit<ConversionAttribution, "personId">;

const EMPTY_STAMP: StampOnly = {
  visitorId: null,
  clickId: null,
  fbp: null,
  fbc: null,
  metaAdId: null,
  metaAdsetId: null,
  metaCampaignId: null,
  metaPlatform: null,
  attributionChannel: null,
};

/** The payer's identity fields (parent/payer only — never a child). */
export interface ConversionIdentity {
  email?: unknown;
  phone?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

/** First non-empty string among candidate keys, checked on the body then a nested
 *  `attribution` blob (cugc funnels ship one). Numbers are coerced. */
function pick(body: any, keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const attr = body.attribution && typeof body.attribution === "object" ? body.attribution : null;
  const utm = body.utm && typeof body.utm === "object" ? body.utm : null;
  for (const k of keys) {
    let v = body[k];
    if ((v === undefined || v === null) && attr) v = attr[k];
    if ((v === undefined || v === null) && utm) v = utm[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Read the attribution stamp off a request (cookies + body) WITHOUT touching the DB.
 * Pure with respect to the DB — safe to call anywhere. Never throws.
 */
export function readAttributionStamp(req: Request): StampOnly {
  try {
    const body = (req?.body ?? {}) as any;
    const cookies = parseCookieHeader(req?.headers?.cookie);

    // Server cookie is the source of truth; body is the fallback (cross-origin posts).
    const cookieVid = cookies[VID_COOKIE];
    const visitorId = isValidVisitorId(cookieVid)
      ? cookieVid
      : validExternalId(pick(body, ["visitorId", "visitor_id", "vid"]));

    const cookieCid = cookies[CID_COOKIE];
    const clickId = isValidClickId(cookieCid)
      ? cookieCid
      : validExternalId(pick(body, ["clickId", "click_id", "ci"]));

    // Meta pixel cookies win over the body; both are hygiene-checked (blocks macros).
    const fbp = validExternalId(cookies["_fbp"]) ?? validExternalId(pick(body, ["fbp", "_fbp"]));
    const fbc = validExternalId(cookies["_fbc"]) ?? validExternalId(pick(body, ["fbc", "_fbc"]));

    // Ad-level params only ever arrive in the body (or as {{macros}} → nulled).
    const metaAdId = validExternalId(pick(body, ["metaAdId", "meta_ad_id", "adId", "ad_id"]));
    const metaAdsetId = validExternalId(pick(body, ["metaAdsetId", "meta_adset_id", "adsetId", "adset_id"]));
    const metaCampaignId = validExternalId(pick(body, ["metaCampaignId", "meta_campaign_id", "campaignId", "campaign_id"]));
    const metaPlatform = cleanMacroValue(pick(body, ["metaPlatform", "meta_platform", "publisher_platform", "publisherPlatform"]));

    // Derive the channel deterministically from whatever signals the form carried.
    const touch: TouchInput = {
      utmSource: pick(body, ["utmSource", "utm_source", "source"]),
      utmMedium: pick(body, ["utmMedium", "utm_medium", "medium"]),
      utmCampaign: pick(body, ["utmCampaign", "utm_campaign", "campaign"]),
      utmContent: pick(body, ["utmContent", "utm_content", "content"]),
      utmTerm: pick(body, ["utmTerm", "utm_term", "term"]),
      referralCode: pick(body, ["referralCode", "referral_code", "ref"]),
      clickId,
      fbclid: pick(body, ["fbclid"]),
      gclid: pick(body, ["gclid"]),
      metaAdId,
      metaAdsetId,
      metaCampaignId,
      metaPlatform,
      referrer: pick(body, ["referrer"]) ?? (typeof req?.headers?.referer === "string" ? req.headers.referer : null),
      landingUrl: pick(body, ["landingUrl", "landing_url", "sourceUrl"]),
    };
    const attributionChannel = classifyTouch(touch).channel;

    return { visitorId, clickId, fbp, fbc, metaAdId, metaAdsetId, metaCampaignId, metaPlatform, attributionChannel };
  } catch {
    return { ...EMPTY_STAMP };
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Build the full conversion-attribution object (stamp + resolved personId) for spreading
 * straight into an insert's `.values({...})`. When an email is supplied, resolves/creates
 * the payer person, binds the visitor id to them, and stitches their history. Every
 * failure is swallowed — a conversion is NEVER blocked by attribution (Hard Rule 5).
 */
export async function buildConversionAttribution(
  req: Request,
  identity: ConversionIdentity = {},
): Promise<ConversionAttribution> {
  const stamp = readAttributionStamp(req);
  let personId: number | null = null;
  try {
    const email = str(identity.email);
    if (email) {
      const person = await getOrCreatePersonByEmail(email, {
        phone: str(identity.phone),
        firstName: str(identity.firstName),
        lastName: str(identity.lastName),
      });
      if (person) {
        personId = person.id;
        if (stamp.visitorId) {
          await bindVisitorToPerson(stamp.visitorId, person.id);
        }
      }
    }
  } catch (e) {
    console.error("[attribution] identity resolution failed (non-blocking):", e);
  }
  return { ...stamp, personId };
}
