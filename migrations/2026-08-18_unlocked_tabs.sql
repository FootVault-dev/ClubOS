-- ─────────────────────────────────────────────────────────────────────────────
-- UNLOCKED TABS — let a NAMED person into a locked tab, without opening it.
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-unlocked-tabs.ts --commit
--
-- The problem this solves. A tab listed in SUPER_ADMIN_ONLY_TABS is reachable
-- by exactly one person: a global super_admin. The documented way to open one
-- up is to delete its slug from that set — but `canAccessTab` returns true for
-- EVERY tab once a membership's role is `admin` or `manager`, and it never
-- consults the tabs whitelist for those roles. So "let Ryan see Vehicles" and
-- "let all eight United Sports Group admins see the staff licence numbers, a
-- staff member's home address and an FBT position" were, until this column,
-- the same action.
--
-- Why a NEW column rather than reusing `tabs`. Reusing the existing whitelist
-- looked tempting — it is already threaded everywhere — but it would have
-- silently promoted stale rows. Dima's United Sports Group membership literally
-- carries tabs = ["budget"], inert today only because "budget" is locked. The
-- moment a locked tab could be granted through `tabs`, that dormant row would
-- have handed him the club's salary data. A separate column cannot be tripped
-- by data written for another purpose, and the Team page's tab-ticking UI
-- cannot reach it, so nobody grants Budget by accident.
--
-- NULL for every existing membership, which reads as "no locked tab granted".
-- Additive, nullable, no default, no CHECK — a default here would assert a
-- permission nobody granted, and a stale CHECK is how the MFL checkout 500'd.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS unlocked_tabs jsonb;

COMMENT ON COLUMN user_organizations.unlocked_tabs IS
  'Locked tabs (SUPER_ADMIN_ONLY_TABS) this person may reach in this workspace. '
  'NULL or [] = none, which is what every membership means by default. A role '
  'never earns an entry here — it is granted per person, deliberately.';
