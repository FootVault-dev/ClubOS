import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

// Raw node-postgres pool — needed by callers that execute pre-built
// `{ text, params }` queries (standard $1,$2,... positional placeholders)
// rather than drizzle's query builder. drizzle-orm 0.39's `sql.raw()` takes
// no params argument, so a parameterised raw query has to go through the
// pool directly. See shared/behavior-rollups.ts / server/behavior-rollup-cron.ts.
export { pool };
