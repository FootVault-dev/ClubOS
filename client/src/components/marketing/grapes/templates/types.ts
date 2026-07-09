// ─────────────────────────────────────────────────────────────────────────────
// grapes/templates/types.ts — the shape of a pre-designed starter template.
//
// A template is BRAND-ADAPTIVE by construction: instead of a fixed doc, each
// carries a `build(brandKey)` function that produces on-brand MJML by reading the
// brand row (colours / logo / fonts) from grapes/brand.ts (brandCanvasTheme) — the
// SAME source the live email shells + the blank-canvas starter use. So one
// template renders correctly for CUFC (navy), MFL (gold/black), CIC (gold), CUGC
// (light royal-blue), SIU (pine/gold), etc. — premium and on-brand before the
// user touches a thing.
//
// The produced doc is the simplest reliable builder format:
//   { engine:'grapesjs-mjml', version:1, mjml:'<mjml>…</mjml>' }
// grapes/editor.ts → loadDoc() accepts an mjml-only doc (no GrapesJS project JSON
// needed — it falls back to editor.setComponents(mjml)).
// ─────────────────────────────────────────────────────────────────────────────

/** The doc a template hands to the builder. A structural subset of editor.ts's
 *  EmailDoc (no `project` — loadDoc compiles from `mjml` directly). */
export interface StarterTemplateDoc {
  engine: "grapesjs-mjml";
  version: 1;
  mjml: string;
}

export type TemplateCategory =
  | "newsletter"
  | "matchday"
  | "welcome"
  | "registration"
  | "event"
  | "product"
  | "announcement";

export interface StarterTemplate {
  /** stable slug — used as a React key + preview cache key */
  id: string;
  name: string;
  /** one-line "what this is for", shown on the card */
  description: string;
  category: TemplateCategory;
  /** which brands this template makes sense for — 'all' or an explicit allowlist
   *  of brand keys (cufc, siu, mfl, usc, cic, cic7s, cugc, usg, prints). */
  brandKeys: string[] | "all";
  /** optional hosted thumbnail; when absent the gallery compiles a live preview */
  thumbnail?: string;
  /** produce the on-brand MJML source for a given brand key */
  build: (brandKey: string) => string;
}

/** Human labels + short blurbs for the category filter. */
export const CATEGORY_META: Record<TemplateCategory, { label: string; blurb: string }> = {
  newsletter: { label: "Newsletter", blurb: "Multi-story roundup" },
  matchday: { label: "Match day", blurb: "Fixture + tickets" },
  welcome: { label: "Welcome", blurb: "New member intro" },
  registration: { label: "Registration", blurb: "Sign-ups open" },
  event: { label: "Event & camps", blurb: "Dates + booking" },
  product: { label: "Merch & shop", blurb: "Product launch" },
  announcement: { label: "Announcement", blurb: "Clean single notice" },
};

export const CATEGORY_ORDER: TemplateCategory[] = [
  "newsletter",
  "matchday",
  "registration",
  "event",
  "welcome",
  "product",
  "announcement",
];

/** True when this template is offered for the given brand. */
export function templateFitsBrand(t: StarterTemplate, brandKey: string): boolean {
  if (t.brandKeys === "all") return true;
  const key = (brandKey || "").toLowerCase();
  return t.brandKeys.some((k) => k.toLowerCase() === key);
}

/** Wrap a template's brand-adaptive MJML into the doc the builder loads. */
export function templateDoc(t: StarterTemplate, brandKey: string): StarterTemplateDoc {
  return { engine: "grapesjs-mjml", version: 1, mjml: t.build(brandKey) };
}
