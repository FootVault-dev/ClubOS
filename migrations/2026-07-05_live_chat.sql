-- ─────────────────────────────────────────────────────────────────────────────
-- Live Chat — the reusable Intercom-style chat widget on the brand marketing
-- sites (cicyouth.com first; reusable across MFL / CUGC / USG). A conversation is
-- a threaded exchange between a website visitor and staff, scoped to an org, and
-- managed in ClubOS → (workspace) → Live Chat. Distinct from inbox_messages
-- (one-shot contact forms).
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB (two new tables +
-- indexes). Run BEFORE the Fly deploy. See reference_clubos_prod_db_drift.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_conversations (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token            text NOT NULL,
  brand_key        text,
  visitor_name     text,
  visitor_email    text,
  visitor_phone    text,
  status           text NOT NULL DEFAULT 'open',
  source_url       text,
  user_agent       text,
  agent_unread     integer NOT NULL DEFAULT 0,
  visitor_unread   integer NOT NULL DEFAULT 0,
  last_visitor_at  timestamp,
  last_agent_at    timestamp,
  last_message_at  timestamp NOT NULL DEFAULT now(),
  created_at       timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_conv_token_unq      ON chat_conversations(token);
CREATE INDEX        IF NOT EXISTS chat_conv_org_recent_idx ON chat_conversations(organization_id, last_message_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id  integer NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender           text NOT NULL,           -- 'visitor' | 'agent' | 'system'
  author_name      text,
  author_user_id   integer REFERENCES users(id),
  body             text NOT NULL,
  created_at       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_msg_conv_idx ON chat_messages(conversation_id, id);
