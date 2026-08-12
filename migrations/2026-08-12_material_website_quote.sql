-- ─────────────────────────────────────────────────────────────────────────────
-- Materials → the unitedprints.co.nz Instant Quote generator
--
-- The website's quote page used to carry its own hardcoded rate table in
-- src/site.ts, so changing a price meant a code edit and a deploy — i.e. it
-- went through Daniel. This column is the switch that lets the Materials tab
-- in ClubOS be the single source of truth instead: Dima edits a price, saves,
-- and the public quote page prices from it on the next request.
--
-- DEFAULT false, deliberately. The catalog holds products that have no
-- business in a width × height signage quote (the AS Colour tee is priced
-- per garment, not per m²), and on 2026-08-12 Daniel explicitly removed ACM
-- Panel from the website's list. A default of true would have silently put
-- both back on the page. Appearing on the website is therefore an opt-in
-- decision someone makes per product, separate from `is_active` — which
-- governs the whole print catalog and the order page, not this one form.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE print_materials
  ADD COLUMN IF NOT EXISTS quote_on_website boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN print_materials.quote_on_website IS
  'Show this material in the unitedprints.co.nz Instant Quote generator. Opt-in per product; separate from is_active (which governs the full catalog + order page). Toggled by Dima in ClubOS → United Prints → Materials, no deploy.';

-- Partial index: the public endpoint only ever asks for the handful that are
-- on the website, and it is hit on every page load of the quote form.
CREATE INDEX IF NOT EXISTS print_materials_website_quote_idx
  ON print_materials (organization_id, display_order)
  WHERE quote_on_website = true AND is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- The printer's roll width (Daniel, 2026-08-12: "1.6m maximum, no limitation
-- on the length").
--
-- 🔴 This is a constraint on the NARROWER side, not on the field labelled
-- "Width". A 3000 × 800mm banner is perfectly printable on a 1.6m roll — it
-- runs the 800mm across the roll and the 3m along it. Capping the width field
-- literally would refuse jobs the shop can actually print, quietly, and only
-- the customer would ever know. So the rule the engine enforces is
-- min(width, height) <= max_roll_width_mm.
--
-- Nullable, and null means "no roll constraint" — sheet goods (aluminium
-- composite panel) and garments are not printed off a roll at all, and giving
-- them a made-up width would reject real orders. Per-material rather than a
-- constant, because a second printer with a different bed is a row edit rather
-- than a deploy.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE print_materials
  ADD COLUMN IF NOT EXISTS max_roll_width_mm integer;

COMMENT ON COLUMN print_materials.max_roll_width_mm IS
  'Printable roll width in mm. Enforced as min(width,height) <= this, because the long side runs along the roll. NULL = not a roll product (panels, garments). United Prints: 1600.';
