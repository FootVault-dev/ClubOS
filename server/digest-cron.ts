// ─────────────────────────────────────────────────────────────────────────────
// Daily / weekly digests — the opt-in "here's what you missed" email.
//
// Runs on the house `setInterval` cron pattern (print-cron, sporty-cron,
// league-balance-cron…), deliberately NOT on graphile-worker: that runner only
// exists on the undeployed marketing-suite branch, so a digest built on it
// would silently never run in production.
//
// 🔴 THE SWEEP IS IDEMPOTENT AND THAT IS THE WHOLE DESIGN. It ticks every 15
// minutes but each person's digest goes once. "Already sent" is decided by
// comparing the last-sent stamp on the NZ CALENDAR DAY, never by elapsed-hours
// arithmetic — so two ticks in the same hour cannot double-send, and a tick
// that is LATE (deploy, restart, slow queue) still sends rather than skipping
// the day entirely. An hourly-modulo check would do the opposite of both.
//
// A digest is a summary of things the person already had the right to see. It
// contains no data they could not open in the app themselves.
// ─────────────────────────────────────────────────────────────────────────────
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import {
  notificationPreferences,
  staffChannels,
  staffChannelMembers,
  ttTasks,
  ttTaskStatuses,
  users as usersTable,
} from "@shared/schema";
import {
  dailyDigestDue,
  weeklyDigestDue,
  nzDateKey,
  type NotificationPreferences,
} from "@shared/notifications";
import { getPreferencesBulk } from "./notifications";
import { sendDigestEmail } from "./email";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface DigestChannelLine {
  name: string;
  unread: number;
  mentions: number;
}

export interface DigestTaskLine {
  title: string;
  dueDate: string | null;
  overdue: boolean;
  project: string | null;
}

export interface DigestContent {
  channels: DigestChannelLine[];
  totalUnread: number;
  totalMentions: number;
  overdueTasks: DigestTaskLine[];
  dueSoonTasks: DigestTaskLine[];
  /** True when there is genuinely nothing to report. */
  empty: boolean;
}

/**
 * What one person missed.
 *
 * `since` bounds the chat half: for a daily digest, unread since their pointer;
 * the pointer is already the right notion of "not seen", so no separate window
 * is needed — a message read three days ago must not reappear in today's email.
 */
async function buildDigest(userId: number, todayNz: string): Promise<DigestContent> {
  // ── Chat: unread + mentions per channel, using the same pointer the badges
  // use, so the digest can never disagree with the app.
  const chatRows = await db.execute(sql`
    WITH mem AS (
      SELECT cm.channel_id, c.kind, c.name,
             COALESCE(cm.last_read_at, cm.joined_at) AS since
        FROM staff_channel_members cm
        JOIN staff_channels c ON c.id = cm.channel_id
       WHERE cm.user_id = ${userId}
         AND cm.left_at IS NULL
         AND c.archived_at IS NULL
         AND cm.notify_level <> 'muted'
    )
    SELECT m.channel_id, m.kind, m.name,
           (SELECT count(*)::int FROM staff_messages msg
             WHERE msg.channel_id = m.channel_id
               AND msg.created_at > m.since
               AND msg.author_id <> ${userId}
               AND msg.deleted_at IS NULL) AS unread,
           (SELECT count(*)::int FROM staff_message_mentions mn
             WHERE mn.channel_id = m.channel_id
               AND mn.user_id = ${userId}
               AND mn.created_at > m.since) AS mentions
      FROM mem m
  `);

  const channels: DigestChannelLine[] = [];
  let totalUnread = 0;
  let totalMentions = 0;
  for (const r of (chatRows as any).rows ?? []) {
    const unread = Number(r.unread) || 0;
    const mentions = Number(r.mentions) || 0;
    if (unread === 0 && mentions === 0) continue;
    channels.push({
      name: r.kind === "dm" ? "Direct messages" : `#${r.name ?? "channel"}`,
      unread,
      mentions,
    });
    totalUnread += unread;
    totalMentions += mentions;
  }
  // Busiest first, but anything that mentioned them outranks raw volume.
  channels.sort((a, b) => b.mentions - a.mentions || b.unread - a.unread);

  // ── Tasks they own that are not done.
  // Overdue is DERIVED (due_date < today-in-NZ AND kind <> 'done') — the Task
  // Tracker's rule, restated here rather than stored, and compared as bare
  // YYYY-MM-DD strings so nothing round-trips through a JS Date.
  const taskRows = await db.execute(sql`
    SELECT t.title, t.due_date::text AS due_date, s.kind, p.name AS project
      FROM tt_tasks t
      JOIN tt_task_statuses s ON s.id = t.status_id
      LEFT JOIN tt_projects p ON p.id = t.project_id
     WHERE t.owner_id = ${userId}
       AND t.archived = false
       AND s.kind <> 'done'
       AND t.due_date IS NOT NULL
       AND t.due_date <= (${todayNz}::date + INTERVAL '7 days')
     ORDER BY t.due_date ASC
     LIMIT 25
  `);

  const overdueTasks: DigestTaskLine[] = [];
  const dueSoonTasks: DigestTaskLine[] = [];
  for (const r of (taskRows as any).rows ?? []) {
    const due = r.due_date ? String(r.due_date) : null;
    const line: DigestTaskLine = {
      title: String(r.title),
      dueDate: due,
      overdue: !!due && due < todayNz,
      project: r.project ? String(r.project) : null,
    };
    (line.overdue ? overdueTasks : dueSoonTasks).push(line);
  }

  return {
    channels,
    totalUnread,
    totalMentions,
    overdueTasks,
    dueSoonTasks,
    empty: channels.length === 0 && overdueTasks.length === 0 && dueSoonTasks.length === 0,
  };
}

