// ─────────────────────────────────────────────────────────────────────────────
// FRIENDLY MANAGER HISTORY — 10 years of CUFC registrations and payments,
// imported 2026-07-14 from the club's Friendly Manager account (org 1).
//
// Read-only. The data lives in two additive tables written by
// script/import-fm-history.ts (fm_registration_history / fm_payment_history —
// raw-SQL tables, mfl_customer_history pattern, NOT in the Drizzle schema) plus
// the imported contacts (contacts.friendly_manager_id IS NOT NULL) and their
// guardian→child rows in contact_relationships.
//
//   GET /api/admin/fm-history/stats        — headline totals + per-season counts
//   GET /api/admin/fm-history/people?q=    — CLV-ranked people list / search
//   GET /api/admin/fm-history/person/:id   — one person: family, terms, payments
//
// Gated by requireTab("fm-history"), which sits in SUPER_ADMIN_ONLY_TABS:
// this is children's enrolment history and family payment records — Daniel-only
// until he opens it up. No public surface, no writes.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";

const lim = (v: any, def: number, max: number) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};

export function registerFmHistoryRoutes(app: Express) {
  const tab = requireTab("fm-history");

  app.get("/api/admin/fm-history/stats", requireAuth, tab, async (_req: Request, res: Response) => {
    try {
      const head: any = (await db.execute(sql`
        SELECT
          (SELECT count(*) FROM contacts WHERE friendly_manager_id IS NOT NULL)::int            AS "people",
          (SELECT count(*) FROM contacts WHERE friendly_manager_id IS NOT NULL AND type='player')::int AS "players",
          (SELECT count(*) FROM contact_relationships cr
             JOIN contacts g ON g.id = cr.guardian_id
            WHERE g.friendly_manager_id IS NOT NULL)::int                                       AS "familyLinks",
          (SELECT count(*) FROM fm_registration_history)::int                                   AS "registrations",
          (SELECT count(DISTINCT fm_person_id) FROM fm_registration_history)::int               AS "enrolledPeople",
          (SELECT count(DISTINCT term_id) FROM fm_registration_history)::int                    AS "terms",
          (SELECT count(*) FROM fm_payment_history)::int                                        AS "payments",
          (SELECT coalesce(sum(amount_cents),0) FROM fm_payment_history)::bigint                AS "totalCents",
          (SELECT to_char(min(paid_on),'YYYY-MM-DD') FROM fm_payment_history)                   AS "firstPayment",
          (SELECT to_char(max(paid_on),'YYYY-MM-DD') FROM fm_payment_history)                   AS "lastPayment"
      `)).rows[0];
      const seasons = (await db.execute(sql`
        SELECT season_year AS "year", count(*)::int AS "registrations"
        FROM fm_registration_history GROUP BY 1 ORDER BY 1 NULLS LAST
      `)).rows;
      res.json({ ...head, totalCents: Number(head.totalCents), seasons });
    } catch (err) {
      console.error("[fm-history] stats:", err);
      res.status(500).json({ message: "Failed to load stats" });
    }
  });

  app.get("/api/admin/fm-history/people", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q ?? "").trim().slice(0, 80);
      const limit = lim(req.query.limit, 100, 300);
      const rows = (await db.execute(sql`
        SELECT c.id, c.type, c.first_name AS "firstName", c.last_name AS "lastName",
               c.email, c.phone, to_char(c.date_of_birth,'YYYY-MM-DD') AS "dob",
               coalesce(reg.terms,0)::int  AS "terms",
               reg.first_year              AS "firstYear",
               reg.last_year               AS "lastYear",
               coalesce(pay.pays,0)::int   AS "payments",
               coalesce(pay.cents,0)::bigint AS "cents",
               guard.names                 AS "guardians",
               coalesce(kids.n,0)::int     AS "children"
        FROM contacts c
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT h.term_id) AS terms,
                 min(h.season_year) AS first_year, max(h.season_year) AS last_year
          FROM fm_registration_history h WHERE h.contact_id = c.id
        ) reg ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS pays, sum(ph.amount_cents) AS cents
          FROM fm_payment_history ph WHERE ph.contact_id = c.id
        ) pay ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(g.first_name || ' ' || g.last_name, ', ') AS names
          FROM contact_relationships cr JOIN contacts g ON g.id = cr.guardian_id
          WHERE cr.player_id = c.id
        ) guard ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM contact_relationships cr WHERE cr.guardian_id = c.id
        ) kids ON true
        WHERE c.friendly_manager_id IS NOT NULL
          AND (${q} = '' OR (c.first_name || ' ' || c.last_name) ILIKE ${"%" + q + "%"}
               OR c.email ILIKE ${"%" + q + "%"})
        ORDER BY coalesce(pay.cents,0) DESC, coalesce(reg.terms,0) DESC, c.last_name, c.first_name
        LIMIT ${limit}
      `)).rows.map((r: any) => ({ ...r, cents: Number(r.cents) }));
      res.json(rows);
    } catch (err) {
      console.error("[fm-history] people:", err);
      res.status(500).json({ message: "Failed to load people" });
    }
  });

  app.get("/api/admin/fm-history/person/:id", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });
      const person: any = (await db.execute(sql`
        SELECT c.id, c.type, c.first_name AS "firstName", c.last_name AS "lastName",
               c.email, c.phone, to_char(c.date_of_birth,'YYYY-MM-DD') AS "dob",
               c.address, c.medical_notes AS "medicalNotes", c.notes, c.tags,
               c.friendly_manager_id AS "fmId"
        FROM contacts c WHERE c.id = ${id} AND c.friendly_manager_id IS NOT NULL
      `)).rows[0];
      if (!person) return res.status(404).json({ message: "Not an imported contact" });

      const guardians = (await db.execute(sql`
        SELECT g.id, g.first_name AS "firstName", g.last_name AS "lastName", g.email, g.phone
        FROM contact_relationships cr JOIN contacts g ON g.id = cr.guardian_id
        WHERE cr.player_id = ${id} ORDER BY g.last_name
      `)).rows;
      const children = (await db.execute(sql`
        SELECT p.id, p.first_name AS "firstName", p.last_name AS "lastName",
               to_char(p.date_of_birth,'YYYY-MM-DD') AS "dob"
        FROM contact_relationships cr JOIN contacts p ON p.id = cr.player_id
        WHERE cr.guardian_id = ${id} ORDER BY p.date_of_birth
      `)).rows;
      const registrations = (await db.execute(sql`
        SELECT term_id AS "termId", term_name AS "termName", season_year AS "seasonYear",
               programme_group AS "programmeGroup", position
        FROM fm_registration_history WHERE contact_id = ${id} ORDER BY term_id DESC
      `)).rows;
      const payments = (await db.execute(sql`
        SELECT to_char(paid_on,'YYYY-MM-DD') AS "paidOn", amount_cents AS "amountCents",
               method, method_raw AS "methodRaw", fee_number AS "feeNumber",
               fee_description AS "feeDescription", note_reference AS "noteReference"
        FROM fm_payment_history WHERE contact_id = ${id} ORDER BY paid_on DESC, id DESC
      `)).rows.map((r: any) => ({ ...r, amountCents: Number(r.amountCents) }));

      // Family total: self + guardians + children + siblings (other players
      // under the same guardians) — one household's lifetime value.
      const family: any = (await db.execute(sql`
        WITH fam AS (
          SELECT ${id}::int AS cid
          UNION SELECT cr.guardian_id FROM contact_relationships cr WHERE cr.player_id = ${id}
          UNION SELECT cr.player_id   FROM contact_relationships cr WHERE cr.guardian_id = ${id}
          UNION SELECT sib.player_id  FROM contact_relationships g
                 JOIN contact_relationships sib ON sib.guardian_id = g.guardian_id
                 WHERE g.player_id = ${id}
        )
        SELECT coalesce(sum(ph.amount_cents),0)::bigint AS cents, count(*)::int AS pays
        FROM fm_payment_history ph WHERE ph.contact_id IN (SELECT cid FROM fam)
      `)).rows[0];

      res.json({
        person, guardians, children, registrations, payments,
        familyCents: Number(family.cents), familyPayments: family.pays,
      });
    } catch (err) {
      console.error("[fm-history] person:", err);
      res.status(500).json({ message: "Failed to load person" });
    }
  });
}
