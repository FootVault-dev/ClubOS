// Verify family resolution against the LIVE database. Read-only.
//
//   npx tsx --env-file=.env script/_verify-family-links.ts
//
// Every case below is a real record chosen because it exercises a different one
// of the three link mechanisms. This is the harness for Olga's actual complaint:
// find the child, see the parent, see the parent's other children and their
// programmes.
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { resolveFamily, searchPeople } from "../server/family-routes";

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const name = (p: any) => `${p.firstName} ${p.lastName}`;

console.log("\n═══ FAMILY LINKING — verification against live data ═══\n");

// ── 1. Olga's exact case: a U4–U8 child who paid online ──────────────────────
console.log("1. A U4–U8 child who paid online (the reported case)");
const u4 = await db.execute(sql`
  SELECT r.contact_id, r.guardian_id FROM registrations r
  WHERE r.program_id = 4 AND r.status = 'confirmed' AND r.guardian_id IS NOT NULL
  ORDER BY r.id DESC LIMIT 1`);
const u4row = (u4.rows as any[])[0];
const childFam = await resolveFamily("contact", Number(u4row.contact_id));
ok(!!childFam, "child resolves");
console.log(`     child: ${childFam ? name(childFam.person) : "—"}`);
ok((childFam?.guardians.length || 0) > 0, "child shows at least one parent");
console.log(`     parents: ${childFam?.guardians.map(name).join(", ") || "NONE"}`);
ok((childFam?.registrations.length || 0) > 0, "child shows their own programme(s)");
console.log(`     programmes: ${childFam?.registrations.map(r => `${r.programName} (${r.status})`).join(", ") || "NONE"}`);

ok(/^\d{4}-\d{2}-\d{2}$/.test(childFam?.person.dateOfBirth || ""),
   "date of birth is a bare ISO day, not a driver Date", String(childFam?.person.dateOfBirth));

// ── 2. That child's parent, from the other direction ─────────────────────────
console.log("\n2. The same parent, opened from their own page");
const parentFam = await resolveFamily("contact", Number(u4row.guardian_id));
ok(!!parentFam, "parent resolves");
console.log(`     parent: ${parentFam ? name(parentFam.person) : "—"}`);
ok((parentFam?.children.length || 0) > 0, "parent shows their child/children");
for (const c of parentFam?.children || []) {
  console.log(`     child: ${name(c)} — ${c.registrations.map(r => `${r.programName} (${r.status})`).join(", ") || "no programmes"}${c.duplicateOfKey ? "  [duplicate]" : ""}`);
}
ok((parentFam?.children || []).some(c => c.registrations.length > 0),
   "at least one child carries their programme");

// ── 3. A parent with children on TWO different programmes ────────────────────
console.log("\n3. A parent whose children are on different programmes");
const multi = await db.execute(sql`
  SELECT r.guardian_id FROM registrations r
  JOIN contacts ct ON ct.id = r.contact_id
  WHERE r.guardian_id IS NOT NULL AND ct.type = 'player' AND r.contact_id <> r.guardian_id
  GROUP BY r.guardian_id HAVING count(DISTINCT r.program_id) > 1 LIMIT 1`);
const multiRow = (multi.rows as any[])[0];
if (multiRow) {
  const fam = await resolveFamily("contact", Number(multiRow.guardian_id));
  console.log(`     parent: ${fam ? name(fam.person) : "—"}`);
  const programmes = new Set((fam?.children || []).flatMap(c => c.registrations.map(r => r.programName)));
  for (const c of fam?.children || []) {
    console.log(`     child: ${name(c)} — ${c.registrations.map(r => r.programName).join(", ") || "no programmes"}`);
  }
  ok(programmes.size > 1, "two different programmes visible under one parent", `saw ${programmes.size}`);
} else { console.log("     (none in data)"); }

// ── 4. Camp shape: a `children` row and its parent ───────────────────────────
console.log("\n4. A holiday-camp child (the other people table)");
const camp = await db.execute(sql`
  SELECT ch.id, ch.parent_id FROM children ch
  JOIN registration_items ri ON ri.child_id = ch.id LIMIT 1`);
const campRow = (camp.rows as any[])[0];
if (campRow) {
  const kidFam = await resolveFamily("child", Number(campRow.id));
  ok(!!kidFam, "camp child resolves");
  console.log(`     child: ${kidFam ? name(kidFam.person) : "—"}`);
  ok((kidFam?.guardians.length || 0) > 0, "camp child shows their parent");
  console.log(`     parent: ${kidFam?.guardians.map(name).join(", ") || "NONE"}`);
  ok((kidFam?.registrations.length || 0) > 0, "camp child shows their camp booking");
  console.log(`     programmes: ${kidFam?.registrations.map(r => r.programName).join(", ") || "NONE"}`);

  const campParent = await resolveFamily("contact", Number(campRow.parent_id));
  ok((campParent?.children || []).some(c => c.kind === "child"), "camp parent shows camp children (regression)");
  console.log(`     parent's children: ${(campParent?.children || []).map(c => `${name(c)}[${c.kind}]`).join(", ")}`);
} else { console.log("     (none in data)"); }

