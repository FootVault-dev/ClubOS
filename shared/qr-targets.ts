/**
 * Where a QR code / tracked link should point for a given business + programme.
 *
 * The QR Code Generator is a UNIVERSAL tab: it is not scoped to the workspace
 * you happen to be standing in, so the person building a poster has to say
 * which business it is for. That makes the destination derivable rather than
 * typed, which matters because a wrong URL on a printed poster is expensive to
 * discover and impossible to correct.
 *
 * Every host below is a `joinHost` from shared/org-domains.ts (one source of
 * truth) and every path shape was verified live on 2026-09-03.
 */
import { WORKSPACE_DOMAINS, workspaceDomainByOrgId } from "./org-domains.js";
import { isAllowedDestination } from "./short-links.js";

export interface QrProgramme {
  id: number;
  slug: string;
  name: string;
  type: string | null;
  isActive: boolean;
  registrationOpen: boolean;
}

export interface QrBusiness {
  orgId: number;
  slug: string;
  name: string;
  /** null when the workspace has no public funnel host (United Sports Group). */
  joinHost: string | null;
  programmes: QrProgramme[];
}

/** The public home page of a business's funnel, when it has one. */
export function businessHomeUrl(orgId: number): string | null {
  const host = workspaceDomainByOrgId(orgId)?.joinHost;
  return host ? `https://${host}/` : null;
}

/**
 * The real public URL a parent lands on for one programme.
 *
 *   holiday_camp  → https://{joinHost}/{slug}          the camp landing page
 *   academy       → https://{joinHost}/{slug}/class-book   the light checkout
 *   league_team   → https://{joinHost}/league/{slug}
 *
 * 🔴 `academy` deliberately uses /class-book and NOT /academy/:slug. The latter
 * hard-requires full NZF identity (iwi, nationality code, region) — correct for
 * a CUFC academy registration, absurd behind a QR code on a poster.
 */
export function programmeUrl(orgId: number, p: Pick<QrProgramme, "slug" | "type">): string | null {
  const host = workspaceDomainByOrgId(orgId)?.joinHost;
  if (!host || !p.slug) return null;
  switch (p.type) {
    case "holiday_camp": return `https://${host}/${p.slug}`;
    case "academy":      return `https://${host}/${p.slug}/class-book`;
    case "league_team":  return `https://${host}/league/${p.slug}`;
    default:             return `https://${host}/${p.slug}`;
  }
}

/**
 * Suggested destination for a (business, programme?) pair — the programme's own
 * page, else the business's funnel home. Returns null rather than a guess when
 * the result would not survive the open-redirect allow-list, so the form never
 * offers a destination the server will refuse.
 */
export function suggestedDestination(orgId: number, programme?: Pick<QrProgramme, "slug" | "type"> | null): string | null {
  const url = programme ? programmeUrl(orgId, programme) : businessHomeUrl(orgId);
  return url && isAllowedDestination(url) ? url : null;
}

/** Businesses that can carry a public QR destination at all. */
export function businessesWithFunnels(): { orgId: number; slug: string; name: string; joinHost: string }[] {
  return WORKSPACE_DOMAINS.filter((w) => !!w.joinHost)
    .map((w) => ({ orgId: w.orgId, slug: w.slug, name: w.name, joinHost: w.joinHost! }));
}
