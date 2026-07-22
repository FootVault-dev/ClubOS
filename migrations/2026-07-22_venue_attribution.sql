-- Venue booking marketing attribution (2026-07-22). ADDITIVE ONLY.
--
-- The cufc.co.nz "Field Hire" menu link routes through the /l/ tracked redirect
-- and lands on book.unitedsportscentre.com carrying a ?source= tag (e.g.
-- "field-hire-mainmenu"). The public booking page reads that tag and stamps it
-- here, so United Sports Centre can report bookings + revenue by where a booking
-- came from — and compare placements (main-menu vs submenu) later.
--
-- Nullable text, no CHECK, no backfill: existing rows keep NULL and nothing is
-- removed or rewritten. Deliberately distinct from facility_bookings.source (the
-- manual|public|member_request channel), which is unchanged.
BEGIN;

ALTER TABLE facility_bookings
  ADD COLUMN IF NOT EXISTS attribution_source text;

COMMIT;
