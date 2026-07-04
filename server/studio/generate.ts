// USG Studio — brand-aware page generation service.
//
// Extends the server/ai.ts approach (same @anthropic-ai/sdk client + error style)
// but produces a full { meta, blocks[] } page doc constrained to the Studio block
// schema. The model is FORCED to return through a single `emit_page` tool whose
// input_schema IS the page-doc JSON Schema (server/studio/schema.ts) — so the
// output is always schema-shaped — and we then re-validate with the Zod
// pageDocSchema as the deterministic gate.
//
// Why forced tool use (not output_config.format): the installed SDK ^0.95.0 does
// expose `output_config.format` (structured outputs / zodOutputFormat), but that
// path's guarantees depend on the specific model supporting structured outputs.
// STUDIO_MODEL defaults to the SAME id server/ai.ts already ships on, and forced
// tool use is universally supported by every tool-capable Claude model, so it's
// the runtime-safe choice here. The Zod parse below is the real correctness gate
// either way. Swap to output_config.format when bumping STUDIO_MODEL to a model
// with first-class structured-output support (e.g. claude-sonnet-5).

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import {
  pageDocSchema,
  type PageDoc,
  type Block,
  BLOCK_TYPES,
} from "@shared/studio-blocks";
import { pageDocJsonSchema } from "./schema";
import { contentHashOf } from "./hash";
import crypto from "crypto";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Same model server/ai.ts uses — do NOT switch to an unverified id here. Can be
// bumped to a newer model (e.g. "claude-sonnet-5") once verified.
export const STUDIO_MODEL = "claude-sonnet-4-6";

// ── Brand pack loading ─────────────────────────────────────────────────────

export interface BrandPack {
  brandId: string;
  voiceJson: Record<string, any> | null;
  messagingJson: Record<string, any> | null;
  lexiconJson: any;
  bannedTerms: string[];
  ctaConventionsJson: Record<string, any> | null;
  dataBindingsJson: Record<string, any> | null;
  themeRef: string | null;
}

const DEFAULT_BRAND_PACK: BrandPack = {
  brandId: "nexus-dark",
  voiceJson: {
    essence: "Warm, specific, plain English. Confident without hype.",
    adjectives: ["clear", "human", "specific", "confident"],
  },
  messagingJson: null,
  lexiconJson: null,
  bannedTerms: [
    "elite", "world-class", "premium", "unleash", "elevate", "seamless",
    "leverage", "empower", "game-changer", "cutting-edge", "synergy",
  ],
  ctaConventionsJson: null,
  dataBindingsJson: null,
  themeRef: "nexus-dark",
};

/** Load a brand's Studio pack from org_brand_context; sane default if none. */
export async function loadBrandPack(orgId: number): Promise<BrandPack> {
  const row = await storage.getOrgBrandContext(orgId);
  if (!row) return DEFAULT_BRAND_PACK;
  return {
    brandId: row.brandId,
    voiceJson: row.voiceJson ?? null,
    messagingJson: row.messagingJson ?? null,
    lexiconJson: row.lexiconJson ?? null,
    bannedTerms: Array.isArray(row.bannedTerms) ? row.bannedTerms : [],
    ctaConventionsJson: row.ctaConventionsJson ?? null,
    dataBindingsJson: row.dataBindingsJson ?? null,
    themeRef: row.themeRef ?? null,
  };
}

// ── Prompt assembly ────────────────────────────────────────────────────────

// The length / count guidance the Zod + JSON schema cannot encode. The schema
// says WHAT a block is; this says how MANY and how LONG for a page that reads well.
const BLOCK_GUIDE = `
You build a single proposal / landing page as an ordered list of content blocks.
Block types you may use (discriminated by "type"): ${BLOCK_TYPES.join(", ")}.

Composition rules (the schema can't encode these — follow them):
- Start with exactly ONE "hero" block: a short eyebrow (2-4 words), a headline
  (under ~12 words, benefit-led), and a one-to-two-sentence subhead.
- Then 3-6 body blocks chosen to fit the brief. Good building blocks:
  - "section": a heading + a short bodyMd paragraph (2-5 sentences, safe-subset
    markdown only — no raw HTML, no images).
  - "stat_grid": 3-4 punchy stats (value + label). Only use numbers that are TRUE
    per the live data / brand facts below — never invent figures.
  - "deal_options": the good / better / best pattern — usually 3 options, each with
    a name, optional price, short summary, and 3-5 feature bullets.
  - "proof": 2-4 concrete credibility items (label + one-line detail).
  - "quote": one real-sounding testimonial with an attribution (and role if known).
    Do NOT fabricate a specific named person unless the brief supplies one.
  - "faq": 4-6 genuine buyer questions with short, direct answers.
  - "image_feature" / "logo_wall": only when the brief supplies an imageRef / logos.
- End with exactly ONE "cta" block. Pick action.kind from book_meeting /
  register_program / external and set action.ref to the intent's reference (the
  renderer maps it to the real URL and appends attribution). Label is an
  action-first verb.
- Every block MUST include a short unique "id" (e.g. "hero", "why-1", "stats",
  "deals", "cta"). Never include any styling — no colour, font, or spacing fields.
- meta.title is the browser/OG title; meta.seoDescription is one clear sentence.
`.trim();

