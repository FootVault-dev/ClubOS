import "dotenv/config";
// READ-ONLY verification of getProgramPlayers across both registration shapes.
import { storage } from "../server/storage";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const progs = await db.execute(sql`
  SELECT id, name, slug, type FROM programs
  WHERE slug IN ('u4-u8','pre-academy-u9-u12','academy-u13-u17')
     OR type = 'holiday_camp'
  ORDER BY type, id LIMIT 8`);

for (const p of progs.rows as any[]) {
  const players = await storage.getProgramPlayers(p.id);
  const stats = await storage.getCampRegistrationStats(p.id);
  const byStatus = players.reduce((a: any, x) => { a[x.status] = (a[x.status] ?? 0) + 1; return a; }, {});
  console.log(`\n=== ${p.name} (id ${p.id}, /${p.slug}, ${p.type}) ===`);
  console.log(`  registrations=${stats.totalRegistrations} confirmed=${stats.confirmedRegistrations}`);
  console.log(`  players=${players.length}`, byStatus,
              `| noDob=${players.filter(x => !x.dateOfBirth).length}`,
              `noParent=${players.filter(x => !x.parent).length}`,
              `multiReg=${players.filter(x => x.registrationIds.length > 1).length}`);
  console.log("  sample:", players.slice(0, 3).map(x => ({
    name: `${x.firstName} ${x.lastName}`, dob: x.dateOfBirth, status: x.status,
    sess: x.sessionsBooked, paid: x.paidCents, regs: x.registrationIds.length,
    parent: x.parent ? `${x.parent.firstName} ${x.parent.lastName}` : null,
    email: x.parent?.email, path: x.profilePath,
  })));
}
process.exit(0);
