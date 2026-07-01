// Import extracted CIC team/club CONTACTS (rosters-contacts/*.json) into ClubOS:
//   - tournament_staff  (managers, coaches, officials: role/name/email/phone per team)
//   - tournament_teams.contactName/contactEmail/contactPhone  (team primary contact)
//   - clubs.contactName/contactEmail/contactPhone             (club official)
// Merges age + club sources by teamId, dedupes staff. Dry-run unless --commit.
//   npx tsx script/import-cic-contacts.ts <dir> [--commit]

import "dotenv/config";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const CIC_ORG_ID = 5;
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (s: any) => (s == null ? null : String(s).trim() || null);
function splitName(full: string): { first: string; last: string } {
  const n = (full || "").trim().replace(/\s+/g, " ");
  const sp = n.indexOf(" ");
  return sp === -1 ? { first: n, last: "" } : { first: n.slice(0, sp), last: n.slice(sp + 1) };
}

async function main() {
  const dir = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!dir) { console.error("Usage: tsx script/import-cic-contacts.ts <dir> [--commit]"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ClubOS teams + clubs
  const tours = (await pool.query(`SELECT id, age_group FROM tournaments WHERE organization_id=$1`, [CIC_ORG_ID])).rows;
  const ageNormKeyToId = new Map<string, number>();
  const teamAll: { teamId: number; name: string; age: string; clubId: number | null }[] = [];
  const validTeamIds = new Set<number>();
  for (const t of tours) {
    const age = "U" + String(t.age_group).replace(/\D/g, "");
    const teams = (await pool.query(`SELECT id, name, club_id FROM tournament_teams WHERE tournament_id=$1`, [t.id])).rows;
    for (const tm of teams) { teamAll.push({ teamId: tm.id, name: tm.name, age, clubId: tm.club_id }); ageNormKeyToId.set(age + "|" + norm(tm.name), tm.id); validTeamIds.add(tm.id); }
  }
  const clubs = (await pool.query(`SELECT id, name FROM clubs WHERE organization_id=$1`, [CIC_ORG_ID])).rows;
  const clubByName = new Map<string, number>(); for (const c of clubs) clubByName.set(norm(c.name), c.id);

  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  let staffIns = 0, staffSkip = 0, teamContacts = 0, clubContacts = 0;
  const teamsWithContact = new Set<number>();
  const unresolved: string[] = [];
  const clubMerge = new Map<string, { name: string | null; email: string | null; phone: string | null }>();

  await pool.query("BEGIN");
  for (const f of files) {
    let data: any; try { data = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { console.log(`⚠ ${f}: bad JSON`); continue; }
    for (const t of data.teams || []) {
      let tid: number | undefined = t.clubosTeamId && validTeamIds.has(t.clubosTeamId) ? t.clubosTeamId : undefined;
      if (!tid) tid = ageNormKeyToId.get((t.age || data.scope) + "|" + norm(t.clubosName || ""));
      if (!tid) { unresolved.push(`${f}: ${t.age || data.scope} "${t.clubosName}"`); continue; }

      // team primary contact
      const tc = t.teamContact || {};
      if (clean(tc.name) || clean(tc.email) || clean(tc.phone)) {
        await pool.query(
          `UPDATE tournament_teams SET contact_name=COALESCE($1,contact_name), contact_email=COALESCE($2,contact_email), contact_phone=COALESCE($3,contact_phone) WHERE id=$4`,
          [clean(tc.name), clean(tc.email), clean(tc.phone), tid]);
        teamContacts++; teamsWithContact.add(tid);
      }

      // staff (dedup vs existing)
      const existing = (await pool.query(`SELECT role, first_name, last_name FROM tournament_staff WHERE team_id=$1`, [tid])).rows;
      const seen = new Set(existing.map((e: any) => norm(e.role) + "|" + norm(e.first_name) + "|" + norm(e.last_name)));
      for (const s of t.staff || []) {
        let first = clean(s.firstName) || "", last = clean(s.lastName) || "";
        if (!first && (s as any).name) { const sp = splitName((s as any).name); first = sp.first; last = sp.last; }
        if (!first && !last) continue;
        const role = clean(s.role) || "Contact";
        const key = norm(role) + "|" + norm(first) + "|" + norm(last);
        if (seen.has(key)) { staffSkip++; continue; }
        seen.add(key);
        await pool.query(`INSERT INTO tournament_staff (team_id, role, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tid, role, first, last || "", clean(s.email), clean(s.phone)]);
        staffIns++; teamsWithContact.add(tid);
      }
    }
    // club-level contacts (merge across files)
    for (const c of data.clubContacts || []) {
      const k = norm(c.clubName || "");
      if (!k) continue;
      const cur = clubMerge.get(k) || { name: null, email: null, phone: null };
      cur.name ||= clean(c.name); cur.email ||= clean(c.email); cur.phone ||= clean(c.phone);
      clubMerge.set(k, cur);
    }
  }
  // apply club contacts
  for (const [k, v] of clubMerge) {
    let cid = clubByName.get(k);
    if (!cid) { for (const [cn, id] of clubByName) { if (cn && (cn.includes(k) || k.includes(cn))) { cid = id; break; } } }
    if (!cid) { unresolved.push(`club "${k}" not matched`); continue; }
    if (v.name || v.email || v.phone) {
      await pool.query(`UPDATE clubs SET contact_name=COALESCE($1,contact_name), contact_email=COALESCE($2,contact_email), contact_phone=COALESCE($3,contact_phone) WHERE id=$4`,
        [v.name, v.email, v.phone, cid]);
      clubContacts++;
    }
  }
  if (commit) await pool.query("COMMIT"); else await pool.query("ROLLBACK");

  console.log(`\n${commit ? "🟢 COMMITTED" : "🟡 DRY RUN"} — staff inserted ${staffIns} (skipped dupe ${staffSkip}), team-contacts set ${teamContacts}, club-contacts set ${clubContacts}`);
  if (unresolved.length) { console.log(`\n⚠ unresolved (${unresolved.length}):`); unresolved.forEach(u => console.log("   " + u)); }
  // coverage
  console.log(`\n=== CONTACT COVERAGE (teams with ≥1 staff/contact) ===`);
  const byAge: Record<string, { withc: number; tot: number; none: string[] }> = {};
  for (const t of teamAll) {
    if (t.name.toLowerCase() === "bye") continue;
    const a = (byAge[t.age] ||= { withc: 0, tot: 0, none: [] }); a.tot++;
    if (teamsWithContact.has(t.teamId)) a.withc++; else a.none.push(t.name);
  }
  for (const age of ["U9", "U10", "U11", "U12", "U13", "U14", "U15"]) {
    const a = byAge[age]; if (!a) continue;
    console.log(`\n${age}: ${a.withc}/${a.tot} teams have a contact`);
    if (a.none.length) console.log(`   no contact: ${a.none.join(", ")}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