function voicePrompt(pack: BrandPack): string {
  const v = pack.voiceJson || {};
  const parts: string[] = [];
  if (v.essence) parts.push(`Essence: ${v.essence}`);
  if (Array.isArray(v.adjectives) && v.adjectives.length) parts.push(`Adjectives: ${v.adjectives.join(", ")}.`);
  if (Array.isArray(v.traits)) {
    for (const t of v.traits) {
      if (t?.trait) parts.push(`- ${t.trait}: ${t.is || ""}${t.isNot ? ` (NOT: ${t.isNot})` : ""}${t.example ? ` e.g. "${t.example}"` : ""}`);
    }
  }
  if (v.dials) parts.push(`Dials: ${JSON.stringify(v.dials)}`);
  if (Array.isArray(v.sentenceRules)) parts.push("Sentence rules:\n" + v.sentenceRules.map((r: string) => `- ${r}`).join("\n"));
  if (v.readAloudTest) parts.push(`Read-aloud test: ${v.readAloudTest}`);
  if (Array.isArray(v.signatureLines) && v.signatureLines.length) parts.push(`Signature lines to echo (don't overuse): ${v.signatureLines.map((s: string) => `"${s}"`).join(" · ")}`);
  return parts.join("\n");
}

function messagingPrompt(pack: BrandPack): string {
  const m = pack.messagingJson || {};
  const parts: string[] = [];
  if (m.positioning) parts.push(`Positioning: ${m.positioning}`);
  if (Array.isArray(m.keyMessages)) parts.push("Key messages:\n" + m.keyMessages.map((k: string) => `- ${k}`).join("\n"));
  if (Array.isArray(m.valueProps)) parts.push("Value props:\n" + m.valueProps.map((k: string) => `- ${k}`).join("\n"));
  if (Array.isArray(m.taglines)) parts.push("Approved taglines: " + m.taglines.filter((t: any) => t?.status === "approved").map((t: any) => `"${t.text}"`).join(" · "));
  if (Array.isArray(m.doNotClaim)) parts.push("DO NOT CLAIM:\n" + m.doNotClaim.map((k: string) => `- ${k}`).join("\n"));
  return parts.join("\n");
}

function lexiconPrompt(pack: BrandPack): string {
  const lex = pack.lexiconJson;
  if (!Array.isArray(lex)) return "";
  const approved = lex.filter((t: any) => t?.type === "approved").map((t: any) => t.term);
  const careful = lex.filter((t: any) => t?.type === "careful").map((t: any) => `${t.term} → ${t.replacement || "rephrase"}`);
  const out: string[] = [];
  if (approved.length) out.push(`Preferred phrases: ${approved.join(", ")}.`);
  if (careful.length) out.push(`Use carefully / prefer replacement: ${careful.join("; ")}.`);
  return out.join("\n");
}

function ctaPrompt(pack: BrandPack): string {
  const c = pack.ctaConventionsJson;
  if (!c) return "";
  const parts: string[] = [];
  if (c.style) parts.push(`CTA style: ${c.style}`);
  if (Array.isArray(c.ctas)) {
    parts.push("CTA intents available:\n" + c.ctas.map((x: any) => `- ${x.intent}: label like ${JSON.stringify(x.text)}${x.destination ? ` → ${x.destination}` : ""}`).join("\n"));
  }
  return parts.join("\n");
}

// Minimal LIVE DATA block for v1 — the safe evergreen facts the brand already
// encodes in dataBindingsJson, plus anything the caller passes through. NOTE: a
// later increment can bind the current league_competition / pricing / capacity
// here (TODO(studio/live-data)); for now we surface only what is safe + static so
// the model never invents live figures.
function liveDataPrompt(pack: BrandPack, liveData?: Record<string, any>): string {
  const parts: string[] = [];
  const db = pack.dataBindingsJson;
  if (db) {
    if (db.org) parts.push(`Org: ${JSON.stringify(db.org)}`);
    if (Array.isArray(db.bindings)) {
      const statics = db.bindings.filter((b: any) => b?.value || (b?.values && typeof b.values === "object"));
      for (const b of statics) {
        parts.push(`- ${b.key}: ${b.value ?? JSON.stringify(b.values)}`);
      }
    }
  }
  if (liveData && Object.keys(liveData).length) parts.push("Caller-supplied live values:\n" + JSON.stringify(liveData, null, 2));
  if (!parts.length) return "No structured live data — use only what the brief states, and do not invent specific numbers, prices, or dates.";
  return parts.join("\n");
}

export interface AssembleContextParams {
  brandPack: BrandPack;
  brief: string;
  references?: string;
  liveData?: Record<string, any>;
}

