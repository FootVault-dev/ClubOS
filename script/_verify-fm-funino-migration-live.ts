// Live verification of script/migrate-fm-funino-2026.ts against production.
// Asserts the 24 Term 3 2026 FUNiño registrations migrated from Friendly
// Manager on 2026-09-08 are present, paid, visible to staff, correctly linked
// to their parents, and that nothing else on programme 4 was disturbed.
//   npx tsx --env-file=.env script/_verify-fm-funino-migration-live.ts
import pg from "pg";
import { REAL_REGISTRATION_STATUS_SQL } from "../shared/registrations";
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s: string, p: any[] = []) => (await c.query(s, p)).rows;
  let fails = 0; const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails++; };
  const regs = await q(`select r.id, r.order_number, r.status, r.total_cents, r.amount_paid, r.payment_method, r.registration_location, r.source, r.legacy_external_id, r.paid_at, r.registered_at, r.guardian_id, r.program_option_id, r.season_year, r.academy_payment_plan, c.first_name, c.last_name, c.friendly_manager_id fm from registrations r join contacts c on c.id=r.contact_id where r.legacy_source='friendly_manager' order by r.id`);
  ok(regs.length === 24, `24 migrated registrations (${regs.length})`);
  ok(regs.every(r => r.status === "confirmed" && r.total_cents === 16000 && r.amount_paid === "160.00" && r.program_option_id === 7 && r.season_year === 2026 && r.academy_payment_plan === "term" && r.guardian_id && r.order_number), "every row confirmed · $160 · option 7 · 2026 · term · guardian · order number");
  ok(regs.filter(r => r.payment_method === "eftpos" && r.registration_location === "cufc_office").length === 7, "7 EFTPOS at cufc_office");
  ok(regs.filter(r => r.payment_method === "online_card" && r.registration_location === "online").length === 17, "17 online_card / online");
  ok(new Set(regs.map(r => r.legacy_external_id)).size === 24, "24 distinct FM fee refs");
  const counts = (await q(`select status, count(*)::int n from registrations where program_id=4 group by 1`)).reduce((a: any, r: any) => (a[r.status] = r.n, a), {});
  console.log("  program 4 now:", JSON.stringify(counts));
  ok(counts.confirmed === 115, `programme 4 confirmed = 115 (90 + 24 migrated + William Ellis, an online checkout at 19:54 NZ tonight) → ${counts.confirmed}`);
  ok(counts.pending === 28, `programme 4 pending = 28 (29 − Bastian's superseded checkout) → ${counts.pending}`);
  const b = (await q(`select id, status, notes from registrations where id=605`))[0];
  ok(b.status === "cancelled" && /superseded by registration #757/.test(b.notes), `Bastian's abandoned checkout #605 cancelled with cross-reference → ${b.status}`);
  const hidden = await q(`select c.id, c.first_name from contacts c where c.id = any($1) and (EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = c.id OR r.guardian_id = c.id) AND r.status = 'pending') AND NOT EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = c.id OR r.guardian_id = c.id) AND r.status IN ('confirmed','refunded','partially_refunded')) AND c.friendly_manager_id IS NULL)`, [ (await q(`select contact_id from registrations where legacy_source='friendly_manager'`)).map(r => r.contact_id) ]);
  ok(hidden.length === 0, `none of the 24 players is hidden by the paid-only decider (${hidden.length} hidden)`);
  const gHidden = await q(`select c.id, c.first_name from contacts c where c.id = any($1) and (EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = c.id OR r.guardian_id = c.id) AND r.status = 'pending') AND NOT EXISTS (SELECT 1 FROM registrations r WHERE (r.contact_id = c.id OR r.guardian_id = c.id) AND r.status IN ('confirmed','refunded','partially_refunded')) AND c.friendly_manager_id IS NULL)`, [ regs.map(r => r.guardian_id) ]);
  ok(gHidden.length === 0, `no primary guardian hidden (${gHidden.length})`);
  const real = await q(`select count(*)::int n from registrations where program_id=4 and status in ${REAL_REGISTRATION_STATUS_SQL}`);
  console.log("  real registrations on programme 4:", real[0].n);
  const dupOrders = await q(`select order_number from registrations where order_number is not null group by 1 having count(*)>1`);
  ok(dupOrders.length === 0, "order numbers unique");
  const aaron = (await q(`select * from contacts where friendly_manager_id='43590'`))[0];
  console.log("  Aaron Wang:", JSON.stringify({ id: aaron.id, type: aaron.type, dob: aaron.date_of_birth, gender: aaron.gender, address: aaron.address, street: aaron.address_street, suburb: aaron.address_suburb, city: aaron.address_city, pc: aaron.address_postcode, school: aaron.school, photo: aaron.photo_consent, cob: aaron.country_of_birth, cobc: aaron.country_of_birth_code, nat: aaron.nationality, natc: aaron.nationality_code, eth: aaron.ethnicity, ethg: aaron.ethnicity_group_id, sub: aaron.sub_ethnicity, sel: aaron.ethnicity_selection_ids, src: aaron.identity_captured_source }));
  ok(aaron.address_street === "113 kittyhawk avenue" && aaron.school?.startsWith("Wigram") && aaron.photo_consent === true && aaron.nationality_code === "NZL" && aaron.ethnicity_group_id != null, "Aaron Wang's details landed (address parts, school, photo consent, structured NZF identity)");
  const fam = await q(`select r.relationship, r.is_primary_contact, g.type gtype, g.first_name||' '||g.last_name guardian, g.email, g.phone, g.friendly_manager_id gfm from contact_relationships r join contacts g on g.id=r.guardian_id where r.player_id=$1`, [aaron.id]);
  console.log("  Aaron's family:", JSON.stringify(fam));
  ok(fam.length === 1 && fam[0].gtype === "guardian" && fam[0].email === "selinewem@gmail.com" && fam[0].gfm === "43589", "Aaron ↔ Seline Han linked, guardian typed, FM id set");
  const moss = await q(`select r.relationship, r.is_primary_contact, g.type gtype, g.first_name guardian, g.friendly_manager_id gfm from contact_relationships r join contacts g on g.id=r.guardian_id where r.player_id=(select id from contacts where friendly_manager_id='43379') order by r.is_primary_contact desc`);
  console.log("  Jackson Moss family:", JSON.stringify(moss));
  ok(moss.length === 2 && moss.some(m => m.guardian === "Quentin" && m.gtype === "guardian" && m.is_primary_contact === false), "Jackson Moss: Kim (primary) + Quentin (secondary, retyped to guardian)");
  const jackson = (await q(`select medical_notes, school_year, ethnicity, ethnicity_group_id, sub_ethnicity from contacts where friendly_manager_id='43379'`))[0];
  ok(jackson.medical_notes === "Asthma - managed" && jackson.school_year === "Year 2" && jackson.ethnicity === "NZ European" && jackson.ethnicity_group_id != null, `Jackson Moss medical/school-year/NZ European landed → ${JSON.stringify(jackson)}`);
  const iritana = (await q(`select medical_notes, ethnicity, sub_ethnicity, ethnicity_selection_ids from contacts where friendly_manager_id='43442'`))[0];
  // Her "No" medical note predates this migration (July FM history import wrote it verbatim); the migration must leave it, not overwrite it.
  ok(iritana.medical_notes === "No" && iritana.sub_ethnicity === "Ngāti Porou" && (iritana.ethnicity_selection_ids?.length === 1), `Iritana: pre-existing medical note untouched; Māori · Ngāti Porou structured → ${JSON.stringify(iritana)}`);
  const audit = await q(`select count(*)::int n from audit_logs where action='import' and entity='registration' and details like 'FM migration (script/migrate-fm-funino-2026.ts)%'`);
  ok(audit[0].n === 24, `24 audit rows (${audit[0].n})`);
  const dates = regs.map(r => [r.legacy_external_id, r.paid_at?.toISOString?.().slice(0,10), String(r.registered_at).slice(0,15)]);
  console.log("  sample dates:", JSON.stringify(dates.slice(0,3)));
  ok(regs.every(r => r.paid_at && r.paid_at.toISOString().slice(0,10) >= "2026-07-01" && r.paid_at.toISOString().slice(0,10) <= "2026-08-25"), "paid_at all within 1 Jul – 25 Aug 2026 (Term 3 window)");
  console.log(fails ? `\n${fails} FAILED` : "\nALL CHECKS PASSED");
  await c.end();
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
