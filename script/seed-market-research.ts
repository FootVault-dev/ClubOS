/**
 * Seed the Sandbox → Market Research tab from the offline research corpus.
 *
 * Reads the artefacts produced by the research fleet in the parent AIOS workspace:
 *
 *   outputs/market-research/sources.json          -> the 'sources' snapshot
 *   outputs/market-research/synthesis/00-MASTER.md -> the 'master' snapshot
 *   outputs/market-research/synthesis/<slug>.json  -> one 'vertical' snapshot each
 *
 * The sources snapshot is seeded FIRST and is not optional. It records which
 * sources were reachable when the research ran. Without it a reader could mistake
 * "we could not fetch Google reviews" for "customers have no complaints".
 *
 * Idempotent: upserts on (slug, kind), so a re-run replaces rather than duplicates.
 * Nothing is ever deleted.
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-market-research.ts            # dry run
 *   npx tsx --env-file=.env script/seed-market-research.ts --write    # apply
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const WRITE = process.argv.includes("--write");

// apps/clubos/script -> apps/clubos -> apps -> <workspace root>
const WORKSPACE = resolve(import.meta.dirname, "..", "..", "..");
const MR = join(WORKSPACE, "outputs", "market-research");
const SYNTH = join(MR, "synthesis");

type Snapshot = {
  slug: string;
  kind: "master" | "vertical" | "sources";
  title: string;
  generatedAt: string;
  payload: unknown;
};

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collect(): Snapshot[] {
  if (!existsSync(MR)) {
    throw new Error(`No research corpus at ${MR}. Run the research fleet first.`);
  }

  const snapshots: Snapshot[] = [];

  // 1. sources — mandatory. Refuse to seed findings without their provenance.
  const sourcesPath = join(MR, "sources.json");
  if (!existsSync(sourcesPath)) {
    throw new Error(
      `Missing ${sourcesPath}. Run: python3 scripts/market_research/probe_sources.py\n` +
        `Findings must never be seeded without the record of which sources were blocked.`,
    );
  }
  const sources = readJson(sourcesPath);
  snapshots.push({
    slug: "sources",
    kind: "sources",
    title: "Source status",
    generatedAt: sources.probedAt,
    payload: sources,
  });

  // 2. master report (markdown)
  const masterPath = join(SYNTH, "00-MASTER.md");
  if (existsSync(masterPath)) {
    snapshots.push({
      slug: "master",
      kind: "master",
      title: "Master report",
      generatedAt: sources.probedAt,
      payload: { markdown: readFileSync(masterPath, "utf8") },
    });
  } else {
    console.warn(`⚠ no master report at ${masterPath} — seeding verticals only`);
  }

  // 3. per-vertical briefs.
  // Prefer synthesis/normalized/ — build_report.py flattens the keys the research
  // agents drifted into (price_ladder_nzd, price_ladder_markdown, {note,rows} wrappers)
  // back onto the schema fields the UI renders. Reading the raw briefs instead would
  // silently drop real, sourced tables.
  const NORM = join(SYNTH, "normalized");
  const briefDir = existsSync(NORM) && readdirSync(NORM).some((f) => f.endsWith(".json")) ? NORM : SYNTH;
  if (briefDir === SYNTH) {
    console.warn("⚠ no normalized/ briefs — run: python3 scripts/market_research/build_report.py");
  }

  if (existsSync(briefDir)) {
    for (const f of readdirSync(briefDir).filter((f) => f.endsWith(".json")).sort()) {
      const brief = readJson(join(briefDir, f));
      const slug = basename(f, ".json");
      snapshots.push({
        slug,
        kind: "vertical",
        title: brief.vertical ?? slug,
        generatedAt: sources.probedAt,
        payload: brief,
      });
    }
  }

  return snapshots;
}

async function main() {
  const snapshots = collect();

  console.log(`${snapshots.length} snapshot(s) from ${MR}\n`);
  for (const s of snapshots) {
    const size = JSON.stringify(s.payload).length;
    console.log(`  ${s.kind.padEnd(9)} ${s.slug.padEnd(22)} ${(size / 1024).toFixed(1)} KB  ${s.title}`);
  }

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written. Re-run with --write to apply.");
    console.log("Requires migrations/2026-07-10_market_research.sql to have been applied.");
    return;
  }

  let written = 0;
  for (const s of snapshots) {
    await db.execute(sql`
      INSERT INTO market_research_snapshots (slug, kind, title, generated_at, payload)
      VALUES (${s.slug}, ${s.kind}, ${s.title}, ${s.generatedAt}::timestamptz, ${JSON.stringify(s.payload)}::jsonb)
      ON CONFLICT (slug, kind) DO UPDATE
        SET title = EXCLUDED.title,
            generated_at = EXCLUDED.generated_at,
            payload = EXCLUDED.payload,
            updated_at = now()
    `);
    written++;
  }
  console.log(`\n✓ ${written} snapshot(s) upserted into market_research_snapshots`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  });
