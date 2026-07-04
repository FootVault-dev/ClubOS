// USG Studio — JSON Schema for constrained generation (server-only).
//
// Fulfils the TODO(studio) in shared/studio-blocks.ts. Kept out of the shared
// module on purpose: `zod-to-json-schema` is a server concern and shouldn't be
// pulled into the client bundle. The Zod `pageDocSchema` stays the single source
// of truth — this file just projects it into the JSON Schema shape the Anthropic
// tool `input_schema` needs so the model can ONLY emit a schema-valid page doc.
//
// `$refStrategy: "none"` inlines every nested block schema (no `$ref`), which is
// the simplest, most portable shape for a tool input_schema and keeps the
// discriminated union as a plain `anyOf` on `blocks.items`.

import { zodToJsonSchema } from "zod-to-json-schema";
import { pageDocSchema } from "@shared/studio-blocks";

// Draft-07 JSON Schema, fully inlined. Top-level is `{ type: "object", ... }`
// because pageDocSchema is a z.object — exactly what Anthropic's
// Tool.InputSchema expects.
export const pageDocJsonSchema = zodToJsonSchema(pageDocSchema, {
  $refStrategy: "none",
  target: "jsonSchema7",
}) as Record<string, unknown> & { type: "object" };
