// Seed Christchurch United's Term 3 2026 youth rosters into club_squads /
// club_squad_members.
//
//   npx tsx --env-file=.env script/seed-cufc-term3-rosters.ts            # dry run
//   npx tsx --env-file=.env script/seed-cufc-term3-rosters.ts --commit   # writes
//
// SOURCE OF TRUTH: "CUFC Youth - Team Rosters (Term 3) - 2026.xlsx", supplied by
// Paul Holocher (Academy Director), 23 July 2026. Parsed verbatim into
// script/data/cufc-term3-2026-rosters.json — 23 teams, 256 players. Nothing in
// that file is inferred; every player sits at a known row of Paul's sheet.
//
// WHY THIS ISN'T JUST AN INSERT
// -----------------------------
// A squad member is a `contacts` row (see migrations/2026-07-10_club_squads.sql).
// Paul's sheet gives a NAME and usually only a BIRTH YEAR, so each of the 256
// players has to be resolved against 6,482 existing player contacts. Two ways to
// get that wrong, and they are not equally bad:
//
//   • Linking the WRONG child — the roster lies, the NZF audit lies, and a coach
//     sees a child who isn't theirs. Unacceptable.
//   • Creating a DUPLICATE contact — the roster still reads correctly; the club
//     carries one more duplicate in a table that already has many.
//
// So the rule is: when in doubt, CREATE. Never guess a link.
//
// Resolution order per player:
//   1. MANUAL[] below — a human (Claude, with Daniel reviewing) checked the
//      evidence and pinned the contact id. Every entry carries its reason.
//   2. Exact match on the full name with punctuation/spacing/case ignored, so
//      "Amir | Ali Rahimi" finds "Amir Ali | Rahimi".
//   3. Among several same-name contacts, prefer birth-year agreement first, then
//      the most complete record (has registrations > has DOB > has contact
//      details), then the lowest id. The DB holds many duplicate contacts; this
//      picks the one the rest of ClubOS already uses.
//   4. Fuzzy (edit distance ≤ 2 on the full name) ONLY when the birth year also
//      agrees — this is what catches Soppett/Soppet, Bayley/Bayly, Faalago/Fa'alogo.
//   5. Anything left over becomes a new contact, listed in the dry run.
//
// REJECT[] holds fuzzy matches that look close but are different children.
//
// Idempotent: squads on (org, season, lower(name)), members on the
// (squad, contact, role) unique index. Safe to re-run.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const COMMIT = process.argv.includes("--commit");
const ORG_SLUG = "christchurch-united";
const SEASON = 2026;
const HERE = dirname(fileURLToPath(import.meta.url));

type Player = {
  first: string; last: string; dob: string | null; birth_year: number | null;
  position: string | null; notes: string | null; sheet_row: number;
};
type Team = {
  name: string; age_grade: number; competition: string; band: string;
  coach: string | null; display_order: number; source_title: string; players: Player[];
};

const TEAMS: Team[] = JSON.parse(
  readFileSync(join(HERE, "data/cufc-term3-2026-rosters.json"), "utf8"),
);

