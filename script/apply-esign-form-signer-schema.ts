// Additive migration: esign_signers.is_form_signer
//
// WHY: the signing engine conflated two different ideas — "signs first" and
// "fills in their own details". Both were `signing_order = 0`. That made it
// impossible for the Club to sign first, because the Club would then be the one
// asked for the counterparty's date of birth, bank account and IRD number.
//
// This column separates them. `signing_order` keeps controlling WHO SIGNS FIRST
// (and therefore the sequential guard and the email hand-off). `is_form_signer`
// controls WHO FILLS THE FORM.
//
// SAFE ON EXISTING DATA: every current signer row with signing_order = 0 is the
// form signer, so we backfill exactly that. Every in-flight MFL referee and CIC
// vendor document keeps behaving identically.
//
// Idempotent. Run BEFORE deploying the code that reads the column
// (see reference_clubos_prod_db_drift: migrate first, then deploy).
//
// Usage: npx tsx --env-file=.env script/apply-esign-form-signer-schema.ts

import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE esign_signers
        ADD COLUMN IF NOT EXISTS is_form_signer boolean NOT NULL DEFAULT false
    `);

    // Backfill: the order-0 signer of every existing document is its form signer.
    const back = await client.query(`
      UPDATE esign_signers
         SET is_form_signer = true
       WHERE signing_order = 0
         AND is_form_signer = false
    `);

    // Integrity check: exactly one form signer per document, or none (pdf docs
    // created before native mode). Never more than one.
    const dupes = await client.query(`
      SELECT document_id, count(*) AS n
        FROM esign_signers
       WHERE is_form_signer
       GROUP BY document_id
      HAVING count(*) > 1
    `);
    if (dupes.rows.length) {
      throw new Error(`Refusing to commit — ${dupes.rows.length} document(s) have >1 form signer: ${dupes.rows.map((r) => r.document_id).join(", ")}`);
    }

    await client.query("COMMIT");
    console.log(`✅ esign_signers.is_form_signer applied — backfilled ${back.rowCount} signer row(s)`);

    const check = await client.query(`
      SELECT count(*) FILTER (WHERE is_form_signer) AS form_signers,
             count(*)                               AS total
        FROM esign_signers
    `);
    console.log(`   ${check.rows[0].form_signers} of ${check.rows[0].total} signer rows are form signers`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error("❌ Migration failed:", err.message ?? err); process.exit(1); });
