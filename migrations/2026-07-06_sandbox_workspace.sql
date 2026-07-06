-- ─────────────────────────────────────────────────────────────────────────────
-- Sandbox workspace — a PRIVATE experimentation space, visible only to the
-- super-admin (Daniel). Where new ClubOS features are built and trialled before
-- they touch a real workspace. First project inside it: the "Club Dossier" tab.
--
-- Privacy is enforced two ways:
--   1) Workspace visibility = membership. We insert exactly one user_organizations
--      row (the super_admin). No other user's /api/auth/me returns this org, so it
--      never appears in anyone else's workspace switcher.
--   2) Tab access = SUPER_ADMIN_ONLY_TABS ("club-dossier") in shared/tabs.ts +
--      requireTab on the server.
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB. Run BEFORE the deploy.
-- Idempotent: re-running does nothing.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) The workspace. organizations.id is GENERATED ALWAYS AS IDENTITY — never
--    hardcode the id; reference by slug everywhere.
INSERT INTO organizations (name, slug, active)
VALUES ('Sandbox', 'sandbox', true)
ON CONFLICT (slug) DO NOTHING;

-- 2) Membership for the super-admin(s) only (today that is Daniel alone).
--    tabs = NULL (full access); the "club-dossier" tab is still gated by
--    SUPER_ADMIN_ONLY_TABS regardless. No guaranteed unique (user,org) index
--    exists, so guard with NOT EXISTS rather than ON CONFLICT.
INSERT INTO user_organizations (user_id, organization_id, role, tabs)
SELECT u.id, o.id, 'super_admin', NULL
FROM users u
CROSS JOIN organizations o
WHERE o.slug = 'sandbox'
  AND u.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM user_organizations x
    WHERE x.user_id = u.id AND x.organization_id = o.id
  );
