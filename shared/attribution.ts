// AttributionOS — vocabulary, touch classifier, and conversion waterfall.
//
// PURE logic only. No DB / network / env / Date-of-day access — deterministic so it
// can be unit-tested standalone (script/test-attribution.ts) and reused by both the
// public collector ingest (server) and the reporting query layer.
//
// Everything here implements the PINNED design decisions in AGENTS.md — do not
// re-litigate them. In particular:
//   - Canonical channel vocabulary + synonym map (utm_source normalisation).
//   - GA4-style classifier precedence:
//       referral-code  →  paid (medium/meta-ad/gclid)  →  utm_source  →
//       fbclid-only (meta_unattributed, NEVER paid)  →  known-referrer table  →  direct
//   - Conversion waterfall: referral code → tracked (click-id/UTM) → self-reported
//     (HDYHAU) → unattributed. Deterministic, never blended.
//   - Meta macro hygiene: any value containing "{{" is an unreplaced macro → null.
//   - Illegal-id blocklist ('undefined','null','[object Object]', …) for external ids.
//
// NOTE ON ?ci= (our click id): our short-link redirect always appends the link's
// stored utm params alongside ?ci=, so the CHANNEL is derived from those utm values.
// ?ci= therefore sets the `tracked` flag on the classified touch (and drives the
// "tracked" rung of the conversion waterfall); it does not, on its own, name a channel.

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical channel vocabulary the UI groups/reports by (utm_source normalised). */
export const CANONICAL_CHANNELS = [
  "facebook",
  "instagram",
  "google",
  "email",
  "whatsapp",
  "sms",
  "qr",
  "referral",
  "organic",
  "direct",
  "other",
] as const;

export type CanonicalChannel = (typeof CANONICAL_CHANNELS)[number];

/**
 * Extra recognised channel tokens beyond the canonical set: Meta sub-platforms the
 * synonym map / ad breakdowns can produce, plus the special low-confidence bucket
 * for fbclid-only touches. Kept distinct so reporting can roll them up under Meta.
 */
export const META_UNATTRIBUTED = "meta_unattributed";
export const EXTENDED_CHANNELS = [
  "messenger",
  "audience_network",
  META_UNATTRIBUTED,
] as const;

/** Every channel token classify/normalise can emit. */
export const ALL_CHANNELS = [...CANONICAL_CHANNELS, ...EXTENDED_CHANNELS] as const;
export type Channel = (typeof ALL_CHANNELS)[number] | string;

const RECOGNIZED = new Set<string>([...CANONICAL_CHANNELS, "messenger", "audience_network"]);

/** Raw utm_source token → canonical channel. Always keep the raw value alongside. */
export const SYNONYM_MAP: Record<string, string> = {
  // facebook
  fb: "facebook",
  "fb.com": "facebook",
  "facebook.com": "facebook",
  meta: "facebook",
  "facebook-ads": "facebook",
  fbads: "facebook",
  // instagram
  ig: "instagram",
  insta: "instagram",
  "instagram.com": "instagram",
  "ig-ads": "instagram",
  igads: "instagram",
  // messenger / audience network (Meta sub-platforms)
  msg: "messenger",
  messenger: "messenger",
  an: "audience_network",
  "audience-network": "audience_network",
  audiencenetwork: "audience_network",
  // google
  "google.com": "google",
  googlesearch: "google",
  "google-ads": "google",
  googleads: "google",
  adwords: "google",
  gads: "google",
  // email
  "e-mail": "email",
  newsletter: "email",
  broadcast: "email",
  mailchimp: "email",
  klaviyo: "email",
  resend: "email",
  transactional: "email",
  // whatsapp
  wa: "whatsapp",
  "wa.me": "whatsapp",
  "whats-app": "whatsapp",
  "whatsapp.com": "whatsapp",
  // sms
  text: "sms",
  txt: "sms",
  "text-message": "sms",
  // qr
  qrcode: "qr",
  "qr-code": "qr",
  poster: "qr",
  flyer: "qr",
  // referral (friend / word of mouth)
  ref: "referral",
  friend: "referral",
  wom: "referral",
  "word-of-mouth": "referral",
  // organic / search
  seo: "organic",
  search: "organic",
  // direct
  none: "direct",
  "(direct)": "direct",
  "(none)": "direct",
};

