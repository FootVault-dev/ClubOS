/**
 * Marketing Suite — HMAC-signed opaque tokens for the public (no-auth) endpoints.
 *
 * Two tokens: an UNSUBSCRIBE token {profileId, workspaceId, scope} carried by the
 * RFC 8058 one-click header + the visible unsubscribe link, and a PREFERENCE
 * token {profileId, workspaceId} for the preference centre. Both are opaque and
 * unforgeable — a scanner or attacker can't unsubscribe someone else — and verify
 * with a CONSTANT-TIME compare.
 *
 * Secret derivation follows the existing mflUnsubToken convention (server/routes.ts):
 * MARKETING_TOKEN_SECRET → SESSION_SECRET → STRIPE_WEBHOOK_SECRET → dev fallback.
 */

import crypto from "crypto";

const TOKEN_SECRET =
  process.env.MARKETING_TOKEN_SECRET ||
  process.env.SESSION_SECRET ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  "mkt-token-secret-v1";

export type UnsubScope = "global" | "brand";

export interface UnsubscribeTokenPayload {
  profileId: number;
  workspaceId: number;
  scope: UnsubScope;
}
export interface PreferenceTokenPayload {
  profileId: number;
  workspaceId: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(purpose: string, payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, _p: purpose }), "utf8"));
  const sig = b64url(crypto.createHmac("sha256", TOKEN_SECRET).update(`${purpose}.${body}`).digest());
  return `${body}.${sig}`;
}

function verify<T>(purpose: string, token: string | undefined | null): T | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac("sha256", TOKEN_SECRET).update(`${purpose}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Constant-time compare (length-guarded — timingSafeEqual throws on length mismatch).
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(fromB64url(body).toString("utf8"));
    if (parsed?._p !== purpose) return null;
    delete parsed._p;
    return parsed as T;
  } catch {
    return null;
  }
}

// ── Unsubscribe token ──────────────────────────────────────────────────────
export function signUnsubscribeToken(p: UnsubscribeTokenPayload): string {
  return sign("unsub", { i: p.profileId, w: p.workspaceId, s: p.scope });
}
export function verifyUnsubscribeToken(token: string | undefined | null): UnsubscribeTokenPayload | null {
  const raw = verify<{ i: number; w: number; s: UnsubScope }>("unsub", token);
  if (!raw || typeof raw.i !== "number" || typeof raw.w !== "number") return null;
  const scope: UnsubScope = raw.s === "global" ? "global" : "brand";
  return { profileId: raw.i, workspaceId: raw.w, scope };
}

// ── Preference-centre token ────────────────────────────────────────────────
export function signPreferenceToken(p: PreferenceTokenPayload): string {
  return sign("prefs", { i: p.profileId, w: p.workspaceId });
}
export function verifyPreferenceToken(token: string | undefined | null): PreferenceTokenPayload | null {
  const raw = verify<{ i: number; w: number }>("prefs", token);
  if (!raw || typeof raw.i !== "number" || typeof raw.w !== "number") return null;
  return { profileId: raw.i, workspaceId: raw.w };
}
