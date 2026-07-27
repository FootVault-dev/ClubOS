/**
 * Marketing Suite — per-brand identity for the send engine + public pages.
 *
 * The single place that maps a workspace/org id to (a) its `brand_key` — the
 * scope key for brand-level suppressions — and (b) the visual shell (accent /
 * background / logo / name) used to render the branded unsubscribe + preference
 * pages, so a CUFC unsubscribe page looks like CUFC and an MFL one like MFL.
 *
 * Brand keys mirror server/marketing/ingest.ts (BRAND_KEY_BY_ORG) — keep in sync.
 * Colours mirror the existing per-brand unsub pages in server/routes.ts.
 */

import { workspaceDomainByOrgId } from "@shared/org-domains";

// org id → brand_key. Sponsors/print rows carry their own organizationId.
export const BRAND_KEY_BY_ORG: Record<number, string> = {
  1: "cufc", 2: "siu", 3: "mfl", 4: "usc", 5: "cic", 6: "cugc", 7: "usg", 8: "prints",
};

export function brandKeyForWorkspace(orgId: number | null | undefined): string | null {
  if (orgId == null) return null;
  return BRAND_KEY_BY_ORG[orgId] ?? String(orgId);
}

export interface BrandShell {
  brandKey: string;
  name: string;
  /** Accent colour (buttons / labels). */
  accent: string;
  /** Page background. */
  bg: string;
  /** Body text colour. */
  fg: string;
  /** Optional hosted logo (only where we're confident the asset exists). */
  logoUrl?: string;
  /** Public host to build links against (join.* where available, else the email domain). */
  linkHost: string;
}

// Palettes lifted from the live per-brand unsub pages (mflUnsubPage / cicUnsubPage
// / cufcUnsubPage) plus sensible defaults for the rest. `fg` is a light body grey.
const SHELLS: Record<string, Omit<BrandShell, "brandKey" | "linkHost">> = {
  cufc:   { name: "Christchurch United FC",         accent: "#7d95ff", bg: "#030711", fg: "#e6e6e6" },
  siu:    { name: "South Island United",            accent: "#c59949", bg: "#0d0f0d", fg: "#e6e6e6" },
  mfl:    { name: "Mini Football Leagues",          accent: "#d1b96e", bg: "#000000", fg: "#e6e6e6", logoUrl: "https://join.minifootball.co.nz/logos/mini-football-leagues.png" },
  usc:    { name: "United Sports Centre",           accent: "#4ea1ff", bg: "#0a0e14", fg: "#e6e6e6" },
  cic:    { name: "Christchurch International Cup",  accent: "#c9a43e", bg: "#0b0b08", fg: "#e6e6e6" },
  cugc:   { name: "United Gymnastics",              accent: "#8b5cf6", bg: "#0c0a12", fg: "#e6e6e6" },
  usg:    { name: "United Sports Group",            accent: "#7d95ff", bg: "#05070c", fg: "#e6e6e6" },
  prints: { name: "United Prints",                  accent: "#ff7a45", bg: "#0c0a09", fg: "#e6e6e6" },
};

const DEFAULT_SHELL: Omit<BrandShell, "brandKey" | "linkHost"> = {
  name: "United Sports Group", accent: "#7d95ff", bg: "#05070c", fg: "#e6e6e6",
};

export function brandShell(orgId: number | null | undefined): BrandShell {
  const brandKey = brandKeyForWorkspace(orgId) ?? "usg";
  const shell = SHELLS[brandKey] ?? DEFAULT_SHELL;
  const wd = workspaceDomainByOrgId(orgId ?? undefined);
  const linkHost = wd?.joinHost || wd?.emailDomain || "cufc.co.nz";
  return { brandKey, linkHost, ...shell };
}

/** The public base URL the RFC 8058 / preference links point at (https, no trailing slash). */
export function publicBaseUrl(): string {
  // App is served from app.usg.co.nz; overridable for staging/dev.
  const raw = process.env.MARKETING_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "https://app.usg.co.nz";
  return raw.replace(/\/+$/, "");
}
