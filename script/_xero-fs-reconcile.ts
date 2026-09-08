import fs from "fs";
import pg from "pg";
const ROOT = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/fm-migration/2026-09-08-funino";
const norm = (s: string) => s.replace(/^\((FS|G|A[^)]*)\)\s*/, "").replace(/[’']/g, "'").trim().toLowerCase();
const lines = fs.readFileSync(`${ROOT}/xero/invoices-FS-2026-07-01-to-09-08.txt`, "utf8").split("\n").filter(Boolean);
type Inv = { num: string; ref: string; to: string; date: string; paid: number; due: number; status: string };
const inv: Inv[] = [];
for (const l of lines) {
  const c = l.split(" | ").map((x) => x.trim());
  if (/^(INV|CN)-/.test(c[0])) {
    const money = (v: string) => Number(v.replace(/[(),]/g, "")) * (v.startsWith("(") ? -1 : 1);
    // INV rows: num, ref, to, date, due date, paid, due, status[, sent]; CN rows: num, ref, to, date, paid, due, status
    const isCn = c[0].startsWith("CN-");
    inv.push({ num: c[0], ref: c[1], to: c[2], date: c[3], paid: money(isCn ? c[4] : c[5]), due: money(isCn ? c[5] : c[6]), status: isCn ? c[6] : c[7] });
  }
}
const t3 = inv.filter((i) => /^FS 2026 - Term 3/.test(i.ref) && i.num.startsWith("INV-"));
const t3paid = t3.filter((i) => i.paid > 0 && i.status === "Paid");
const t3other = t3.filter((i) => !(i.paid > 0 && i.status === "Paid"));
const dump = JSON.parse(fs.readFileSync(`${ROOT}/fm-dump.json`, "utf8"));
const report = JSON.parse(fs.readFileSync(`${ROOT}/report-commit.json`, "utf8"));
const migrated = new Map(report.migrated.map((m: any) => [norm(m.player), m]));
const fmNames = new Map(Object.values(dump).map((p: any) => [norm(p.fields["person[firstName]"] + " " + p.fields["person[lastName]"]), p.id]));
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const clubos = (await c.query(`select r.id, r.status, r.total_cents, r.amount_paid, r.registered_at::date::text d, r.source, r.legacy_source, c.first_name||' '||c.last_name name, c.id cid from registrations r join contacts ct on ct.id=r.contact_id join contacts c on c.id=r.contact_id where r.program_id=4`)).rows;
  const byName = new Map<string, any[]>();
  for (const r of clubos) { const k = norm(r.name); byName.set(k, [...(byName.get(k) ?? []), r]); }
  const allContacts = async (n: string) => (await c.query(`select id, type, date_of_birth::text dob, friendly_manager_id fm from contacts where lower(first_name||' '||last_name)=$1`, [n])).rows;
  console.log(`Xero FS Term 3 invoices: ${t3.length} · paid ${t3paid.length} ($${t3paid.reduce((a, i) => a + i.paid, 0).toFixed(2)}) · not paid/other ${t3other.length}`);
  const buckets: Record<string, string[]> = { "A. already migrated from FM (Xero agrees)": [], "B. in FM group, no FM fee, PAID IN XERO → register": [], "C. not in FM group; paid in Xero; ClubOS has a confirmed reg (Olga mirrors ClubOS?)": [], "D. not in FM group, paid in Xero, NOT in ClubOS → register (needs contact details)": [] };
  const detail: any[] = [];
  for (const i of t3paid) {
    const n = norm(i.to);
    const m = migrated.get(n); const fm = fmNames.get(n); const regs = byName.get(n) ?? [];
    const real = regs.filter((r) => ["confirmed", "refunded", "partially_refunded"].includes(r.status));
    const line = `${i.to} · ${i.num} ${i.date} $${i.paid.toFixed(2)}${i.ref.length > 16 ? " · " + i.ref.slice(16) : ""}`;
    let bucket: string;
    if (m) bucket = "A. already migrated from FM (Xero agrees)";
    else if (fm) bucket = "B. in FM group, no FM fee, PAID IN XERO → register";
    else if (real.length) bucket = "C. not in FM group; paid in Xero; ClubOS has a confirmed reg (Olga mirrors ClubOS?)";
    else bucket = "D. not in FM group, paid in Xero, NOT in ClubOS → register (needs contact details)";
    buckets[bucket].push(line + (real.length ? ` [ClubOS #${real.map((r) => r.id + " " + r.source + " " + r.d + " $" + r.amount_paid).join(", ")}]` : "") + (regs.length && !real.length ? ` [ClubOS pending #${regs.map((r) => r.id).join(",")}]` : ""));
    detail.push({ xero: i, fmId: fm ?? null, migrated: !!m, clubos: regs.map((r) => ({ id: r.id, status: r.status, source: r.source, amount: r.amount_paid })), contacts: fm ? undefined : await allContacts(n), bucket: bucket[0] });
  }
  for (const [k, v] of Object.entries(buckets)) { console.log(`\n${k} (${v.length})`); v.forEach((x) => console.log("  " + x)); }
  console.log(`\nXero FS Term 3 rows NOT counted as paid (${t3other.length}):`); t3other.forEach((i) => console.log(`  ${i.num} ${i.to} ${i.date} paid $${i.paid} due $${i.due} ${i.status} · ${i.ref}`));
  const migratedNotInXero = report.migrated.filter((m: any) => !t3paid.some((i) => norm(i.to) === norm(m.player)));
  console.log(`\nMigrated from FM but NO Xero FS Term 3 invoice (${migratedNotInXero.length}):`); migratedNotInXero.forEach((m: any) => console.log(`  ${m.player} · ${m.feeRef} ${m.method} ${m.paidOn}`));
  const fmUnpaidStill = Object.values(dump).filter((p: any) => !migrated.has(norm(p.fields["person[firstName]"] + " " + p.fields["person[lastName]"])) && !t3paid.some((i) => norm(i.to) === norm(p.fields["person[firstName]"] + " " + p.fields["person[lastName]"])));
  console.log(`\nIn FM group, still NO Term 3 payment anywhere (${fmUnpaidStill.length}):`); fmUnpaidStill.forEach((p: any) => console.log(`  ${p.id} ${p.fields["person[firstName]"]} ${p.fields["person[lastName]"]}`));
  const cn = inv.filter((i) => i.num.startsWith("CN-") || i.due < 0);
  console.log(`\nCredit notes / overpayments in the window (${cn.length}):`); cn.forEach((i) => console.log(`  ${i.num} ${i.to} ${i.date} ${i.ref} paid ${i.paid} due ${i.due} ${i.status}`));
  fs.writeFileSync(`${ROOT}/xero/reconcile.json`, JSON.stringify({ t3paid, t3other, detail, migratedNotInXero, fmUnpaidStill: fmUnpaidStill.map((p: any) => p.id) }, null, 2));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
