// USG Studio — content-block schema (single source of truth)
//
// A Studio page doc is `{ meta, blocks[] }`. This Zod schema is the ONE definition
// shared by three consumers:
//   1. generation  — constrains what the model may emit (structured output)
//   2. validation  — server validates content_json before it is stored/published
//   3. rendering    — the client renderer derives its prop types from `Block`
//
// Hard rule: blocks describe CONTENT and DATA ONLY. No colour, font, spacing, or
// any other styling field lives here — presentation is owned entirely by the
// brand theme at render time (see org_brand_context.themeRef). `*Ref` fields are
// stable references (asset keys / ids), resolved to real URLs by the renderer.
// `bodyMd` is a SAFE-SUBSET markdown string, sanitised when rendered.

import { z } from "zod";

// The block `type` discriminant — also the canonical list of renderable blocks.
export const BLOCK_TYPES = [
  "hero",
  "section",
  "stat_grid",
  "quote",
  "image_feature",
  "logo_wall",
  "deal_options",
  "faq",
  "proof",
  "cta",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

// Safe-subset markdown (rendered through a sanitising renderer, never raw HTML).
const bodyMd = z.string();

// ── Individual block schemas ──────────────────────────────────────────────────
// Every block carries a stable `id` (used for inline editing + analytics anchoring
// — studio_analytics_events.block_id points at these).

export const heroBlock = z.object({
  type: z.literal("hero"),
  id: z.string(),
  eyebrow: z.string(),
  headline: z.string(),
  subhead: z.string(),
  imageRef: z.string().optional(),
});

export const sectionBlock = z.object({
  type: z.literal("section"),
  id: z.string(),
  heading: z.string(),
  bodyMd,
});

export const statGridBlock = z.object({
  type: z.literal("stat_grid"),
  id: z.string(),
  stats: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
    }),
  ),
});

export const quoteBlock = z.object({
  type: z.literal("quote"),
  id: z.string(),
  quote: z.string(),
  attribution: z.string(),
  role: z.string().optional(),
});

export const imageFeatureBlock = z.object({
  type: z.literal("image_feature"),
  id: z.string(),
  imageRef: z.string(),
  heading: z.string().optional(),
  bodyMd: bodyMd.optional(),
  caption: z.string().optional(),
});

export const logoWallBlock = z.object({
  type: z.literal("logo_wall"),
  id: z.string(),
  heading: z.string().optional(),
  logoRefs: z.array(z.string()),
});

export const dealOptionsBlock = z.object({
  type: z.literal("deal_options"),
  id: z.string(),
  heading: z.string().optional(),
  // The three-deal-structure pattern (good / better / best).
  options: z.array(
    z.object({
      name: z.string(),
      price: z.string().optional(),
      summary: z.string().optional(),
      features: z.array(z.string()),
    }),
  ),
});

export const faqBlock = z.object({
  type: z.literal("faq"),
  id: z.string(),
  items: z.array(
    z.object({
      q: z.string(),
      a: z.string(),
    }),
  ),
});

export const proofBlock = z.object({
  type: z.literal("proof"),
  id: z.string(),
  heading: z.string().optional(),
  items: z.array(
    z.object({
      label: z.string(),
      detail: z.string(),
    }),
  ),
});

// The model picks an intent + a reference, NOT a raw URL. The renderer/route maps
// `action` to the real destination (Meet booking link, ClubOS registration URL,
// or an approved external link), appending attribution (?source=<sourceTag>).
export const CTA_ACTION_KINDS = ["book_meeting", "register_program", "external"] as const;
export type CtaActionKind = (typeof CTA_ACTION_KINDS)[number];

export const ctaBlock = z.object({
  type: z.literal("cta"),
  id: z.string(),
  label: z.string(),
  sublabel: z.string().optional(),
  action: z.object({
    kind: z.enum(CTA_ACTION_KINDS),
    ref: z.string(),
  }),
});

// ── The discriminated union + page doc ────────────────────────────────────────

export const blockSchema = z.discriminatedUnion("type", [
  heroBlock,
  sectionBlock,
  statGridBlock,
  quoteBlock,
  imageFeatureBlock,
  logoWallBlock,
  dealOptionsBlock,
  faqBlock,
  proofBlock,
  ctaBlock,
]);
export type Block = z.infer<typeof blockSchema>;

export const pageMetaSchema = z.object({
  title: z.string(),
  seoDescription: z.string(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

export const pageDocSchema = z.object({
  meta: pageMetaSchema,
  blocks: z.array(blockSchema),
});
export type PageDoc = z.infer<typeof pageDocSchema>;

// ── JSON Schema for structured generation ─────────────────────────────────────
// `zod-to-json-schema` is NOT currently a dependency of this app (see package.json).
// When the generation service is built (next increment) and that dep is added,
// wire the helper here so the model can be constrained by the exact same schema:
//
//   import { zodToJsonSchema } from "zod-to-json-schema";
//   export const pageDocJsonSchema = zodToJsonSchema(pageDocSchema, "PageDoc");
//
// TODO(studio): add `zod-to-json-schema` and export `pageDocJsonSchema` above.
// Until then, pass `pageDocSchema` / `blockSchema` directly for validation.
