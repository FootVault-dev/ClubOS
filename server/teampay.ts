/**
 * Team Pay — the engine.
 *
 * A team manager enters a team, builds a squad, and every player pays their own
 * share. The manager sees who has paid, who has opened their link and who has
 * not touched it, and nudges the stragglers. Short of players, they pull one
 * from the fill-in pool.
 *
 * From Isaac Living's spec, 13 Aug 2026 Tournament Planning Meeting. Piloting on
 * the Christchurch Ethnic Cup; MFL and CIC 7's are a row in teampay_competitions.
 *
 * The rules live in shared/teampay.ts. The invariants live in Postgres. This
 * file is the plumbing between them.
 */
import { randomBytes } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  teampayCompetitions, teampayEntries, teampayPlayers,
  teampayFillins, teampayFillinHolds, teampayEvents,
  type TeampayCompetition, type TeampayEntry, type TeampayPlayer,
} from "@shared/schema";
import {
  shareCents, playerStatus, entryMoney, nudgeGate, isNudgeable,
  countsTowardsSquad, brandFor, withinNudgeHoursNz,
  playerChargeCents, teamChargeCents, isPaymentMode,
  FILLIN_HOLD_HOURS, FILLIN_MAX_CONCURRENT_HOLDS, FILLIN_REASK_COOLDOWN_DAYS,
  RELEASE_CONTACT_ON_REQUEST, MIN_SQUAD_SIZE, MAX_SQUAD_SIZE, TOKEN_BYTES,
  type FillinPublic, type PaymentMode,
} from "@shared/teampay";
import { createCardPaymentIntent, getOrCreateCustomer, retrievePaymentIntent } from "./stripe";
import { sendEmail } from "./email";
import { workspaceDomainByOrgId } from "@shared/org-domains";

const PUBLIC_BASE_URL = process.env.TEAMPAY_PUBLIC_URL || "https://app.usg.co.nz";

