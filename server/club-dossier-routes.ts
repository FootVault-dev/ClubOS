// ─────────────────────────────────────────────────────────────────────────────
// Club Dossier — first-party people intelligence (Sandbox workspace).
//
// v1 (this file) is READ-ONLY and 100% first-party: it UNIONs every registrant /
// contact table we already legitimately hold and rolls them up "by program" —
// the raw material for club-wide audience insight and sponsor pitches.
//
// It intentionally does NOT touch any external/third-party source. The next
// phases (consented Club Census + compliant enrichment + a per-person confidence
// model) layer on top of this and are designed separately.
//
// Access: locked to super_admin via requireTab("club-dossier") + the
// SUPER_ADMIN_ONLY_TABS entry in shared/tabs.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";

// One normalised row per source table: (program, name, email, phone, created_at).
// STATIC SQL — no user input is interpolated, so sql.raw is safe here.
// created_at is cast to timestamptz so the UNION resolves to one type across the
// mix of timestamp / timestamptz columns.
const PEOPLE_UNION = `(
  SELECT 'Camps & Academy (parents)'::text AS program,
         btrim(concat(first_name, ' ', last_name)) AS name,
         email, phone, created_at::timestamptz AS created_at
    FROM contacts WHERE type = 'guardian'
  UNION ALL
  SELECT 'MFL Teams'::text, contact_name, contact_email, contact_phone, created_at::timestamptz
    FROM league_teams
  UNION ALL
  SELECT 'MFL Waitlist'::text, contact_name, email, phone, created_at::timestamptz
    FROM league_waitlist
  UNION ALL
  SELECT 'CIC Interest'::text, btrim(concat(first_name, ' ', coalesce(last_name, ''))), email, phone, created_at::timestamptz
    FROM cic_interest_registrations
  UNION ALL
  SELECT 'CIC 7s'::text, btrim(concat(first_name, ' ', coalesce(last_name, ''))), email, phone, created_at::timestamptz
    FROM cic7s_registrations
  UNION ALL
  SELECT 'Gymnastics Enrolments'::text, parent_name, email, phone, created_at::timestamptz
    FROM cugc_registrations
  UNION ALL
  SELECT 'Gymnastics Free Sessions'::text, parent_name, email, phone, created_at::timestamptz
    FROM cugc_free_sessions
  UNION ALL
  SELECT 'Football Institute'::text, coalesce(parent_name, applicant_name), email, phone, created_at::timestamptz
    FROM football_institute_applications
  UNION ALL
  SELECT 'SIU Membership'::text, name, email, phone, created_at::timestamptz
    FROM members
  UNION ALL
  SELECT 'Print Customers'::text, btrim(concat(first_name, ' ', last_name)), email, phone, created_at::timestamptz
    FROM print_contacts
) AS people`;

const HAS_CONTACT = `((email IS NOT NULL AND btrim(email) <> '') OR (phone IS NOT NULL AND btrim(phone) <> ''))`;
const PEOPLE_CAP = 5000;

export function registerClubDossierRoutes(app: Express) {
  app.get(
    "/api/admin/club-dossier",
    requireAuth,
    requireTab("club-dossier"),
    async (_req, res) => {
      try {
        const totalsRes = await db.execute(
          sql.raw(
            `SELECT count(*)::int AS records,
                    count(distinct lower(nullif(btrim(email), '')))::int AS unique_emails,
                    count(distinct nullif(btrim(phone), ''))::int AS unique_phones,
                    count(distinct program)::int AS programs
               FROM ${PEOPLE_UNION}`,
          ),
        );
        const programsRes = await db.execute(
          sql.raw(
            `SELECT program,
                    count(*)::int AS records,
                    count(distinct lower(nullif(btrim(email), '')))::int AS unique_emails,
                    count(*) FILTER (WHERE ${HAS_CONTACT})::int AS contactable
               FROM ${PEOPLE_UNION}
              GROUP BY program
              ORDER BY records DESC`,
          ),
        );
        const peopleRes = await db.execute(
          sql.raw(
            `SELECT program, name, email, phone, created_at
               FROM ${PEOPLE_UNION}
              WHERE ${HAS_CONTACT}
              ORDER BY created_at DESC NULLS LAST
              LIMIT ${PEOPLE_CAP + 1}`,
          ),
        );

        const people = peopleRes.rows as any[];
        const truncated = people.length > PEOPLE_CAP;

        res.json({
          generatedAt: new Date().toISOString(),
          totals: (totalsRes.rows as any[])[0] ?? {
            records: 0,
            unique_emails: 0,
            unique_phones: 0,
            programs: 0,
          },
          programs: programsRes.rows,
          people: truncated ? people.slice(0, PEOPLE_CAP) : people,
          truncated,
          cap: PEOPLE_CAP,
        });
      } catch (e: any) {
        console.error("[club-dossier] failed:", e);
        res.status(500).json({ message: e.message });
      }
    },
  );
}
