/**
 * Seed the Staff Chat v1 channel structure (Daniel's directive, 2026-07-24).
 *
 * The structure is the "USG Blueprint" from the channel-structure deep-research
 * run: outputs/deep-research/2026-07-24-staff-chat-channel-structure/synthesis.md
 * (4 topic agents + critic + synthesis). Doctrine it encodes:
 *   - Brand-first prefixes (cufc-/siu-/mfl-/cic-/gym-/print-/usc-/academy-)
 *     because the channel list is a flat alphabetical list — the prefix is the
 *     only grouping mechanism. Function-first names only for cross-brand rooms.
 *   - Public by default. Exactly four private channels (leadership, finance,
 *     people-hr, safeguarding) — a named list, not a ban.
 *   - Default/auto-join stays at the existing two (#announcements, #general).
 *   - A channel splits only for a distinct AUDIENCE, never a distinct topic
 *     (the no-threads granularity-stop rule). Age-band academy splits, proj-*
 *     and social-* channels are deliberately NOT seeded — triggers documented
 *     in the synthesis §4.
 *   - safeguarding is staff escalation ONLY (never parent/child comms), owner
 *     to be transferred to the named safeguarding officer once appointed.
 *
 * No migration, no deploy: staff_chat tables + routes are live on prod.
 * Channel creation mirrors the API route exactly: channel row + owner
 * membership (+ suggested members so the room is in people's sidebars from
 * day one — membership is otherwise manual, there are no auto-join bundles).
 *
 * Idempotent: a live channel with the same lower(name) is skipped entirely.
 * Dry-run by default:
 *   npx tsx --env-file=.env script/seed-staff-chat-channels.ts          # preview
 *   npx tsx --env-file=.env script/seed-staff-chat-channels.ts --apply  # write
 */
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");

// Staff user ids verified against prod users/user_organizations 2026-07-24.
const U = {
  daniel: 1, // BDM, super admin
  zach: 2, // grassroots U4–U8
  liam: 3, // marketing
  paul: 4, // Academy Director U9–U20
  avi: 5, // office / info
  ryan: 6, // GM
  dima: 7, // United Print
  natalia: 8, // United Gymnastics
  jessie: 11, // USC support
  max: 12, // socials / media
  riley: 14, // USC grounds
  isaac: 15, // MFL + CIC
  travis: 44, // club ops CUFC/SIU/USC/CIC
  olga: 45, // CUFC + gymnastics
} as const;

type ChannelSeed = {
  name: string;
  topic: string;
  isPrivate: boolean;
  postPolicy: "anyone" | "leadership";
  owner: number;
  members: number[]; // excluding owner
};

const CHANNELS: ChannelSeed[] = [
  // ── Brand channels (public) ────────────────────────────────────────────────
  {
    name: "cufc-club",
    topic: "Christchurch United FC — first team + senior club ops",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.travis,
    members: [U.ryan, U.daniel, U.olga],
  },
  {
    name: "siu-club",
    topic: "South Island United — club + season ops",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.travis,
    members: [U.ryan, U.daniel],
  },
  {
    name: "mfl-league",
    topic: "Mini Football Leagues — league nights, teams, refs",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.isaac,
    members: [U.ryan, U.daniel],
  },
  {
    name: "cic-tournament",
    topic: "Christchurch International Cup — planning + tournament ops",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.isaac,
    members: [U.travis, U.ryan, U.daniel],
  },
  {
    name: "gym-club",
    topic: "United Gymnastics — club ops",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.natalia,
    members: [U.olga, U.ryan],
  },
  {
    name: "print-shop",
    topic: "United Print — jobs, production, deliveries",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.dima,
    members: [U.daniel, U.ryan],
  },
  {
    name: "usc-facility",
    topic: "United Sports Centre — grounds, maintenance, bookings, housing",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.riley,
    members: [U.jessie, U.travis, U.ryan],
  },
  // ── Academy frontline (public; coaches added at onboarding) ────────────────
  {
    name: "academy-coaches",
    topic: "All academy coaches — sessions, cover, key instructions. Voice notes welcome, RU/EN",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.paul,
    members: [U.zach, U.ryan, U.daniel],
  },
  // ── Cross-brand function channels (public) ─────────────────────────────────
  {
    name: "media-content",
    topic: "Content, photography + socials across all brands",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.max,
    members: [U.liam, U.daniel],
  },
  {
    name: "commercial-sponsorship",
    topic: "Sponsorship, sales + partnership activation",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.daniel,
    members: [U.ryan, U.liam],
  },
  {
    name: "ops-matchday",
    topic: "Weekend fixtures — refs, cover, wet weather, matchday logistics",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.travis,
    members: [U.zach, U.paul, U.isaac, U.riley, U.ryan, U.daniel],
  },
  {
    name: "help-it-admin",
    topic: "Ask anything — office, IT, admin, how-do-I questions",
    isPrivate: false,
    postPolicy: "anyone",
    owner: U.avi,
    members: [U.daniel],
  },
  // ── Private (the ONLY four; a named list, not a ban) ───────────────────────
  {
    name: "leadership",
    topic: "Exec room — strategy + sensitive decisions",
    isPrivate: true,
    postPolicy: "anyone",
    owner: U.ryan,
    members: [U.daniel],
  },
  {
    name: "finance",
    topic: "Budgets, Xero, pay + sensitive money",
    isPrivate: true,
    postPolicy: "anyone",
    owner: U.ryan,
    members: [U.daniel, U.travis],
  },
  {
    name: "people-hr",
    topic: "Hiring, personnel + disciplinary",
    isPrivate: true,
    postPolicy: "anyone",
    owner: U.ryan,
    members: [U.daniel],
  },
  {
    name: "safeguarding",
    topic: "Child-protection escalation — staff concerns only. Owner passes to the safeguarding officer",
    isPrivate: true,
    postPolicy: "anyone",
    owner: U.ryan,
    members: [U.daniel],
  },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      `SELECT lower(name) AS name FROM staff_channels
       WHERE kind = 'channel' AND archived_at IS NULL AND name IS NOT NULL`,
    );
    const live = new Set(existing.map((r) => r.name));

    let created = 0;
    for (const ch of CHANNELS) {
      if (live.has(ch.name.toLowerCase())) {
        console.log(`  skip   #${ch.name} (already live)`);
        continue;
      }
      const vis = ch.isPrivate ? "private" : "public";
      console.log(
        `  create #${ch.name} [${vis}] owner=${ch.owner} members=[${ch.members.join(",")}]`,
      );
      created++;
      if (!APPLY) continue;

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO staff_channels (kind, name, topic, is_private, is_default, post_policy, created_by)
         VALUES ('channel', $1, $2, $3, false, $4, $5) RETURNING id`,
        [ch.name, ch.topic, ch.isPrivate, ch.postPolicy, U.daniel],
      );
      await client.query(
        `INSERT INTO staff_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'owner') ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [row.id, ch.owner],
      );
      for (const uid of ch.members) {
        if (uid === ch.owner) continue;
        await client.query(
          `INSERT INTO staff_channel_members (channel_id, user_id, role)
           VALUES ($1, $2, 'member') ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [row.id, uid],
        );
      }
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\nAPPLIED: ${created} channels created.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\nDRY RUN: ${created} channels would be created. Re-run with --apply.`);
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