function token(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function dashboardUrl(t: string) { return `${PUBLIC_BASE_URL}/team/${t}`; }
export function payUrl(t: string)       { return `${PUBLIC_BASE_URL}/pay/${t}`; }
export function holdUrl(t: string)      { return `${PUBLIC_BASE_URL}/fill-in/reply/${t}`; }
export function enterUrl(slug: string)  { return `${PUBLIC_BASE_URL}/enter/${slug}`; }
export function fillinUrl(slug: string) { return `${PUBLIC_BASE_URL}/fill-in/${slug}`; }

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function logEvent(e: {
  entryId?: number | null; playerId?: number | null; fillinId?: number | null;
  kind: string; actor?: string; detail?: unknown;
}) {
  // Audit must never be the reason a manager's action fails.
  try {
    await db.insert(teampayEvents).values({
      entryId: e.entryId ?? null,
      playerId: e.playerId ?? null,
      fillinId: e.fillinId ?? null,
      kind: e.kind,
      actor: e.actor ?? "system",
      detail: (e.detail ?? null) as any,
    });
  } catch (err) {
    console.error("[teampay] event log failed:", err);
  }
}

// ── email ────────────────────────────────────────────────────────────────────

/**
 * One shell, themed from the competition's own brand row — so an Ethnic Cup
 * email is black and gold and an MFL one is not, without a second template.
 */
function shell(comp: TeampayCompetition, heading: string, bodyHtml: string, cta?: { label: string; href: string }) {
  const b = brandFor(comp.brand);
  return `<!doctype html><html><body style="margin:0;padding:0;background:${b.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.bg};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${b.card};border:1px solid ${b.line};border-radius:14px;">
<tr><td style="padding:28px 28px 8px;">
  <div style="font:600 11px/1.4 ${b.fontBody};letter-spacing:.14em;text-transform:uppercase;color:${b.accent};">${escapeHtml(comp.name)}</div>
  <h1 style="margin:10px 0 0;font:700 24px/1.25 ${b.fontHeading};color:${b.ink};">${escapeHtml(heading)}</h1>
</td></tr>
<tr><td style="padding:12px 28px 4px;font:400 15px/1.65 ${b.fontBody};color:${b.ink};">${bodyHtml}</td></tr>
${cta ? `<tr><td style="padding:20px 28px 28px;">
  <a href="${cta.href}" style="display:inline-block;background:${b.accent};color:${b.onAccent};text-decoration:none;font:700 15px/1 ${b.fontBody};padding:14px 26px;border-radius:999px;">${escapeHtml(cta.label)}</a>
  <div style="margin:14px 0 0;font:400 12px/1.6 ${b.fontBody};color:${b.mute};word-break:break-all;">Or paste this into your browser:<br>${cta.href}</div>
</td></tr>` : `<tr><td style="padding:0 28px 28px;"></td></tr>`}
</table>
</td></tr></table></body></html>`;
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fromFor(orgId: number, comp: TeampayCompetition) {
  const w = workspaceDomainByOrgId(orgId);
  // ⚠️ ethniccup.com is NOT a verified Resend sending domain (its Workspace mail
  // went live 2026-08-27, which is a different thing). Until it is, the Cup
  // sends from its own family's verified domain rather than an unverified one,
  // which would bounce or land in spam under a p=quarantine policy.
  const domain = w?.emailDomain || "cufc.co.nz";
  return `${comp.name} <noreply@${domain}>`;
}

// ── competitions ─────────────────────────────────────────────────────────────

export async function competitionBySlug(slug: string): Promise<TeampayCompetition | undefined> {
  const [c] = await db.select().from(teampayCompetitions).where(eq(teampayCompetitions.slug, slug));
  return c;
}

export async function competitionById(id: number): Promise<TeampayCompetition | undefined> {
  const [c] = await db.select().from(teampayCompetitions).where(eq(teampayCompetitions.id, id));
  return c;
}

/** What the public entry page needs. Never exposes the switches' internals. */
export function competitionPublic(c: TeampayCompetition) {
  return {
    slug: c.slug,
    name: c.name,
    brand: c.brand,
    theme: brandFor(c.brand),
    feeCents: c.feeCents,
    currency: c.currency,
    defaultSquadSize: c.defaultSquadSize,
    entriesOpen: c.entriesOpen,
    paymentsEnabled: c.paymentsEnabled,
    fillinsOpen: c.fillinsOpen,
    blurb: c.blurb,
    payByDate: c.payByDate,
  };
}

// ── entries ──────────────────────────────────────────────────────────────────

export async function createEntry(input: {
  slug: string;
  teamName: string;
  community?: string | null;
  managerName: string;
  managerEmail: string;
  managerPhone?: string | null;
  squadSize?: number | null;
  /** The manager pays a share like everyone else, so they get a roster row. */
  managerPlays?: boolean;
  /** 'split' (default) or 'whole' — see PAYMENT_MODES. */
  paymentMode?: string | null;
}): Promise<{ error?: string; entry?: TeampayEntry; dashboardUrl?: string }> {
  const comp = await competitionBySlug(input.slug);
  if (!comp) return { error: "That competition isn't open for entries." };
  if (!comp.entriesOpen) return { error: "Entries aren't open yet." };

  const teamName = input.teamName.trim();
  const managerName = input.managerName.trim();
  const managerEmail = input.managerEmail.trim().toLowerCase();
  if (!teamName) return { error: "Your team needs a name." };
  if (!managerName) return { error: "We need your name." };
  if (!/.+@.+\..+/.test(managerEmail)) return { error: "That email doesn't look right." };

  const squadSize = Number(input.squadSize ?? comp.defaultSquadSize);
  if (!Number.isInteger(squadSize) || squadSize < MIN_SQUAD_SIZE || squadSize > MAX_SQUAD_SIZE) {
    return { error: `Squad size needs to be between ${MIN_SQUAD_SIZE} and ${MAX_SQUAD_SIZE}.` };
  }

  // 🔴 An unrecognised mode falls back to 'split' rather than being rejected.
  // The alternative is a form that refuses a team over a field the manager
  // cannot see; and 'split' is the safe default because it keeps asking players
  // rather than quietly deciding the fee is somebody else's problem.
  const paymentMode: PaymentMode = isPaymentMode(input.paymentMode) ? input.paymentMode : "split";

  const organiserToken = token();
  const [entry] = await db.insert(teampayEntries).values({
    competitionId: comp.id,
    organizationId: comp.organizationId,
    teamName,
    community: input.community?.trim() || null,
    managerName,
    managerEmail,
    managerPhone: input.managerPhone?.trim() || null,
    // 🔴 Copied from the competition, not read from it later. Changing the Cup's
    // fee next week must not silently re-price a squad that is halfway paid.
    feeCents: comp.feeCents,
    squadSize,
    paymentMode,
    organiserToken,
  }).returning();

  // The manager is a squad member unless they say otherwise — Isaac's spec is
  // explicit that they pay their own share, same as everyone.
  if (input.managerPlays !== false) {
    await db.insert(teampayPlayers).values({
      entryId: entry.id,
      name: managerName,
      email: managerEmail,
      phone: input.managerPhone?.trim() || null,
      inviteToken: token(),
      source: "manager",
      isManager: true,
    });
  }

  await logEvent({ entryId: entry.id, kind: "entry_created", actor: "manager", detail: { teamName, squadSize, paymentMode } });

  const url = dashboardUrl(organiserToken);
  await sendEmail({
    from: fromFor(comp.organizationId, comp),
    to: managerEmail,
    subject: `${teamName} is entered — here's your team page`,
    html: shell(comp, `${teamName} is in`,
      `<p>You've entered <strong>${escapeHtml(teamName)}</strong> in the ${escapeHtml(comp.name)}.</p>
       <p>Your team page is where you add your squad, send each player their own payment link, and see at a glance who has paid and who hasn't. Bookmark it — anyone with this link can manage your team.</p>
       <p>The team fee is <strong>${money(comp.feeCents)}</strong>, split ${squadSize} ways: <strong>${money(shareCents(comp.feeCents, squadSize))} each</strong>.</p>
       ${comp.paymentsEnabled ? "" : `<p style="color:#C9A43E;">Payment isn't switched on yet — you can build your squad now and everyone pays once the venue is confirmed.</p>`}`,
      { label: "Open your team page", href: url }),
  }).catch((e) => console.error("[teampay] entry email failed:", e));

  return { entry, dashboardUrl: url };
}

export async function entryByToken(organiserToken: string): Promise<TeampayEntry | undefined> {
  const [e] = await db.select().from(teampayEntries)
    .where(eq(teampayEntries.organiserToken, organiserToken));
  return e;
}

async function playersOf(entryId: number): Promise<TeampayPlayer[]> {
  return db.select().from(teampayPlayers)
    .where(eq(teampayPlayers.entryId, entryId))
    .orderBy(teampayPlayers.id);
}

/**
 * The manager's dashboard.
 *
 * 🔴 Every player carries their NAME. Isaac's spec calls out an earlier internal
 * build that showed the manager status counts only and was useless — the manager
 * needs to know WHO, not how many.
 */
export async function dashboardView(organiserToken: string) {
  const entry = await entryByToken(organiserToken);
  if (!entry) return null;
  const comp = await competitionById(entry.competitionId);
  if (!comp) return null;

  const players = await playersOf(entry.id);
  const now = new Date();
  const share = shareCents(entry.feeCents, entry.squadSize);
  const teamMoney = entryMoney(entry, players);

  const holds = await db.select({
    id: teampayFillinHolds.id,
    state: teampayFillinHolds.state,
    expiresAt: teampayFillinHolds.expiresAt,
    fillinId: teampayFillinHolds.fillinId,
    firstName: teampayFillins.firstName,
    position: teampayFillins.position,
  })
    .from(teampayFillinHolds)
    .innerJoin(teampayFillins, eq(teampayFillins.id, teampayFillinHolds.fillinId))
    .where(eq(teampayFillinHolds.entryId, entry.id))
    .orderBy(desc(teampayFillinHolds.requestedAt));

  return {
    competition: competitionPublic(comp),
    entry: {
      id: entry.id,
      teamName: entry.teamName,
      community: entry.community,
      managerName: entry.managerName,
      managerEmail: entry.managerEmail,
      squadSize: entry.squadSize,
      feeCents: entry.feeCents,
      status: entry.status,
      paidUpAt: entry.paidUpAt,
      createdAt: entry.createdAt,
      paymentMode: (entry.paymentMode === "whole" ? "whole" : "split") as PaymentMode,
      teamPaidCents: entry.teamPaidCents,
      teamPaidAt: entry.teamPaidAt,
    },
    shareCents: share,
    money: teamMoney,
    /**
     * What the manager's own "pay the team fee" button would charge right now.
     * Recomputed on every read, so two players paying while the page is open
     * changes the button rather than the manager over-paying.
     */
    teamChargeCents: teamChargeCents(teamMoney),
    /**
     * 🔴 Squad size is frozen by a database trigger once ANY money has landed —
     * a player's share or the manager's team payment. The button has to agree
     * with the trigger or the manager gets a 500 instead of a disabled control.
     */
    canResize: players.every((p) => !p.paidAt) && !entry.teamPaidAt,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      isManager: p.isManager,
      source: p.source,
      status: playerStatus(p),
      firstOpenedAt: p.firstOpenedAt,
      lastOpenedAt: p.lastOpenedAt,
      openCount: p.openCount,
      nudgeCount: p.nudgeCount,
      lastNudgedAt: p.lastNudgedAt,
      paidAt: p.paidAt,
      paidCents: p.paidCents,
      refundedAt: p.refundedAt,
      payUrl: payUrl(p.inviteToken),
      nudge: nudgeGate(p, now),
      counts: countsTowardsSquad(p),
    })),
    holds: holds.map((h) => ({
      id: h.id,
      state: h.state,
      expiresAt: h.expiresAt,
      firstName: h.firstName,
      position: h.position,
      // Live/expired is DERIVED — a hold whose clock ran out is expired whether
      // or not the sweep has been round yet.
      live: h.state === "active" && new Date(h.expiresAt) > now,
    })),
  };
}

