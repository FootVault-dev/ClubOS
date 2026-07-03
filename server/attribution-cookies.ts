// AttributionOS — first-party visitor/click cookie middleware (T4).
//
// A tiny, defensive Express middleware that owns the two first-party attribution
// cookies for every real page load:
//   - usg_vid : the visitor id (uuid, 2-year sliding window)   — "who"
//   - usg_cid : the click id    (90-day sliding window)         — "which click"
//
// Design decisions (pinned in AGENTS.md, do not re-litigate here):
//   - Cookies are set from the SERVER via HTTP Set-Cookie, never from JS.
//   - SameSite=Lax, Secure (on https), NOT HttpOnly — the client analytics script
//     reads them back, so they must be JS-visible.
//   - An incoming `?ci=<clickId>` on the landing URL seeds/overrides usg_cid so a
//     redirect (/l/:key → destination?ci=…, T9) plants the click on first paint.
//   - An incoming `?vi=<visitorId>` (T12 tracker decorates cross-root links with it)
//     is ACCEPTED on the landing (T13): if this root has no first-party id yet we
//     adopt it so the spine is unbroken; if it differs from an id we already have we
//     keep ours and record an `alias` event linking the two so identity stitching
//     (T7) can bridge them.
//   - The middleware MUST NEVER throw: attribution can never block a page load.
//
// All the decision logic is pure and unit-tested in
// `script/test-attribution-spine.ts` (no Express, no DB). The exported middleware
// is a thin wrapper that reads req/res and applies the pure result.

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { validExternalId } from "../shared/attribution";
import { EMAIL_CI_PREFIX } from "../shared/email-attribution";

export const VID_COOKIE = "usg_vid";
export const CID_COOKIE = "usg_cid";

// 2 years for the visitor id, 90 days for the click id (in seconds).
export const VID_MAX_AGE_SECONDS = 2 * 365 * 24 * 60 * 60; // 63,072,000
export const CID_MAX_AGE_SECONDS = 90 * 24 * 60 * 60; // 7,776,000

// A visitor id is one of our uuids (crypto.randomUUID → 36 chars incl. hyphens).
// A click id is our url-safe base64 (T9, ~22 chars). Both restricted to a url-safe
// charset so a value read from a cookie or `?ci=` can NEVER inject a `;`, `,` or
// newline into a Set-Cookie header.
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Requests we skip entirely: only real (HTML) page loads should carry Set-Cookie.
// This keeps API JSON responses and every static asset fetch header-clean.
const STATIC_ASSET_RE =
  /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|json|txt|xml|wasm|mp4|webm|mp3|pdf)$/i;

export function isValidVisitorId(value: unknown): boolean {
  if (validExternalId(value) === null) return false;
  return typeof value === "string" && VID_RE.test(value);
}

export function isValidClickId(value: unknown): boolean {
  if (validExternalId(value) === null) return false;
  return typeof value === "string" && CID_RE.test(value);
}

/**
 * Parse a raw `Cookie:` request header into a name→value map. Tolerant of quoting,
 * URL-encoding, and malformed pairs (skipped). Never throws.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value if it isn't valid percent-encoding
    }
    // last write wins — matches browser behaviour for duplicate names
    out[name] = value;
  }
  return out;
}

export interface SetCookieSpec {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

export interface CookieDecisionInput {
  /** parsed request cookies (see parseCookieHeader) */
  cookies: Record<string, string>;
  /** the `?ci=` query param off the landing URL, if any */
  ciParam?: string | null;
  /** the `?vi=` query param (T12 tracker decorates cross-root links with it), if any */
  viParam?: string | null;
  /** visitor-id generator, injected so tests are deterministic */
  mintVisitorId: () => string;
}

/**
 * A cross-root visitor crossing (T13): the visitor arrived carrying a decorated
 * `?vi=` id that DIFFERS from the first-party cookie we already hold on this root, so
 * one human now has two visitor spines. We keep our own id and record the pair as an
 * `alias` event so identity stitching (T7) can later treat both spines as one person.
 */
export interface VisitorAlias {
  /** the first-party visitor id we keep on this root (never overwritten) */
  keep: string;
  /** the decorated `?vi=` id from the origin root, to be stitched to `keep` */
  alias: string;
}

export interface CookieDecision {
  /** the visitor id for this request (reused if valid, adopted from `?vi=`, else minted) */
  visitorId: string;
  /** the click id for this request, or null when there is none */
  clickId: string | null;
  /** cookies to Set-Cookie on the response */
  setCookies: SetCookieSpec[];
  /** non-null when an `alias` analytics event should be recorded (see VisitorAlias) */
  alias: VisitorAlias | null;
}

/**
 * Pure decision: given the request cookies, a possible `?ci=` and a possible `?vi=`,
 * work out the visitor id + click id, which cookies to (re)set, and whether a
 * cross-root alias should be recorded. Sliding windows: an active visitor's cookies
 * are re-issued on every page load so they never expire mid-use.
 */