/** utm_medium values that mean paid. */
export const PAID_MEDIUMS = new Set<string>([
  "paid",
  "cpc",
  "ppc",
  "paid_social",
  "paidsocial",
  "paid-social",
  "paid_search",
  "paidsearch",
  "cpm",
  "display",
]);

// ─────────────────────────────────────────────────────────────────────────────
// External-id hygiene
// ─────────────────────────────────────────────────────────────────────────────

/** Junk values that must NEVER be treated as a real external id (case-insensitive). */
export const ILLEGAL_IDS = new Set<string>([
  "undefined",
  "null",
  "none",
  "[object object]",
  "nan",
  "anonymous",
  "guest",
  "",
]);

/**
 * A macro/value from an ad platform, cleaned. Returns null when the value is missing,
 * empty, or contains an unreplaced templating macro (`{{...}}`, incl. the URL-encoded
 * `%7B%7B` form). Otherwise the trimmed string. Meta occasionally ships literal
 * `{{ad.id}}` when a macro fails to render — we must never persist that.
 */
export function cleanMacroValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (s.includes("{{") || s.includes("}}")) return null;
  if (lower.includes("%7b%7b") || lower.includes("%7d%7d")) return null;
  return s;
}

/**
 * True when `value` is a usable external id: a non-empty string, not on the illegal
 * blocklist, not an unreplaced macro, and of sane length. Used before we ever key an
 * identity / click / ad on a supplied value.
 */
export function isValidExternalId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s || s.length > 512) return false;
  if (s.includes("{{") || s.includes("}}")) return false;
  if (ILLEGAL_IDS.has(s.toLowerCase())) return false;
  return true;
}

/** cleanMacroValue + isValidExternalId in one: returns the cleaned id, or null. */
export function validExternalId(value: unknown): string | null {
  const cleaned = cleanMacroValue(value);
  if (cleaned === null) return null;
  return isValidExternalId(cleaned) ? cleaned : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a raw utm_source to a canonical channel token. Returns null for
 * missing/empty/macro values, the mapped canonical channel for known synonyms or
 * recognised tokens, and "other" for any non-empty but unrecognised source (the raw
 * value should be preserved separately in a `_raw` column).
 */
export function normalizeSource(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.includes("{{") || s.includes("}}")) return null; // unreplaced macro
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/\/+$/, ""); // trailing slash
  if (SYNONYM_MAP[s]) return SYNONYM_MAP[s];
  if (RECOGNIZED.has(s)) return s;
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Known-referrer table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a document.referrer against the KNOWN-referrer table (social link shims,
 * organic search). Returns { channel, raw } for a table hit, or null for anything not
 * in the table (the caller then falls through to `direct`, per the pinned precedence).
 */
export function classifyReferrer(referrer: unknown): { channel: string; raw: string } | null {
  if (referrer === null || referrer === undefined) return null;
  const s = String(referrer).trim().toLowerCase();
  if (!s) return null;

  // Native app referrers (android-app://<package>).
  if (s.startsWith("android-app://")) {
    const pkg = s.slice("android-app://".length).split("/")[0];
    if (!pkg) return null;
    if (pkg.includes("instagram")) return { channel: "instagram", raw: pkg };
    if (pkg.includes("facebook") || pkg.includes("katana")) return { channel: "facebook", raw: pkg };
    if (pkg.includes("whatsapp")) return { channel: "whatsapp", raw: pkg };
    if (pkg.includes("google")) return { channel: "google", raw: pkg };
    return null;
  }

  const host = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
  if (!host) return null;

  // Facebook (incl. l./lm./m. link shims and fb.com).
  if (/(^|\.)facebook\.com$/.test(host) || host === "fb.com") return { channel: "facebook", raw: host };
  // Instagram.
  if (/(^|\.)instagram\.com$/.test(host)) return { channel: "instagram", raw: host };
  // WhatsApp.
  if (/(^|\.)whatsapp\.com$/.test(host) || host === "wa.me") return { channel: "whatsapp", raw: host };
  // Twitter/X (no canonical channel → other).
  if (host === "t.co" || /(^|\.)twitter\.com$/.test(host) || host === "x.com")
    return { channel: "other", raw: host };
  // Google (any TLD) → google organic.
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return { channel: "google", raw: host };
  // Other search engines → generic organic.
  if (/(^|\.)(bing|duckduckgo|ecosia)\.com$/.test(host) || /(^|\.)yahoo\.com$/.test(host))
    return { channel: "organic", raw: host };
  // Other well-known social/video/professional referrers → other (raw preserved).
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return { channel: "other", raw: host };
  if (/(^|\.)linkedin\.com$/.test(host) || host === "lnkd.in") return { channel: "other", raw: host };
  if (/(^|\.)tiktok\.com$/.test(host)) return { channel: "other", raw: host };

  return null; // not in the table → caller falls through to direct
}