/** Add squad members. Partial success is real: three good rows and one bad one. */
export async function addPlayers(
  organiserToken: string,
  rows: Array<{ name: string; email?: string | null; phone?: string | null }>,
): Promise<{ error?: string; added: number; rejected: Array<{ name: string; reason: string }> }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found", added: 0, rejected: [] };
  if (entry.status !== "active") return { error: "This team has been withdrawn.", added: 0, rejected: [] };

  let added = 0;
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const r of rows) {
    const name = String(r.name || "").trim();
    const email = String(r.email || "").trim().toLowerCase() || null;
    const phone = String(r.phone || "").trim() || null;

    if (!name) { rejected.push({ name: "(no name)", reason: "Needs a name" }); continue; }
    if (!email && !phone) { rejected.push({ name, reason: "Needs an email or a mobile" }); continue; }
    if (email && !/.+@.+\..+/.test(email)) { rejected.push({ name, reason: "That email doesn't look right" }); continue; }

    try {
      const [p] = await db.insert(teampayPlayers).values({
        entryId: entry.id, name, email, phone, inviteToken: token(), source: "roster",
      }).returning();
      added++;
      await logEvent({ entryId: entry.id, playerId: p.id, kind: "player_added", actor: "manager" });
    } catch (e: any) {
      // 🔴 The database decides whether there is a seat and whether this person
      // is already on the roster. This does not pre-check — a pre-check is a
      // second implementation of the rule, and two managers adding players at
      // once would walk through it.
      const msg = String(e?.message || "");
      rejected.push({
        name,
        reason: msg.includes("squad is full") ? "The squad is full"
          : msg.includes("teampay_players_entry_email_unique") ? "Already on your squad"
          : "Couldn't add them",
      });
    }
  }
  return { added, rejected };
}

export async function setSquadSize(organiserToken: string, size: number): Promise<{ error?: string; ok?: boolean }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  if (!Number.isInteger(size) || size < MIN_SQUAD_SIZE || size > MAX_SQUAD_SIZE) {
    return { error: `Squad size needs to be between ${MIN_SQUAD_SIZE} and ${MAX_SQUAD_SIZE}.` };
  }
  const players = await playersOf(entry.id);
  const active = players.filter(countsTowardsSquad).length;
  if (size < active) return { error: `You already have ${active} players — remove someone first.` };

  try {
    await db.update(teampayEntries)
      .set({ squadSize: size, updatedAt: new Date() })
      .where(eq(teampayEntries.id, entry.id));
  } catch (e: any) {
    // The trigger, not a guess about what the trigger would say.
    if (String(e?.message || "").includes("squad size is fixed")) {
      return { error: "Someone has already paid, so the share is locked in. Get in touch if you need it changed." };
    }
    throw e;
  }
  await logEvent({ entryId: entry.id, kind: "squad_size_changed", actor: "manager", detail: { from: entry.squadSize, to: size } });
  return { ok: true };
}

export async function removePlayer(organiserToken: string, playerId: number): Promise<{ error?: string; ok?: boolean }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  const [p] = await db.select().from(teampayPlayers)
    .where(and(eq(teampayPlayers.id, playerId), eq(teampayPlayers.entryId, entry.id)));
  if (!p) return { error: "not_found" };
  if (p.isManager) return { error: "You can't remove yourself from your own squad." };
  if (p.paidAt && !p.refundedAt) {
    // The constraint would refuse this anyway; saying so plainly is better than
    // surfacing a database error to a team manager.
    return { error: `${p.name} has already paid ${money(p.paidCents ?? 0)}. That needs refunding before they come off the squad — get in touch and we'll sort it.` };
  }
  await db.update(teampayPlayers)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(eq(teampayPlayers.id, p.id));
  await logEvent({ entryId: entry.id, playerId: p.id, kind: "removed", actor: "manager" });
  return { ok: true };
}

// ── the nudge ────────────────────────────────────────────────────────────────

/**
 * Re-send one player their payment link. Replaces the manager texting each
 * player individually, which is the single biggest point of registration
 * drop-off according to Isaac's spec.
 */
export async function nudgePlayer(organiserToken: string, playerId: number): Promise<{ error?: string; ok?: boolean; sentTo?: string }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp) return { error: "not_found" };

  const [p] = await db.select().from(teampayPlayers)
    .where(and(eq(teampayPlayers.id, playerId), eq(teampayPlayers.entryId, entry.id)));
  if (!p) return { error: "not_found" };

  const now = new Date();
  const gate = nudgeGate(p, now);
  if (!gate.allowed) return { error: gate.reason || "Can't send that right now." };
  if (!withinNudgeHoursNz(now)) return { error: "It's outside sending hours — try between 8am and 8pm." };
  if (!p.email) return { error: `We've only got a mobile for ${p.name}. Copy their link and text it to them.` };

  // 🔴 Claim the nudge BEFORE sending, and only if nobody else just did.
  // Two taps on a slow connection is one nudge, not two.
  const claimed = await db.update(teampayPlayers)
    .set({ nudgeCount: (p.nudgeCount ?? 0) + 1, lastNudgedAt: now, updatedAt: now })
    .where(and(
      eq(teampayPlayers.id, p.id),
      sql`coalesce(${teampayPlayers.nudgeCount}, 0) = ${p.nudgeCount ?? 0}`,
    ))
    .returning({ id: teampayPlayers.id });
  if (!claimed.length) return { error: "Just sent — give it a moment." };

  const share = shareCents(entry.feeCents, entry.squadSize);
  const sent = await sendEmail({
    from: fromFor(entry.organizationId, comp),
    to: p.email,
    subject: `${entry.teamName} — your ${money(share)} for the ${comp.name}`,
    html: shell(comp, `${entry.managerName} is chasing`,
      `<p>Hi ${escapeHtml(p.name.split(" ")[0])},</p>
       <p>You're in <strong>${escapeHtml(entry.teamName)}</strong> for the ${escapeHtml(comp.name)}. Your share of the team fee is <strong>${money(share)}</strong>.</p>
       ${comp.paymentsEnabled
         ? `<p>It takes about thirty seconds.</p>`
         : `<p>Payment isn't open yet — this link shows you where you stand and we'll email when it is.</p>`}`,
      { label: comp.paymentsEnabled ? `Pay ${money(share)}` : "See your spot", href: payUrl(p.inviteToken) }),
  });

  await logEvent({ entryId: entry.id, playerId: p.id, kind: "nudge_sent", actor: "manager", detail: { delivered: sent } });
  // Resend accepting it is not the same as an inbox receiving it — the manager
  // is told what actually happened, not a comforting fiction.
  if (!sent) return { error: "We couldn't get that email away just now. Copy their link and send it yourself." };
  return { ok: true, sentTo: p.email };
}

/** Send every unpaid player their link in one go. */
export async function nudgeAll(organiserToken: string): Promise<{ error?: string; sent: number; skipped: Array<{ name: string; reason: string }> }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found", sent: 0, skipped: [] };
  const players = await playersOf(entry.id);
  let sent = 0;
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const p of players.filter(isNudgeable)) {
    const r = await nudgePlayer(organiserToken, p.id);
    if (r.ok) sent++;
    else skipped.push({ name: p.name, reason: r.error || "skipped" });
  }
  return { sent, skipped };
}

// ── the player's page ────────────────────────────────────────────────────────

export async function playerByToken(inviteToken: string) {
  const [p] = await db.select().from(teampayPlayers)
    .where(eq(teampayPlayers.inviteToken, inviteToken));
  if (!p) return null;
  const [entry] = await db.select().from(teampayEntries).where(eq(teampayEntries.id, p.entryId));
  if (!entry) return null;
  const comp = await competitionById(entry.competitionId);
  if (!comp) return null;
  return { player: p, entry, comp };
}

