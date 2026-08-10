-- Who may send money back to a customer's card.
--
-- Additive, one column, default false. Nobody gains the ability to refund by
-- this migration running — the grant is a separate, deliberate act per person.
--
-- Deliberately NOT derived from `users.role`: `canAccessTab` gives an
-- admin/manager member every tab in a workspace they belong to, and the role
-- column defaults to 'coach' (which public fan signups receive). Neither is a
-- safe proxy for "may move money".

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_issue_refunds boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.can_issue_refunds IS
  'May issue Stripe refunds against registrations. Per-person, never role-derived. Granted in /admin/team by a super admin.';

COMMIT;
