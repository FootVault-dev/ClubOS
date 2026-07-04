// USG Studio — content hashing (pure, server-only).
//
// A stable sha256 over the canonical JSON of a page doc. Canonical = object keys
// sorted recursively so that logically-identical docs hash identically regardless
// of key order. Used to freeze a version fingerprint on publish and to detect
// "did the content actually change" on save. Shared by the generation service and
// storage so the hash is computed one way everywhere.

import crypto from "crypto";

/** Recursively sort object keys so JSON.stringify is deterministic. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON of `value`. */
export function contentHashOf(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