export async function playerView(inviteToken: string) {
  const found = await playerByToken(inviteToken);
  if (!found) return null;
  const { player, entry, comp } = found;
  const players = await playersOf(entry.id);
  const m = entryMoney(entry, players);

  return {
    competition: competitionPublic(comp),
    team: {
      name: entry.teamName,
      community: entry.community,
      managerName: entry.managerName,
      squadSize: entry.squadSize,
      /** So the page can say who is paying, rather than showing a dead button. */
      paymentMode: m.paymentMode,
      isPaidUp: m.isPaidUp,
    },
    you: {
      name: player.name,
      status: playerStatus(player),
      paidAt: player.paidAt,
      paidCents: player.paidCents,
      /** What you owe — derived from the team fee and the squad size, always. */
      shareCents: m.shareCents,
      /**
       * 🔴 What you will ACTUALLY be charged, which is not always your share:
       * zero when the manager is covering the fee, and the remainder when you
       * are the last one paying into a nearly-settled balance. The page must
       * show this figure, not shareCents, or the button lies about the amount.
       */
      chargeCents: playerChargeCents(m),
    },
    squad: {
      paidCount: m.paidCount,
      squadSize: entry.squadSize,
      percentPaid: m.percentPaid,
    },
  };
}

/**
 * 🔴 "Opened" is stamped HERE — from a POST the page makes once it has mounted —
 * and never from the GET that served the link.
 *
 * Corporate mail scanners, link previewers and Apple's Mail Privacy Protection
 * all fetch URLs out of emails. If a GET stamped this, the manager's dashboard
 * would tell them a player had seen their link when a robot had, and they would
 * stop chasing the exact person who needs chasing. Scanners do not run JavaScript.
 */
export async function markOpened(inviteToken: string): Promise<boolean> {
  const now = new Date();
  const r = await db.update(teampayPlayers)
    .set({
      firstOpenedAt: sql`coalesce(${teampayPlayers.firstOpenedAt}, ${now})`,
      lastOpenedAt: now,
      openCount: sql`${teampayPlayers.openCount} + 1`,
      updatedAt: now,
    })
    .where(eq(teampayPlayers.inviteToken, inviteToken))
    .returning({ id: teampayPlayers.id, first: teampayPlayers.firstOpenedAt });
  if (!r.length) return false;
  return true;
}

export async function declinePlayer(inviteToken: string): Promise<{ error?: string; ok?: boolean }> {
  const found = await playerByToken(inviteToken);
  if (!found) return { error: "not_found" };
  if (found.player.paidAt) return { error: "You've already paid — talk to your manager." };
  await db.update(teampayPlayers)
    .set({ declinedAt: new Date(), updatedAt: new Date() })
    .where(eq(teampayPlayers.id, found.player.id));
  await logEvent({ entryId: found.entry.id, playerId: found.player.id, kind: "declined", actor: "player" });
  return { ok: true };
}

// ── money ────────────────────────────────────────────────────────────────────

/**
 * Mint (or reuse) this player's PaymentIntent.
 *
 * 🔴 The amount is computed here, from the entry. The browser sends a token and
 * nothing else — it cannot name its own price.
 */
export async function payIntent(inviteToken: string): Promise<{ error?: string; clientSecret?: string | null; amountCents?: number }> {
  const found = await playerByToken(inviteToken);
  if (!found) return { error: "not_found" };
  const { player, entry, comp } = found;

  if (!comp.paymentsEnabled) return { error: "Payment isn't open yet." };
  if (entry.status !== "active") return { error: "This team has been withdrawn." };
  if (player.paidAt) return { error: "already_paid" };
  if (player.removedAt) return { error: "You're not on this squad any more." };

  /**
   * 🔴 The amount comes from the entry's live balance, not from fee ÷ squad.
   *
   * Two reasons, both of which end in a refund if this is got wrong:
   *   1. In 'whole' mode the manager is settling the fee. Charging this player
   *      a share as well takes the money twice for one seat.
   *   2. Even in 'split' mode the balance can already be covered — a manager
   *      who gave up chasing and paid the remainder themselves is the whole
   *      point of the team-pay button. The last player to open a stale link
   *      must not be charged into an over-collection.
   */
  const players = await playersOf(entry.id);
  const m = entryMoney(entry, players);
  const amountCents = playerChargeCents(m);

  if (amountCents <= 0) {
    return { error: m.paymentMode === "whole" ? "manager_paying" : "team_paid_up" };
  }
  // Stripe will not take less than roughly 50c in NZD.
  if (amountCents < 50) return { error: "That amount is too small to charge." };

  let customerId = player.stripeCustomerId ?? undefined;
  if (!customerId && player.email) {
    try {
      const c = await getOrCreateCustomer({
        email: player.email, name: player.name, phone: player.phone ?? undefined,
      });
      customerId = c.id;
    } catch (e) { console.error("[teampay] customer failed:", e); }
  }

  const pi = await createCardPaymentIntent({
    amountCents,
    currency: comp.currency,
    receiptEmail: player.email,
    description: `${comp.name} — ${entry.teamName} — ${player.name}`,
    metadata: {
      // 🔴 `kind` is what the webhook branches on. Deliberately NOT
      // `registrationId`, which the webhook's catch-all branch would treat as a
      // camp registration and finalise something unrelated.
      kind: "teampay",
      teampayPlayerId: String(player.id),
      teampayEntryId: String(entry.id),
    },
    customerId,
    // 🔴 Keyed on the player AND the amount.
    //
    // Per player alone looks right — one share per seat, so a double tap is a
    // retry — but the manager is invited to change the squad size right up until
    // the first payment, and that changes everyone's share. A player who had
    // already opened their page at $57.15 and came back at $50.00 would send the
    // same key with a different amount, and Stripe refuses that outright: "Keys
    // for idempotent requests can only be used with the same parameters." They
    // would see "couldn't start that payment" and have no way through it.
    //
    // With the amount in the key, a re-quote mints a fresh intent (correct — the
    // price genuinely changed) and a repeat at the same price is still a retry
    // (correct — one share per seat). The abandoned intent was never confirmed
    // and expires on its own.
    idempotencyKey: `teampay-player-${player.id}-${amountCents}`,
  });

  if (customerId && customerId !== player.stripeCustomerId) {
    await db.update(teampayPlayers).set({ stripeCustomerId: customerId })
      .where(eq(teampayPlayers.id, player.id));
  }
  await db.update(teampayPlayers).set({ stripePaymentIntentId: pi.id, updatedAt: new Date() })
    .where(eq(teampayPlayers.id, player.id));

  return { clientSecret: pi.client_secret, amountCents };
}

/**
 * Flip a player to paid, once.
 *
 * 🔴 Atomic: the WHERE clause carries the guard, so a webhook retry racing the
 * browser's confirm call produces one paid row and one no-op, not two.
 */
async function markPaidOnce(playerId: number, paymentIntentId: string, amountCents: number): Promise<boolean> {
  const r = await db.update(teampayPlayers)
    .set({
      paidAt: new Date(), paidCents: amountCents,
      stripePaymentIntentId: paymentIntentId, updatedAt: new Date(),
    })
    .where(and(eq(teampayPlayers.id, playerId), isNull(teampayPlayers.paidAt)))
    .returning({ id: teampayPlayers.id, entryId: teampayPlayers.entryId });
  if (!r.length) return false;
  await logEvent({ entryId: r[0].entryId, playerId, kind: "paid", actor: "player", detail: { amountCents, paymentIntentId } });
  await afterPayment(r[0].entryId, playerId);
  return true;
}