/** Build the system prompt + user message for a page generation. */
export function assembleContext(params: AssembleContextParams): { system: string; user: string } {
  const { brandPack, brief, references, liveData } = params;

  const bannedList = (brandPack.bannedTerms || []).join(", ");

  const system = [
    "You are USG Studio — a brand-aware page writer for United Sports Group's brands.",
    "You produce a single, coherent proposal or landing page as a structured page doc,",
    "returned ONLY by calling the emit_page tool. Do not write any prose outside the tool call.",
    "",
    "## Page structure",
    BLOCK_GUIDE,
    "",
    "## Brand voice",
    voicePrompt(brandPack) || "(no voice pack — write warm, specific, plain English)",
    "",
    "## Messaging",
    messagingPrompt(brandPack) || "(no messaging pack)",
    "",
    "## Lexicon",
    lexiconPrompt(brandPack) || "(no lexicon)",
    "",
    "## CTA conventions",
    ctaPrompt(brandPack) || "(default: one primary action-first CTA)",
    "",
    "## Banned words — NEVER use these",
    bannedList || "(none specified)",
    "",
    "Write NZ English. No em-dashes. No exclamation marks unless quoting genuine excitement.",
    "Never fabricate statistics, prices, dates, named people, or logos that aren't provided.",
  ].join("\n");

  const user = [
    "## Live data (the only safe source of specific facts)",
    liveDataPrompt(brandPack, liveData),
    "",
    "## Brief from the staffer",
    brief,
    references ? `\n## References / supporting material\n${references}` : "",
    "",
    "Now compose the page and return it by calling emit_page.",
  ].join("\n");

  return { system, user };
}

// ── The generation call ─────────────────────────────────────────────────────

const EMIT_PAGE_TOOL: Anthropic.Tool = {
  name: "emit_page",
  description:
    "Emit the finished page as a structured { meta, blocks[] } document. This is the ONLY way to return the page — call it exactly once with the complete page.",
  input_schema: pageDocJsonSchema as unknown as Anthropic.Tool.InputSchema,
};

export interface GenerateStudioPageParams {
  orgId: number;
  brief: string;
  references?: string;
  liveData?: Record<string, any>;
  brandPack?: BrandPack;   // pass to avoid a second load; otherwise loaded by orgId
  maxTokens?: number;
}

export interface GenerateStudioPageResult {
  doc: PageDoc;
  warnings: string[];
  contentHash: string;
  brandId: string;
}

/** Give every block a stable short id if the model omitted one (mutates a copy). */
function ensureBlockIds(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const doc = { ...raw };
  if (Array.isArray(doc.blocks)) {
    const seen = new Set<string>();
    doc.blocks = doc.blocks.map((b: any, i: number) => {
      let id = typeof b?.id === "string" && b.id.trim() ? b.id.trim() : "";
      if (!id || seen.has(id)) {
        id = `${b?.type || "block"}-${i + 1}-${crypto.randomBytes(2).toString("hex")}`;
      }
      seen.add(id);
      return { ...b, id };
    });
  }
  return doc;
}

/** Case-insensitive scan for banned terms across every string in the doc. */
export function lintDoNotSay(doc: PageDoc, bannedTerms: string[]): string[] {
  if (!bannedTerms?.length) return [];
  const warnings: string[] = [];
  const hay: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") hay.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(doc);
  const text = hay.join("\n").toLowerCase();
  for (const term of bannedTerms) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    // word-ish boundary so "elite" doesn't hit inside another word unintentionally
    const re = new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(text)) warnings.push(`Banned term used: "${term}"`);
  }
  return warnings;
}

/**
 * Generate a brand-aware page. Returns the validated PageDoc + any do-not-say
 * lint warnings + a content hash. Non-streamed for v1 (streaming is a later
 * refinement — return the full doc for now).
 */
export async function generateStudioPage(params: GenerateStudioPageParams): Promise<GenerateStudioPageResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured. Set it via fly secrets.");
  }

  const brandPack = params.brandPack ?? (await loadBrandPack(params.orgId));
  const { system, user } = assembleContext({
    brandPack,
    brief: params.brief,
    references: params.references,
    liveData: params.liveData,
  });

  const response = await client.messages.create({
    model: STUDIO_MODEL,
    max_tokens: params.maxTokens ?? 8000,
    system,
    tools: [EMIT_PAGE_TOOL],
    tool_choice: { type: "tool", name: "emit_page" },
    messages: [{ role: "user", content: user }],
  });

  const toolUse = response.content.find((b: any) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Studio model returned no page (no tool_use block).");
  }

  // Backfill ids, then the Zod schema is the deterministic correctness gate.
  const withIds = ensureBlockIds(toolUse.input);
  let doc: PageDoc;
  try {
    doc = pageDocSchema.parse(withIds);
  } catch (e: any) {
    // Surface as a validation failure so the route maps it to 422.
    throw new Error(`Generated page failed schema validation: ${e?.message || String(e)}`);
  }

  const warnings = lintDoNotSay(doc, brandPack.bannedTerms);
  const contentHash = contentHashOf(doc);
  return { doc, warnings, contentHash, brandId: brandPack.brandId };
}
