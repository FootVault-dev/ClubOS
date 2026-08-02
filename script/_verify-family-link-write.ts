// Exercises the WRITE path (link + unlink) on TEST records only, then restores
// the database to exactly the state it was found in.
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { resolveFamily } from "../server/family-routes";

let pass = 0, fail = 0;
const ok = (c: boolean, l: string, d = "") => { if (c) { pass++; console.log(`  ok    ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` — ${d}` : ""}`); } };

// A test player and a test guardian — never a real family.
const child = (await db.execute(sql`SELECT id, first_name, last_name FROM contacts WHERE type='player' AND first_name ILIKE 'Test%' ORDER BY id LIMIT 1`)).rows[0] as any;
const guardian = (await db.execute(sql`SELECT id, first_name, last_name FROM contacts WHERE type='guardian' AND (first_name ILIKE 'Test%' OR email ILIKE '%test%') ORDER BY id LIMIT 1`)).rows[0] as any;
console.log(`\nUsing TEST records only: child #${child.id} ${child.first_name} ${child.last_name} · guardian #${guardian.id} ${guardian.first_name} ${guardian.last_name}\n`);

const edgeExists = async () => ((await db.execute(sql`SELECT 1 FROM contact_relationships WHERE guardian_id=${guardian.id} AND player_id=${child.id}`)).rows as any[]).length > 0;
const preExisting = await edgeExists();
console.log(`  (edge existed before: ${preExisting})`);

const link = async (rel: string) => db.execute(sql`
  INSERT INTO contact_relationships (guardian_id, player_id, relationship, is_primary_contact)
  VALUES (${guardian.id}, ${child.id}, ${rel}, true)
  ON CONFLICT (guardian_id, player_id) DO UPDATE SET relationship = EXCLUDED.relationship`);

if (!preExisting) {
  await link("Mother");
  ok(await edgeExists(), "link creates the edge");
  let fam = await resolveFamily("contact", child.id);
  ok((fam?.guardians || []).some(g => g.id === guardian.id), "the child's page now shows the parent");
  ok((fam?.guardians || []).find(g => g.id === guardian.id)?.relationship === "Mother", "relationship label is stored and shown");

  // Idempotency — the exact ON CONFLICT the endpoint relies on.
  await link("Father");
  const n = ((await db.execute(sql`SELECT 1 FROM contact_relationships WHERE guardian_id=${guardian.id} AND player_id=${child.id}`)).rows as any[]).length;
  ok(n === 1, "linking twice updates, never duplicates", `${n} rows`);
  fam = await resolveFamily("contact", child.id);
  ok((fam?.guardians || []).find(g => g.id === guardian.id)?.relationship === "Father", "re-linking updates the relationship");

  // Reverse direction must agree.
  const pfam = await resolveFamily("contact", guardian.id);
  ok((pfam?.children || []).some(c => c.records.some((r: any) => r.key === `contact-${child.id}`)),
     "the parent's page shows the child (both directions agree)");

  await db.execute(sql`DELETE FROM contact_relationships WHERE guardian_id=${guardian.id} AND player_id=${child.id}`);
  ok(!(await edgeExists()), "unlink removes the edge");
  const after = await resolveFamily("contact", child.id);
  const stillThere = (after?.guardians || []).some(g => g.id === guardian.id);
  const impliedByReg = ((await db.execute(sql`SELECT 1 FROM registrations WHERE contact_id=${child.id} AND guardian_id=${guardian.id}`)).rows as any[]).length > 0;
  ok(stillThere === impliedByReg, "after unlink the parent only remains if a registration implies it", `shown=${stillThere} implied=${impliedByReg}`);
} else {
  console.log("  (skipped write test — a real edge already exists for this pair)");
}

const finalState = await edgeExists();
ok(finalState === preExisting, "DATABASE RESTORED to its original state", `before=${preExisting} after=${finalState}`);
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
process.exit(fail > 0 ? 1 : 0);