/** Read the truth back from Stripe. Never trust the browser for paid state. */
export async function confirmPayment(inviteToken: string): Promise<{ error?: string; paid?: boolean }> {
  const found = await playerByToken(inviteToken);
  if (!found) return { error: "not_found" };
  const { player } = found;
  if (player.paidAt) return { paid: true };
  if (!player.stripePaymentIntentId) return { error: "No payment to confirm." };

  const pi = await retrievePaymentIntent(player.stripePaymentIntentId);
  if (pi.status !== "succeeded") return { paid: false };
  await markPaidOnce(player.id, pi.id, pi.amount_received || pi.amount);
  return { paid: true };
}

/** The Stripe webhook's teampay branch. Idempotent. */
export async function markPaidByPaymentIntent(pi: any): Promise<boolean> {
  // 🔴 Two kinds of teampay payment now ride this webhook. A team payment
  // carries no teampayPlayerId, and treating it as a player's would silently
  // fail to record $800.
  if (pi?.metadata?.teampayKind === "team") return markTeamPaidByPaymentIntent(pi);
  const playerId = Number(pi?.metadata?.teampayPlayerId);
  if (!Number.isInteger(playerId)) return false;
  return markPaidOnce(playerId, pi.id, pi.amount_received || pi.amount);
}

// ── the manager settles the team fee ─────────────────────────────────────────

/**
 * How the team pays. Offered at entry and changeable from the dashboard.
 *
 * 🔴 Deliberately NOT frozen once money has landed, unlike squad size. Switching
 * mode re-prices nobody: both routes settle the same balance, and every charge
 * is capped at what is still outstanding. The case this exists for is real and
 * common — a manager splits it, three players never pay, and after two weeks of
 * chasing they give up and put the rest on their own card.
 */
export async function setPaymentMode(
  organiserToken: string,
  mode: string,
): Promise<{ error?: string; paymentMode?: PaymentMode }> {
  if (!isPaymentMode(mode)) return { error: "That isn't a way to pay." };
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  if (entry.status !== "active") return { error: "This team has been withdrawn." };
  if (entry.paidUpAt) return { error: "This team is already paid up." };

  await db.update(teampayEntries)
    .set({ paymentMode: mode, updatedAt: new Date() })
    .where(eq(teampayEntries.id, entry.id));
  await logEvent({ entryId: entry.id, kind: "payment_mode_changed", actor: "manager", detail: { paymentMode: mode } });
  return { paymentMode: mode };
}

/**
 * Mint the manager's PaymentIntent for whatever the team still owes.
 *
 * 🔴 Same rule as the player path: the amount is computed here from the entry,
 * and the browser sends a token and nothing else.
 */
