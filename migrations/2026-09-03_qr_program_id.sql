-- QR Code Generator: remember which programme a tracked link/QR was built for.
--
-- Additive and nullable, with no default and no backfill: the 7 links that
-- already exist (Dima's three instant-quote codes, the 860-click field-hire
-- one, the three technification ones) keep working untouched and simply read
-- "no programme". A default would assert a fact about a link nobody recorded.
--
-- ON DELETE SET NULL, never CASCADE: retiring a programme must not delete a
-- poster's tracking history along with it. The link keeps its clicks.
ALTER TABLE short_links
  ADD COLUMN IF NOT EXISTS program_id integer REFERENCES programs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS short_links_program_idx ON short_links (program_id) WHERE program_id IS NOT NULL;
