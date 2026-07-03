/**
 * Per-club branding for the public holiday-camp flow (booking form, checkout,
 * success, feedback). The landing page carries the full brand identity in its
 * own component; these tokens keep the utility pages (light forms) on-brand
 * without forking them.
 *
 * The org slug comes from the camp's owning organisation — returned by
 * /api/public/camps/:slug (organization.slug) and /api/public/checkout/:id
 * (organizationSlug).
 */

export const SIU_ORG_SLUG = "south-island-united";

export interface CampBrand {
  /** Primary action colour (buttons, selected states, step markers). */
  primary: string;
  /** Dark heading / emphasis colour. */
  dark: string;
  /** Page background. */
  pageBg: string;
  /** Accent (highlights, selection summary). */
  gold: string;
  /** Short mark shown in the compact header chip. */
  monogram: string;
  /** Club display name for headers/footers. */
  clubName: string;
  /** Crest served from client/public. */
  logoUrl: string;
}

export const CUFC_BRAND: CampBrand = {
  primary: "#22399B",
  dark: "#221F7A",
  pageBg: "#FBFBFC",
  gold: "#D9B10F",
  monogram: "CU",
  clubName: "Christchurch United FC",
  logoUrl: "/logos/christchurch-united.png",
};

export const SIU_BRAND: CampBrand = {
  // Pupila identity — Unity Black, Leader Green, Ambition Gold.
  primary: "#1B3D24",
  dark: "#000000",
  pageBg: "#FBFBFC",
  gold: "#C59949",
  monogram: "SIU",
  clubName: "South Island United",
  logoUrl: "/logos/south-island-united.png",
};

export function brandForOrg(orgSlug: string | null | undefined): CampBrand {
  return orgSlug === SIU_ORG_SLUG ? SIU_BRAND : CUFC_BRAND;
}
