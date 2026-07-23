import "dotenv/config";
// READ-ONLY: reuse an existing live session id to drive the LOCAL dev server,
// so the Players tab can be screenshotted without creating any new state.
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import crypto from "crypto";

const rows = await db.execute(sql`
  SELECT sid, sess, expire FROM session
  WHERE expire > now() AND (sess->>'userId') IS NOT NULL
  ORDER BY expire DESC LIMIT 5`);

const secret = process.env.SESSION_SECRET || "cufc-dev-secret";
for (const r of rows.rows as any[]) {
  const mac = crypto.createHmac("sha256", secret).update(r.sid).digest("base64").replace(/=+$/, "");
  console.log(JSON.stringify({ userId: (r.sess as any).userId, cookie: `connect.sid=s%3A${r.sid}.${encodeURIComponent(mac)}` }));
}
process.exit(0);
