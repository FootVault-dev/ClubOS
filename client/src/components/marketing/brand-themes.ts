// ─────────────────────────────────────────────────────────────────────────────
// Per-brand editor themes for the ClubOS email builder (Phase D).
//
// Two theming layers, both derived from ONE brand row below:
//   1. getBrandTheme(key)  → an `@react-email/editor` `theme` (EditorThemeInput).
//      This styles the EMAIL CONTENT the recipient sees (body bg, card, headings,
//      buttons, links) — so the email opens on-brand BEFORE the user touches a
//      thing. This is the "premium by default" lever from the UX research.
//   2. getBrandChrome(key) → CSS custom properties (`--re-*`) applied to the
//      editor wrapper so the editing UI chrome (bubble menus, toolbars, slash
//      menu) matches the brand's dark/light nature instead of clashing with it.
//
// Palettes/fonts are lifted verbatim from the live brand email shells in
// server/email.ts (mflShell, the CIC/CUFC inline shells, cugcEmailShell,
// uscShell, the SIU membership shell) and server/marketing/brand.ts
// (BRAND_KEY_BY_ORG). Brand keys are the canonical set: cufc, siu, mfl, usc, cic,
// cugc, usg, prints (+ a cic7s alias). Keep in sync with server/marketing/brand.ts.
//
// Fonts stay on the email-safe system stack (exactly what every shell already
// uses) — brand display faces (Anton, Kanit, …) can't be relied on in email
// clients without hosted web-fonts, so we do not emit them here.
// ─────────────────────────────────────────────────────────────────────────────

import type { CSSProperties } from "react";
import type { EmailEditorProps } from "@react-email/editor";

/** The editor's public theme input type, pulled from its props (no private import). */
export type BrandEditorTheme = NonNullable<EmailEditorProps["theme"]>;

/** The email-safe font stack every brand shell already uses. */
const SYSTEM_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface BrandTheme {
  key: string;
  name: string;
  /** Dark brands invert the editor chrome + email canvas to a dark surface. */
  isDark: boolean;
  /** Accent — buttons, links, eyebrow labels. */
  accent: string;
  /** Readable text colour to sit on the accent (button label). */
  onAccent: string;
  /** Outer page background (email body). */
  bg: string;
  /** Content card / container background. */
  surface: string;
  /** Hairline border on the card. */
  border: string;
  /** Body text colour. */
  text: string;
  /** Muted / secondary text. */
  muted: string;
  /** Heading colour. */
  heading: string;
  /** Optional hosted logo (only where we're confident the asset exists). */
  logoUrl?: string;
}

// One row per brand — every downstream theme is derived from this.
export const BRAND_THEMES: Record<string, BrandTheme> = {
  // Mini Football Leagues — black + gold (mflShell).
  mfl: {
    key: "mfl", name: "Mini Football Leagues", isDark: true,
    accent: "#d1b96e", onAccent: "#000000",
    bg: "#000000", surface: "#101010", border: "#242424",
    text: "#e6e6e6", muted: "#7d7d7d", heading: "#ffffff",
    logoUrl: "https://join.minifootball.co.nz/logos/mini-football-leagues.png",
  },
  // Christchurch United FC — navy (the CUFC inline shell).
  cufc: {
    key: "cufc", name: "Christchurch United FC", isDark: true,
    accent: "#7d95ff", onAccent: "#02040c",
    bg: "#030711", surface: "#0c1226", border: "#1d2a55",
    text: "#e6e8f0", muted: "#7d8ba8", heading: "#ffffff",
  },
  // South Island United — Unity Black / pine / gold (the SIU membership shell).
  siu: {
    key: "siu", name: "South Island United", isDark: true,
    accent: "#c59949", onAccent: "#000000",
    bg: "#0a0a09", surface: "#111111", border: "#1f1f1f",
    text: "#e6e6e6", muted: "#8c8c8c", heading: "#c59949",
  },
  // Christchurch International Cup (Youth) — black + gold (the CIC youth shell).
  cic: {
    key: "cic", name: "Christchurch International Cup", isDark: true,
    accent: "#c9a43e", onAccent: "#0b0b08",
    bg: "#0b0b08", surface: "#141511", border: "#2c2d23",
    text: "#e6e6e6", muted: "#7f7f70", heading: "#ffffff",
  },
  // CIC Summer 7's — navy + lime (the CIC 7s shell) — alias, not in BRAND_KEY_BY_ORG.
  cic7s: {
    key: "cic7s", name: "CIC Summer 7's", isDark: true,
    accent: "#cffd5a", onAccent: "#0a1122",
    bg: "#0a1122", surface: "#10131c", border: "#252a38",
    text: "#e6e8f0", muted: "#7c869c", heading: "#ffffff",
  },
  // United Gymnastics — LIGHT: royal blue header + gold accent (cugcEmailShell).
  cugc: {
    key: "cugc", name: "United Gymnastics", isDark: false,
    accent: "#013590", onAccent: "#ffffff",
    bg: "#f1f4fa", surface: "#ffffff", border: "#e3e9f5",
    text: "#191919", muted: "#8492af", heading: "#013590",
  },
  // United Sports Centre — dark indigo (uscShell).
  usc: {
    key: "usc", name: "United Sports Centre", isDark: true,
    accent: "#6366f1", onAccent: "#ffffff",
    bg: "#0a0e1a", surface: "#0d1222", border: "#232a44",
    text: "#e6e8f0", muted: "#8b8fa8", heading: "#ffffff",
    logoUrl: "https://book.unitedsportscentre.com/logos/united-sports-group.png",
  },
  // United Sports Group — umbrella, professional dark navy.
  usg: {
    key: "usg", name: "United Sports Group", isDark: true,
    accent: "#7d95ff", onAccent: "#02040c",
    bg: "#05070c", surface: "#0d1120", border: "#1c2440",
    text: "#e6e8f0", muted: "#7d8ba8", heading: "#ffffff",
  },
  // United Prints — dark with the print orange accent (server/marketing/brand.ts).
  prints: {
    key: "prints", name: "United Prints", isDark: true,
    accent: "#ff7a45", onAccent: "#1a0f08",
    bg: "#0c0a09", surface: "#161311", border: "#2a2420",
    text: "#ececec", muted: "#8a8178", heading: "#ffffff",
  },
};

