// AttributionOS — cross-root visitor alias recorder (T13).
//
// When a visitor crosses between two of our brand roots (e.g. minifootball.co.nz →
// join.cic.co.nz), the T12 `/t.js` tracker decorates the outbound link with
// `?vi=<their id on the origin root>`. The T4 cookie middleware ACCEPTS that on the
// destination landing (server/attribution-cookies.ts → decideAttributionCookies):
//   - no first-party id here yet → adopt the decorated id (no alias needed);
//   - a DIFFERENT first-party id already here → keep ours, and record an `alias`
//     analytics event linking the two visitor ids.
//
// The alias event is what identity stitching (server/identity.ts →
// stitchVisitorHistory) follows to treat both spines as one person, in either
// direction. Its shape:
//   visitor_id = <the id we keep>, event_type = 'alias',
//   metadata   = { aliasVisitorId: <the decorated origin id>, source: 'cross-root' }
//
// Hard Rule 4: no child PII — this only ever stores opaque visitor ids, a path, and a
// user-agent. Defensive: never throws (the middleware fires it and forgets).

import { db } from "./db";
import { analyticsEvents } from "@shared/schema";
import type { VisitorAlias } from "./attribution-cookies";

/** The analytics_events.event_type used for cross-root visitor links. */
export const ALIAS_EVENT_TYPE = "alias";

export interface AliasEventContext {
  /** the landing path the crossing happened on (no query string) */
  page?: string | null;
  /** the full landing URL incl. the `?vi=`/`?ci=` decoration, for debugging */
  landingUrl?: string | null;
  /** request user-agent (used only for context; bots are already skipped upstream) */
  userAgent?: string | null;
}

/**
 * Persist a cross-root visitor alias as an analytics event. Idempotency is not
 * required: the middleware only fires this when `?vi=` is present on the URL (i.e. the
 * first landing after a decorated click), and stitchVisitorHistory reads links with
 * SELECT DISTINCT, so a rare duplicate row is harmless. Swallows all errors.
 */
export async function recordVisitorAlias(
  alias: VisitorAlias,
  ctx: AliasEventContext = {},
): Promise<void> {
  try {
    await db.insert(analyticsEvents).values({
      visitorId: alias.keep,
      // synthetic session id — an alias is a linking record, not part of a page session
      sessionId: `alias:${alias.keep}`,
      eventType: ALIAS_EVENT_TYPE,
      page: ctx.page ?? null,
      landingUrl: ctx.landingUrl ?? null,
      metadata: { aliasVisitorId: alias.alias, source: "cross-root" },
    });
  } catch {
    // attribution must never break a page load — swallow.
  }
}
