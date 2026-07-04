-- Public membership signup + payment — extra columns on members for the
-- self-serve join flow (embedded Stripe). ADDITIVE ONLY.
ALTER TABLE members ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS source TEXT;               -- 'public_signup' | 'admin' | ...
ALTER TABLE members ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
