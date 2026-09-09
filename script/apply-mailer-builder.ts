// The Mailer's visual builder — the one column it needs.
//
// `email_campaigns.body` is the compiled, sendable HTML and stays exactly as it
// is: the send path reads it and nothing else, so a design that cannot be parsed
// can never stop an email going out. `body_doc` is the EDITABLE design behind it
// — what the builder loads when you reopen or duplicate a campaign.
//
// Additive, nullable, no default: every campaign sent before 2026-09-09 was
// written by the old contentEditable and genuinely has no design, which is not
// the same as an empty one.
//
// Dry run (default):  npx tsx --env-file=.env script/apply-mailer-builder.ts
// Apply:              npx tsx --env-file=.env script/apply-mailer-builder.ts --commit

import "dotenv/config";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const q = async (sql: string, p: any[] = []) => (await c.query(sql, p)).rows;

  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "  ok  " : "  ✗   "}${label}`);
    if (!ok) failures++;
  };

  try {
    await c.query("BEGIN");

    const before = (await q(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name='email_campaigns' AND column_name='body_doc'`,
    ))[0].n;
    console.log(`body_doc present before: ${before ? "yes (re-run)" : "no"}`);

    await c.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS body_doc jsonb`);

    // ── prove it, rather than trust the DDL ──────────────────────────────────
    const col = (await q(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='email_campaigns' AND column_name='body_doc'`,
    ))[0];
    check(!!col, "column exists");
    check(col?.data_type === "jsonb", `type is jsonb (${col?.data_type})`);
    check(col?.is_nullable === "YES", "nullable — 'no design' is a real answer");
    check(col?.column_default === null, "no default — an old campaign is not given a fake design");

    const campaigns = (await q(`SELECT count(*)::int n FROM email_campaigns`))[0].n;
    const withDoc = (await q(`SELECT count(*)::int n FROM email_campaigns WHERE body_doc IS NOT NULL`))[0].n;
    check(withDoc === 0 || before === 1, "existing campaigns untouched");
    console.log(`  ${campaigns} campaigns on file, ${withDoc} carrying a design`);

    // A round-trip, so we know the column really takes what the builder emits.
    const doc = { engine: "grapesjs-mjml", version: 1, mjml: "<mjml></mjml>", project: { pages: [] } };
    const probe = (await q(
      `INSERT INTO email_campaigns (subject, body, from_email, segment_type, status, body_doc)
       VALUES ('__probe__', '<p>x</p>', 'x@x', 'custom', 'draft', $1::jsonb) RETURNING id, body_doc`,
      [JSON.stringify(doc)],
    ))[0];
    check(probe?.body_doc?.engine === "grapesjs-mjml", "a builder document round-trips intact");
    await q(`DELETE FROM email_campaigns WHERE id=$1`, [probe.id]);

    if (failures) throw new Error(`${failures} check(s) failed`);

    if (COMMIT) {
      await c.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await c.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Re-run with --commit to apply.");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("\n✗", e.message ?? e);
  process.exit(1);
});
