-- camp_dates: one row per DAY is the wrong key for a term timetable.
--
-- `camp_dates_camp_id_date_key UNIQUE (camp_id, date)` encodes a holiday-camp
-- assumption: a camp runs once a day (split into morning/afternoon by capacity
-- columns on that single row). A term timetable runs the same programme more
-- than once on the same day — the U4-U8 academy trains Saturday 9:30 (U4–U6)
-- AND Saturday 10:30 (U7–U8), two separate rolls.
--
-- The schema comment on camp_dates.name already promised this ("Lets a single
-- program run multiple slots on the same day with different rolls") but the
-- constraint made it impossible; generating the Term 3 timetable failed on it.
--
-- The real natural key is the SLOT: (camp_id, date, start_time). Replacing the
-- constraint with a plain 3-column UNIQUE would quietly weaken the camp rule,
-- because Postgres treats NULLs as distinct and every holiday-camp row has a
-- NULL start_time — two rows for the same camp day would become legal. So the
-- rule is split in two, and each model keeps exactly the invariant it needs:
--
--   start_time IS NULL      → holiday camps: one row per camp per day (as before)
--   start_time IS NOT NULL  → term slots:   one row per camp per day per start time
--
-- Verified before applying: all 28 existing rows have a NULL start_time, and no
-- (camp_id, date, start_time) group has duplicates — neither index can fail.

ALTER TABLE camp_dates DROP CONSTRAINT IF EXISTS camp_dates_camp_id_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS camp_dates_day_uniq
  ON camp_dates (camp_id, date)
  WHERE start_time IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS camp_dates_slot_uniq
  ON camp_dates (camp_id, date, start_time)
  WHERE start_time IS NOT NULL;
