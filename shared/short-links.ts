// AttributionOS — short-link redirect logic (T9), pure + dependency-free.
//
// The `/l/:key` redirect route (server/routes.ts) uses these helpers to:
//   - guard against open redirects (a destination must resolve to one of OUR hosts),
//   - turn 16 random bytes into a url-safe first-party click id,
//   - append the minted click id (?ci=) + the link's stored utm set to the
//     destination WITHOUT clobbering query params the destination already carries,
//   - pick a safe fallback ("the org's main site") for an unknown/inactive key,
//   - build the deterministic dedupe-hash seed (SHA256(ip+ua)) input.
//
// No node built-ins are referenced so this stays client-safe — the T11 links UI
// imports it for the same allow-list + preview logic. All logic here is pure and
// unit-tested in `script/test-attribution-links.ts`.

// Registrable root domains we own. A destination host is allowed iff it EQUALS one
// of these or is a SUBDOMAIN of one (join.minifootball.co.nz, order.unitedprints.co.nz,
// www.cugc.co.nz, …). Keep this list in sync as brands are added.
export const CLUB_ROOT_DOMAINS = [
  "minifootball.co.nz",
  "christchurchunited.co.nz",
  "cicyouth.com",
  "unitedprints.co.nz",
  "southislandunited.com",
  "footballinstitute.co.nz",
  "cugc.co.nz",
  "cufc.co.nz",
  "usg.co.nz",
] as const;

// Our own app host(s) + preview + dev hosts (exact host or suffix match).
const APP_HOSTS = ["clubos.fly.dev"];
const PREVIEW_SUFFIXES = [".vercel.app"];
const DEV_HOSTS = ["localhost", "127.0.0.1"];

// Where an unknown/inactive key sends people when we can't derive a brand root.
export const DEFAULT_MAIN_SITE = "https://christchurchunited.co.nz";

// Funnel subdomains stripped to reach a brand's marketing root for the fallback.
const FUNNEL_PREFIXES = ["join.", "order.", "book.", "app.", "l.", "www."];

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normHost(host: string | null | undefined): string {
  if (!host) return "";
  return String(host).toLowerCase().split(":")[0].trim();
}

/** True when a bare hostname is one of ours (root, subdomain, app, preview, or dev). */
export function hostIsOurs(host: string | null | undefined): boolean {
  const h = normHost(host);
  if (!h) return false;
  if (DEV_HOSTS.includes(h)) return true;
  if (APP_HOSTS.includes(h)) return true;
  if (PREVIEW_SUFFIXES.some((s) => h.endsWith(s))) return true;
  for (const root of CLUB_ROOT_DOMAINS) {
    if (h === root || h.endsWith("." + root)) return true;
  }
  return false;
}

/**
 * True when a destination URL is a safe redirect target: a well-formed http(s) URL
 * whose host is one of ours. Blocks open redirects (evil.com), scheme abuse
 * (javascript:, data:, ftp:), and look-alikes (minifootball.co.nz.evil.com).
 */
export function isAllowedDestination(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const u = parseUrl(raw.trim());
  if (!u) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return hostIsOurs(u.hostname);
}

// base64url alphabet (RFC 4648 §5): index 62 = '-', 63 = '_'. Matches
// node's Buffer.toString("base64url") exactly, but implemented by hand so the
// module needs no Buffer/btoa and stays portable to the client bundle.
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode raw bytes to base64url (no padding). Pure — tests pass fixed arrays. */
export function bytesToBase64Url(bytes: ArrayLike<number>): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] & 0xff;
    const b1 = i + 1 < n ? bytes[i + 1] & 0xff : 0;
    const b2 = i + 2 < n ? bytes[i + 2] & 0xff : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < n) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < n) out += B64URL[b2 & 63];
  }
  return out;
}

/**
 * Turn 16 random bytes into a ~22-char url-safe click id. The server passes
 * crypto.randomBytes(16); the id matches the CID cookie charset (url-safe, no
 * separators) so it can never inject into a Set-Cookie header or the ?ci= param.
 */
export function clickIdFromBytes(bytes: ArrayLike<number>): string {
  return bytesToBase64Url(bytes);
}

export interface LinkUtm {
  channel?: string | null; // → utm_source
  medium?: string | null; // → utm_medium
  campaign?: string | null; // → utm_campaign
  content?: string | null; // → utm_content
}

/**
 * Append our click id (?ci=) + the link's stored utm set to the destination.
 * Existing destination params are PRESERVED — a destination that already sets
 * utm_source keeps its own value; only absent utm keys are filled in. `ci` is
 * always ours, so it overwrites any pre-existing ci.
 */
export function buildRedirectUrl(destination: string, clickId: string, utm?: LinkUtm): string {
  const u = parseUrl(destination);
  if (!u) return destination; // callers only pass allow-listed dests; be defensive
  const setIfAbsent = (k: string, v: string | null | undefined) => {
    if (v == null) return;
    const val = String(v).trim();
    if (!val) return;
    if (!u.searchParams.has(k)) u.searchParams.set(k, val);
  };
  if (clickId) u.searchParams.set("ci", clickId);
  if (utm) {
    setIfAbsent("utm_source", utm.channel);
    setIfAbsent("utm_medium", utm.medium);
    setIfAbsent("utm_campaign", utm.campaign);
    setIfAbsent("utm_content", utm.content);
  }
  return u.toString();
}

/**
 * The "org's main site" fallback for an unknown / inactive / foreign-destination
 * key: the marketing root of whichever brand domain the /l/ link was hit on
 * (funnel subdomains stripped). Only ever returns a host we own; dev/preview hosts
 * fall back to the club default rather than an unreachable https://localhost.
 */
export function mainSiteForHost(host: string | null | undefined): string {
  let h = normHost(host);
  if (!h) return DEFAULT_MAIN_SITE;
  if (DEV_HOSTS.includes(h) || PREVIEW_SUFFIXES.some((s) => h.endsWith(s))) {
    return DEFAULT_MAIN_SITE;
  }
  for (const p of FUNNEL_PREFIXES) {
    if (h.startsWith(p)) {
      h = h.slice(p.length);
      break;
    }
  }
  return hostIsOurs(h) ? "https://" + h : DEFAULT_MAIN_SITE;
}

/**
 * Deterministic seed for the per-click dedupe hash. The server SHA256s this and
 * stores only the digest (never the raw IP). The `||` separator guarantees the
 * (ip, ua) pair is unambiguous — ("1.2.3.4", "") and ("", "1.2.3.4") differ.
 */
export function ipHashSeed(ip: string | null | undefined, ua: string | null | undefined): string {
  return `${ip ?? ""}||${ua ?? ""}`;
}