export async function teamPayIntent(
  organiserToken: string,
): Promise<{ error?: string; clientSecret?: string | null; amountCents?: number }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp) return { error: "not_found" };

  if (!comp.paymentsEnabled) return { error: "Payment isn't open yet." };
  if (entry.status !== "active") return { error: "This team has been withdrawn." };

  const players = await playersOf(entry.id);
  const m = entryMoney(entry, players);
  const amountCents = teamChargeCents(m);

  if (amountCents <= 0) return { error: "already_paid" };
  if (amountCents < 50) return { error: "That amount is too small to charge." };

  let customerId = entry.teamStripeCustomerId ?? undefined;
  if (!customerId) {
    try {
      const c = await getOrCreateCustomer({
        email: entry.managerEmail, name: entry.managerName, phone: entry.managerPhone ?? undefined,
      });
      customerId = c.id;
    } catch (e) { console.error("[teampay] team customer failed:", e); }
  }

  const pi = await createCardPaymentIntent({
    amountCents,
    currency: comp.currency,
    receiptEmail: entry.managerEmail,
    description: `${comp.name} — ${entry.teamName} — team fee`,
    metadata: {
      kind: "teampay",
      // 🔴 What tells the webhook this is a whole-team payment. Without it the
      // player branch looks for a teampayPlayerId, finds none, and drops it.
      teampayKind: "team",
      teampayEntryId: String(entry.id),
    },
    customerId,
    // Keyed on the entry AND the amount, for the same reason the player key is:
    // a manager who opens the page at $800, has two players pay, and comes back
    // to a $700 balance is a genuinely different charge, not a retry.
    idempotencyKey: `teampay-team-${entry.id}-${amountCents}`,
  });

  await db.update(teampayEntries)
    .set({
      teamStripePaymentIntentId: pi.id,
      ...(customerId ? { teamStripeCustomerId: customerId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(teampayEntries.id, entry.id));

  return { clientSecret: pi.client_secret, amountCents };
}

/**
 * Record the team payment, once.
 *
 * 🔴 Atomic on `team_paid_at IS NULL`, so the browser's confirm racing the
 * webhook produces one payment and one no-op — the same guard the player path
 * uses, and for the same reason.
 */
async function markTeamPaidOnce(entryId: number, paymentIntentId: string, amountCents: number): Promise<boolean> {
  const r = await db.update(teampayEntries)
    .set({
      teamPaidAt: new Date(), teamPaidCents: amountCents,
      teamStripePaymentIntentId: paymentIntentId, updatedAt: new Date(),
    })
    .where(and(eq(teampayEntries.id, entryId), isNull(teampayEntries.teamPaidAt)))
    .returning({ id: teampayEntries.id });
  if (!r.length) return false;
  await logEvent({ entryId, kind: "team_paid", actor: "manager", detail: { amountCents, paymentIntentId } });
  await afterPayment(entryId, null);
  return true;
}

/** Read the truth back from Stripe. Never trust the browser for paid state. */
export async function confirmTeamPayment(organiserToken: string): Promise<{ error?: string; paid?: boolean }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  if (entry.teamPaidAt) return { paid: true };
  if (!entry.teamStripePaymentIntentId) return { error: "No payment to confirm." };

  const pi = await retrievePaymentIntent(entry.teamStripePaymentIntentId);
  if (pi.status !== "succeeded") return { paid: false };
  await markTeamPaidOnce(entry.id, pi.id, pi.amount_received || pi.amount);
  return { paid: true };
}

/** The webhook's team branch. Idempotent. */
export async function markTeamPaidByPaymentIntent(pi: any): Promise<boolean> {
  const entryId = Number(pi?.metadata?.teampayEntryId);
  if (!Number.isInteger(entryId)) return false;
  return markTeamPaidOnce(entryId, pi.id, pi.amount_received || pi.amount);
}

/**
 * Everything that happens after a share lands: tell the player, and if that was
 * the last one, tell the manager their team is paid up.
 */
async function afterPayment(entryId: number, playerId: number | null) {
  try {
    const [entry] = await db.select().from(teampayEntries).where(eq(teampayEntries.id, entryId));
    if (!entry) return;
    const comp = await competitionById(entry.competitionId);
    if (!comp) return;
    const players = await playersOf(entryId);
    // null when the manager settled the whole fee — there is no one player to
    // send a share receipt to, and the paid-up branch below covers the manager.
    const me = playerId === null ? undefined : players.find((p) => p.id === playerId);
    const m = entryMoney(entry, players);

    if (me?.email) {
      await sendEmail({
        from: fromFor(entry.organizationId, comp),
        to: me.email,
        subject: `Paid — you're in for ${entry.teamName}`,
        html: shell(comp, "You're paid up ✓",
          `<p>Thanks ${escapeHtml(me.name.split(" ")[0])} — <strong>${money(me.paidCents ?? 0)}</strong> received for <strong>${escapeHtml(entry.teamName)}</strong>.</p>
           <p>That's ${m.paidCount} of ${entry.squadSize} paid.</p>`),
      });
    }

    // 🔴 Stamped once, atomically. Without the paidUpAt guard a webhook retry
    // sends the manager a second "your team is paid up" email.
    if (m.isPaidUp) {
      const flipped = await db.update(teampayEntries)
        .set({ paidUpAt: new Date(), updatedAt: new Date() })
        .where(and(eq(teampayEntries.id, entryId), isNull(teampayEntries.paidUpAt)))
        .returning({ id: teampayEntries.id });
      if (flipped.length) {
        await logEvent({ entryId, kind: "entry_paid_up", actor: "system", detail: { paidCents: m.paidCents } });
        await sendEmail({
          from: fromFor(entry.organizationId, comp),
          to: entry.managerEmail,
          subject: `${entry.teamName} is paid up 🎉`,
          // The manager who just put $800 on their own card should not be told
          // "everyone's paid" — nobody else paid anything, and it reads as the
          // system having lost their payment.
          html: shell(comp, m.playersPaidCents === 0 ? "You're paid up" : "Everyone's paid",
            `<p>${m.playersPaidCents === 0
                ? `The team fee for <strong>${escapeHtml(entry.teamName)}</strong> is in`
                : `Every share for <strong>${escapeHtml(entry.teamName)}</strong> is in`
              } — ${money(m.paidCents)} of ${money(entry.feeCents)}.</p>
             <p>Nothing else to chase. We'll be in touch with the draw.</p>`,
            { label: "Open your team page", href: dashboardUrl(entry.organiserToken) }),
        });
      }
    }
  } catch (e) {
    // 🔴 Wrapped: an email failure must never read as a failed payment, or the
    // player taps Pay again.
    console.error("[teampay] afterPayment failed:", e);
  }
}

// ── the fill-in marketplace ──────────────────────────────────────────────────

export async function createFillin(input: {
  slug: string;
  firstName: string; lastName?: string | null;
  email: string; phone?: string | null;
  position?: string | null; ability?: string | null; highestLevel?: string | null;
  fromWhere?: string | null; motivation?: string | null; note?: string | null;
}): Promise<{ error?: string; ok?: boolean; alreadyIn?: boolean }> {
  const comp = await competitionBySlug(input.slug);
  if (!comp) return { error: "not_found" };
  if (!comp.fillinsOpen) return { error: "The fill-in list isn't open yet." };

  const firstName = input.firstName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName) return { error: "We need your first name." };
  if (!/.+@.+\..+/.test(email)) return { error: "That email doesn't look right." };

  const values = {
    competitionId: comp.id,
    organizationId: comp.organizationId,
    firstName,
    lastName: input.lastName?.trim() || null,
    email,
    phone: input.phone?.trim() || null,
    position: input.position?.trim() || null,
    ability: input.ability?.trim() || null,
    highestLevel: input.highestLevel?.trim() || null,
    fromWhere: input.fromWhere?.trim() || null,
    motivation: input.motivation?.trim() || null,
    note: input.note?.trim().slice(0, 1000) || null,
    playerToken: token(),
  };

  // Signing up twice is one person checking, not two people.
  //
  // 🔴 Insert first and handle the conflict, rather than looking first. The
  // unique index is on (competition_id, lower(email)) — an expression index,
  // which drizzle's onConflictDoUpdate cannot target — and a look-then-write
  // would race two taps on a slow connection into two pool entries.
  // Their token is deliberately NOT regenerated: it is the link in an email they
  // may already have.
  let row;
  try {
    [row] = await db.insert(teampayFillins).values(values).returning();
  } catch (e: any) {
    if (!String(e?.message || "").includes("teampay_fillins_competition_email_unique")) throw e;
    const { playerToken: _ignored, ...updatable } = values;
    [row] = await db.update(teampayFillins)
      .set({ ...updatable, updatedAt: new Date() })
      .where(and(
        eq(teampayFillins.competitionId, comp.id),
        sql`lower(${teampayFillins.email}) = ${email}`,
      ))
      .returning();
    if (!row) return { error: "Couldn't save that just now." };
    return { ok: true, alreadyIn: true };
  }

  await logEvent({ fillinId: row.id, kind: "fillin_joined", actor: "player" });
  await sendEmail({
    from: fromFor(comp.organizationId, comp),
    to: email,
    subject: `You're on the ${comp.name} fill-in list`,
    html: shell(comp, "You're on the list",
      `<p>Thanks ${escapeHtml(firstName)} — you're on the fill-in list for the ${escapeHtml(comp.name)}.</p>
       <p>Team managers who are short a player will see your profile. If one wants you, we'll email you their team's details and you can say yes or no — nothing happens without you agreeing to it.</p>
       <p style="color:#9A9A9A;font-size:13px;">Managers can't see your email address or phone number until you accept.</p>`),
  }).catch(() => {});

  return { ok: true, alreadyIn: false };
}

/**
 * Holds whose clock has run out go back in the pool.
 *
 * Swept lazily on every browse rather than by a cron — the venue-booking splits
 * do the same, and it means the pool is correct on the screen that reads it,
 * with nothing to schedule and nothing to forget.
 */
export async function sweepExpiredHolds(competitionId: number): Promise<number> {
  const expired = await db.execute(sql`
    UPDATE teampay_fillin_holds h
       SET state = 'expired', responded_at = now()
      FROM teampay_fillins f
     WHERE h.fillin_id = f.id
       AND f.competition_id = ${competitionId}
       AND h.state = 'active'
       AND h.expires_at <= now()
    RETURNING h.fillin_id`);
  const ids = (expired as any).rows?.map((r: any) => r.fillin_id) ?? [];
  if (ids.length) {
    await db.execute(sql`
      UPDATE teampay_fillins SET status = 'available', updated_at = now()
       WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)}) AND status = 'held'`);
  }
  return ids.length;
}

/**
 * What a manager sees when they're short a player.
 *
 * 🔴 The response is built field by field from an allowlist. No contact details
 * leave the server. See RELEASE_CONTACT_ON_REQUEST in shared/teampay.ts for why
 * this deviates from the spec's "managers can see all profiles".
 */
export async function browseFillins(organiserToken: string): Promise<{ error?: string; fillins?: FillinPublic[]; holdsLeft?: number }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp) return { error: "not_found" };
  if (!comp.fillinsOpen) return { error: "The fill-in list isn't open yet." };

  await sweepExpiredHolds(comp.id);

  const [{ open }] = await db.select({ open: sql<number>`count(*)::int` })
    .from(teampayFillinHolds)
    .where(and(eq(teampayFillinHolds.entryId, entry.id), eq(teampayFillinHolds.state, "active")));

  // Players this team asked and was turned down by, inside the cooldown.
  const recentlyDeclined = await db.select({ fillinId: teampayFillinHolds.fillinId })
    .from(teampayFillinHolds)
    .where(and(
      eq(teampayFillinHolds.entryId, entry.id),
      eq(teampayFillinHolds.state, "declined"),
      sql`${teampayFillinHolds.respondedAt} > now() - interval '${sql.raw(String(FILLIN_REASK_COOLDOWN_DAYS))} days'`,
    ));
  const blocked = new Set(recentlyDeclined.map((r) => r.fillinId));

  const rows = await db.select({
    id: teampayFillins.id,
    firstName: teampayFillins.firstName,
    position: teampayFillins.position,
    ability: teampayFillins.ability,
    highestLevel: teampayFillins.highestLevel,
    fromWhere: teampayFillins.fromWhere,
    motivation: teampayFillins.motivation,
    note: teampayFillins.note,
    createdAt: teampayFillins.createdAt,
  })
    .from(teampayFillins)
    .where(and(
      eq(teampayFillins.competitionId, comp.id),
      eq(teampayFillins.status, "available"),
    ))
    .orderBy(desc(teampayFillins.createdAt));

  return {
    fillins: rows
      .filter((r) => !blocked.has(r.id))
      .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    holdsLeft: Math.max(0, FILLIN_MAX_CONCURRENT_HOLDS - Number(open ?? 0)),
  };
}

