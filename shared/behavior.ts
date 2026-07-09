// Phase 1 (Behavioral Depth) — pure event-shaping for the NEW `behavior_events` table.
// This is a SEPARATE pipeline from shared/attribution.ts (session_start/page_view
// touch classification, which is live in production and must not be touched — see
// AGENTS.md rule 4). No DB / network imports here so this unit-tests standalone:
//   npx tsx script/test-behavior.ts

import { detectBot, cleanMacroValue, validExternalId } from "./attribution";

/** The v2 behavioral taxonomy the t.js tracker (T6) will emit. Anything else is dropped. */
export const BEHAVIOR_EVENT_TYPES = [
  "page_leave",
  "scroll",
  "section_view",
  "click",
  "rage_click",
  "route_change",
  "form_start",
  "form_abandon",
  "vitals",
] as const;
export type BehaviorEventType = (typeof BEHAVIOR_EVENT_TYPES)[number];
const BEHAVIOR_EVENT_TYPE_SET = new Set<string>(BEHAVIOR_EVENT_TYPES);

export const VIEWPORT_BUCKETS = ["mobile", "tablet", "desktop"] as const;
export type ViewportBucket = (typeof VIEWPORT_BUCKETS)[number];
const VIEWPORT_BUCKET_SET = new Set<string>(VIEWPORT_BUCKETS);

/** Web Vitals metrics carried by the `vitals` event type. */
export const VITALS_METRICS = ["LCP", "CLS", "INP"] as const;
const VITALS_METRIC_SET = new Set<string>(VITALS_METRICS);

/**
 * A behavior_events row, shaped for insertion (drizzle camelCase column keys).
 * NOTE: `textHash` has no column in the AGENTS.md §3 column list yet — it's an
 * addition required by the §1 taxonomy ("a text hash (NO raw text)"). T2 (schema
 * migration) must add a `text_hash text` column alongside the others.
 */
export interface ShapedBehaviorEvent {
  visitorId: string;
  sessionId: string;
  site: string | null;
  eventType: BehaviorEventType;
  pagePath: string | null;
  cssPath: string | null;
  offsetX: number | null;
  offsetY: number | null;
  viewport: ViewportBucket | null;
  scrollBand: number | null;
  sectionKey: string | null;
  visibleMs: number | null;
  dwellMs: number | null;
  formId: string | null;
  metric: string | null;
  metricValue: number | null;
  textHash: string | null;
  isBot: boolean;
}

