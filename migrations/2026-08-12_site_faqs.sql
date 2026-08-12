-- ─────────────────────────────────────────────────────────────────────────────
-- Site FAQs — the questions on a brand's website and in its live-chat widget
--
-- Both lists were hardcoded in the website repo (site.ts FAQ.items for the page,
-- chatConfig.faqs for the widget), so answering a new question or fixing a typo
-- meant a code edit and a deploy. Dima owns them now.
--
-- Brand-keyed, not print-only: the live-chat widget is already brand-agnostic,
-- so CIC/MFL/CUGC can adopt this with no schema change.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS site_faqs (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Matches the CHAT_BRANDS key so the widget and the site ask for one list.
  brand_key          text NOT NULL,

  question           text NOT NULL,
  answer             text NOT NULL,

  -- Two switches, because the surfaces want different lengths: the website
  -- answers are long and detailed, the chat answers have to be short.
  show_on_website    boolean NOT NULL DEFAULT true,
  show_in_chat       boolean NOT NULL DEFAULT true,

  is_active          boolean NOT NULL DEFAULT true,
  display_order      integer NOT NULL DEFAULT 0,

  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_faqs_brand_idx
  ON site_faqs (brand_key, display_order)
  WHERE is_active = true;

-- 🔴 New tables default to RLS OFF and a Supabase anon key is public by design.
ALTER TABLE site_faqs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE site_faqs IS
  'FAQs for a brand website + its live-chat widget. Edited in ClubOS → (workspace) → FAQs; served publicly by GET /api/public/faqs/:brandKey.';
