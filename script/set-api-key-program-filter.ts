/**
 * Set (or lift) the programme allow-list on an existing API key.
 *
 *   npx tsx script/set-api-key-program-filter.ts --key "Zach AIOS" \
 *       --types holiday_camp --slugs u4-u8            # dry run — shows the effect
 *   npx tsx script/set-api-key-program-filter.ts --key "Zach AIOS" \
 *       --types holiday_camp --slugs u4-u8 --apply    # writes it
 *
 *   npx tsx script/set-api-key-program-filter.ts --key "Zach AIOS" --clear --apply
 *       # lifts the restriction (back to every programme in its workspaces)
 *
 * DRY RUN BY DEFAULT. The dry run reports, from the live database, exactly which
 * programmes the key would read and which it would stop reading — so the effect
 * is visible before the write, not after.
 *
 * The key itself does not change: the holder's .env keeps working, and the new
 * fence applies from their very next request.
 */

import "dotenv/config";
import { Pool } from "pg";
import { normalizeProgramFilter, describeProgramFilter, programFilterIsEmpty } from "../shared/api-scopes";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const keyName = arg("key");
const apply = has("apply");
const clear = has("clear");
const types = (arg("types") || "").split(",").map(s => s.trim()).filter(Boolean);
const slugs = (arg("slugs") || "").split(",").map(s => s.trim()).filter(Boolean);

if (!keyName) {
  console.error('Usage: --key "<key name>" [--types a,b] [--slugs c,d] [--clear] [--apply]');
  process.exit(1);
}

const filter = clear ? null : normalizeProgramFilter({ types, slugs });
if (!clear && (filter === null || programFilterIsEmpty(filter))) {
  console.error("Refusing: no valid programme types or slugs given. That key would be able to read nothing.");
  console.error("Pass --clear if you actually mean to lift the restriction.");
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: keys } = await pool.query(
      `SELECT id, name, organization_id, allowed_org_ids, scopes, program_filter, active
         FROM api_keys WHERE name = $1 AND active = true`,
      [keyName],
    );
    if (keys.length === 0) {
      console.error(`No active API key named "${keyName}".`);
      const { rows: all } = await pool.query(`SELECT name FROM api_keys WHERE active = true ORDER BY id`);
      console.error(`Active keys: ${all.map((k: any) => `"${k.name}"`).join(", ")}`);
      process.exit(1);
    }
    if (keys.length > 1) {
      console.error(`${keys.length} active keys share the name "${keyName}" — rename one first, this script will not guess.`);
      process.exit(1);
    }

    const key = keys[0];
    const orgIds: number[] = key.allowed_org_ids?.length ? key.allowed_org_ids : [key.organization_id];

    console.log(`\nKey "${key.name}" (#${key.id})`);
    console.log(`  scopes:     ${(key.scopes || []).join(", ")}`);
    console.log(`  workspaces: ${orgIds.join(", ")}`);
    console.log(`  programmes now:  ${describeProgramFilter(normalizeProgramFilter(key.program_filter))}`);
    console.log(`  programmes after: ${describeProgramFilter(filter)}\n`);

    // Show the real effect, from the real data, before writing anything.
    const { rows: programs } = await pool.query(
      `SELECT id, name, slug, type FROM programs WHERE organization_id = ANY($1::int[]) ORDER BY id`,
      [orgIds],
    );
    const allowed = (p: any) =>
      !filter || (filter.types || []).includes(p.type) || (filter.slugs || []).includes(p.slug);

    console.log("  Programmes this key would read:");
    for (const p of programs.filter(allowed)) console.log(`      ✓ ${p.name}  [type=${p.type} slug=${p.slug}]`);
    const blocked = programs.filter((p: any) => !allowed(p));
    if (blocked.length) {
      console.log("  Programmes it would NOT read:");
      for (const p of blocked) console.log(`      ✗ ${p.name}  [type=${p.type} slug=${p.slug}]`);
    }

    // Registration counts — the personal-data exposure, in numbers.
    const { rows: regs } = await pool.query(
      `SELECT p.name, COUNT(*)::int AS n
         FROM registrations r JOIN programs p ON r.program_id = p.id
        WHERE p.organization_id = ANY($1::int[]) AND r.registered_at >= now() - interval '365 days'
        GROUP BY p.name ORDER BY n DESC`,
      [orgIds],
    );
    const visible = regs.filter((r: any) => programs.some((p: any) => p.name === r.name && allowed(p)));
    const hidden = regs.filter((r: any) => !programs.some((p: any) => p.name === r.name && allowed(p)));
    const sum = (rs: any[]) => rs.reduce((s, r) => s + r.n, 0);
    console.log(`\n  Registrations (365d): ${sum(visible)} readable, ${sum(hidden)} fenced off`);

    if (!apply) {
      console.log("\n  DRY RUN — nothing written. Re-run with --apply to save.\n");
      return;
    }

    await pool.query(`UPDATE api_keys SET program_filter = $1 WHERE id = $2`, [filter, key.id]);
    const { rows: after } = await pool.query(`SELECT program_filter FROM api_keys WHERE id = $1`, [key.id]);
    console.log(`\n  ✅ Written. Stored filter: ${JSON.stringify(after[0].program_filter)}`);
    console.log(`     ${describeProgramFilter(normalizeProgramFilter(after[0].program_filter))}`);
    console.log("     Takes effect on the key holder's next request — no key change, no re-issue.\n");
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
