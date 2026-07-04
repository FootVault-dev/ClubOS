// Seed / update the MFL "Brand Pack" into org_brand_context (USG Studio).
// Idempotent: upserts on organization_id (one brand pack per org). Re-run any time
// the pack JSON changes. This replaces the hardcoded per-brand voice strings in
// server/ai.ts with data the Studio generation service loads at generate time.
//
// The source of truth is the deep-research brand pack JSON, whose top-level keys
// (voiceJson / messagingJson / lexiconJson / bannedTerms / ctaConventionsJson /
// dataBindingsJson) already match the org_brand_context columns.
//
// Usage (a human runs this AFTER the increment-1 migration is applied):
//   npx tsx --env-file=.env script/seed-mfl-brand-pack.ts [path/to/mfl.json]

import { Pool } from "pg";
import { readFileSync } from "fs";

const ORG_SLUG = "mini-football-leagues"; // MFL = organizationId 3
const DEFAULT_PACK_PATH =
  "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/deep-research/2026-07-04-usg-studio-brand-ai-platform/brand-packs/mfl.json";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

  const packPath = process.argv[2] || DEFAULT_PACK_PATH;
  const pack = JSON.parse(readFileSync(packPath, "utf-8"));

  const brandId: string = pack.brandId || "mfl";
  const themeRef: string = brandId; // text pointer to the brand theme / token set

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const org = await client.query(`SELECT id, name FROM organizations WHERE slug = $1`, [ORG_SLUG]);
    if (!org.rows.length) throw new Error(`Organization '${ORG_SLUG}' not found`);
    const orgId = org.rows[0].id;

    const res = await client.query(
      `INSERT INTO org_brand_context
         (organization_id, brand_id, voice_json, messaging_json, lexicon_json,
          banned_terms, cta_conventions_json, theme_ref, data_bindings_json, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id) DO UPDATE SET
         brand_id = EXCLUDED.brand_id,
         voice_json = EXCLUDED.voice_json,
         messaging_json = EXCLUDED.messaging_json,
         lexicon_json = EXCLUDED.lexicon_json,
         banned_terms = EXCLUDED.banned_terms,
         cta_conventions_json = EXCLUDED.cta_conventions_json,
         theme_ref = EXCLUDED.theme_ref,
         data_bindings_json = EXCLUDED.data_bindings_json,
         version = EXCLUDED.version,
         updated_at = now()
       RETURNING id`,
      [
        orgId,
        brandId,
        JSON.stringify(pack.voiceJson ?? null),
        JSON.stringify(pack.messagingJson ?? null),
        JSON.stringify(pack.lexiconJson ?? null),
        JSON.stringify(pack.bannedTerms ?? []),
        JSON.stringify(pack.ctaConventionsJson ?? null),
        themeRef,
        JSON.stringify(pack.dataBindingsJson ?? null),
        pack.version || "v1.0.0",
      ],
    );
    console.log(`✅ Brand pack '${brandId}' upserted (id ${res.rows[0].id}) for ${org.rows[0].name} (org ${orgId})`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("seed-mfl-brand-pack")) {
  main().catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
}
