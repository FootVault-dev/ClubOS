// Puts the United Prints Instant Quote generator on the ClubOS catalog.
//
// Run:  npx tsx --env-file=.env script/seed-website-quote-materials.ts [--commit]
// Dry-run by default: prints exactly what it would change and touches nothing.
//
// Three things per product:
//
//  1. quote_on_website — which products the public quote form offers. Only the
//     four Daniel named on 2026-08-12. ACM Panel is deliberately OFF: he asked
//     for it removed from that page that morning, and this migration must not
//     hand it back. The AS Colour tee is OFF because a width × height signage
//     form cannot price a garment.
//
//  2. name — the CUSTOMER-FACING label, because the website shows this field
//     and one name is better than two that drift. The spec that used to live in
//     the name ("440gsm — Hemmed + Eyelets") is already in `description`, which
//     the website now prints under the dropdown, so nothing is lost. Dima can
//     rename any of them in the Materials tab whenever he likes.
//
//  3. max_roll_width_mm = 1600 on roll goods, NULL on the panel and the
//     garment. Daniel: "limit the width to 1.6m … no limitation on the length".
//     🔴 The engine applies it to the NARROWER side, so a 3m × 0.8m banner
//     still prices — it runs the 800mm across the roll. The per-axis size caps
//     are cleared on the roll products so length really is unlimited; the
//     engine's $2,500 total cap still sends anything enormous to a human.
//
// Idempotent: re-running makes the same rows the same again. It never creates
// or deletes a material, and never touches a price — the rates in this catalog
// were benchmarked against real NZ competitors when it was seeded, and what
// they should be now is Dima's call, not a script's.

import "dotenv/config";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 8; // United Prints

type Plan = {
  slug: string;
  name: string;
  quoteOnWebsite: boolean;
  maxRollWidthMm: number | null;
  /** null clears the cap (unlimited); undefined leaves it as-is. */
  sizeMaxWMm?: number | null;
  sizeMaxHMm?: number | null;
  why: string;
};

