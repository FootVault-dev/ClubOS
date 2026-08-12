-- ─────────────────────────────────────────────────────────────────────────────
-- Knowledge Base — the club's vault, and Rambo, the assistant that reads it.
--
-- The problem it removes: every specification the club depends on lives in one
-- person's head. What size a banner can physically print, which file format the
-- shop needs, what bleed to leave — all of it is a message to Dima, and the
-- answer arrives when Dima is free. The same is true of every other brand's
-- know-how. This is the shared, searchable place that knowledge goes.
--
-- Deliberately NOT org-scoped, like staff_chat / feature_requests / tt_*: a
-- universal tab in every workspace. Brand is a TAG on the article, so "United
-- Prints knowledge" is a filter over one set of rows rather than eight copies
-- of a table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS kb_articles (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  -- 'all' or a KB_BRANDS key (cufc | siu | mfl | cic | cugc | prints | usc | usg).
  -- Free text, not an enum: a stale CHECK constraint in prod is how the MFL
  -- checkout 500'd. Validation lives in the app where it can be changed.
  brand             text NOT NULL DEFAULT 'all',
  category          text,

  title             text NOT NULL,
  summary           text,
  body              text NOT NULL DEFAULT '',

  -- Extra search terms the author knows people will type but the body may not
  -- contain ("bleed", "banner size", "1.6m"). Boosts retrieval for Rambo.
  keywords          text[] NOT NULL DEFAULT '{}',

  status            text NOT NULL DEFAULT 'draft',   -- draft | published | archived

  -- 🔴 The visibility rule, and the only one. NULL = every staff member may
  -- read it, which is the normal case: how we print a banner is not a secret.
  -- Set it to a ClubOS tab slug and the article becomes readable only by people
  -- who can reach that tab — the SAME decider Rambo's stat tools use
  -- (shared/knowledge-base.ts → viewerCanReachTab). One rule, two surfaces, so
  -- a document can never be more open than the tab its contents came from.
  required_tab       text,
  required_workspace text,   -- org slug to judge required_tab in; NULL = any of theirs

  -- Who owns the accuracy of this article. RESTRICT would block deleting a
  -- staff account over a wiki page, so SET NULL — but the UI reads a null owner
  -- as "unowned", never as "nobody needs to maintain this".
  owner_user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  created_by        integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by        integer REFERENCES users(id) ON DELETE SET NULL,

  view_count        integer NOT NULL DEFAULT 0,

  -- When the facts in here were last confirmed true by a human. Distinct from
  -- updated_at, which a typo fix moves. A spec nobody has re-confirmed in a
  -- year is not wrong, but it is worth flagging, and only a person can say.
  verified_at       timestamp,
  verified_by       integer REFERENCES users(id) ON DELETE SET NULL,

  published_at      timestamp,
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_articles_brand_status_idx
  ON kb_articles (brand, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles (category);
CREATE INDEX IF NOT EXISTS kb_articles_title_trgm_idx
  ON kb_articles USING gin (lower(title) gin_trgm_ops);
-- 🔴 keywords is deliberately NOT in this expression: array_to_string() is
-- STABLE, not IMMUTABLE, and Postgres refuses it in an index expression. The
-- keyword column gets its own array GIN index below, and the search query is
-- written to match THIS expression exactly — an index the query can't use is
-- just a slower write for nothing.
CREATE INDEX IF NOT EXISTS kb_articles_fts_idx
  ON kb_articles USING gin (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(body,''))
  );
CREATE INDEX IF NOT EXISTS kb_articles_keywords_idx ON kb_articles USING gin (keywords);

-- Every edit kept. A print specification that changed is a thing you need to be
-- able to trace: "it used to say 1.5m" is a real question with a real answer.
CREATE TABLE IF NOT EXISTS kb_article_revisions (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  article_id   integer NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  title        text NOT NULL,
  summary      text,
  body         text NOT NULL DEFAULT '',
  edited_by    integer REFERENCES users(id) ON DELETE SET NULL,
  edit_note    text,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_article_revisions_article_idx
  ON kb_article_revisions (article_id, created_at DESC);

-- ── Rambo ───────────────────────────────────────────────────────────────────
-- A person's conversations. CASCADE on the user: these are someone's private
-- working notes with an assistant, not a club record. The thing that must
-- outlive the account is the access log below.
CREATE TABLE IF NOT EXISTS kb_chat_sessions (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand        text NOT NULL DEFAULT 'all',
  title        text,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_chat_sessions_user_idx
  ON kb_chat_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_chat_messages (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  session_id   integer NOT NULL REFERENCES kb_chat_sessions(id) ON DELETE CASCADE,
  role         text NOT NULL,                       -- user | assistant
  content      text NOT NULL DEFAULT '',
  -- Which tools actually ran, and which articles the answer came from. Shown
  -- under the reply so a person can check Rambo against the source rather than
  -- taking its word — the same reason the market-research corpus cites URLs.
  tools_used   jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_chat_messages_session_idx
  ON kb_chat_messages (session_id, created_at);

-- The security audit: which tool ran, for whom, and whether it was allowed.
--
-- ⚠️ Read `allowed = false` correctly. A refusal is logged only if a tool is
-- CALLED and rejected — and because a tool the person can't use is never handed
-- to the model, that path is the unreachable second wall. In normal operation
-- this table is all grants, and an empty denied-list means the design is
-- working, NOT that nobody has asked. Someone repeatedly fishing for budget
-- figures shows up in kb_chat_messages (their questions are all stored), not
-- here. Don't build a "suspicious activity" report on this column alone.
--
-- SET NULL on the user so deleting an account cannot erase the trail.
CREATE TABLE IF NOT EXISTS kb_access_log (
  id            integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id       integer REFERENCES users(id) ON DELETE SET NULL,
  user_label    text,                -- name captured at the time, survives deletion
  tool_name     text NOT NULL,
  allowed       boolean NOT NULL,
  reason        text,
  brand         text,
  question      text,                -- the asking message, truncated
  created_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_access_log_created_idx ON kb_access_log (created_at DESC);
CREATE INDEX IF NOT EXISTS kb_access_log_denied_idx
  ON kb_access_log (user_id, created_at DESC) WHERE allowed = false;

-- 🔴 New tables default to RLS OFF and a Supabase anon key is public by design.
-- Our connections are postgres/service-role (rolbypassrls), so this changes
-- nothing for the app — it is the second wall that catches a leaked key.
ALTER TABLE kb_articles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article_revisions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chat_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_access_log         ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE kb_articles IS
  'Knowledge Base articles — the club vault. Universal tab in every workspace; brand is a tag, not an owner. required_tab gates a sensitive article behind the same ClubOS tab its contents came from.';
COMMENT ON TABLE kb_access_log IS
  'Rambo tool-access audit: which tool ran, for whom, allowed or not. allowed=false is the unreachable second wall (restricted tools are never offered to the model), so an empty denied-list means the design works, not that nobody asked. Questions live in kb_chat_messages.';
