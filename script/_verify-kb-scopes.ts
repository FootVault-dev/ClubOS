/**
 * Prove that Rambo cannot become a back door.
 *
 *   npx tsx --env-file=.env script/_verify-kb-scopes.ts
 *
 * Runs the REAL decider (shared/knowledge-base.ts) against REAL user rows from
 * the live database — not fixtures, not a mock. The question this answers is the
 * one Daniel asked: can a member of staff get at the budget by going through
 * Rambo instead of the Budget tab? Every assertion here is written so that the
 * DANGEROUS outcome fails the run.
 */
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { users } from "@shared/schema";
import { storage } from "../server/storage";
import {
  RAMBO_TOOLS,
  ramboToolsFor,
  viewerCanReachTab,
  viewerCanReadArticle,
  type Viewer,
} from "@shared/knowledge-base";

let pass = 0;
let fail = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}${ok ? "" : `  — expected ${expected}, got ${actual}`}`);
}

async function viewerFor(userId: number): Promise<Viewer | null> {
  const user = await storage.getUser(userId);
  if (!user) return null;
  const orgs = await storage.getUserOrganizations(userId);
  return {
    userId,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email!,
    globalRole: user.role ?? null,
    memberships: (orgs as any[]).map((o) => ({
      orgSlug: o.slug,
      orgName: o.name,
      role: o.userRole ?? null,
      tabs: (o.userTabs as string[] | null) ?? null,
    })),
  };
}

async function main() {
  console.log("\n🔒 Rambo scope verification — against live user records\n");

  const all = await db.select({ id: users.id, email: users.email, role: users.role }).from(users);
  console.log(`   ${all.length} user accounts in the database\n`);

  // ── 1. The canary: budget_summary ────────────────────────────────────────
  // "budget" is in SUPER_ADMIN_ONLY_TABS. Nobody but a super admin may ever get
  // this tool — not a workspace admin, not a manager, nobody.
  console.log("── The budget canary — every real account ──────────────────────");
  let superAdmins = 0;
  let nonSuperWithBudget: string[] = [];
  for (const u of all) {
    const v = await viewerFor(u.id);
    if (!v) continue;
    const tools = ramboToolsFor(v);
    const hasBudget = tools.some((t) => t.name === "budget_summary");
    if (v.globalRole === "super_admin") {
      superAdmins++;
      if (!hasBudget) {
        console.log(`   ❌ super admin ${u.email} CANNOT see budget — the gate is too tight`);
        fail++;
      }
    } else if (hasBudget) {
      nonSuperWithBudget.push(u.email!);
    }
  }
  check(
    `no non-super-admin account can reach budget_summary (${all.length - superAdmins} accounts checked)`,
    nonSuperWithBudget.length === 0,
    true,
  );
  if (nonSuperWithBudget.length) console.log(`      LEAKED TO: ${nonSuperWithBudget.join(", ")}`);
  check(`super admins do get it (${superAdmins} found)`, superAdmins > 0, true);

  // ── 2. Dima — the admin who must NOT reach budget ────────────────────────
  // This is the case the tab-existence check exists for: canAccessTab() returns
  // true for ANY slug when the membership role is admin, so without proving the
  // tab lives in that workspace, an admin of United Prints "reaches" the Budget
  // tab that only exists in USG.
  console.log("\n── Dima (admin of United Prints) ──────────────────────────────");
  const dima = await viewerFor(7);
  if (!dima) {
    console.log("   ⚠️  user 7 not found — skipping");
  } else {
    console.log(`   ${dima.name}: global role "${dima.globalRole}", ${dima.memberships.length} workspaces`);
    for (const m of dima.memberships) {
      console.log(`      · ${m.orgName} — role ${m.role}, tabs ${m.tabs ? JSON.stringify(m.tabs) : "ALL"}`);
    }
    check("can reach the Materials tab (his own)", viewerCanReachTab(dima, "materials").allowed, true);
    check("can reach the print Jobs tab", viewerCanReachTab(dima, "jobs").allowed, true);
    check("CANNOT reach Budget", viewerCanReachTab(dima, "budget").allowed, false);
    check("CANNOT reach Cashflow", viewerCanReachTab(dima, "cashflow").allowed, false);
    check("CANNOT reach Housing (tenant data)", viewerCanReachTab(dima, "housing").allowed, false);
    check("CANNOT reach Vehicles", viewerCanReachTab(dima, "vehicles").allowed, false);
    const t = ramboToolsFor(dima).map((x) => x.name);
    console.log(`      Rambo tools: ${t.join(", ")}`);
    check("Rambo does not offer him budget_summary", t.includes("budget_summary"), false);
    check("Rambo does offer him print_materials", t.includes("print_materials"), true);
  }

  // ── 3. Everyone gets the knowledge base itself ───────────────────────────
  console.log("\n── The knowledge base is open to all staff ────────────────────");
  let missingKb = 0;
  for (const u of all) {
    const v = await viewerFor(u.id);
    if (!v) continue;
    if (!ramboToolsFor(v).some((t) => t.name === "search_knowledge_base")) missingKb++;
  }
  check(`every account can search the knowledge base (${all.length} checked)`, missingKb === 0, true);

  // ── 4. A person with no workspaces at all ────────────────────────────────
  console.log("\n── A brand-new account with no workspace membership ───────────");
  const nobody: Viewer = { userId: -1, name: "Nobody", globalRole: "coach", memberships: [] };
  const nobodyTools = ramboToolsFor(nobody).map((t) => t.name);
  console.log(`      Rambo tools: ${nobodyTools.join(", ") || "(none)"}`);
  check("gets the knowledge base", nobodyTools.includes("search_knowledge_base"), true);
  check("gets nothing else", nobodyTools.length === 1, true);

  // ── 5. The fabricated-membership attack ──────────────────────────────────
  // Someone who is an ADMIN of a workspace that does not contain the tab must
  // not inherit it. This is the exact hole the tab-existence check closes; if
  // the check is ever removed, this assertion fails.
  console.log("\n── Fabricated: admin of a workspace that lacks the tab ────────");
  const printsAdmin: Viewer = {
    userId: -2,
    name: "Prints admin",
    globalRole: "admin",
    memberships: [{ orgSlug: "united-prints", orgName: "United Prints", role: "admin", tabs: null }],
  };
  check("admin of United Prints CANNOT reach Budget", viewerCanReachTab(printsAdmin, "budget").allowed, false);
  check(
    "admin of United Prints CANNOT reach Sponsorship (a USG tab)",
    viewerCanReachTab(printsAdmin, "sponsorship").allowed,
    false,
  );
  check("admin of United Prints CAN reach Materials (its own tab)", viewerCanReachTab(printsAdmin, "materials").allowed, true);

  const usgManager: Viewer = {
    userId: -3,
    name: "USG manager",
    globalRole: "manager",
    memberships: [{ orgSlug: "united-sports-group", orgName: "USG", role: "manager", tabs: null }],
  };
  check("manager of USG CAN reach Sponsorship", viewerCanReachTab(usgManager, "sponsorship").allowed, true);
  check("manager of USG still CANNOT reach Budget (super-admin-only)", viewerCanReachTab(usgManager, "budget").allowed, false);

  // ── 6. Article gating uses the same rule ─────────────────────────────────
  console.log("\n── Article-level gating ───────────────────────────────────────");
  const openArticle = { requiredTab: null, requiredWorkspace: null };
  const budgetArticle = { requiredTab: "budget", requiredWorkspace: "united-sports-group" };
  check("everyone reads an ungated article", viewerCanReadArticle(nobody, openArticle), true);
  check("a coach cannot read a budget-gated article", viewerCanReadArticle(nobody, budgetArticle), false);
  check("a prints admin cannot read a budget-gated article", viewerCanReadArticle(printsAdmin, budgetArticle), false);
  if (dima) check("Dima cannot read a budget-gated article", viewerCanReadArticle(dima, budgetArticle), false);

  // ── 7. Every tool declares a gate we can reason about ────────────────────
  console.log("\n── Tool catalogue sanity ──────────────────────────────────────");
  const ungated = RAMBO_TOOLS.filter((t) => !t.requiredTab);
  console.log(`      ${RAMBO_TOOLS.length} tools, ${ungated.length} open to all staff: ${ungated.map((t) => t.name).join(", ")}`);
  check("only the knowledge base itself is ungated", ungated.length === 1 && ungated[0].name === "search_knowledge_base", true);

  console.log(`\n   ${pass} passed · ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
