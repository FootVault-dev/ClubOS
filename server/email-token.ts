// AttributionOS — email click tokens (T14, server side).
//
// A broadcast decorates each recipient's ours-domain links with `ci=<token>`. The
// token is derived by HMAC over (orgId, campaignId, email) — the same signed
// pattern as mflUnsubToken — so it's deterministic (re-sends reuse it, no dup rows)
// and unforgeable, and stored in email_click_tokens so it can be resolved back to
// the recipient email on click. When the cookie middleware (T13) sees a fresh
// `?ci=emc…` it fire-and-forgets resolveAndBindEmailClick, which maps token → email
// → person and binds the current visitor (retroactively stitching their history).
//
// The pure href-rewriter lives in shared/email-attribution.ts (client-safe, tested);
// this file owns the crypto + DB and is imported lazily by the middleware so
// attribution-cookies.ts stays DB-free.

import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { emailClickTokens } from "@shared/schema";
import { EMAIL_CI_PREFIX } from "@shared/email-attribution";
import { normalizeEmail } from "@shared/identity";
import { getOrCreatePersonByEmail, bindVisitorToPerson } from "./identity";

const EMAIL_TOKEN_SECRET =
  process.env.SESSION_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "email-ci-secret-v1";

// 24 bytes of HMAC (192 bits) → 32 base64url chars; with the 3-char prefix the
// token is 35 chars — well under the 64-char click-id limit (isValidClickId).
const TOKEN_BYTES = 24;

/**
 * Deterministic per-recipient click token for a broadcast. url-safe (base64url +
 * the emc prefix), so it passes isValidClickId and rides the usg_cid cookie.
 * Returns null for a bad email so callers can fall back to no-ci instrumentation.
 */
export function emailClickToken(orgId: number | null, campaignId: number | null, email: unknown): string | null {
  const normEmail = normalizeEmail(email);
  if (!normEmail) return null;
  const msg = `${orgId ?? 0}:${campaignId ?? 0}:${normEmail}`;
  const digest = crypto.createHmac("sha256", EMAIL_TOKEN_SECRET).update(msg).digest();
  return EMAIL_CI_PREFIX + digest.subarray(0, TOKEN_BYTES).toString("base64url");
}

/**
 * Generate the token AND persist the token → email mapping. Best-effort: returns
 * the token even if the row insert fails (the click still carries channel=email
 * via the utm params; only the identity bind is lost). onConflictDoNothing so a
 * re-send of the same campaign never errors on the unique token.
 */
export async function recordEmailClickToken(
  orgId: number | null,
  campaignId: number | null,
  email: unknown,
): Promise<string | null> {
  const token = emailClickToken(orgId, campaignId, email);
  if (!token) return null;
  const normEmail = normalizeEmail(email);
  if (!normEmail) return null;
  try {
    await db
      .insert(emailClickTokens)
      .values({ token, organizationId: orgId ?? null, campaignId: campaignId ?? null, email: normEmail })
      .onConflictDoNothing({ target: emailClickTokens.token });
  } catch {
    // mapping write is best-effort — never block the send
  }
  return token;
}

/**
 * Called by the cookie middleware on a fresh email `?ci=` landing: resolve the
 * token back to its recipient email, ensure the payer person exists, and bind the
 * current visitor to them (which retroactively stitches their anonymous history).
 * Fully swallowed — attribution must never break a page load.
 */
export async function resolveAndBindEmailClick(token: unknown, visitorId: unknown): Promise<void> {
  try {
    if (typeof token !== "string" || !token.startsWith(EMAIL_CI_PREFIX)) return;
    if (typeof visitorId !== "string" || !visitorId) return;
    const [row] = await db
      .select({ email: emailClickTokens.email })
      .from(emailClickTokens)
      .where(eq(emailClickTokens.token, token))
      .limit(1);
    if (!row || !row.email) return;
    const person = await getOrCreatePersonByEmail(row.email);
    if (!person) return;
    await bindVisitorToPerson(visitorId, person.id);
  } catch {
    // swallow — never block a page load
  }
}