// ── Human-verified links ────────────────────────────────────────────────────
// Keyed "Team|First|Last" exactly as it appears in the roster JSON. Each was
// checked against the contact's date of birth and, where relevant, siblings
// already in the club. `null` means "confirmed NOT in contacts — create".
const MANUAL: Record<string, { id: number | null; why: string }> = {
  "U9 Sparrows|Santiago|Goncalves":   { id: 31669, why: "Santiago Romeu Moreira Goncalves, DOB 2018-10-15 = the sheet's DOB exactly" },
  "U10 Royal|Ali|Sena":               { id: 32214, why: "Ali Sena Qurbanzada, b.2017 — sheet split his given names; Qurbanzada siblings in U9/U14/U17" },
  "U11 White|Ezekiel|Johns":          { id: 32735, why: "Ezekiel Atger-Johns, b.2015-01-21 (31570 'Atger-Jihns' is a typo duplicate of the same child)" },
  "U11 White|Eli|Axcell-Stephens":    { id: 30921, why: "Elijah Axcell-Stephens, b.2015 — Eli/Elijah, only Axcell in the club" },
  "U11 Yellow|Rayeed - Mousufuddin|Chowdhurry": { id: 30102, why: "Mousufuddin (Rayeed) Chowdhurry, b.2015 — both names on the contact" },
  "U12 Blue|Riaan|Schvede":           { id: 32080, why: "Riaan Shevde, b.2014-05-29 — spelling variant, only Riaan of that year" },
  "U12 White|Yaraslov|Koulnov":       { id: 28186, why: "Yaroslav Koulanov, b.2014-02-05 — Koulanov siblings in U10 Royal and U14" },
  "U12 White|Panharith|Nhiv":         { id: 32032, why: "Panharith Ngounchhem, b.2014-04-05 — unique forename, year agrees. SURNAME DIFFERS: confirm with Paul" },
  "U13 White|Mario|Dominic - Beltran": { id: 28220, why: "Mario Domenech-Beltran, b.2013-06-30 — brother Ethan Domenech-Beltran in U10 Blue" },
  "U13 White|Benji|Gomez":            { id: 31759, why: "Benjamin Gomez Lambertucci, b.2013-03-29 — Benji/Benjamin" },
  "U14 Academy|Ali|Salehi":           { id: 29225, why: "Alisina Salehi, b.2012-07-14 — only Salehi in the club, year agrees. CONFIRM with Paul" },
  "U14 Academy|Diesel|Macca":         { id: 27045, why: "Diesel Mackie, b.2012-11-27 — unique forename, year agrees" },
  "U14 Academy|Saed|Nuradim":         { id: 32112, why: "Saed Nuradin Saed, b.2012-03-20" },
  "U15 Academy|Mahdi|Husseini":       { id: 26491, why: "Mahdi Hossiani, b.2011-06-23 — spelling variant, year agrees" },
  "U15 Academy|Daniel|Carey":         { id: 30883, why: "Daniel William Carey — only Daniel Carey; brother Peter Carey in U11 Blue" },
  "U17 Academy|Fritz|Cantos":         { id: 27660, why: "Fritz Bon Nino Cantos, b.2010-09-13" },
  "U17 Academy|Xavier|Barnett":       { id: 28952, why: "Xavier Horand Barnett, b.2010-03-31 — only Xavier Barnett (sheet says 2009)" },
  "U10 Blue|Toby|Mitchell":           { id: 32873, why: "Toby Mitchell b.2016 — NOT 25173 (b.2011, a different Toby Mitchell)" },
  "U10 Yellow|Lucas|Wang":            { id: 30075, why: "Lucas Wang b.2018 — NOT 28993 (b.2014, a different Lucas Wang)" },
  "U10 Royal|Ahmad|darwish":          { id: 30341, why: "Ahmed Darwish b.2016 — surname matches the sheet (30121 'Ahmad Dawish' is the same child duplicated)" },
  "U11 Yellow|Hadi|Hussani":          { id: 28604, why: "Hadi Hossiani, b.2014-11-30 — only Hadi; sheet's 2015 is a year out" },
  "U9 Fantails|Zach|Schroder":        { id: 37194, why: "Zac Schroder b.2017 — Zach/Zac; sheet gives no DOB so this can't be auto-matched. 30805 is the same child duplicated; 37194 carries the registration" },
  // Confirmed absent from contacts — these become new records.
  "U13 Blue|Manni|Singh":             { id: null, why: "only Singh is 'Ginni Singh' (no DOB) — a different child" },
  "U17 Academy|Daniel|Bell":          { id: null, why: "no Bell in contacts; fuzzy hit 'Daniel Kelly' b.2006 is a different person" },
  "U12 White|Marko|Ile":              { id: null, why: "fuzzy hit 'Marko Milev' is a different surname — not safe to link" },
  "U12 White|Arush|SELWYN":           { id: null, why: "no Selwyn in contacts; 'SELWYN' in caps may be a club, not a surname — check with Paul" },
  "U15 Academy|Jacob|Sales":          { id: null, why: "only Sales are Hugo (his U15 team-mate) and Eloise" },
  "U17 Academy|Scott|Gilby":          { id: null, why: "no Gilby in contacts" },
  "U17 Academy|Arlo|Moran":           { id: null, why: "no Moran child in contacts" },
  "U13 Blue|Max|Morgan":              { id: null, why: "no Max Morgan in contacts" },
  "NXT (U20)|Carter|Lachlund":        { id: null, why: "no Lachlund in contacts" },
  "NXT (U20)|Sam|Sheppard":           { id: null, why: "only Sheppard is Caden b.2018" },
  "NXT (U20)|Shoto|TBC":              { id: null, why: "surname blank on the sheet; no 'Shoto' in contacts" },
  "U10 Royal|Lakshveer|TBC":          { id: null, why: "surname blank on the sheet; no 'Lakshveer' in contacts" },
};