/**
 * One sweep.
 *
 * Exported so it can be run by hand against production for verification without
 * waiting fifteen minutes, and so a test can drive it with a fixed `now`.
 * `dryRun` builds and reports everything but sends nothing.
 */
export async function runDigestSweep(
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<{ daily: number; weekly: number; skippedEmpty: number }> {
  const todayNz = nzDateKey(now);
  let daily = 0;
  let weekly = 0;
  let skippedEmpty = 0;

  // Only people who actually opted in — the table holds a row for anyone who
  // has opened settings at all, most of whom will have digests off.
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      lastDaily: notificationPreferences.lastDailyDigestAt,
      lastWeekly: notificationPreferences.lastWeeklyDigestAt,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      active: usersTable.active,
    })
    .from(notificationPreferences)
    .innerJoin(usersTable, eq(usersTable.id, notificationPreferences.userId))
    .where(
      or(
        eq(notificationPreferences.dailyDigest, true),
        eq(notificationPreferences.weeklyDigest, true),
      ),
    );

  if (!rows.length) return { daily, weekly, skippedEmpty };

  const prefs = await getPreferencesBulk(rows.map((r) => r.userId));

  for (const row of rows) {
    if (!row.active || !row.email) continue;
    const p = prefs.get(row.userId);
    if (!p) continue;

    // The master email switch governs digests too — someone who turned email
    // off has said something unambiguous, and a recurring summary is exactly
    // the kind of mail they meant.
    if (!p.emailEnabled) continue;

    const wantDaily = dailyDigestDue(p, row.lastDaily, now);
    const wantWeekly = weeklyDigestDue(p, row.lastWeekly, now);
    if (!wantDaily && !wantWeekly) continue;

    // Weekly wins when both fall on the same tick — two emails in one minute
    // saying nearly the same thing is how people learn to filter us.
    const kind: "daily" | "weekly" = wantWeekly ? "weekly" : "daily";

    try {
      const content = await buildDigest(row.userId, todayNz);

      if (content.empty) {
        // 🔴 Nothing to say → say nothing, but STILL stamp the clock. An empty
        // digest that doesn't stamp would retry every fifteen minutes all day;
        // one that sends would train people that our mail is worthless.
        skippedEmpty++;
      } else {
        if (!opts.dryRun) {
          await sendDigestEmail({
            to: row.email,
            recipientName: row.firstName || "there",
            kind,
            content,
            appUrl: (process.env.APP_URL || "https://app.usg.co.nz").replace(/\/+$/, ""),
          });
        }
        if (kind === "daily") daily++;
        else weekly++;
      }

      if (!opts.dryRun) {
        await db
          .update(notificationPreferences)
          .set(
            kind === "daily"
              ? { lastDailyDigestAt: now, updatedAt: now }
              : { lastWeeklyDigestAt: now, updatedAt: now },
          )
          .where(eq(notificationPreferences.userId, row.userId));
      }
    } catch (e) {
      // One person's digest failing must never stop the sweep for everybody
      // else. No stamp on failure, so the next tick retries them.
      console.error(`[digest] failed for user ${row.userId}:`, e);
    }
  }

  return { daily, weekly, skippedEmpty };
}

let started = false;

/**
 * Start the sweep. Self-guarding like every other cron here: a misconfigured
 * job must never crash server startup, and calling twice must not double-tick.
 */
export function startDigestCron(): void {
  if (started) return;
  started = true;

  const tick = () => {
    void runDigestSweep()
      .then((r) => {
        if (r.daily || r.weekly) {
          console.log(`[digest] sent daily=${r.daily} weekly=${r.weekly} skippedEmpty=${r.skippedEmpty}`);
        }
      })
      .catch((e) => console.error("[digest] sweep failed:", e));
  };

  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  (timer as any).unref?.();
  // Deliberately NOT running a tick at boot: Fly restarts and deploys would
  // each fire one, and on a busy deploy day that is several sweeps in an hour
  // competing to stamp the same rows.
  console.log("[digest] cron started (15 min sweep)");
}
