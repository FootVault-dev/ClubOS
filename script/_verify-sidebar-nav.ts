/**
 * Prove that nesting a sidebar row changed the LAYOUT and nothing else.
 *
 *   npx tsx script/_verify-sidebar-nav.ts
 *
 * Squads moved under Academy on 2026-09-02. The risk in that move is not
 * cosmetic: if a child is hidden whenever its parent is, a person holding
 * `squads` but not `academy` loses the only link to a page they are entitled
 * to — and a missing sidebar link is indistinguishable from a feature that was
 * never built, which is exactly how three features have been silently lost here.
 *
 * So the test is a comparison, not an assertion about pixels: the set of
 * destinations a given person can reach must be IDENTICAL before and after.
 */
import { buildNav, reachable, type NavItem } from "../client/src/lib/nav-tree";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

const FLAT: NavItem[] = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: null },
  { tab: "academy", title: "Academy", url: "/admin/academy", icon: null },
  { tab: "squads", title: "Squads", url: "/admin/squads", icon: null },
  { tab: "contacts", title: "Contacts", url: "/admin/contacts", icon: null },
];
const NESTED: NavItem[] = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: null },
  {
    tab: "academy", title: "Academy", url: "/admin/academy", icon: null,
    children: [{ tab: "squads", title: "Squads", url: "/admin/squads", icon: null }],
  },
  { tab: "contacts", title: "Contacts", url: "/admin/contacts", icon: null },
];

const only = (...tabs: string[]) => (i: NavItem) => tabs.includes(i.tab);

console.log("\n── the same person reaches the same pages, nested or not ──");
for (const [who, can] of [
  ["sees everything",              only("dashboard", "academy", "squads", "contacts")],
  ["squads but NOT academy",       only("dashboard", "squads")],
  ["academy but NOT squads",       only("dashboard", "academy")],
  ["neither",                      only("dashboard")],
  ["squads only",                  only("squads")],
] as [string, (i: NavItem) => boolean][]) {
  const before = reachable(buildNav(FLAT, can));
  const after = reachable(buildNav(NESTED, can));
  check(`${who}: ${JSON.stringify(after)}`,
    JSON.stringify(before) === JSON.stringify(after),
    `was ${JSON.stringify(before)}`);
}

console.log("\n── the shape it produces ──");
const all = buildNav(NESTED, () => true);
check("Squads is nested under Academy, not top level",
  all.find((i) => i.tab === "academy")?.children?.[0]?.tab === "squads"
  && !all.some((i) => i.tab === "squads"));

// 🔴 The case the file exists for.
const promoted = buildNav(NESTED, only("squads"));
check("a hidden parent PROMOTES its child rather than hiding it",
  promoted.length === 1 && promoted[0].tab === "squads" && promoted[0].url === "/admin/squads");

const noKids = buildNav(NESTED, only("academy"));
check("a parent whose children are all hidden is a plain row",
  noKids.length === 1 && (noKids[0].children ?? []).length === 0);

check("a promoted child carries no stale children",
  (promoted[0].children ?? []).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