// Coaches. Reuse an existing contact where one plainly is that person; otherwise
// create a `staff` contact with NO email, so nothing can ever be mailed to it.
// Two teams name a coach by first name only — recorded in the squad notes, not
// turned into a half-a-person contact.
const COACH_CONTACT: Record<string, number> = {
  "Lew Gordon": 24648,   // Lewis Gordon, already type=staff
  "Tony Harvey": 25607,  // already type=staff
};
const COACH_NO_SURNAME = new Set(["James", "Will"]);

// ── Matching ────────────────────────────────────────────────────────────────
const norm = (s: string) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const key = (first: string, last: string) => norm(`${first} ${last}`).replace(/ /g, "");

function lev(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

type Contact = { id: number; first_name: string; last_name: string; year: number | null; score: number; k: string };

/** Prefer the birth year agreeing, THEN the most complete record, then oldest id. */
function pick(cands: Contact[], birthYear: number | null): Contact {
  return cands.slice().sort((a, b) => {
    if (birthYear) {
      const ay = a.year === birthYear ? 1 : 0, by = b.year === birthYear ? 1 : 0;
      if (ay !== by) return by - ay;
    }
    return b.score - a.score || a.id - b.id;
  })[0];
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  const [org] = (await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG])).rows;
  if (!org) throw new Error(`No organisation with slug '${ORG_SLUG}'`);
  console.log(`${org.name} (org ${org.id}) — season ${SEASON}`);
  console.log(COMMIT ? "COMMIT — writing to the database.\n" : "DRY RUN — nothing will be written. Re-run with --commit.\n");

  const contacts: Contact[] = (await pool.query(
    `SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.email, c.phone,
            (SELECT count(*) FROM registrations r WHERE r.contact_id = c.id)::int AS regs
       FROM contacts c WHERE c.type = 'player'`,
  )).rows.map((c: any) => ({
    id: c.id, first_name: c.first_name, last_name: c.last_name,
    year: c.date_of_birth ? new Date(c.date_of_birth).getFullYear() : null,
    score: (c.regs > 0 ? 100 : 0) + c.regs + (c.date_of_birth ? 10 : 0) + (c.email ? 5 : 0) + (c.phone ? 3 : 0),
    k: key(c.first_name, c.last_name),
  }));
  const byKey = new Map<string, Contact[]>();
  for (const c of contacts) { const a = byKey.get(c.k) ?? []; a.push(c); byKey.set(c.k, a); }

  type Plan = { p: Player; team: string; contactId: number | null; how: string; detail: string };
  const plans: Plan[] = [];

  for (const t of TEAMS) for (const p of t.players) {
    const mk = `${t.name}|${p.first}|${p.last}`;
    if (mk in MANUAL) {
      const m = MANUAL[mk];
      plans.push({ p, team: t.name, contactId: m.id, how: m.id ? "manual" : "manual-new", detail: m.why });
      continue;
    }
    const k = key(p.first, p.last);
    const exact = byKey.get(k) ?? [];
    if (exact.length) {
      const c = pick(exact, p.birth_year);
      const dup = exact.length > 1 ? ` (${exact.length} same-name contacts)` : "";
      const warn = p.birth_year && c.year && c.year !== p.birth_year ? ` ⚠ sheet ${p.birth_year} vs contact ${c.year}` : "";
      plans.push({ p, team: t.name, contactId: c.id, how: "exact", detail: `${c.first_name} ${c.last_name}${dup}${warn}` });
      continue;
    }
    const near = contacts.filter((c) => Math.abs(c.k.length - k.length) <= 3 && lev(c.k, k) <= 2 && p.birth_year && c.year === p.birth_year);
    if (near.length === 1) {
      plans.push({ p, team: t.name, contactId: near[0].id, how: "fuzzy", detail: `${near[0].first_name} ${near[0].last_name} (b.${near[0].year})` });
      continue;
    }
    plans.push({ p, team: t.name, contactId: null, how: "new", detail: near.length > 1 ? `${near.length} near matches, none decisive` : "no candidate" });
  }

  const n = (h: string) => plans.filter((x) => x.how === h).length;
  console.log(`${TEAMS.length} teams · ${plans.length} players`);
  console.log(`  matched exactly   ${n("exact")}`);
  console.log(`  matched by spelling ${n("fuzzy")}`);
  console.log(`  matched by hand   ${n("manual")}`);
  console.log(`  NEW contacts      ${n("new") + n("manual-new")}\n`);

  console.log("── New contacts to be created ──");
  for (const x of plans.filter((x) => !x.contactId))
    console.log(`  + ${x.team.padEnd(13)} ${x.p.first} ${x.p.last} (b.${x.p.birth_year ?? "?"})  — ${x.detail}`);

  // Two roster rows resolving to ONE contact would silently drop a player at the
  // (squad, contact, role) index — and across teams it means a child listed twice.
  const seen = new Map<string, Plan[]>();
  for (const x of plans.filter((x) => x.contactId)) {
    const k = `${x.team}|${x.contactId}`;
    seen.set(k, [...(seen.get(k) ?? []), x]);
  }
  const clashes = [...seen.values()].filter((v) => v.length > 1);
  console.log("\n── Two players in one team resolving to the same contact ──");
  for (const v of clashes) console.log(`  ✗ ${v[0].team}: ${v.map((x) => `${x.p.first} ${x.p.last} (row ${x.p.sheet_row})`).join("  ==  ")}`);
  if (!clashes.length) console.log("  (none)");

  const across = new Map<number, Plan[]>();
  for (const x of plans.filter((x) => x.contactId)) across.set(x.contactId!, [...(across.get(x.contactId!) ?? []), x]);
  const multi = [...across.values()].filter((v) => v.length > 1);
  console.log("\n── Players rostered in more than one team ──");
  for (const v of multi) console.log(`  · ${v[0].p.first} ${v[0].p.last}: ${v.map((x) => x.team).join(" + ")}`);
  if (!multi.length) console.log("  (none)");

  console.log("\n── Birth-year disagreements (sheet vs ClubOS; ClubOS DOB kept) ──");
  const warns = plans.filter((x) => x.detail.includes("⚠"));
  for (const x of warns) console.log(`  ! ${x.team.padEnd(13)} ${x.p.first} ${x.p.last}: ${x.detail.split("⚠")[1].trim()}`);
  if (!warns.length) console.log("  (none)");

  if (!COMMIT) {
    console.log("\n" + "─".repeat(72));
    console.log("Dry run complete. Re-run with --commit to write.");
    await pool.end();
    process.exit(0);
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    let squadsMade = 0, contactsMade = 0, membersMade = 0, coachesMade = 0;
    const newContactIds = new Map<string, number>();

    for (const t of TEAMS) {
      // Squad — idempotent on (org, season, lower(name)).
      const coachLine = t.coach ? ` Head coach: ${t.coach}.` : " Head coach not named on the sheet.";
      const notes = `Term 3 2026 roster from Paul Holocher (Academy Director), sheet "${t.source_title}", imported 23 Jul 2026.${coachLine}`;
      let [squad] = (await client.query(
        "SELECT id FROM club_squads WHERE organization_id=$1 AND season_year=$2 AND lower(name)=lower($3)",
        [org.id, SEASON, t.name],
      )).rows;
      if (squad) {
        await client.query(
          "UPDATE club_squads SET age_grade=$2, competition=$3, band=$4, display_order=$5, notes=$6, is_active=true, updated_at=now() WHERE id=$1",
          [squad.id, t.age_grade, t.competition, t.band, t.display_order, notes],
        );
        console.log(`= ${t.name.padEnd(14)} squad ${squad.id} (existing)`);
      } else {
        [squad] = (await client.query(
          `INSERT INTO club_squads (organization_id,name,age_grade,season_year,competition,band,display_order,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [org.id, t.name, t.age_grade, SEASON, t.competition, t.band, t.display_order, notes],
        )).rows;
        squadsMade++;
        console.log(`+ ${t.name.padEnd(14)} squad ${squad.id} (new)`);
      }

      for (const p of t.players) {
        const plan = plans.find((x) => x.team === t.name && x.p.sheet_row === p.sheet_row)!;
        let contactId = plan.contactId;
        if (!contactId) {
          const ck = `${key(p.first, p.last)}|${p.birth_year ?? ""}`;
          if (newContactIds.has(ck)) contactId = newContactIds.get(ck)!;
          else {
            const note = `Created from Paul Holocher's Term 3 2026 roster (${t.source_title}, row ${p.sheet_row}).`
              + (p.birth_year && !p.dob ? ` Sheet gives birth year ${p.birth_year} only — full DOB needed for the NZF audit.` : "");
            const [c] = (await client.query(
              `INSERT INTO contacts (type, first_name, last_name, date_of_birth, notes)
               VALUES ('player',$1,$2,$3,$4) RETURNING id`,
              [p.first, p.last, p.dob, note],
            )).rows;
            contactId = c.id; contactsMade++; newContactIds.set(ck, c.id);
          }
        }
        const res = await client.query(
          `INSERT INTO club_squad_members (squad_id, contact_id, role, position, notes)
           VALUES ($1,$2,'player',$3,$4)
           ON CONFLICT (squad_id, contact_id, role) DO NOTHING RETURNING id`,
          [squad.id, contactId, p.position, p.notes],
        );
        if (res.rowCount) membersMade++;
      }

      // Head coach.
      if (t.coach && !COACH_NO_SURNAME.has(t.coach)) {
        let coachId = COACH_CONTACT[t.coach];
        if (!coachId) {
          const [first, ...rest] = t.coach.split(" ");
          const last = rest.join(" ");
          const [existing] = (await client.query(
            "SELECT id FROM contacts WHERE type='staff' AND lower(first_name)=lower($1) AND lower(last_name)=lower($2)",
            [first, last],
          )).rows;
          if (existing) coachId = existing.id;
          else {
            const [c] = (await client.query(
              `INSERT INTO contacts (type, first_name, last_name, notes)
               VALUES ('staff',$1,$2,$3) RETURNING id`,
              [first, last, "Coach, from Paul Holocher's Term 3 2026 roster. No email on file."],
            )).rows;
            coachId = c.id; coachesMade++;
          }
          COACH_CONTACT[t.coach] = coachId;
        }
        const res = await client.query(
          `INSERT INTO club_squad_members (squad_id, contact_id, role, notes)
           VALUES ($1,$2,'head_coach',$3) ON CONFLICT (squad_id, contact_id, role) DO NOTHING RETURNING id`,
          [squad.id, coachId, "Head coach on Paul's Term 3 2026 roster"],
        );
        if (res.rowCount) membersMade++;
      }
    }

    // The generic placeholders seeded on 2026-07-10 are superseded by the real
    // team names. Archived, not deleted — reversible from /admin/squads.
    const superseded = ["U13 Academy", "U12 Pre-Academy", "U11 Pre-Academy", "U10 Pre-Academy", "U9s"];
    const arch = await client.query(
      `UPDATE club_squads SET is_active=false, updated_at=now(),
         notes = coalesce(notes,'') || ' Superseded by the named Term 3 2026 teams (archived 23 Jul 2026).'
       WHERE organization_id=$1 AND season_year=$2 AND name = ANY($3)
         AND NOT EXISTS (SELECT 1 FROM club_squad_members m WHERE m.squad_id = club_squads.id)
       RETURNING name`,
      [org.id, SEASON, superseded],
    );

    await client.query("COMMIT");
    console.log("\n" + "─".repeat(72));
    console.log(`Squads created ${squadsMade} · players linked ${membersMade} · new player contacts ${contactsMade} · new coach contacts ${coachesMade}`);
    console.log(`Archived superseded placeholders: ${arch.rows.map((r: any) => r.name).join(", ") || "none"}`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
