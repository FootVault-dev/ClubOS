// Read-only proof of the mailer send-history search + detail against real data.
// Run: npx tsx script/_test-mailer-history.ts
import "dotenv/config";
import { storage } from "../server/storage";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

async function main() {
  // 1. Unfiltered page
  const page1 = await storage.searchEmailCampaigns({ limit: 5 });
  ok("unfiltered returns rows", page1.rows.length > 0, `${page1.rows.length} of ${page1.total} total`);
  ok("list carries no body", !("body" in (page1.rows[0] as any)));
  ok("newest first", page1.rows.every((r, i) => i === 0 || new Date(page1.rows[i - 1].createdAt) >= new Date(r.createdAt)));
  console.log("   newest:", JSON.stringify(page1.rows[0]?.subject), "|", page1.rows[0]?.segmentType);

  // 2. Paging does not repeat or skip
  const page2 = await storage.searchEmailCampaigns({ limit: 5, offset: 5 });
  const overlap = page1.rows.filter(r => page2.rows.some(o => o.id === r.id));
  ok("page 2 does not overlap page 1", overlap.length === 0, `${page2.rows.length} rows`);
  ok("total is stable across pages", page1.total === page2.total, `${page1.total} vs ${page2.total}`);

  // 3. Subject search finds a known campaign
  const known = page1.rows[0]?.subject ?? "";
  const word = known.split(/\s+/).filter(w => w.length > 3)[0];
  if (word) {
    const hit = await storage.searchEmailCampaigns({ q: word, limit: 50 });
    ok(`subject search "${word}" finds it`, hit.rows.some(r => r.id === page1.rows[0].id), `${hit.total} matches`);
    ok("search narrows the set", hit.total <= page1.total, `${hit.total} <= ${page1.total}`);
  }

  // 4. Content search — matches a word that is in a body
  const first = await storage.getEmailCampaign(page1.rows[0].id);
  ok("detail returns the body", !!first?.body, `${first?.body?.length ?? 0} chars`);
  const bodyWord = String(first?.body ?? "")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(w => /^[a-zA-Z]{6,}$/.test(w))[0];
  if (bodyWord) {
    const contentHit = await storage.searchEmailCampaigns({ q: bodyWord, limit: 50 });
    ok(`content search "${bodyWord}" finds its campaign`, contentHit.rows.some(r => r.id === first!.id), `${contentHit.total} matches`);
  }

  // 5. Wildcard escaping — a bare "%" must not match everything
  const pct = await storage.searchEmailCampaigns({ q: "%", limit: 5 });
  ok("bare % is escaped, not a wildcard", pct.total < page1.total, `${pct.total} vs ${page1.total} unfiltered`);
  const underscore = await storage.searchEmailCampaigns({ q: "_", limit: 5 });
  ok("bare _ is escaped, not a wildcard", underscore.total < page1.total, `${underscore.total} vs ${page1.total}`);

  // 6. Nonsense search returns nothing, cleanly
  const none = await storage.searchEmailCampaigns({ q: "zzqqxx-no-such-campaign", limit: 5 });
  ok("no match returns empty", none.rows.length === 0 && none.total === 0);

  // 7. Limit clamping
  const clamped = await storage.searchEmailCampaigns({ limit: 9999 });
  ok("limit clamps to 100", clamped.rows.length <= 100, `${clamped.rows.length} rows`);

  // 8. Missing id
  const missing = await storage.getEmailCampaign(2147483600);
  ok("unknown id returns undefined", missing === undefined);

  console.log("\nDone.");
  process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
