// READ-ONLY probe. Decides the parent-session design:
// if one email maps to several contact rows, a session that resolves to ONE
// contact shows a parent half their family.
import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s: string) => pool.query(s).then(r => r.rows);

  console.log('\n── contacts with an email, by type ──');
  console.log(await q(`
    SELECT type::text, COUNT(*) AS n, COUNT(email) FILTER (WHERE email <> '') AS with_email
    FROM contacts GROUP BY type ORDER BY n DESC`));

  console.log('\n── emails mapping to MORE THAN ONE contact row ──');
  console.log(await q(`
    SELECT COUNT(*) AS dup_emails, SUM(n) AS rows_involved FROM (
      SELECT LOWER(TRIM(email)) AS e, COUNT(*) AS n
      FROM contacts WHERE email IS NOT NULL AND email <> ''
      GROUP BY 1 HAVING COUNT(*) > 1) t`));

  console.log('\n── worst offenders (how many rows share one email) ──');
  console.log(await q(`
    SELECT LOWER(TRIM(email)) AS email, COUNT(*) AS rows,
           COUNT(DISTINCT type::text) AS types,
           string_agg(DISTINCT type::text, ',') AS kinds
    FROM contacts WHERE email IS NOT NULL AND email <> ''
    GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 8`));

  console.log('\n── would a parent login find children? guardians vs their links ──');
  console.log(await q(`
    SELECT
      (SELECT COUNT(*) FROM contacts WHERE type='guardian' AND email IS NOT NULL AND email<>'') AS guardians_with_email,
      (SELECT COUNT(DISTINCT guardian_id) FROM contact_relationships) AS guardians_linked,
      (SELECT COUNT(*) FROM contact_relationships) AS relationship_rows,
      (SELECT COUNT(DISTINCT guardian_id) FROM registrations WHERE guardian_id IS NOT NULL) AS guardians_via_regs,
      (SELECT COUNT(*) FROM children WHERE parent_id IS NOT NULL) AS camp_children_linked`));

  console.log('\n── the same child registered twice (the duplicate the account fixes) ──');
  console.log(await q(`
    SELECT COUNT(*) AS dup_child_groups FROM (
      SELECT LOWER(TRIM(first_name)) f, LOWER(TRIM(last_name)) l, date_of_birth
      FROM contacts WHERE type='player' AND date_of_birth IS NOT NULL
      GROUP BY 1,2,3 HAVING COUNT(*) > 1) t`));

  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
