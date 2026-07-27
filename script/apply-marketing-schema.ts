// Additive migration: Marketing Suite ("MarketingOS") Phase A foundation —
// mkt_profiles / mkt_consent / mkt_suppressions / mkt_metrics / mkt_events /
// lists / segments / templates / campaigns / flows / email-event + SMS tables.
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying (migrate-before-deploy; never db:push).
//
// Usage: npx tsx --env-file=.env script/apply-marketing-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-09_marketing_suite.sql"), "utf8");

const TABLES = [
  "mkt_profiles", "mkt_consent", "mkt_suppressions", "mkt_metrics", "mkt_events",
  "mkt_lists", "mkt_list_members", "mkt_segments", "mkt_segment_members",
  "mkt_templates", "mkt_campaigns", "mkt_flows", "mkt_flow_versions",
  "mkt_flow_enrollments", "mkt_flow_step_runs", "mkt_email_messages",
  "mkt_email_events", "mkt_email_link_clicks", "mkt_conversions",
  "mkt_sms_messages", "mkt_sms_inbound",
];

(async () => {
  await pool.query(SQL);
  const counts: string[] = [];
  for (const t of TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    counts.push(`${t}=${r.rows[0].n}`);
  }
  console.log(`✅ Marketing schema applied. ${TABLES.length} tables present.`);
  console.log(counts.join(", "));
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });
