// Sporty auto-sync — OFF unless BOTH are true: SPORTY_AUTOSYNC=1 and API
// credentials installed. Mirrors the XERO_AUTOPOST doctrine: outbound writes
// to an external system of record never run just because the code deployed.
// When enabled: hourly, push CUFC players whose data is new or has changed
// since the last successful push (the engine skips unchanged payloads and
// anything with preflight blockers).

import { eq } from "drizzle-orm";
import { db } from "./db";
import { organizations } from "@shared/schema";
import { buildCandidates, pushCandidates } from "./sporty-engine";
import { readSportyConfig } from "./sporty-client";

const CLUB_ORG_SLUG = "christchurch-united";
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000;

async function sweep(): Promise<void> {
  try {
    if (process.env.SPORTY_AUTOSYNC !== "1" || !readSportyConfig()) return;
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, CLUB_ORG_SLUG));
    if (!org) return;

    const built = await buildCandidates(org.id, { scope: "academy" });
    const due = built
      .filter((b) => b.displayStatus === "ready" || b.displayStatus === "changed")
      .map((b) => b.candidate.contactId);
    if (!due.length) return;

    const run = await pushCandidates(org.id, due, { scope: "academy" });
    const tally = run.results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[sporty] auto-sync: ${run.results.length} attempted — ${Object.entries(tally)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")}${run.aborted ? ` (aborted: ${run.aborted})` : ""}`,
    );
  } catch (e: any) {
    console.error("[sporty] auto-sync sweep failed:", e?.message || e);
  }
}

export function startSportySyncCron(): void {
  if (process.env.SPORTY_AUTOSYNC !== "1") {
    console.log("[sporty] auto-sync disabled (SPORTY_AUTOSYNC != 1) — pushes are manual from the Sporty tab");
    return;
  }
  setInterval(sweep, SWEEP_INTERVAL_MS);
  setTimeout(sweep, BOOT_DELAY_MS);
  console.log("[sporty] auto-sync enabled — hourly sweep armed");
}