/** Neutral fallback for an unknown brand key — a calm dark surface. */
export const NEUTRAL_THEME: BrandTheme = {
  key: "neutral", name: "Email", isDark: true,
  accent: "#7d95ff", onAccent: "#02040c",
  bg: "#0b0d12", surface: "#14171f", border: "#252a35",
  text: "#e6e8f0", muted: "#8a90a0", heading: "#ffffff",
};

/** Raw brand row for a key (with neutral fallback). */
export function getBrandMeta(brandKey: string | null | undefined): BrandTheme {
  if (!brandKey) return NEUTRAL_THEME;
  return BRAND_THEMES[brandKey] ?? BRAND_THEMES[brandKey.toLowerCase()] ?? NEUTRAL_THEME;
}

/**
 * The `@react-email/editor` `theme` for a brand — styles the actual email
 * content so it renders on-brand before the user edits anything. Extends the
 * package's `basic` base theme (sensible email spacing) and overrides colours,
 * fonts and the button/link treatment per brand.
 */
export function getBrandTheme(brandKey: string | null | undefined): BrandEditorTheme {
  const b = getBrandMeta(brandKey);
  return {
    extends: "basic",
    styles: {
      body: { backgroundColor: b.bg, color: b.text, fontFamily: SYSTEM_FONT },
      container: { backgroundColor: b.surface, color: b.text },
      paragraph: { color: b.text, fontFamily: SYSTEM_FONT, fontSize: "15px", lineHeight: "1.65" },
      h1: { color: b.heading, fontFamily: SYSTEM_FONT, fontWeight: "800", letterSpacing: "-0.2px" },
      h2: { color: b.heading, fontFamily: SYSTEM_FONT, fontWeight: "700" },
      h3: { color: b.heading, fontFamily: SYSTEM_FONT, fontWeight: "700" },
      link: { color: b.accent, textDecoration: "underline" },
      button: {
        backgroundColor: b.accent,
        color: b.onAccent,
        borderRadius: "10px",
        fontWeight: "700",
        fontFamily: SYSTEM_FONT,
      },
      list: { color: b.text, fontFamily: SYSTEM_FONT },
      listItem: { color: b.text },
      image: { borderRadius: "8px" },
    },
  };
}

/**
 * `--re-*` CSS custom properties for the editor CHROME (bubble menus, toolbars,
 * slash menu), applied to the editor wrapper so the editing UI matches the
 * brand's dark/light nature instead of the package's prefers-color-scheme
 * default. These variable names are defined by @react-email/editor/themes/default.css.
 */
export function getBrandChrome(brandKey: string | null | undefined): CSSProperties {
  const b = getBrandMeta(brandKey);
  const vars: Record<string, string> = {
    "--re-bg": b.surface,
    "--re-border": b.border,
    "--re-text": b.text,
    "--re-text-muted": b.muted,
    "--re-hover": b.isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
    "--re-active": b.isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)",
    "--re-radius": "0.75rem",
    "--re-radius-sm": "0.5rem",
    "--re-shadow": b.isDark
      ? "0 8px 30px rgba(0,0,0,0.55)"
      : "0 8px 30px rgba(15,23,42,0.12)",
  };
  return vars as CSSProperties;
}
