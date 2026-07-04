// MFL Loyalty & Customer Lifetime Value (CLV).
//
// One unified view of every Mini Football purchase — historical (imported into
// mfl_customer_history from Shopify / Friendly Manager / SportNinja) PLUS live
// ClubOS registrations — so the admin can see each customer's full journey,
// lifetime value, seasons played, and a most-loyal leaderboard for both people
// (captains) and teams. Computed on-query (no dependency on the paused rewards
// ledger), so it's always current and includes both data sources automatically.
//
// Money is contracted value in cents. Cent sums are cast ::int for clean JSON
// numbers (ceiling ~$21.4M total — fine for this table for years). MFL org = 3.

import { db } from "./db";
import { sql } from "drizzle-orm";

export const MFL_ORG_ID = 3;

// A CTE that flattens historical + live purchases into one shape.
const UNIFIED = sql`
  WITH unified AS (
    SELECT
      lower(trim(coalesce(h.buyer_email, ''))) AS email_key,
      h.contact_id                              AS contact_id,
      coalesce(h.buyer_first_name, '')          AS first_name,
      coalesce(h.buyer_last_name, '')           AS last_name,
      h.buyer_phone                             AS phone,
      h.amount_cents                            AS cents,
      h.purchased_at                            AS at,
      h.product_title                           AS season,
      h.variant                                 AS variant,
      nullif(trim(coalesce(h.team_name, '')), '') AS team,
      h.financial_status                        AS status,
      h.source                                  AS source,
      'historical'                              AS kind
    FROM mfl_customer_history h
    WHERE h.organization_id = ${MFL_ORG_ID}
    UNION ALL
    SELECT
      lower(trim(coalesce(c.email, ''))) AS email_key,
      r.contact_id                       AS contact_id,
      coalesce(c.first_name, '')         AS first_name,
      coalesce(c.last_name, '')          AS last_name,
      c.phone                            AS phone,
      coalesce(r.total_cents, round(r.amount_paid * 100)::int, 0) AS cents,
      r.registered_at                    AS at,
      p.name                             AS season,
      d.name                             AS variant,
      nullif(trim(coalesce(r.team_name, '')), '') AS team,
      r.status::text                     AS status,
      'clubos'                           AS source,
      'live'                             AS kind
    FROM registrations r
    JOIN programs p ON p.id = r.program_id AND p.organization_id = ${MFL_ORG_ID}
    LEFT JOIN contacts c ON c.id = r.contact_id
    LEFT JOIN league_divisions d ON d.id = r.league_division_id
    WHERE r.status IN ('confirmed', 'refunded', 'partially_refunded')
  )
`;

// Group key: prefer email (unifies a person across historical + live even if
// they ended up as two contact rows); fall back to contact id, then a synthetic.
const GKEY = sql`coalesce(nullif(email_key, ''), 'contact:' || contact_id::text, 'anon')`;

export async function getLoyaltyStats() {
  const r: any = await db.execute(sql`
    ${UNIFIED}
    SELECT
      count(*)::int                                    AS "totalPurchases",
      count(DISTINCT ${GKEY})::int                     AS "totalCustomers",
      count(DISTINCT nullif(lower(team), ''))::int     AS "totalTeams",
      coalesce(sum(cents), 0)::int                     AS "totalCents",
      min(at)                                          AS "firstAt",
      max(at)                                          AS "lastAt",
      count(*) FILTER (WHERE kind = 'historical')::int AS "historicalPurchases",
      count(*) FILTER (WHERE kind = 'live')::int       AS "livePurchases"
    FROM unified
  `);
  return r.rows[0];
}

export async function getCustomerLeaderboard(limit = 1000) {
  const r: any = await db.execute(sql`
    ${UNIFIED}
    SELECT
      ${GKEY}                                        AS "gkey",
      min(contact_id)                                AS "contactId",
      (array_agg(first_name ORDER BY at DESC) FILTER (WHERE first_name <> ''))[1] AS "firstName",
      (array_agg(last_name  ORDER BY at DESC) FILTER (WHERE last_name  <> ''))[1] AS "lastName",
      max(email_key)                                 AS "email",
      (array_agg(phone ORDER BY at DESC) FILTER (WHERE phone IS NOT NULL))[1]     AS "phone",
      coalesce(sum(cents), 0)::int                   AS "totalCents",
      count(*)::int                                  AS "orders",
      count(DISTINCT season)::int                    AS "seasons",
      min(at)                                        AS "firstAt",
      max(at)                                        AS "lastAt",
      array_remove(array_agg(DISTINCT team), NULL)   AS "teams",
      bool_or(kind = 'live')                         AS "hasLive",
      bool_or(kind = 'historical')                   AS "hasHistorical"
    FROM unified
    GROUP BY ${GKEY}
    ORDER BY "totalCents" DESC, "seasons" DESC
    LIMIT ${limit}
  `);
  return r.rows;
}