/**
 * Ask a fill-in to join. Places a hold so no other team can ask at the same
 * time, and emails them the team's details with a yes/no.
 */
export async function requestFillin(
  organiserToken: string, fillinId: number, managerNote?: string | null,
): Promise<{ error?: string; ok?: boolean; expiresAt?: Date }> {
  const entry = await entryByToken(organiserToken);
  if (!entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp || !comp.fillinsOpen) return { error: "The fill-in list isn't open yet." };

  await sweepExpiredHolds(comp.id);

  const players = await playersOf(entry.id);
  const m = entryMoney(entry, players);
  if (m.emptySlots < 1) return { error: "Your squad is full — make room first." };

  const [{ open }] = await db.select({ open: sql<number>`count(*)::int` })
    .from(teampayFillinHolds)
    .where(and(eq(teampayFillinHolds.entryId, entry.id), eq(teampayFillinHolds.state, "active")));
  if (Number(open ?? 0) >= FILLIN_MAX_CONCURRENT_HOLDS) {
    return { error: `You can only ask ${FILLIN_MAX_CONCURRENT_HOLDS} players at a time. Wait for one to answer.` };
  }

  const [f] = await db.select().from(teampayFillins)
    .where(and(eq(teampayFillins.id, fillinId), eq(teampayFillins.competitionId, comp.id)));
  if (!f) return { error: "not_found" };
  if (f.status !== "available") return { error: "Someone just asked them — try another player." };

  const holdToken = token();
  const expiresAt = new Date(Date.now() + FILLIN_HOLD_HOURS * 3600_000);

  try {
    // 🔴 The unique index on (fillin_id) WHERE state='active' is what actually
    // stops two teams booking the same player. This insert either wins or
    // raises — no read-then-write, because between the read and the write is
    // exactly where the other manager's tap lands.
    await db.insert(teampayFillinHolds).values({
      fillinId: f.id, entryId: entry.id, holdToken, expiresAt,
      managerNote: managerNote?.trim().slice(0, 500) || null,
    });
  } catch {
    return { error: "Someone just asked them — try another player." };
  }

  await db.update(teampayFillins)
    .set({ status: "held", updatedAt: new Date() })
    .where(eq(teampayFillins.id, f.id));

  await logEvent({ entryId: entry.id, fillinId: f.id, kind: "fillin_requested", actor: "manager" });

  const share = shareCents(entry.feeCents, entry.squadSize);
  await sendEmail({
    from: fromFor(entry.organizationId, comp),
    to: f.email,
    subject: `${entry.teamName} wants you for the ${comp.name}`,
    html: shell(comp, "A team wants you",
      `<p>Hi ${escapeHtml(f.firstName)},</p>
       <p><strong>${escapeHtml(entry.teamName)}</strong>${entry.community ? ` (${escapeHtml(entry.community)})` : ""} is short a player for the ${escapeHtml(comp.name)} and would like you in their squad.</p>
       ${managerNote ? `<p style="padding:12px 14px;border-left:3px solid #C9A43E;margin:16px 0;">“${escapeHtml(managerNote)}”<br><span style="color:#9A9A9A;font-size:13px;">— ${escapeHtml(entry.managerName)}, manager</span></p>` : ""}
       <p>The team fee is split across the squad, so your share would be <strong>${money(share)}</strong>.</p>
       <p>Say yes and we'll put you in touch with ${escapeHtml(entry.managerName)}. Say no and you stay on the list for other teams. If you don't answer within ${FILLIN_HOLD_HOURS} hours you go back on the list automatically.</p>`,
      { label: "Yes or no", href: holdUrl(holdToken) }),
  }).catch((e) => console.error("[teampay] fill-in request email failed:", e));

  return { ok: true, expiresAt };
}

export async function holdView(holdToken: string) {
  const [h] = await db.select().from(teampayFillinHolds)
    .where(eq(teampayFillinHolds.holdToken, holdToken));
  if (!h) return null;
  const [f] = await db.select().from(teampayFillins).where(eq(teampayFillins.id, h.fillinId));
  const [entry] = await db.select().from(teampayEntries).where(eq(teampayEntries.id, h.entryId));
  if (!f || !entry) return null;
  const comp = await competitionById(entry.competitionId);
  if (!comp) return null;

  const live = h.state === "active" && new Date(h.expiresAt) > new Date();
  return {
    competition: competitionPublic(comp),
    state: live ? "active" : (h.state === "active" ? "expired" : h.state),
    expiresAt: h.expiresAt,
    managerNote: h.managerNote,
    team: {
      name: entry.teamName,
      community: entry.community,
      managerName: entry.managerName,
      // Released only once they accept — see acceptHold.
      managerEmail: h.state === "accepted" ? entry.managerEmail : null,
      managerPhone: h.state === "accepted" ? entry.managerPhone : null,
    },
    you: { firstName: f.firstName },
    shareCents: shareCents(entry.feeCents, entry.squadSize),
  };
}

/**
 * The player says yes. This is the moment contact details are exchanged — the
 * consent step that makes browsing safe to keep anonymous.
 */
