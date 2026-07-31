-- ─────────────────────────────────────────────────────────────────────────────
-- Pro-rata grace weeks — a term price that does NOT discount from day one.
--
-- The club's actual U4–U8 rule, confirmed by Olga on 2026-08-01:
--
--     weeks 1–5 of the term  →  the full $160
--     week 6 onward          →  pro-rated for what's left
--
-- ClubOS had been pro-rating U4–U8 from the first day of the term, so families
-- registering in weeks 2–5 were being charged less than the published fee
-- ($144 in week 2, $128 in week 3 …). Technification is genuinely pro-rated
-- from the start and does NOT change.
--
-- 🔴 DEFAULT 0 = today's behaviour, exactly. Every existing programme — the
-- other CUFC academy programmes, and every United Gymnastics class booking that
-- shares this engine — keeps pro-rating from day one. This migration changes
-- the price of nothing on its own; only the UPDATE below, scoped to one row,
-- turns the rule on.
--
-- NOT NULL with a default rather than nullable: the price path reads this on
-- every quote, and "unset" and "no grace" are the same thing. No CHECK
-- constraint (a stale one is how the MFL checkout started 500-ing); the value
-- is clamped to [0, sessionCount] in shared/academy.ts on the way through, so a
-- mistyped 99 can never charge more than one full term.
--
-- Scoped by (organization_id, slug), never by a bare id — ids differ between
-- environments and a mis-hit here changes what a parent is charged.
--
-- Rehearse (the DEFAULT — rolls back), then apply:
--   npx tsx --env-file=.env script/apply-prorata-grace-weeks.ts
--   npx tsx --env-file=.env script/apply-prorata-grace-weeks.ts --apply
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS prorata_grace_weeks integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN programs.prorata_grace_weeks IS
  'Weeks from the term start charged at the FULL term price before pro-rata begins. 5 = weeks 1-5 full price, pro-rata from week 6 (CUFC U4-U8). 0 = pro-rate from day one (default, and every other programme).';

-- The one programme the rule applies to. Idempotent.
UPDATE programs
   SET prorata_grace_weeks = 5
 WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'christchurch-united')
   AND slug = 'u4-u8'
   AND prorata_grace_weeks IS DISTINCT FROM 5;