export function decideAttributionCookies(input: CookieDecisionInput): CookieDecision {
  const setCookies: SetCookieSpec[] = [];

  const existingVid = input.cookies[VID_COOKIE];
  const decoratedVid = isValidVisitorId(input.viParam) ? String(input.viParam) : null;

  // Visitor id resolution with cross-root acceptance (T13):
  //   - a valid existing cookie wins (it's our first-party id for this root);
  //   - otherwise adopt a valid decorated `?vi=` (the visitor came from another brand
  //     root and has no id here yet — take theirs so the spine is unbroken);
  //   - otherwise mint a fresh one.
  let visitorId: string;
  let alias: VisitorAlias | null = null;
  if (isValidVisitorId(existingVid)) {
    visitorId = existingVid;
    // A decorated id that DIFFERS from our own means two spines for one human — record
    // the link (we never overwrite our first-party cookie with a decorated id).
    if (decoratedVid && decoratedVid !== existingVid) {
      alias = { keep: existingVid, alias: decoratedVid };
    }
  } else if (decoratedVid) {
    visitorId = decoratedVid;
  } else {
    visitorId = input.mintVisitorId();
  }
  // Always (re)issue to slide the 2-year window forward for returning visitors.
  setCookies.push({ name: VID_COOKIE, value: visitorId, maxAgeSeconds: VID_MAX_AGE_SECONDS });

  // Click id: a fresh `?ci=` wins (a new tracked click); otherwise refresh the
  // existing click cookie so it survives the 90-day window while still active.
  let clickId: string | null = null;
  if (isValidClickId(input.ciParam)) {
    clickId = String(input.ciParam);
  } else if (isValidClickId(input.cookies[CID_COOKIE])) {
    clickId = input.cookies[CID_COOKIE];
  }
  if (clickId) {
    setCookies.push({ name: CID_COOKIE, value: clickId, maxAgeSeconds: CID_MAX_AGE_SECONDS });
  }

  return { visitorId, clickId, setCookies, alias };
}

/**
 * Serialize a cookie spec into a Set-Cookie header value. Path=/, SameSite=Lax,
 * Secure (when the connection is https), and deliberately NOT HttpOnly so the
 * client analytics script can read the visitor/click ids.
 *
 * `domain` scopes the cookie to a registrable root (e.g. `minifootball.co.nz`) so
 * the funnel subdomain and the marketing root share ONE first-party cookie — the
 * T12 `/api/public/analytics/hello` boot uses this so join.brand + brand.co.nz see
 * the same usg_vid. Omit it (the default) for a host-only cookie (T4 middleware).
 */
export function serializeSetCookie(
  spec: SetCookieSpec,
  opts?: { secure?: boolean; domain?: string | null; sameSite?: "Lax" | "Strict" | "None" },
): string {
  const secure = opts?.secure !== false; // default to Secure unless explicitly disabled
  const parts = [`${spec.name}=${encodeURIComponent(spec.value)}`, "Path=/", `Max-Age=${spec.maxAgeSeconds}`];
  if (opts?.domain) parts.push(`Domain=${opts.domain}`);
  parts.push(`SameSite=${opts?.sameSite || "Lax"}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function firstQueryValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/**
 * Express middleware — mounted before the routes, applied only to real (non-API,
 * non-asset) GET page loads. Ensures usg_vid + refreshes usg_cid via Set-Cookie,
 * and hangs the resolved ids off the request for any downstream handler that wants
 * them. Wrapped so a failure here can NEVER break a page load.
 */
export function attributionCookieMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.method !== "GET") return next();
    const path = req.path || "";
    if (path.startsWith("/api")) return next();
    if (STATIC_ASSET_RE.test(path)) return next();

    const cookies = parseCookieHeader(req.headers.cookie);
    const ciParam = firstQueryValue(req.query?.ci);
    const viParam = firstQueryValue(req.query?.vi);

    const decision = decideAttributionCookies({
      cookies,
      ciParam,
      viParam,
      mintVisitorId: () => randomUUID(),
    });

    const secure = Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";
    for (const spec of decision.setCookies) {
      // append (not set) so we never clobber a session Set-Cookie on the same response
      res.append("Set-Cookie", serializeSetCookie(spec, { secure }));
    }

    // Cross-root crossing (T13): the visitor carried a decorated id that differs from
    // ours. Link the two spines so identity stitching can bridge them later. This is a
    // fire-and-forget DB write, loaded lazily so this module stays DB-free (and its
    // pure logic unit-testable). Never block the page load; swallow any failure.
    if (decision.alias) {
      const aliasSpec = decision.alias;
      const ctx = {
        page: req.path || null,
        landingUrl: typeof req.originalUrl === "string" ? req.originalUrl : null,
        userAgent: (req.headers["user-agent"] as string | undefined) || null,
      };
      void import("./attribution-alias")
        .then((m) => m.recordVisitorAlias(aliasSpec, ctx))
        .catch(() => {});
    }

    // Email click (T14): a fresh `?ci=emc…` on this landing is a per-recipient
    // broadcast click token. Resolve it back to the recipient email and bind THIS
    // visitor to that person (retroactively stitching their anonymous history). Only
    // the URL param counts as a fresh click — the usg_cid cookie carries the token
    // forward on later page views, but we bind once, on the email-click landing. The
    // dynamic import keeps this module DB-free (spine test loads it); fully swallowed.
    if (typeof ciParam === "string" && ciParam.startsWith(EMAIL_CI_PREFIX) && isValidClickId(ciParam)) {
      const emailCi = ciParam;
      const boundVisitor = decision.visitorId;
      void import("./email-token")
        .then((m) => m.resolveAndBindEmailClick(emailCi, boundVisitor))
        .catch(() => {});
    }

    // expose for any downstream handler in this request lifecycle
    (req as any).usgVid = decision.visitorId;
    (req as any).usgCid = decision.clickId;
  } catch {
    // swallow — attribution must never block a page load
  }
  next();
}
