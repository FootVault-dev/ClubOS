// ─────────────────────────────────────────────────────────────────────────────
// grapes/templates/index.ts — the starter-template registry.
//
// Pre-designed, brand-adaptive email templates that give the visual builder a
// gorgeous starting point instead of a blank canvas. Each template is a function
// of the brand (see ./types → StarterTemplate.build), so the SAME design renders
// on-brand for every workspace (CUFC navy, MFL gold/black, CUGC light royal-blue,
// SIU pine/gold, …). Add a template = drop a file next to this one and register
// it in STARTER_TEMPLATES below.
// ─────────────────────────────────────────────────────────────────────────────

import { newsletterTemplate } from "./newsletter";
import { matchdayTemplate } from "./matchday";
import { welcomeTemplate } from "./welcome";
import { registrationTemplate } from "./registration";
import { eventTemplate } from "./event";
import { productTemplate } from "./product";
import { announcementTemplate } from "./announcement";
import { CATEGORY_ORDER, templateFitsBrand, type StarterTemplate } from "./types";

export * from "./types";

/** The full library, ordered for display (most-used categories first). */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  newsletterTemplate,
  matchdayTemplate,
  registrationTemplate,
  eventTemplate,
  welcomeTemplate,
  productTemplate,
  announcementTemplate,
];

/** Templates offered for a given brand, category-ordered. */
export function templatesForBrand(brandKey: string): StarterTemplate[] {
  const order = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
  return STARTER_TEMPLATES.filter((t) => templateFitsBrand(t, brandKey)).sort(
    (a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99),
  );
}
