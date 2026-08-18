// Prove the locked-tab gate lets in exactly who it should — against LIVE rows.
//
//   npx tsx --env-file=.env script/_verify-unlocked-tabs.ts
//
// Runs the real `canAccessTab` over every real membership in the database, so
// the answer is about actual people, not a fixture. The thing being asserted is
// not "Ryan can see Vehicles" — it is "and the six other United Sports Group
// admins still cannot", which is the half a change like this gets wrong.
import pg from "pg";
import { canAccessTab, SUPER_ADMIN_ONLY_TABS } from "../shared/tabs";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    `select u.id, u.email, u.first_name || ' ' || coalesce(u.last_name,'') as name,
            u.role as global_role, o.slug as workspace,
            uo.role as ws_role, uo.tabs, uo.unlocked_tabs
       from user_organizations uo
       join users u on u.id = uo.user_id
       join organizations o on o.id = uo.organization_id
      where o.slug = 'united-sports-group'
      order by u.id`,
  );

  const reach = (r: any, tab: string) =>
    canAccessTab({
      globalRole: r.global_role,
      membershipRole: r.ws_role,
      membershipTabs: Array.isArray(r.tabs) ? r.tabs : null,
      membershipUnlockedTabs: Array.isArray(r.unlocked_tabs) ? r.unlocked_tabs : null,
      tabSlug: tab,
    });

  console.log(`\n  United Sports Group — ${rows.length} memberships\n`);

  const canSee = rows.filter((r) => reach(r, "vehicles"));
  const names = canSee.map((r) => r.name).sort();
  console.log(`  Vehicles is reachable by: ${names.join(", ")}\n`);

  // ── The grant works ────────────────────────────────────────────────────────
  const ryan = rows.find((r) => r.email === "ryan@cufc.co.nz");
  const travis = rows.find((r) => r.email === "travis@cufc.co.nz");
  ok("Ryan Edwards reaches Vehicles", !!ryan && reach(ryan, "vehicles"));
  ok("Travis Graham reaches Vehicles", !!travis && reach(travis, "vehicles"));
  ok("Daniel (super admin) still reaches Vehicles",
     !!rows.find((r) => r.email === "daniel@cufc.co.nz" && reach(r, "vehicles")));

  // ── And nobody else did ────────────────────────────────────────────────────
  const shouldNot = ["grassroots@cufc.co.nz", "marketing@cufc.co.nz", "academy@cufc.co.nz",
                     "info@cufc.co.nz", "dima@cufc.co.nz", "info@cugc.co.nz"];
  for (const email of shouldNot) {
    const r = rows.find((x) => x.email === email);
    ok(`${r?.name ?? email} (workspace admin) still cannot reach Vehicles`, !!r && !reach(r, "vehicles"));
  }

  // ── The grant is narrow: it opens ONE tab, not the locked set ──────────────
  for (const r of [ryan, travis]) {
    if (!r) continue;
    const others = [...SUPER_ADMIN_ONLY_TABS].filter((t) => t !== "vehicles" && reach(r, t));
    ok(`${r.name} gained Vehicles and no other locked tab`, others.length === 0,
       others.length ? `also reaches ${others.join(", ")}` : "");
  }

  // ── The stale grant that must stay inert ───────────────────────────────────
  // Dima's membership carries tabs = ["budget"] from an old grant. It is inert
  // only because a locked tab can never be opened through the `tabs` whitelist.
  const dima = rows.find((r) => r.email === "dima@cufc.co.nz");
  ok("Dima's stale tabs:[\"budget\"] still does NOT open the Budget tab",
     !!dima && !reach(dima, "budget"),
     `tabs=${JSON.stringify(dima?.tabs)}`);

  // ── Nothing else in the club gained a locked tab ───────────────────────────
  const all = await client.query(
    `select count(*)::int n from user_organizations
      where unlocked_tabs is not null and jsonb_array_length(unlocked_tabs) > 0`,
  );
  ok("exactly two locked-tab grants exist anywhere", all.rows[0].n === 2, `${all.rows[0].n} found`);

  // ── An unlocked tab is untouched by any of this ────────────────────────────
  const connor = rows.find((r) => r.email === "support@cufc.co.nz");
  ok("a team_member with tabs:[] still sees nothing they shouldn't",
     !!connor && !reach(connor, "sponsorship") && !reach(connor, "vehicles"));

  await client.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