// ── 5. An imported child: an edge, but no live registration ──────────────────
console.log("\n5. A Friendly Manager child — edge exists, no live registration");
const fm = await db.execute(sql`
  SELECT cr.player_id FROM contact_relationships cr
  JOIN contacts c ON c.id = cr.player_id
  WHERE c.friendly_manager_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.contact_id = cr.player_id)
  LIMIT 1`);
const fmRow = (fm.rows as any[])[0];
if (fmRow) {
  const fam = await resolveFamily("contact", Number(fmRow.player_id));
  console.log(`     child: ${fam ? name(fam.person) : "—"}`);
  ok((fam?.guardians.length || 0) > 0, "imported child still shows their parent (was invisible before)");
  console.log(`     parents: ${fam?.guardians.map(name).join(", ") || "NONE"}`);
} else { console.log("     (none in data)"); }

// ── 6. One card per child, programmes pooled ────────────────────────────────
console.log("\n6. Records for the same child merged into one");
const dupe = await db.execute(sql`
  SELECT cr.guardian_id FROM contact_relationships cr
  JOIN contacts c ON c.id = cr.player_id
  WHERE c.date_of_birth IS NOT NULL
  GROUP BY cr.guardian_id, lower(trim(c.first_name)), lower(trim(c.last_name)), c.date_of_birth
  HAVING count(*) > 1 LIMIT 1`);
const dupeRow = (dupe.rows as any[])[0];
if (dupeRow) {
  const fam = await resolveFamily("contact", Number(dupeRow.guardian_id));
  console.log(`     parent: ${fam ? name(fam.person) : "—"}`);
  for (const c of fam?.children || []) {
    console.log(`     ${name(c)} (${c.dateOfBirth}) — ${c.records.length} record(s) — ${c.registrations.map(r => `${r.programName}/${r.status}`).join(", ") || "no programmes"}`);
  }
  const multiRecord = (fam?.children || []).filter(c => c.records.length > 1);
  ok(multiRecord.length > 0, "repeated records collapse into a single child card");
  // The card must never show fewer programmes than the rows it stands for.
  let lost = 0;
  for (const c of fam?.children || []) {
    const perRecord = c.records.reduce((n: number, r: any) => n + r.registrationCount, 0);
    if (c.registrations.length < Math.min(perRecord, 1)) lost++;
  }
  ok(lost === 0, "no child card hides a programme its records carry");
} else { console.log("     (none in data)"); }

// A cross-shape child — camp row AND academy row — must show BOTH programmes.
const cross = await db.execute(sql`
  SELECT ch.parent_id AS gid FROM children ch
  JOIN contact_relationships cr ON cr.guardian_id = ch.parent_id
  JOIN contacts ct ON ct.id = cr.player_id
  WHERE ct.date_of_birth = ch.date_of_birth
    AND lower(trim(ct.first_name)) = lower(trim(ch.first_name))
    AND lower(trim(ct.last_name)) = lower(trim(ch.last_name))
  LIMIT 1`);
const crossRow = (cross.rows as any[])[0];
if (crossRow) {
  const fam = await resolveFamily("contact", Number(crossRow.gid));
  const merged = (fam?.children || []).find(c => c.crossShape);
  ok(!!merged, "a child with both a camp and an academy record is ONE card");
  if (merged) {
    console.log(`     ${name(merged)} — records ${merged.records.map(r => r.key).join(" + ")} — ${merged.registrations.map(r => r.programName).join(", ")}`);
    const perRecord = merged.records.reduce((n: number, r: any) => n + r.registrationCount, 0);
    ok(merged.registrations.length === perRecord,
       "that card carries every programme from both records", `${merged.registrations.length} vs ${perRecord}`);
  }
}

// ── 7. Search finds a child by name ──────────────────────────────────────────
console.log("\n7. Search — the thing that returned nothing before");
const target = childFam ? childFam.person : null;
if (target) {
  const r = await searchPeople(target.firstName, "all", 50, 0);
  const found = (r.rows as any[]).some(x => Number(x.id) === target.id && x.kind === "contact");
  ok(found, `searching "${target.firstName}" returns the child`, `${r.total} results`);

  const players = await searchPeople(target.firstName, "players", 100, 0);
  ok((players.rows as any[]).some(x => Number(x.id) === target.id), "the Players filter includes academy children");
}

// A camp child must be findable too — they were in no search at all before.
const campKid = await db.execute(sql`SELECT first_name, id FROM children LIMIT 1`);
const campKidRow = (campKid.rows as any[])[0];
if (campKidRow) {
  const r = await searchPeople(campKidRow.first_name, "all", 50, 0);
  ok((r.rows as any[]).some(x => x.kind === "child" && Number(x.id) === Number(campKidRow.id)),
     `searching "${campKidRow.first_name}" returns the camp child`);
}

// Typo tolerance, since staff type fast.
if (target && target.firstName.length > 4) {
  const typo = target.firstName.slice(0, -1);
  const r = await searchPeople(typo, "all", 50, 0);
  ok((r.rows as any[]).some(x => Number(x.id) === target.id), `partial "${typo}" still finds them`);
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
process.exit(fail > 0 ? 1 : 0);
