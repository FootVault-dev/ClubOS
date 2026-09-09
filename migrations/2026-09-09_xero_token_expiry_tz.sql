-- The Xero connection silently stopped refreshing itself.
--
-- 🔴 `token_expires_at` was `timestamp WITHOUT time zone`. A JS Date written into
-- it loses its offset, and reading it back builds a Date 12 hours out in NZ — so
-- `getXeroForOrg()` computed "expires in 11.8 hours" for a token that had died 13
-- minutes earlier, never refreshed, and every call 401'd. Found the first time a
-- post was attempted more than 30 minutes after connecting.
--
-- 🔴 The stored naive value is LOCAL, not UTC: the driver converted the JS Date
-- to local time on the way in. Converting with `AT TIME ZONE 'UTC'` moves it 12
-- hours the wrong way — which is exactly the mistake this migration was written
-- to fix, made a second time. Name the zone the value is actually in.
--
-- The one existing row is overwritten by the next token refresh either way, so
-- this only matters if the table ever holds a connection worth preserving.

ALTER TABLE org_integrations
  ALTER COLUMN token_expires_at TYPE timestamptz
  USING token_expires_at AT TIME ZONE 'Pacific/Auckland';
