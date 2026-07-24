// One-off: back up + (with --apply) repoint org-4 facility image_urls to
// app-served /facility-photos/ static paths (Supabase egress-restricted).
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

const NEW_URLS: Record<number, string[]> = {
  1: ["/facility-photos/s1-turf-1.webp", "/facility-photos/turf-aerial.webp"],
  2: ["/facility-photos/turf-aerial.webp", "/facility-photos/s1-turf-1.webp"],
  3: ["/facility-photos/mini-pitch-cage.webp", "/facility-photos/mini-pitches-overhead.webp"],
  4: ["/facility-photos/mini-pitches-overhead.webp", "/facility-photos/mini-pitch-cage.webp"],
  6: ["/facility-photos/s3-grass-1.webp", "/facility-photos/grass-overhead.webp", "/facility-photos/grass-goal.webp"],
  8: ["/facility-photos/grass-wide.webp", "/facility-photos/grass-goal.webp", "/facility-photos/grass-overhead.webp"],
};

async function main() {
  const before = await db.execute(sql`SELECT id, name, image_url, image_urls FROM facilities WHERE organization_id = 4 ORDER BY id`);
  console.log("BEFORE:");
  console.log(JSON.stringify(before.rows, null, 2));

  if (!APPLY) {
    console.log("\n(dry run — pass --apply to write)");
    process.exit(0);
  }

  for (const [idStr, urls] of Object.entries(NEW_URLS)) {
    const id = parseInt(idStr);
    const arr = `{${urls.map(u => `"${u}"`).join(",")}}`;
    await db.execute(sql`UPDATE facilities SET image_urls = ${arr}::text[] WHERE id = ${id} AND organization_id = 4`);
    console.log(`updated facility ${id}`);
  }

  const after = await db.execute(sql`SELECT id, name, image_urls FROM facilities WHERE organization_id = 4 ORDER BY id`);
  console.log("AFTER:");
  console.log(JSON.stringify(after.rows, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