export async function acceptHold(holdToken: string): Promise<{ error?: string; ok?: boolean; payUrl?: string }> {
  const [h] = await db.select().from(teampayFillinHolds)
    .where(eq(teampayFillinHolds.holdToken, holdToken));
  if (!h) return { error: "not_found" };
  if (h.state !== "active") return { error: "This invitation has already been answered." };
  if (new Date(h.expiresAt) <= new Date()) return { error: "This invitation has expired — you're back on the list." };

  const [f] = await db.select().from(teampayFillins).where(eq(teampayFillins.id, h.fillinId));
  const [entry] = await db.select().from(teampayEntries).where(eq(teampayEntries.id, h.entryId));
  if (!f || !entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp) return { error: "not_found" };

  // 🔴 Claim the hold first, atomically. Two taps on the accept button must
  // produce one roster row.
  const claimed = await db.update(teampayFillinHolds)
    .set({ state: "accepted", respondedAt: new Date() })
    .where(and(eq(teampayFillinHolds.id, h.id), eq(teampayFillinHolds.state, "active")))
    .returning({ id: teampayFillinHolds.id });
  if (!claimed.length) return { error: "This invitation has already been answered." };

  let player;
  try {
    [player] = await db.insert(teampayPlayers).values({
      entryId: entry.id,
      name: [f.firstName, f.lastName].filter(Boolean).join(" "),
      email: f.email,
      phone: f.phone,
      inviteToken: token(),
      source: "fillin",
      fillinId: f.id,
    }).returning();
  } catch (e: any) {
    // The squad filled up while they were deciding. Put the hold back rather
    // than leaving them accepted into a team with no seat.
    await db.update(teampayFillinHolds)
      .set({ state: "expired", respondedAt: new Date() })
      .where(eq(teampayFillinHolds.id, h.id));
    await db.update(teampayFillins).set({ status: "available", updatedAt: new Date() })
      .where(eq(teampayFillins.id, f.id));
    return { error: "That team filled their last spot while you were deciding — you're still on the list." };
  }

  await db.update(teampayFillinHolds).set({ playerId: player.id }).where(eq(teampayFillinHolds.id, h.id));
  await db.update(teampayFillins).set({ status: "placed", updatedAt: new Date() })
    .where(eq(teampayFillins.id, f.id));
  await logEvent({ entryId: entry.id, playerId: player.id, fillinId: f.id, kind: "fillin_accepted", actor: "player" });

  const share = shareCents(entry.feeCents, entry.squadSize);

  await sendEmail({
    from: fromFor(entry.organizationId, comp),
    to: entry.managerEmail,
    subject: `${f.firstName} said yes — they're in your squad`,
    html: shell(comp, `${escapeHtml(f.firstName)} is in`,
      `<p><strong>${escapeHtml([f.firstName, f.lastName].filter(Boolean).join(" "))}</strong> has accepted and is on your squad for the ${escapeHtml(comp.name)}.</p>
       <p>Email: ${escapeHtml(f.email)}${f.phone ? `<br>Mobile: ${escapeHtml(f.phone)}` : ""}</p>
       <p>Their ${money(share)} share link has gone to them too.</p>`,
      { label: "Open your team page", href: dashboardUrl(entry.organiserToken) }),
  }).catch(() => {});

  await sendEmail({
    from: fromFor(entry.organizationId, comp),
    to: f.email,
    subject: `You're in — ${entry.teamName}`,
    html: shell(comp, `You're in ${escapeHtml(entry.teamName)}`,
      `<p>Nice one. You're in <strong>${escapeHtml(entry.teamName)}</strong> for the ${escapeHtml(comp.name)}.</p>
       <p>Your manager is ${escapeHtml(entry.managerName)} — ${escapeHtml(entry.managerEmail)}${entry.managerPhone ? `, ${escapeHtml(entry.managerPhone)}` : ""}.</p>
       <p>Your share of the team fee is <strong>${money(share)}</strong>.</p>`,
      { label: comp.paymentsEnabled ? `Pay ${money(share)}` : "See your spot", href: payUrl(player.inviteToken) }),
  }).catch(() => {});

  return { ok: true, payUrl: payUrl(player.inviteToken) };
}

export async function declineHold(holdToken: string): Promise<{ error?: string; ok?: boolean }> {
  const [h] = await db.select().from(teampayFillinHolds)
    .where(eq(teampayFillinHolds.holdToken, holdToken));
  if (!h) return { error: "not_found" };
  if (h.state !== "active") return { error: "This invitation has already been answered." };

  // 🔴 Released and re-opened as two statements. Postgres gives every
  // sub-statement of one command the same snapshot, so releasing a hold inside a
  // CTE is invisible to any insert beside it — the next team's request would be
  // refused by the unique index. Found while rehearsing the migration.
  await db.update(teampayFillinHolds)
    .set({ state: "declined", respondedAt: new Date() })
    .where(and(eq(teampayFillinHolds.id, h.id), eq(teampayFillinHolds.state, "active")));
  await db.update(teampayFillins)
    .set({ status: "available", updatedAt: new Date() })
    .where(and(eq(teampayFillins.id, h.fillinId), eq(teampayFillins.status, "held")));

  await logEvent({ entryId: h.entryId, fillinId: h.fillinId, kind: "fillin_declined", actor: "player" });
  return { ok: true };
}

// ── staff ────────────────────────────────────────────────────────────────────

/** The admin board: every entry in a competition, with its money position. */
export async function adminOverview(organizationId: number) {
  const comps = await db.select().from(teampayCompetitions)
    .where(eq(teampayCompetitions.organizationId, organizationId))
    .orderBy(desc(teampayCompetitions.createdAt));

  const out = [];
  for (const comp of comps) {
    const entries = await db.select().from(teampayEntries)
      .where(eq(teampayEntries.competitionId, comp.id))
      .orderBy(desc(teampayEntries.createdAt));

    const withMoney = [];
    for (const e of entries) {
      const players = await playersOf(e.id);
      withMoney.push({
        ...e,
        dashboardUrl: dashboardUrl(e.organiserToken),
        money: entryMoney(e, players),
        players: players.map((p) => ({
          id: p.id, name: p.name, email: p.email, phone: p.phone,
          status: playerStatus(p), source: p.source, isManager: p.isManager,
          paidCents: p.paidCents, paidAt: p.paidAt,
          openCount: p.openCount, nudgeCount: p.nudgeCount,
        })),
      });
    }

    const fillins = await db.select().from(teampayFillins)
      .where(eq(teampayFillins.competitionId, comp.id))
      .orderBy(desc(teampayFillins.createdAt));

    // Totals are DERIVED here and never stored — see the Accommodation import.
    const collected = withMoney.reduce((s, e) => s + e.money.paidCents, 0);
    const committed = withMoney.filter((e) => e.status === "active").reduce((s, e) => s + e.feeCents, 0);

    out.push({
      competition: comp,
      entryUrl: enterUrl(comp.slug),
      fillinUrl: fillinUrl(comp.slug),
      totals: {
        entries: withMoney.filter((e) => e.status === "active").length,
        collectedCents: collected,
        committedCents: committed,
        outstandingCents: Math.max(0, committed - collected),
        paidUpTeams: withMoney.filter((e) => e.paidUpAt).length,
        fillinsAvailable: fillins.filter((f) => f.status === "available").length,
        fillinsPlaced: fillins.filter((f) => f.status === "placed").length,
      },
      entries: withMoney,
      fillins,
    });
  }
  return out;
}

export async function adminSetSwitches(
  competitionId: number,
  patch: Partial<Pick<TeampayCompetition, "entriesOpen" | "paymentsEnabled" | "fillinsOpen" | "feeCents" | "defaultSquadSize" | "blurb" | "payByDate">>,
) {
  const [row] = await db.update(teampayCompetitions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(teampayCompetitions.id, competitionId))
    .returning();
  return row;
}

/** Re-send a manager their dashboard link — the "I lost the link" call. */
export async function adminResendDashboardLink(entryId: number): Promise<{ error?: string; ok?: boolean; to?: string }> {
  const [entry] = await db.select().from(teampayEntries).where(eq(teampayEntries.id, entryId));
  if (!entry) return { error: "not_found" };
  const comp = await competitionById(entry.competitionId);
  if (!comp) return { error: "not_found" };
  const sent = await sendEmail({
    from: fromFor(entry.organizationId, comp),
    to: entry.managerEmail,
    subject: `Your ${entry.teamName} team page`,
    html: shell(comp, "Your team page",
      `<p>Here's the link to manage <strong>${escapeHtml(entry.teamName)}</strong>.</p>`,
      { label: "Open your team page", href: dashboardUrl(entry.organiserToken) }),
  });
  return sent ? { ok: true, to: entry.managerEmail } : { error: "Send failed" };
}