const PLAN: Plan[] = [
  {
    slug: "vinyl-decal-medium-term",
    name: "Self-Adhesive Vinyl",
    quoteOnWebsite: true,
    maxRollWidthMm: 1600,
    sizeMaxWMm: null,
    sizeMaxHMm: null,
    why: "On the website (Daniel's list, 2026-08-12). Roll-fed.",
  },
  {
    slug: "corflute-3mm",
    name: "Corflute Sign",
    quoteOnWebsite: true,
    maxRollWidthMm: 1600,
    sizeMaxWMm: null,
    sizeMaxHMm: null,
    why: "On the website. ⚠️ slug says 3mm, name said 5mm — Dima to confirm which.",
  },
  {
    slug: "mesh-fence-banner",
    name: "Fence Mesh Banner",
    quoteOnWebsite: true,
    maxRollWidthMm: 1600,
    sizeMaxWMm: null,
    sizeMaxHMm: null,
    why: "On the website. Roll-fed.",
  },
  {
    slug: "pvc-banner-440",
    name: "PVC Banner",
    quoteOnWebsite: true,
    maxRollWidthMm: 1600,
    sizeMaxWMm: null,
    sizeMaxHMm: null,
    why: "On the website. Roll-fed.",
  },
  {
    slug: "acm-aluminium-3mm",
    name: "Aluminium Composite Panel 3mm (printed)", // unchanged
    quoteOnWebsite: false,
    maxRollWidthMm: null,
    why: "OFF the website — Daniel removed ACM Panel from that page on 2026-08-12. Sheet good, not roll-fed, so no roll limit.",
  },
  {
    slug: "tee-as-colour-staple",
    name: "AS Colour Staple Tee + Print/Embroidery", // unchanged
    quoteOnWebsite: false,
    maxRollWidthMm: null,
    why: "OFF the website — priced per garment; a width × height form can't quote it.",
  },
];

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

  // The column has to exist before this can mean anything.
  const cols = await q(
    `select column_name from information_schema.columns
      where table_name = 'print_materials' and column_name in ('quote_on_website','max_roll_width_mm')`,
  );
  const have = new Set(cols.map((c: any) => c.column_name));
  for (const needed of ["quote_on_website", "max_roll_width_mm"]) {
    if (!have.has(needed)) {
      console.error(`✗ print_materials.${needed} does not exist — apply migrations/2026-08-12_material_website_quote.sql first.`);
      await pool.end();
      process.exit(1);
    }
  }

  const rows = await q(
    `select id, slug, name, base_rate_cents, min_charge_cents, pricing_method, is_active,
            quote_on_website, max_roll_width_mm, size_max_w_mm, size_max_h_mm
       from print_materials where organization_id = $1 order by display_order, id`,
    [ORG_ID],
  );
  const bySlug = new Map(rows.map((r: any) => [r.slug, r]));

  console.log(`${COMMIT ? "APPLYING" : "DRY RUN"} — United Prints (org ${ORG_ID}), ${rows.length} materials\n`);

  const missing = PLAN.filter((p) => !bySlug.has(p.slug));
  if (missing.length) {
    // Never invent a product to make the plan fit.
    console.log(`⚠️  Not in the catalog, skipped: ${missing.map((m) => m.slug).join(", ")}\n`);
  }

  const changes: string[] = [];

  for (const p of PLAN) {
    const row: any = bySlug.get(p.slug);
    if (!row) continue;

    const diffs: string[] = [];
    if (row.name !== p.name) diffs.push(`name: "${row.name}" → "${p.name}"`);
    if (row.quote_on_website !== p.quoteOnWebsite) diffs.push(`on website: ${row.quote_on_website} → ${p.quoteOnWebsite}`);
    if ((row.max_roll_width_mm ?? null) !== p.maxRollWidthMm) diffs.push(`roll width: ${row.max_roll_width_mm ?? "—"} → ${p.maxRollWidthMm ?? "—"}`);
    if (p.sizeMaxWMm !== undefined && (row.size_max_w_mm ?? null) !== p.sizeMaxWMm) diffs.push(`max width cap: ${row.size_max_w_mm ?? "—"} → ${p.sizeMaxWMm ?? "unlimited"}`);
    if (p.sizeMaxHMm !== undefined && (row.size_max_h_mm ?? null) !== p.sizeMaxHMm) diffs.push(`max height cap: ${row.size_max_h_mm ?? "—"} → ${p.sizeMaxHMm ?? "unlimited"}`);

    const flag = p.quoteOnWebsite ? "🌐" : "  ";
    console.log(`${flag} ${p.slug}`);
    console.log(`     rate ${dollars(row.base_rate_cents)} · min ${dollars(row.min_charge_cents)} · ${row.pricing_method}${row.is_active ? "" : " · INACTIVE"}`);
    console.log(`     ${p.why}`);
    if (diffs.length) {
      diffs.forEach((d) => console.log(`     → ${d}`));
      changes.push(p.slug);
    } else {
      console.log(`     (already correct)`);
    }
    console.log("");

    if (COMMIT && diffs.length) {
      const sets = ["name = $2", "quote_on_website = $3", "max_roll_width_mm = $4", "updated_at = now()"];
      const params: any[] = [row.id, p.name, p.quoteOnWebsite, p.maxRollWidthMm];
      if (p.sizeMaxWMm !== undefined) { sets.push(`size_max_w_mm = $${params.length + 1}`); params.push(p.sizeMaxWMm); }
      if (p.sizeMaxHMm !== undefined) { sets.push(`size_max_h_mm = $${params.length + 1}`); params.push(p.sizeMaxHMm); }
      await q(`update print_materials set ${sets.join(", ")} where id = $1`, params);
    }
  }

  // Anything in the catalog the plan didn't mention keeps its current state.
  const unplanned = rows.filter((r: any) => !PLAN.some((p) => p.slug === r.slug));
  if (unplanned.length) {
    console.log(`Left untouched (${unplanned.length}): ${unplanned.map((r: any) => r.slug).join(", ")}\n`);
  }

  if (COMMIT) {
    // Verify by re-reading, not by trusting the writes.
    const after = await q(
      `select slug, name, quote_on_website, max_roll_width_mm from print_materials
        where organization_id = $1 and quote_on_website = true and is_active = true
        order by display_order, id`,
      [ORG_ID],
    );
    console.log(`✓ Live on the website quote (${after.length}):`);
    after.forEach((r: any) => console.log(`    ${r.name}  [${r.slug}]  roll ${r.max_roll_width_mm ?? "—"}mm`));

    const wrong = after.filter((r: any) => r.max_roll_width_mm !== 1600);
    if (wrong.length) console.log(`\n⚠️  Not on a 1600mm roll limit: ${wrong.map((r: any) => r.slug).join(", ")}`);
  } else {
    console.log(changes.length
      ? `${changes.length} material(s) would change. Re-run with --commit to apply.`
      : `Nothing to change.`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
