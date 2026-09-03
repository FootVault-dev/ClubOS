/**
 * access-review.ts — who can actually see what in ClubOS?
 *
 * Built 2026-09-03. A super admin short-circuits every permission check, so
 * Daniel opening a page proves nothing about whether any member of staff can.
 * That is how 21 tabs ended up visible to him alone, and how one staff account
 * ended up with a completely blank sidebar without anyone noticing.
 *
 * Reads the live user table and reports, using the REAL canAccessTab:
 *   - every member, every workspace, how many tabs they actually get
 *   - any membership that renders an EMPTY sidebar
 *   - which tabs no ordinary staff member can reach at all
 *   - who holds each per-person unlocked_tabs grant
 *
 *   npx tsx --env-file=.env script/access-review.ts            # summary
 *   npx tsx --env-file=.env script/access-review.ts --full     # every tab listed
 *   npx tsx --env-file=.env script/access-review.ts --who ryan # one person
 */
import pg from "pg";
import { canAccessTab, SUPER_ADMIN_ONLY_TABS, tabsForOrgSlug } from "../shared/tabs.js";
import { HIDDEN_GLOBAL, HIDDEN_BY_WORKSPACE } from "../shared/sidebar-hidden.js";

/** A tab clears TWO gates to be visible: may this person reach it, AND do we
 *  draw it at all? Permission alone over-reports — Studio is unlocked for
 *  everyone and drawn for nobody. */
const drawn = (ws: string, slug: string) =>
  !HIDDEN_GLOBAL.includes(slug) && !(HIDDEN_BY_WORKSPACE[ws] ?? []).includes(slug);

const FULL = process.argv.includes("--full");
const WHO = process.argv[process.argv.indexOf("--who") + 1];
const who = process.argv.includes("--who") ? WHO?.toLowerCase() : null;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(`
  select u.id, u.email, u.role gr, u.first_name f, u.last_name l,
         o.slug ws, uo.role mr, uo.tabs, uo.unlocked_tabs un
  from users u
  join user_organizations uo on uo.user_id = u.id
  join organizations o on o.id = uo.organization_id
  where u.email not like 'viewas-%'
  order by u.id, o.slug;`);
await c.end();

const byUser = new Map<number, typeof rows>();
for (const r of rows) {
  if (!byUser.has(r.id)) byUser.set(r.id, [] as any);
  byUser.get(r.id)!.push(r);
}

const empty: string[] = [];
const grants: string[] = [];

console.log("ACCESS REVIEW — what each person actually sees\n" + "=".repeat(60));
for (const [, rs] of byUser) {
  const name = `${rs[0].f || ""} ${rs[0].l || ""}`.trim() || rs[0].email;
  if (who && !name.toLowerCase().includes(who) && !rs[0].email.toLowerCase().includes(who)) continue;
  console.log(`\n${name}  <${rs[0].email}>   global_role=${rs[0].gr}`);
  for (const w of rs) {
    const defs = tabsForOrgSlug(w.ws);
    const vis = defs.filter((t) => drawn(w.ws, t.slug) &&
      canAccessTab({ globalRole: w.gr, membershipRole: w.mr, membershipTabs: w.tabs,
                     membershipUnlockedTabs: w.un, tabSlug: t.slug }));
    let note = "";
    if (vis.length === 0) { note = "   🔴 EMPTY SIDEBAR — this person logs in to nothing"; empty.push(`${name} — ${w.ws}`); }
    else if (vis.length <= 3) note = `   ⚠️  only: ${vis.map((t) => t.title).join(", ")}`;
    console.log(`   ${w.ws.padEnd(30)} role=${String(w.mr).padEnd(12)} ${String(vis.length).padStart(2)}/${defs.length}${note}`);
    if (FULL && vis.length) console.log(`        ${vis.map((t) => t.title).join(" · ")}`);
    if (w.un?.length) grants.push(`${name.padEnd(20)} ${w.ws.padEnd(24)} ${w.un.join(", ")}`);
  }
}

// Which tabs can NO ordinary staff member reach?
const unreachable = new Map<string, string[]>();
for (const ws of [...new Set(rows.map((r) => r.ws))].sort()) {
  for (const t of tabsForOrgSlug(ws)) {
    const anyone = rows.some((w) => w.ws === ws && w.gr !== "super_admin" && drawn(ws, t.slug) &&
      canAccessTab({ globalRole: w.gr, membershipRole: w.mr, membershipTabs: w.tabs,
                     membershipUnlockedTabs: w.un, tabSlug: t.slug }));
    if (!anyone) {
      if (!unreachable.has(t.title)) unreachable.set(t.title, []);
      unreachable.get(t.title)!.push(ws);
    }
  }
}

console.log("\n" + "=".repeat(60));
console.log(`\nLOCKED TO THE SUPER ADMIN (${SUPER_ADMIN_ONLY_TABS.size} slugs):`);
console.log("  " + [...SUPER_ADMIN_ONLY_TABS].sort().join(", "));

console.log(`\nTABS NO ORDINARY STAFF MEMBER CAN REACH (${unreachable.size})`);
console.log("  (either locked to the super admin, or not drawn in the sidebar at all)");
if (!unreachable.size) console.log("  none — every tab is reachable by at least one non-super-admin");
for (const [title, wss] of [...unreachable].sort()) console.log(`  ${title.padEnd(24)} ${wss.join(", ")}`);

console.log(`\nPER-PERSON UNLOCKS (${grants.length}):`);
console.log(grants.length ? grants.map((g) => "  " + g).join("\n") : "  none");

console.log(`\nEMPTY SIDEBARS (${empty.length}):`);
console.log(empty.length ? empty.map((e) => "  🔴 " + e).join("\n") : "  none ✅");
console.log("");
