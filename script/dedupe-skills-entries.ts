// Remove the surplus row where one child was registered twice in the same
// Skills Challenge category under two spellings of their club.
//
// Why this exists: skillsCreateEntry() dedupes on (player, club, age, challenge)
// with an EXACT club-string compare, so "Nomads united" and "Nomads United AFC"
// look like two different clubs and Arlo Pitman ends up in the U10 juggling
// twice. Left alone he ranks 1st AND 2nd on the live leaderboard.
//
// Rules, deliberately conservative:
//   • A group is only a duplicate if the player name matches (case/space
//     insensitive) AND canonicalClub() says the clubs are the same club AND the
//     age group and challenge are identical. Nothing fuzzy about names.
//   • Keep the EARLIEST registration (the original), delete the later one — but
//     if exactly one row in the group carries a score, keep that one instead.
//     Never delete a scored row in favour of an unscored one.
//   • If more than one row in a group is scored, SKIP the group and report it.
//     Two different scores for one child is a human question, not a script's.
//   • The kept row's club_name is rewritten to the canonical spelling so the
//     standings read consistently and the picker stops fragmenting.
//
// Usage:
//   npx tsx --env-file=.env script/dedupe-skills-entries.ts            # dry run
//   npx tsx --env-file=.env script/dedupe-skills-entries.ts --apply    # writes
import { Pool } from "pg";
import { canonicalClub } from "../client/src/lib/skills-clubs";

const ORG_ID = 5; // CIC
const APPLY = process.argv.includes("--apply");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface Row {
  id: number;
  player_name: string;
  club_name: string;
  age_group: string;
  challenge: string;
  score: string | null;
  created_at: Date;
}

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

async function main() {
  const { rows } = await pool.query<Row>(
    `select id, player_name, club_name, age_group, challenge, score, created_at
       from skills_challenge_entries where organization_id = $1 order by created_at asc`,
    [ORG_ID],
  );

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = [normName(r.player_name), canonicalClub(r.club_name).toLowerCase(), r.age_group, r.challenge].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const deletions: { keep: Row; drop: Row[] }[] = [];
  const conflicts: Row[][] = [];

  for (const group of Array.from(groups.values())) {
    if (group.length < 2) continue;
    const scored = group.filter((r) => r.score != null);
    if (scored.length > 1) {
      conflicts.push(group);
      continue;
    }
    const keep = scored.length === 1 ? scored[0] : group[0]; // group is created_at asc
    deletions.push({ keep, drop: group.filter((r) => r.id !== keep.id) });
  }

  console.log(`\n${rows.length} entries · ${deletions.length} duplicate players · ${conflicts.length} needing a human\n`);

  for (const { keep, drop } of deletions) {
    const canon = canonicalClub(keep.club_name);
    console.log(`${keep.player_name} — ${keep.age_group} ${keep.challenge}`);
    console.log(`   KEEP   id=${keep.id}  "${keep.club_name}"${canon !== keep.club_name ? ` → "${canon}"` : ""}${keep.score != null ? `  score=${keep.score}` : ""}`);
    for (const d of drop) console.log(`   DELETE id=${d.id}  "${d.club_name}"${d.score != null ? `  score=${d.score}` : ""}`);
  }

  for (const group of conflicts) {
    console.log(`\n⚠️  SKIPPED — ${group[0].player_name} (${group[0].age_group} ${group[0].challenge}) has more than one score:`);
    for (const r of group) console.log(`   id=${r.id}  "${r.club_name}"  score=${r.score}`);
    console.log(`   A human must decide which score is real.`);
  }

  if (!APPLY) {
    console.log(`\n🔍 DRY RUN — nothing written. Re-run with --apply to delete ${deletions.reduce((s, d) => s + d.drop.length, 0)} row(s).\n`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let deleted = 0;
    let renamed = 0;
    for (const { keep, drop } of deletions) {
      for (const d of drop) {
        const res = await client.query(
          `delete from skills_challenge_entries where id = $1 and organization_id = $2 and score is null`,
          [d.id, ORG_ID],
        );
        // score is null in the WHERE clause is a belt-and-braces guard: if a
        // score landed between the read and this write, the delete is a no-op
        // and the transaction aborts rather than throwing away a real result.
        if (res.rowCount !== 1) throw new Error(`refusing to delete id=${d.id} — it now carries a score. Re-run the dry run.`);
        deleted += res.rowCount;
      }
      const canon = canonicalClub(keep.club_name);
      if (canon !== keep.club_name) {
        await client.query(`update skills_challenge_entries set club_name = $1 where id = $2 and organization_id = $3`, [canon, keep.id, ORG_ID]);
        renamed++;
      }
    }
    await client.query("COMMIT");
    console.log(`\n✅ Deleted ${deleted} duplicate row(s), canonicalised ${renamed} club name(s).\n`);
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(`\n❌ Rolled back — nothing changed. ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
