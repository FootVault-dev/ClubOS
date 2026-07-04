// USG Studio (admin) — shared helpers for the Studio tab.
//
// Pure data + utilities used by StudioHome / StudioNew / StudioEditor. No JSX
// here so it stays a plain module. The block field descriptors below are the
// heart of the Tier-1 inline editor: a flat, path-addressed list of the ONLY
// text a staffer may touch. Brand + layout are never exposed — they stay locked
// to the theme + the block schema.
import type { Block, PageDoc } from "@shared/studio-blocks";

// ── The document row shape returned by the admin API (server StudioDocument) ──
export interface StudioDocRow {
  id: number;
  token: string;
  slug: string | null;
  brandId: string;
  format: string;
  title: string;
  status: string; // draft | published | archived
  contentJson: PageDoc;
  schemaVersion: number;
  contentHash: string | null;
  sourceTag: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

// ── Brand picker catalog ──────────────────────────────────────────────────────
// Only brands that resolve to a real theme in STUDIO_THEMES. MFL is the one that
// is fully packed today (voice + palette + display face); the house theme is the
// safe fallback for everything else until each brand's pack lands.
export interface BrandCard {
  id: string;        // the brandId stored on the doc + passed to <BrandTheme>
  name: string;
  note: string;
  packed: boolean;   // "fully packed" vs interim/house look
}

export const BRAND_CARDS: BrandCard[] = [
  {
    id: "mfl",
    name: "Mini Football Leagues",
    note: "Fully packed — warm gold, Anton display face",
    packed: true,
  },
  {
    id: "nexus-dark",
    name: "United Sports Group (house)",
    note: "The house dark + gold look — used until a brand has its own pack",
    packed: false,
  },
];

export function brandName(brandId: string): string {
  return BRAND_CARDS.find((b) => b.id === brandId)?.name ?? brandId;
}

// ── Tone chips ────────────────────────────────────────────────────────────────
export const TONES = [
  { id: "warm", label: "Warm", hint: "friendly, human, community-first" },
  { id: "sharp", label: "Sharp & commercial", hint: "direct, numbers-led, confident" },
  { id: "formal", label: "Formal", hint: "measured, corporate, restrained" },
] as const;
export type ToneId = (typeof TONES)[number]["id"];

// ── Guided brief → generation brief string ────────────────────────────────────
export interface GuidedBrief {
  partner: string;
  dealOneLiner: string;
  upside: string;
  ask?: string;
  notes?: string;
  tone: ToneId;
}

/** Assemble the guided form into the single `brief` string the generator takes. */
export function buildBrief(g: GuidedBrief): string {
  const toneLine = TONES.find((t) => t.id === g.tone);
  const lines = [
    `Prospect / partner being pitched: ${g.partner.trim()}`,
    `The deal in one line: ${g.dealOneLiner.trim()}`,
    `Their single biggest upside (LEAD the page with this, framed as what THEY get): ${g.upside.trim()}`,
  ];
  if (g.ask?.trim()) lines.push(`What we're asking for: ${g.ask.trim()}`);
  if (toneLine) lines.push(`Tone: ${toneLine.label} — ${toneLine.hint}.`);
  if (g.notes?.trim()) lines.push(`Things to say or avoid: ${g.notes.trim()}`);
  lines.push(
    "Write it as a partner proposal page that leads with the partner's upside, not our need. Only use facts stated above — do not invent numbers, prices, dates, named people, or logos.",
  );
  return lines.join("\n");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Immutable path get/set over the PageDoc ───────────────────────────────────
export type FieldPath = (string | number)[];

export function getAtPath(obj: any, path: FieldPath): any {
  return path.reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setAtPath<T>(obj: T, path: FieldPath, value: any): T {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const clone: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  clone[head] = setAtPath(clone[head], rest, value);
  return clone;
}

// ── The editable-field model (Tier-1 inline editing) ──────────────────────────
export interface FieldDesc {
  path: FieldPath;   // absolute path from the PageDoc root
  label: string;
  value: string;
  multiline?: boolean;
}
export interface BlockFieldGroup {
  blockId: string;
  type: Block["type"];
  title: string;
  fields: FieldDesc[];
}

const BLOCK_TITLE: Record<Block["type"], string> = {
  hero: "Hero",
  section: "Section",
  stat_grid: "Stats",
  quote: "Quote",
  image_feature: "Image feature",
  logo_wall: "Logo wall",
  deal_options: "Deal options",
  faq: "Questions & answers",
  proof: "Proof points",
  cta: "Call to action",
};

/**
 * Derive the editable text fields for every block in the doc. Returns paths
 * addressed from the doc root so an edit is `setAtPath(doc, field.path, value)`.
 * Optional fields are only surfaced when the generator actually produced them —
 * so the loop is "edit the text that's there", never "restructure the page".
 */
export function docFieldGroups(doc: PageDoc): BlockFieldGroup[] {
  return (doc.blocks ?? []).map((block, bi) => {
    const P = (...k: (string | number)[]): FieldPath => ["blocks", bi, ...k];
    const fields: FieldDesc[] = [];
    const add = (path: FieldPath, label: string, multiline = false) => {
      const value = getAtPath(doc, path);
      if (typeof value === "string") fields.push({ path, label, value, multiline });
    };

    switch (block.type) {
      case "hero":
        add(P("eyebrow"), "Eyebrow");
        add(P("headline"), "Headline", true);
        add(P("subhead"), "Subheading", true);
        break;
      case "section":
        add(P("heading"), "Heading", true);
        add(P("bodyMd"), "Body", true);
        break;
      case "stat_grid":
        block.stats.forEach((_, si) => {
          add(P("stats", si, "value"), `Stat ${si + 1} — number`);
          add(P("stats", si, "label"), `Stat ${si + 1} — label`);
        });
        break;
      case "quote":
        add(P("quote"), "Quote", true);
        add(P("attribution"), "Who said it");
        add(P("role"), "Their role");
        break;
      case "image_feature":
        add(P("heading"), "Heading");
        add(P("bodyMd"), "Body", true);
        add(P("caption"), "Caption");
        break;
      case "logo_wall":
        add(P("heading"), "Heading");
        break;
      case "deal_options":
        add(P("heading"), "Heading", true);
        block.options.forEach((o, oi) => {
          add(P("options", oi, "name"), `Option ${oi + 1} — name`);
          add(P("options", oi, "price"), `Option ${oi + 1} — price`);
          add(P("options", oi, "summary"), `Option ${oi + 1} — summary`, true);
          o.features.forEach((_, fi) =>
            add(P("options", oi, "features", fi), `Option ${oi + 1} — feature ${fi + 1}`),
          );
        });
        break;
      case "faq":
        block.items.forEach((_, ii) => {
          add(P("items", ii, "q"), `Q${ii + 1}`);
          add(P("items", ii, "a"), `A${ii + 1}`, true);
        });
        break;
      case "proof":
        add(P("heading"), "Heading", true);
        block.items.forEach((_, ii) => {
          add(P("items", ii, "label"), `Point ${ii + 1} — label`);
          add(P("items", ii, "detail"), `Point ${ii + 1} — detail`, true);
        });
        break;
      case "cta":
        add(P("label"), "Headline", true);
        add(P("sublabel"), "Supporting line", true);
        break;
    }

    return { blockId: block.id, type: block.type, title: BLOCK_TITLE[block.type], fields };
  });
}

// ── localStorage keys — stash the brief/warnings from create → editor ─────────
// The generation brief is NOT persisted server-side (no schema field for it), so
// we stash it client-side to power the editor's whole-page regenerate. Gracefully
// absent for docs created elsewhere → regenerate disabled with an explanation.
export const briefKey = (id: number) => `studio_brief_${id}`;
export const warningsKey = (id: number) => `studio_warnings_${id}`;
