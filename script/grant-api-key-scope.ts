/**
 * Grant (or revoke) ONE scope on an existing API key.
 *
 *   npx tsx script/grant-api-key-scope.ts --key "<name>" --scope squads:read
 *   npx tsx script/grant-api-key-scope.ts --key "<name>" --scope squads:read --apply
 *   npx tsx script/grant-api-key-scope.ts --key "<name>" --scope squads:read --revoke --apply
 *
 * DRY RUN BY DEFAULT — prints the before/after scope set from the live database
 * so the effect is visible before the write, not after.
 *
 * The key itself never changes: the holder's .env keeps working and the new
 * grant applies from their very next request. Adding a scope is additive; use
 * --revoke to take one away.
 */

import "dotenv/config";
import { Pool } from "pg";
import { isValidApiScope, API_SCOPES } from "../shared/api-scopes";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const keyName = arg("key");
const scope = arg("scope");
const apply = has("apply");
const revoke = has("revoke");

if (!keyName || !scope) {
  console.error('Usage: --key "<key name>" --scope <scope> [--revoke] [--apply]');
  console.error(`Valid scopes: ${API_SCOPES.map((s) => s.scope).join(", ")}`);
  process.exit(1);
}
// 🔴 Validate against the shared vocabulary, not a free string. A typo'd scope
// written into the column is a grant that silently never matches — or worse,
// one that looks granted in the UI and is not.
if (!isValidApiScope(scope)) {
  console.error(`Unknown scope "${scope}". Valid: ${API_SCOPES.map((s) => s.scope).join(", ")}`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const { rows } = await pool.query(
    `SELECT id, name, scopes, allowed_org_ids, active FROM api_keys WHERE name ILIKE $1`,
    [keyName]
  );
  if (rows.length === 0) {
    console.error(`No API key named like "${keyName}".`);
    const all = await pool.query(`SELECT name, active FROM api_keys ORDER BY created_at DESC LIMIT 20`);
    console.error("Existing keys:", all.rows.map((r) => `${r.name}${r.active ? "" : " (inactive)"}`).join(" · "));
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`"${keyName}" matched ${rows.length} keys — be more specific:`,
      rows.map((r) => r.name).join(" · "));
    process.exit(1);
  }

  const key = rows[0];
  const before: string[] = Array.isArray(key.scopes) ? key.scopes : [];
  const after = revoke
    ? before.filter((s) => s !== scope)
    : before.includes(scope)
      ? before
      : [...before, scope];

  console.log(`Key:     ${key.name}${key.active ? "" : "  ⚠️ INACTIVE"}`);
  console.log(`Orgs:    ${JSON.stringify(key.allowed_org_ids)}`);
  console.log(`Before:  ${before.join(", ") || "(none)"}`);
  console.log(`After:   ${after.join(", ") || "(none)"}`);

  if (before.length === after.length && before.every((s, i) => s === after[i])) {
    console.log("\nNo change needed.");
    await pool.end();
    return;
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to make it so.");
    await pool.end();
    return;
  }

  await pool.query(`UPDATE api_keys SET scopes = $1 WHERE id = $2`, [after, key.id]);
  console.log(`\n✅ ${revoke ? "Revoked" : "Granted"} ${scope} on "${key.name}".`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
