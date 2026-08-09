/**
 * Applies migrations/2026-08-09_email_campaign_recipients.sql — per-recipient
 * delivery + open tracking for the ClubOS mailers.
 *
 * Additive and idempotent (every statement is IF NOT EXISTS), so a second run
 * is a no-op. There is no local Postgres, so `--dry-run` rehearses the whole
 * thing inside a transaction that is then ROLLED BACK — the only safe way to
 * prove a ClubOS migration before it touches prod.
 *
 *   npx tsx --env-file=.env script/apply-email-campaign-recipients.ts --dry-run
 *   npx tsx --env-file=.env script/apply-email-campaign-recipients.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const sql = readFileSync(
    join(process.cwd(), "migrations", "2026-08-09_email_campaign_recipients.sql"),
    "utf8",
  );

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`${dryRun ? "DRY RUN" : "APPLYING"} — email_campaign_recipients\n`);

  try {
    await client.query("BEGIN");
    await client.query(sql);

    // Verify inside the same transaction, so a dry run proves the real thing.
    const cols = await client.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_name = 'email_campaign_recipients'
        order by ordinal_position`,
    );
    console.log("Columns:");
    console.table(cols.rows);

    const idx = await client.query(
      `select indexname from pg_indexes where tablename = 'email_campaign_recipients' order by 1`,
    );
    console.log("Indexes:", idx.rows.map((r) => r.indexname).join(", "));

    const rls = await client.query(
      `select relrowsecurity from pg_class where relname = 'email_campaign_recipients'`,
    );
    console.log("RLS enabled:", rls.rows[0]?.relrowsecurity);

    // The unique index must actually stop a duplicate (campaign, email) pair —
    // asserted rather than assumed, because that is what keeps open counts sane.
    const [campaign] = (await client.query(`select id from email_campaigns order by id desc limit 1`)).rows;
    if (campaign) {
      await client.query(
        `insert into email_campaign_recipients (campaign_id, email) values ($1, 'Dupe@Test.example')`,
        [campaign.id],
      );
      const dupe = await client.query(
        `insert into email_campaign_recipients (campaign_id, email) values ($1, 'dupe@test.example')
         on conflict do nothing returning id`,
        [campaign.id],
      );
      console.log(
        dupe.rowCount === 0
          ? "✓ duplicate (campaign, email) correctly rejected — case-insensitively"
          : "✗ DUPLICATE GOT IN — the unique index is not doing its job",
      );
      if (dupe.rowCount !== 0) throw new Error("unique index failed its check");
      // Clean the probe rows regardless of dry/live.
      await client.query(
        `delete from email_campaign_recipients where lower(email) = 'dupe@test.example'`,
      );
    } else {
      console.log("(no campaigns yet — skipped the duplicate check)");
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("\nROLLED BACK — nothing was changed. Re-run without --dry-run to apply.");
    } else {
      await client.query("COMMIT");
      console.log("\n✓ Applied.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("\n✗ FAILED:", e.message); process.exit(1); });