// ─────────────────────────────────────────────────────────────────────────────
// Touch classifier
// ─────────────────────────────────────────────────────────────────────────────

export interface TouchInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  /** ?ref= / promo/referral code param. */
  referralCode?: string | null;
  /** Our own click id (?ci=), minted by the short-link redirect. */
  clickId?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  /** Meta ad-level params (may arrive as literal {{ad.id}} macros — cleaned here). */
  metaAdId?: string | null;
  metaAdsetId?: string | null;
  metaCampaignId?: string | null;
  /** publisher_platform, when known (facebook|instagram|messenger|audience_network). */
  metaPlatform?: string | null;
  /** document.referrer. */
  referrer?: string | null;
  landingUrl?: string | null;
}

export type TouchMatch =
  | "referral_code"
  | "paid_meta"
  | "paid_google"
  | "paid_medium"
  | "utm_source"
  | "fbclid_organic"
  | "referrer"
  | "direct";

export interface ClassifiedTouch {
  /** Canonical channel (or META_UNATTRIBUTED / messenger / audience_network / other). */
  channel: string;
  /** Raw source/referrer preserved for auditing (never lost). */
  channelRaw: string | null;
  /** Paid ad click (utm_medium paid, or Meta ad params, or gclid). */
  isPaid: boolean;
  /** Arrived via one of OUR tracked short links (?ci=). */
  tracked: boolean;
  /** Which precedence rung fired (deterministic). */
  matchedBy: TouchMatch;
}

/** Map a normalised source onto the Meta family (facebook by default). */
function metaChannelFor(src: string | null, platform: string | null): string {
  const p = platform ? normalizeSource(platform) : null;
  if (p && RECOGNIZED.has(p) && (p === "facebook" || p === "instagram" || p === "messenger" || p === "audience_network"))
    return p;
  if (src === "facebook" || src === "instagram" || src === "messenger" || src === "audience_network") return src;
  return "facebook"; // Meta umbrella
}

/**
 * Classify a single touch into a channel using the pinned GA4-style precedence.
 * Every id/macro is hygiene-checked (validExternalId) before it counts, so a literal
 * `{{ad.id}}` never registers as a real ad param.
 */
