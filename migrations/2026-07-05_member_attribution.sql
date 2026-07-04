-- Attribution capture on members (parity with registrations): UTM + fbclid from
-- the landing URL + a "how did you hear about us" answer. ADDITIVE ONLY.
ALTER TABLE members ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS fbclid TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS referral_source TEXT;
