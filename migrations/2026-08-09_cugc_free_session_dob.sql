-- Date of birth on a CUGC free-session (trial) booking.
--
-- The trial form asked for an AGE as a number. Age goes stale the moment it is
-- typed, can't be checked, and can't grade a child into the right class next
-- term — the paid enrolment form has always asked for a date of birth, and the
-- trial form is the one most families fill in FIRST.
--
-- Nullable on purpose: the 7 bookings taken before this change genuinely have
-- no date of birth on file, and a default would state a fact about a real child
-- that nobody ever told us. The ENDPOINT requires it from here on; the column
-- records honestly that the older rows predate it.
--
-- child_age is kept and now DERIVED from this on write, so the admin list and
-- anything reading it keeps working and stops drifting.

ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS child_dob text;