export async function getTeamLeaderboard(limit = 1000) {
  const r: any = await db.execute(sql`
    ${UNIFIED}
    SELECT
      team                                           AS "teamName",
      coalesce(sum(cents), 0)::int                   AS "totalCents",
      count(*)::int                                  AS "orders",
      count(DISTINCT season)::int                    AS "seasons",
      count(DISTINCT nullif(email_key, ''))::int     AS "captains",
      (array_agg(trim(first_name || ' ' || last_name) ORDER BY at DESC) FILTER (WHERE first_name <> ''))[1] AS "latestCaptain",
      min(at)                                        AS "firstAt",
      max(at)                                        AS "lastAt"
    FROM unified
    WHERE team IS NOT NULL
    GROUP BY team
    ORDER BY "totalCents" DESC, "seasons" DESC
    LIMIT ${limit}
  `);
  return r.rows;
}

// Full journey for one customer — by email if present, else by contact id.
export async function getCustomerJourney(key: string) {
  const isEmail = key.includes("@");
  const r: any = await db.execute(sql`
    ${UNIFIED}
    SELECT
      first_name AS "firstName", last_name AS "lastName", email_key AS "email", phone AS "phone",
      cents AS "cents", at AS "at", season AS "season", variant AS "variant",
      team AS "team", status AS "status", source AS "source", kind AS "kind"
    FROM unified
    WHERE ${isEmail ? sql`email_key = ${key.toLowerCase()}` : sql`contact_id = ${parseInt(key, 10)}`}
    ORDER BY at ASC
  `);
  return r.rows;
}

// Plan B — manually add a purchase we missed (team sends screenshot proof).
// Writes to mfl_customer_history with source 'manual' and the admin's user id.
export async function addManualPurchase(input: {
  firstName: string; lastName: string; email?: string; phone?: string;
  productTitle: string; variant?: string; teamName?: string;
  amountCents: number; purchasedAt: string; addedByUserId?: number; notes?: string;
}) {
  // Reuse an existing contact by email, else create one (matches import behaviour).
  let contactId: number | null = null;
  const email = (input.email || "").trim().toLowerCase();
  if (email) {
    const found: any = await db.execute(sql`SELECT id FROM contacts WHERE lower(trim(email)) = ${email} ORDER BY id LIMIT 1`);
    if (found.rows[0]) contactId = found.rows[0].id;
    else {
      const ins: any = await db.execute(sql`
        INSERT INTO contacts (type, first_name, last_name, email, phone, newsletter_consent, tags, notes)
        VALUES ('guardian', ${input.firstName}, ${input.lastName}, ${input.email}, ${input.phone || null}, true, 'mfl,manual-import', 'Added manually (missed-transaction correction)')
        RETURNING id`);
      contactId = ins.rows[0].id;
    }
  }
  const r: any = await db.execute(sql`
    INSERT INTO mfl_customer_history
      (organization_id, contact_id, source, category, product_title, variant, team_name,
       purchased_at, amount_cents, currency, quantity, financial_status,
       buyer_first_name, buyer_last_name, buyer_email, buyer_phone, notes, added_by_user_id)
    VALUES (${MFL_ORG_ID}, ${contactId}, 'manual', 'manual', ${input.productTitle}, ${input.variant || null}, ${input.teamName || null},
       ${input.purchasedAt}, ${input.amountCents}, 'NZD', 1, 'paid',
       ${input.firstName}, ${input.lastName}, ${input.email || null}, ${input.phone || null}, ${input.notes || null}, ${input.addedByUserId || null})
    RETURNING id`);
  return { id: r.rows[0].id, contactId };
}