export function classifyTouch(input: TouchInput): ClassifiedTouch {
  const src = normalizeSource(input.utmSource);
  const rawSource = typeof input.utmSource === "string" && input.utmSource.trim() ? input.utmSource.trim() : null;
  const medium = typeof input.utmMedium === "string" ? input.utmMedium.trim().toLowerCase() : "";

  const clickId = validExternalId(input.clickId);
  const fbclid = validExternalId(input.fbclid);
  const gclid = validExternalId(input.gclid);
  const referralCode = validExternalId(input.referralCode);
  const metaAdId = validExternalId(input.metaAdId);
  const metaAdsetId = validExternalId(input.metaAdsetId);
  const metaCampaignId = validExternalId(input.metaCampaignId);
  const hasMetaAd = !!(metaAdId || metaAdsetId || metaCampaignId);

  const tracked = !!clickId;

  // 1. Referral / promo code — highest priority.
  if (referralCode) {
    return { channel: "referral", channelRaw: rawSource ?? "referral", isPaid: false, tracked, matchedBy: "referral_code" };
  }

  // 2. Paid — utm_medium paid, OR Meta ad params, OR gclid (gclid only appears on
  //    Google Ads clicks, so it is safe to treat as paid google).
  const isPaidMedium = !!medium && PAID_MEDIUMS.has(medium);
  if (isPaidMedium || hasMetaAd || gclid) {
    if (hasMetaAd || src === "facebook" || src === "instagram" || src === "messenger" || src === "audience_network") {
      return {
        channel: metaChannelFor(src, input.metaPlatform ?? null),
        channelRaw: rawSource ?? "meta_ad",
        isPaid: true,
        tracked,
        matchedBy: "paid_meta",
      };
    }
    if (gclid || src === "google") {
      return { channel: "google", channelRaw: rawSource ?? "gclid", isPaid: true, tracked, matchedBy: "paid_google" };
    }
    return { channel: src ?? "other", channelRaw: rawSource, isPaid: true, tracked, matchedBy: "paid_medium" };
  }

  // 3. utm_source present (organic-tagged link, email, whatsapp, qr, etc.).
  if (src) {
    return { channel: src, channelRaw: rawSource, isPaid: false, tracked, matchedBy: "utm_source" };
  }

  // 4. fbclid with NO utm/ad params → meta_unattributed, NEVER paid (fbclid rides
  //    organic clicks too).
  if (fbclid) {
    return { channel: META_UNATTRIBUTED, channelRaw: "fbclid", isPaid: false, tracked, matchedBy: "fbclid_organic" };
  }

  // 5. Known-referrer table.
  const ref = classifyReferrer(input.referrer);
  if (ref) {
    return { channel: ref.channel, channelRaw: ref.raw, isPaid: false, tracked, matchedBy: "referrer" };
  }

  // 6. Direct.
  return { channel: "direct", channelRaw: null, isPaid: false, tracked, matchedBy: "direct" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-reported (HDYHAU) → channel
// ─────────────────────────────────────────────────────────────────────────────

/** Map a "how did you hear about us?" answer onto a canonical channel. */
export function mapHdyhauToChannel(answer: unknown): string {
  const s = typeof answer === "string" ? answer.trim().toLowerCase() : "";
  if (!s) return "other";
  if (/(friend|teammate|word|referr|family|someone)/.test(s)) return "referral";
  if (/(instagram|insta|\big\b)/.test(s)) return "instagram";
  if (/(facebook|\bfb\b|meta)/.test(s)) return "facebook";
  if (/(google|search|web)/.test(s)) return "google";
  if (/(whatsapp|\bwa\b)/.test(s)) return "whatsapp";
  if (/(email|newsletter|mail)/.test(s)) return "email";
  if (/(\bsms\b|text)/.test(s)) return "sms";
  if (/(poster|flyer|\bqr\b|sign)/.test(s)) return "qr";
  return "other";
}

/**
 * The self-report options shown on success screens (T17 HDYHAU capture). Order
 * is display order. Each `id` is stored verbatim as the conversion row's
 * self-report value and MUST resolve through `mapHdyhauToChannel` to `channel`
 * (guarded by `script/test-attribution-hdyhau.ts`) so the reporting waterfall
 * classifies it consistently.
 */
export const HDYHAU_OPTIONS = [
  { id: "friend_teammate", label: "Friend or Teammate", channel: "referral" },
  { id: "facebook", label: "Facebook", channel: "facebook" },
  { id: "instagram", label: "Instagram", channel: "instagram" },
  { id: "google", label: "Google", channel: "google" },
  { id: "email", label: "Email", channel: "email" },
  { id: "whatsapp", label: "WhatsApp", channel: "whatsapp" },
  { id: "poster_qr", label: "Poster or QR code", channel: "qr" },
  { id: "other", label: "Other", channel: "other" },
] as const;

/** A valid HDYHAU option id, or null. Used server-side to reject junk values. */
export function normalizeHdyhauAnswer(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 200) return null;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion attribution waterfall
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionSignals {
  /** Referral/promo code captured on the conversion. */
  referralCode?: string | null;
  /** Our click id (?ci=) captured at conversion. */
  clickId?: string | null;
  /** The classified last-touch (from utm/referrer), if any. */
  touch?: ClassifiedTouch | null;
  /** Self-reported "how did you hear about us?" answer. */
  hdyhau?: string | null;
}

export type AttributionMethod = "referral" | "tracked" | "self_reported" | "unattributed";

export interface ResolvedAttribution {
  method: AttributionMethod;
  channel: string;
  /** The referral code / hdyhau answer that produced the result (audit), or null. */
  detail: string | null;
}

/**
 * Deterministic conversion waterfall (AGENTS.md): referral code → tracked
 * (click-id/UTM) → self-reported (HDYHAU) → unattributed. Never blends rungs — the
 * first satisfied rung wins.
 */
export function resolveConversionAttribution(signals: ConversionSignals): ResolvedAttribution {
  // 1. Referral / promo code.
  const referralCode = validExternalId(signals.referralCode);
  if (referralCode) {
    return { method: "referral", channel: "referral", detail: referralCode };
  }

  // 2. Tracked — a real click id, OR a classified touch that names a channel other
  //    than pure "direct".
  const clickId = validExternalId(signals.clickId);
  const touch = signals.touch ?? null;
  const touchIsTracked = !!touch && touch.channel !== "direct";
  if (clickId || touchIsTracked) {
    const channel = touch && touch.channel !== "direct" ? touch.channel : "other";
    return { method: "tracked", channel, detail: null };
  }

  // 3. Self-reported (HDYHAU).
  const hdyhau = typeof signals.hdyhau === "string" ? signals.hdyhau.trim() : "";
  if (hdyhau) {
    return { method: "self_reported", channel: mapHdyhauToChannel(hdyhau), detail: hdyhau };
  }

  // 4. Unattributed.
  return { method: "unattributed", channel: "direct", detail: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collector ingest (T6) — bot detection + row shaping
// ─────────────────────────────────────────────────────────────────────────────
//
// The public collector (`/api/public/analytics/event` + `/batch`) accepts loosely
// typed payloads straight off the wire from analytics.js. Everything below is pure
// so it can be unit-tested without a DB: shape a raw event into a row ready for
// `db.insert(analyticsEvents)`, running classifyTouch() at ingest and flagging
// obvious bots. Malformed rows (missing/illegal ids) return null → silently dropped.

/**
 * isbot-style user-agent patterns. Basic but covers the common search crawlers,
 * link unfurlers / social preview fetchers, headless browsers, automation drivers,
 * and CLI HTTP clients. Case-insensitive. The goal is to FLAG (not perfectly block)
 * obvious non-human traffic so reporting can exclude it — analytics rows are still
 * stored, just marked is_bot. Deliberately avoids a bare `bot` substring so device
 * brands like "CUBOT" are not false-flagged; uses `\bbot\b` for the generic case.
 */
const BOT_UA_RE =
  /(googlebot|bingbot|bingpreview|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|facebookexternalhit|facebot|meta-externalagent|ia_archiver|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|dataforseo|blexbot|gptbot|ccbot|claudebot|anthropic-ai|perplexitybot|amazonbot|bytespider|twitterbot|linkedinbot|pinterest|slackbot|discordbot|telegrambot|redditbot|whatsapp\/|skypeuripreview|embedly|quora link preview|vkshare|google-inspectiontool|chrome-lighthouse|headless|phantomjs|electron\/|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|curl\/|wget\/|libwww-perl|scrapy|node-fetch|axios\/|guzzlehttp|postmanruntime|insomnia|uptimerobot|pingdom|statuscake|site24x7|monitoring|\bbot\b|\bcrawler\b|\bspider\b|\bscraper\b)/i;

/**
 * True when a user-agent looks like a bot/crawler/automation. A missing or empty UA
 * is treated as a bot (real browsers always send one; beacon/fetch from analytics.js
 * always include it), as is an absurdly long UA.
 */
export function isBotUserAgent(ua: unknown): boolean {
  if (typeof ua !== "string") return true;
  const s = ua.trim();
  if (!s || s.length > 2048) return true;
  return BOT_UA_RE.test(s);
}

export interface BotSignals {
  /** The request User-Agent header. */
  userAgent?: string | null;
  /** Client-supplied navigator.webdriver hint (true when automation drives the page). */
  webdriver?: unknown;
}

/** Combine the UA blocklist with the client's navigator.webdriver hint. */
export function detectBot(signals: BotSignals): boolean {
  if (signals.webdriver === true || signals.webdriver === "true") return true;
  return isBotUserAgent(signals.userAgent);
}

/** Event types that carry the full attribution bundle → classifyTouch() runs on them. */
export const TOUCH_EVENT_TYPES = new Set<string>(["session_start", "page_view"]);

/** A raw analytics_events row shaped for insertion (drizzle camelCase column keys). */
export interface ShapedAnalyticsEvent {
  visitorId: string;
  sessionId: string;
  eventType: string;
  page: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: string | null;
  browser: string | null;
  screenWidth: number | null;
  campSlug: string | null;
  fbclid: string | null;
  gclid: string | null;
  clickId: string | null;
  fbp: string | null;
  fbc: string | null;
  channel: string | null;
  channelRaw: string | null;
  landingUrl: string | null;
  isBot: boolean;
  metadata: Record<string, unknown> | null;
}

export interface ShapeContext {
  /** The request User-Agent header (shared across a batch of events). */
  userAgent?: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** cleanMacroValue + a length clamp: nulls macros/empties, truncates over `max`. */
function clampText(value: unknown, max: number): string | null {
  const c = cleanMacroValue(value);
  if (c === null) return null;
  return c.length > max ? c.slice(0, max) : c;
}

/** Coerce a value to a finite integer, or null. */
function safeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/**
 * Shape one raw collector payload into an analytics_events row, or null when it is
 * malformed (missing/illegal visitorId, sessionId, or eventType → silently dropped).
 * Runs classifyTouch() on touch-bearing events (session_start / page_view), cleans
 * macro values off every stored field, flags bots, and stashes fields that have no
 * dedicated column (legacyVid for stitching, utmContent/utmTerm) into metadata.
 */
export function shapeAnalyticsEvent(raw: unknown, ctx?: ShapeContext): ShapedAnalyticsEvent | null {
  if (!isPlainObject(raw)) return null;

  // Required identifiers — malformed rows are silently dropped.
  const visitorId = validExternalId(raw.visitorId);
  const sessionId = validExternalId(raw.sessionId);
  if (!visitorId || !sessionId) return null;
  const eventType = clampText(raw.eventType, 64);
  if (!eventType) return null;

  const utmSource = clampText(raw.utmSource, 256);
  const utmMedium = clampText(raw.utmMedium, 256);
  const utmCampaign = clampText(raw.utmCampaign, 256);
  const utmContent = clampText(raw.utmContent, 256);
  const utmTerm = clampText(raw.utmTerm, 256);
  const referrer = clampText(raw.referrer, 2048);
  const landingUrl = clampText(raw.landingUrl, 2048);

  // External ids get the full hygiene pass (illegal-id blocklist + macro + length).
  const fbclid = validExternalId(raw.fbclid);
  const gclid = validExternalId(raw.gclid);
  const clickId = validExternalId(raw.clickId);
  const fbp = clampText(raw.fbp, 512);
  const fbc = clampText(raw.fbc, 512);

  // Classify the touch at ingest — only the touch-bearing events carry the full
  // attribution bundle (fbclid/gclid/clickId), so only they get a channel.
  let channel: string | null = null;
  let channelRaw: string | null = null;
  if (TOUCH_EVENT_TYPES.has(eventType)) {
    const touch = classifyTouch({
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      clickId,
      fbclid,
      gclid,
      referrer,
      landingUrl,
    });
    channel = touch.channel;
    channelRaw = touch.channelRaw;
  }

  // Preserve any client metadata verbatim (the overview endpoint reads
  // trafficSource / isNewVisitor / seconds / maxPercent off it), then add fields
  // that have no dedicated column so downstream stitching/reporting can reach them.
  let metadata: Record<string, unknown> | null = isPlainObject(raw.metadata) ? { ...raw.metadata } : null;
  const extras: Record<string, unknown> = {};
  const legacyVid = validExternalId(raw.legacyVid);
  if (legacyVid) extras.legacyVid = legacyVid;
  if (utmContent) extras.utmContent = utmContent;
  if (utmTerm) extras.utmTerm = utmTerm;
  if (Object.keys(extras).length > 0) metadata = { ...(metadata ?? {}), ...extras };

  return {
    visitorId,
    sessionId,
    eventType,
    page: clampText(raw.page, 1024),
    referrer,
    utmSource,
    utmMedium,
    utmCampaign,
    device: clampText(raw.device, 32),
    browser: clampText(raw.browser, 64),
    screenWidth: safeInt(raw.screenWidth),
    campSlug: clampText(raw.campSlug, 256),
    fbclid,
    gclid,
    clickId,
    fbp,
    fbc,
    channel,
    channelRaw,
    landingUrl,
    isBot: detectBot({ userAgent: ctx?.userAgent, webdriver: raw.webdriver }),
    metadata,
  };
}

/**
 * Shape a batch of raw payloads, dropping malformed rows and capping at `limit`
 * (default 50). Non-array input → empty array.
 */
export function shapeAnalyticsEvents(rawEvents: unknown, ctx?: ShapeContext, limit = 50): ShapedAnalyticsEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  const out: ShapedAnalyticsEvent[] = [];
  for (const raw of rawEvents) {
    if (out.length >= limit) break;
    const shaped = shapeAnalyticsEvent(raw, ctx);
    if (shaped) out.push(shaped);
  }
  return out;
}