export interface ShapeBehaviorContext {
  /** The request User-Agent header (shared across a batch of events). */
  userAgent?: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** cleanMacroValue + control-char strip + a length clamp. */
function clampText(value: unknown, max: number): string | null {
  const c = cleanMacroValue(value);
  if (c === null) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = c.replace(/[\x00-\x1F\x7F]/g, "");
  if (!stripped) return null;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Coerce to a finite number and clamp to [min, max], or null if not numeric. */
function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Non-negative integer, clamped to `max` (guards against garbage/overflow durations). */
function clampNonNegativeInt(value: unknown, max: number): number | null {
  const n = clampNumber(value, 0, max);
  return n === null ? null : Math.round(n);
}

/** Bucket a raw 0-100 scroll percentage to the nearest 10% band (0,10,...,100). */
function bucketScrollBand(value: unknown): number | null {
  const n = clampNumber(value, 0, 100);
  if (n === null) return null;
  return Math.round(n / 10) * 10;
}

/**
 * mobile <768px, tablet <768-1023px, desktop >=1024px — survives responsive layouts
 * because we bucket, never store raw pixel widths. Accepts an explicit bucket string
 * from the client (cheaper than shipping window.innerWidth every event) or a raw
 * viewportWidth to bucket ourselves.
 */
function coerceViewport(raw: Record<string, unknown>): ViewportBucket | null {
  if (typeof raw.viewport === "string") {
    const v = raw.viewport.trim().toLowerCase();
    if (VIEWPORT_BUCKET_SET.has(v)) return v as ViewportBucket;
  }
  const width = clampNumber(raw.viewportWidth, 0, 20000);
  if (width === null) return null;
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

/** Normalise a site hostname: strip protocol/www/path/query, lowercase, cap length. */
function normalizeSite(raw: unknown): string | null {
  const c = cleanMacroValue(raw);
  if (c === null) return null;
  let s = c
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].trim();
  if (!s) return null;
  return s.length > 255 ? s.slice(0, 255) : s;
}

/**
 * Stable non-cryptographic hash (FNV-1a, 32-bit, hex) of client-supplied element
 * text. We NEVER persist raw text (rule: no PII, no arbitrary user-facing copy in
 * the warehouse) — only a hash stable enough to group "same element text" in the
 * top-clicked-elements view.
 */
function hashText(value: unknown): string | null {
  const c = clampText(value, 4096);
  if (c === null) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < c.length; i++) {
    h ^= c.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Shape one raw behavioral collector payload into a behavior_events row, or null
 * when malformed (missing/illegal visitorId/sessionId, or an unrecognised
 * eventType — silently dropped, same convention as shapeAnalyticsEvent). Every
 * field is validated/clamped independently of eventType: a client sending fields
 * outside its event's shape just gets them stored as null (cheaper than per-type
 * branching; rollups only ever read the columns relevant to their event type).
 */
export function shapeBehaviorEvent(raw: unknown, ctx?: ShapeBehaviorContext): ShapedBehaviorEvent | null {
  if (!isPlainObject(raw)) return null;

  const visitorId = validExternalId(raw.visitorId);
  const sessionId = validExternalId(raw.sessionId);
  if (!visitorId || !sessionId) return null;

  const eventTypeRaw = cleanMacroValue(raw.eventType);
  if (!eventTypeRaw || !BEHAVIOR_EVENT_TYPE_SET.has(eventTypeRaw)) return null;
  const eventType = eventTypeRaw as BehaviorEventType;

  const metricRaw = clampText(raw.metric, 16);
  const metricUpper = metricRaw ? metricRaw.toUpperCase() : null;

  return {
    visitorId,
    sessionId,
    site: normalizeSite(raw.site),
    eventType,
    pagePath: clampText(raw.pagePath ?? raw.page, 1024),
    cssPath: clampText(raw.cssPath, 512),
    offsetX: clampNumber(raw.offsetX, 0, 1),
    offsetY: clampNumber(raw.offsetY, 0, 1),
    viewport: coerceViewport(raw),
    scrollBand: bucketScrollBand(raw.scrollBand ?? raw.scrollPercent),
    sectionKey: clampText(raw.sectionKey, 256),
    visibleMs: clampNonNegativeInt(raw.visibleMs, 24 * 60 * 60 * 1000),
    dwellMs: clampNonNegativeInt(raw.dwellMs, 24 * 60 * 60 * 1000),
    formId: clampText(raw.formId, 256),
    metric: metricUpper && VITALS_METRIC_SET.has(metricUpper) ? metricUpper : null,
    metricValue: clampNumber(raw.metricValue, 0, 1_000_000),
    textHash: hashText(raw.text),
    isBot: detectBot({ userAgent: ctx?.userAgent, webdriver: raw.webdriver }),
  };
}

/**
 * Shape a batch of raw payloads, dropping malformed rows and capping at `limit`
 * (default 50). Non-array input → empty array.
 */
export function shapeBehaviorEvents(
  rawEvents: unknown,
  ctx?: ShapeBehaviorContext,
  limit = 50,
): ShapedBehaviorEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  const out: ShapedBehaviorEvent[] = [];
  for (const raw of rawEvents) {
    if (out.length >= limit) break;
    const shaped = shapeBehaviorEvent(raw, ctx);
    if (shaped) out.push(shaped);
  }
  return out;
}

/**
 * T5's `POST /api/public/analytics/behavior` collector maps a raw request body
 * straight to `db.insert(behaviorEvents).values(...)` via this one function — kept
 * here (not inlined in the route) so the shape→insert-rows mapping unit-tests
 * without a database (script/test-behavior-endpoint.ts). Bot-flagged rows are
 * dropped entirely rather than stored-and-flagged (unlike analytics_events):
 * behavior_events has no attribution/audit need to keep bot noise.
 */
export function behaviorEventsToInsert(
  rawEvents: unknown,
  ctx?: ShapeBehaviorContext,
  limit = 50,
): ShapedBehaviorEvent[] {
  return shapeBehaviorEvents(rawEvents, ctx, limit).filter((e) => !e.isBot);
}
