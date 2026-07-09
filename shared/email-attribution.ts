// AttributionOS — email link instrumentation (T14).
//
// Pure, client-safe helpers that rewrite the `href`s in an outgoing email so a
// click lands on our funnels carrying attribution:
//   - utm_source=email
//   - utm_medium=broadcast | transactional
//   - utm_campaign=<slug/id>
//   - ci=<token>          (broadcasts only — a per-recipient signed click token
//                           that server/email-token.ts resolves back to the
//                           recipient email for an identity bind on click)
//
// Only links to OUR OWN domains are touched (open-set safe via hostIsOurs) and
// only real landing pages — `/api/...` links (e.g. the unsubscribe endpoint) are
// left alone. The rewrite is IDEMPOTENT: each param is appended only when the URL
// does not already carry it, so re-running over already-instrumented HTML is a
// no-op (broadcasts re-send the same body per recipient).
//
// No node/DB imports — token GENERATION (HMAC + storage) lives server-side in
// server/email-token.ts; this module just splices a supplied `ci` string in.
// Unit-tested in script/test-attribution-email.ts.

import { hostIsOurs } from "./short-links";

// Fast-path marker every email `ci` token starts with, so the cookie middleware
// (T13) only attempts an email→identity resolve for tokens that look like ours,
// not for every tracked link-redirect click id. Kept url-safe (base64url charset)
// so it survives isValidClickId. server/email-token.ts prepends it.
export const EMAIL_CI_PREFIX = "emc";

export interface EmailUtmOptions {
  /** utm_source — defaults to "email". */
  source?: string;
  /** utm_medium — "broadcast" | "transactional". */
  medium: string;
  /** utm_campaign — a slug or campaign id. Omitted when empty. */
  campaign?: string | null;
  /** Per-recipient signed click token (broadcasts only). Omitted when empty. */
  ci?: string | null;
}

// Matches an href attribute and captures its quote + raw value. Lazy so it stops
// at the closing quote; [\s\S] so a stray newline inside the tag can't break it.
const HREF_RE = /(\bhref\s*=\s*)(["'])([\s\S]*?)\2/gi;

interface SplitUrl {
  base: string;   // scheme + host + path (everything before ? and #)
  query: string;  // between ? and # (without the leading ?)
  hash: string;   // after # (without the leading #)
}

function splitUrl(url: string): SplitUrl {
  let rest = url;
  let hash = "";
  const hi = rest.indexOf("#");
  if (hi >= 0) {
    hash = rest.slice(hi + 1);
    rest = rest.slice(0, hi);
  }
  let query = "";
  const qi = rest.indexOf("?");
  if (qi >= 0) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }
  return { base: rest, query, hash };
}

// True when the query already carries `key=` — tolerant of both `&` and the
// HTML-entity-encoded `&amp;` separator so idempotency holds either way.
function queryHasKey(query: string, key: string): boolean {
  if (!query) return false;
  for (const pair of query.split(/&(?:amp;)?/)) {
    const name = pair.split("=")[0];
    if (name === key) return true;
  }
  return false;
}

function reassemble(parts: SplitUrl): string {
  let out = parts.base;
  if (parts.query) out += "?" + parts.query;
  if (parts.hash) out += "#" + parts.hash;
  return out;
}

/**
 * Instrument a single URL string. Returns the URL unchanged unless it is an
 * absolute http(s) link to one of our own non-`/api` pages, in which case the
 * absent utm_* (+ optional ci) params are appended. Idempotent per param.
 */
export function instrumentUrl(url: string, opts: EmailUtmOptions): string {
  if (typeof url !== "string") return url;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return url; // mailto:, tel:, #anchor, relative

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return url;
  }
  if (!hostIsOurs(parsed.hostname)) return url;
  if (parsed.pathname.startsWith("/api/") || parsed.pathname === "/api") return url;

  const parts = splitUrl(trimmed);
  const append = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    if (queryHasKey(parts.query, key)) return; // idempotent
    const pair = `${key}=${encodeURIComponent(value)}`;
    parts.query = parts.query ? `${parts.query}&${pair}` : pair;
  };

  append("utm_source", opts.source || "email");
  append("utm_medium", opts.medium);
  append("utm_campaign", opts.campaign);
  append("ci", opts.ci);

  return reassemble(parts);
}

/**
 * Rewrite every `href` in an HTML email body via instrumentUrl. Non-ours and
 * non-http links pass through untouched. Idempotent — safe to run over HTML that
 * was already instrumented.
 */
export function instrumentEmailHtml(html: string, opts: EmailUtmOptions): string {
  if (typeof html !== "string" || !html) return html;
  return html.replace(HREF_RE, (_m, pre: string, quote: string, value: string) => {
    return `${pre}${quote}${instrumentUrl(value, opts)}${quote}`;
  });
}

/** Slugify a free-text campaign name into a utm-safe token (lowercase, dashed). */
export function slugifyEmailCampaign(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
