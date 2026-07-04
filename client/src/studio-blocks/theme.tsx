// USG Studio — brand theme layer.
//
// BrandTheme injects a brand's design tokens as CSS custom properties onto a
// SCOPED `.studio-scope` container (never :root) so the studio look can never
// leak into the ClubOS admin UI. Every scoped class in `studio.css` reads these
// vars, so the whole block library re-skins by swapping the token record entry.
//
// This `STUDIO_THEMES` record is the INTERIM brand-token source. It is replaced
// by `org_brand_context.themeRef` once the brand-context increment lands — at
// which point a theme is resolved server-side and passed in as tokens. Adding a
// new brand today = one new entry here.
import { type CSSProperties, type ReactNode } from "react";
import "./studio.css";

export interface StudioTokens {
  /** page background (the "ink") */
  bg: string;
  /** solid panel base */
  panel: string;
  /** base body text colour */
  text: string;
  /** primary accent */
  gold: string;
  /** soft accent — the serif "wink", hovers */
  goldSoft: string;
  /** primary-accent channels "r, g, b" for rgba() auras */
  goldRgb: string;
  /** secondary-accent channels "r, g, b" for the second ambient glow */
  royalRgb: string;
  fontSans: string;
  fontDisplay: string;
  fontSerif: string;
}

// The nexus-dark + gold system (ported from apps/partners) is the base look and
// the fallback for any brand without its own entry yet.
const NEXUS_DARK: StudioTokens = {
  bg: "#050505",
  panel: "#0a0a0a",
  text: "rgba(229, 229, 229, 0.92)",
  gold: "#d4af37",
  goldSoft: "#e6c96a",
  goldRgb: "212, 175, 55",
  royalRgb: "38, 57, 150",
  fontSans: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontDisplay: "'Space Grotesk', 'Inter', sans-serif",
  fontSerif: "'Instrument Serif', Georgia, serif",
};

// Mini Football Leagues — matches the live minifootball.co.nz palette
// (gold #D1B96E, ink #0A0A0A, Anton display face). Warmer gold, warmer second
// glow (no royal blue), Anton poster display.
const MFL: StudioTokens = {
  bg: "#0A0A0A",
  panel: "#121212",
  text: "rgba(232, 226, 208, 0.92)",
  gold: "#D1B96E",
  goldSoft: "#E6D5A0",
  goldRgb: "209, 185, 110",
  royalRgb: "58, 51, 32",
  fontSans: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontDisplay: "'Anton', 'Space Grotesk', Impact, sans-serif",
  fontSerif: "'Instrument Serif', Georgia, serif",
};

export const STUDIO_THEMES: Record<string, StudioTokens> = {
  "nexus-dark": NEXUS_DARK,
  default: NEXUS_DARK,
  mfl: MFL,
  "mini-football-leagues": MFL,
};

export function resolveTokens(brand?: string | null): StudioTokens {
  if (brand && STUDIO_THEMES[brand]) return STUDIO_THEMES[brand];
  return NEXUS_DARK;
}

function tokensToVars(t: StudioTokens): CSSProperties {
  return {
    "--studio-bg": t.bg,
    "--studio-panel": t.panel,
    "--studio-text": t.text,
    "--studio-gold": t.gold,
    "--studio-gold-soft": t.goldSoft,
    "--studio-gold-rgb": t.goldRgb,
    "--studio-royal-rgb": t.royalRgb,
    "--studio-font-sans": t.fontSans,
    "--studio-font-display": t.fontDisplay,
    "--studio-font-serif": t.fontSerif,
  } as CSSProperties;
}

/**
 * BrandTheme — the scoped `.studio-scope` container. Renders the brand's tokens
 * as CSS variables inline so they apply only within this subtree. Consumers put
 * a `<BlockRenderer />` inside it.
 */
export function BrandTheme({
  brand,
  children,
  grain = true,
  flat = false,
  className = "",
}: {
  brand?: string | null;
  children: ReactNode;
  /** film-grain overlay (on by default; matches partners `bg-grain`) */
  grain?: boolean;
  /** QA / reduced-motion mode — reveal states are skipped, everything visible */
  flat?: boolean;
  className?: string;
}) {
  const tokens = resolveTokens(brand);
  const classes = ["studio-scope", grain ? "s-grain" : "", flat ? "is-flat" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} style={tokensToVars(tokens)}>
      {children}
    </div>
  );
}
