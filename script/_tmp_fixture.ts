import pg from "pg";
import { holderLink } from "../server/equipment-routes";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  const [{ id: orgId }] = (await c.query("select id from organizations where slug='united-sports-group'")).rows;
  const h = (await c.query(
    `insert into equipment_holders (organization_id, team_name, programme, person_name, email, storage_location)
     values ($1,'PREFLIGHT U9 Sparrows','Academy','Sam Peterson','preflight-equip@example.invalid','Container 2')
     returning id, link_version`, [orgId])).rows[0];
  const items: [string, string, number][] = [
    ["Size 4 footballs", "balls", 22], ["Training bibs (yellow)", "bibs", 24],
    ["Marker cones", "cones_markers", 40], ["Portable goals 1.5m", "goals_nets", 2],
    ["First aid kit", "first_aid", 1], ["Ball bag", "bags_storage", 2],
  ];
  for (const [name, category, quantity] of items) {
    await c.query(
      `insert into equipment_items (organization_id, holder_id, name, category, quantity, added_via)
       values ($1,$2,$3,$4,$5,'holder')`, [orgId, h.id, name, category, quantity]);
  }
  await c.query(
    `insert into equipment_audit_rounds (organization_id, year, term_number, label, due_on, notes)
     values ($1, 2999, 4, 'PREFLIGHT ROUND', '2999-09-05', 'preflight')`, [orgId]);
  console.log(holderLink(h.id, h.link_version));
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
