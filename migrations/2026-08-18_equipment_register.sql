-- ─────────────────────────────────────────────────────────────────────────────
-- EQUIPMENT REGISTER — who is responsible for which team's gear, what they
-- hold, and their termly declaration of it.
--
-- ADDITIVE ONLY. Six new tables, nothing existing is touched.
-- Rehearse:  npx tsx --env-file=.env script/apply-equipment-register.ts --dry-run
-- Apply:     npx tsx --env-file=.env script/apply-equipment-register.ts
-- Never `db:push` against prod — it drops drifted columns.
--
-- Shaped by the 18 Aug 2026 meeting (Ryan, Travis, Daniel). The spine is a
-- HOLDER — one named person against one team — not an item catalogue with an
-- owner column. "We don't want to do it by equipment, we want to do it by team",
-- and "it should be one main person per team".
--
-- Deliberately NO CHECK constraints on `category`, `condition`, `source`,
-- `status` or `added_via`. Those value sets will grow, and a stale CHECK is how
-- the MFL checkout 500'd on registration_items_product_type_check — code
-- shipped a value the database had never heard of. They are validated
-- application-side in shared/equipment.ts.
--
-- The CHECKs that ARE here encode invariants that can never need to grow: you
-- cannot hold a negative number of footballs, and a round cannot be due before
-- it opens.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Holders ──────────────────────────────────────────────────────────────────
-- A holder is the one person answerable for one team's equipment.
--
-- `contact_id` is NULLABLE on purpose, against the house habit of "a person IS
-- a contacts row". Every coach the club employs should be in `contacts`, and
-- where they are, the holder links to them. But the register has to be
-- fillable on the afternoon Travis has the team list and before anybody has
-- reconciled it against `contacts` — and the alternative, minting a contact row
-- from a gear form, is precisely how 175 duplicate-people groups arrived in the
-- contacts table. So: link when we can, never invent a person. ON DELETE
-- RESTRICT, because deleting a staff member must not quietly erase who was
-- holding four thousand dollars of gear.
CREATE TABLE IF NOT EXISTS equipment_holders (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  team_name         text NOT NULL,
  programme         text,

  contact_id        integer REFERENCES contacts(id) ON DELETE RESTRICT,
  person_name       text NOT NULL,
  email             text NOT NULL,
  phone             text,

  storage_location  text,
  status            text NOT NULL DEFAULT 'active',

  -- Bumping this invalidates every link previously issued to this holder,
  -- without touching anybody else's. The token is derived, not stored, so this
  -- integer is the only revocation lever that does not require a secret change.
  link_version      integer NOT NULL DEFAULT 1,

  notes             text,
  created_by        integer REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT equipment_holders_link_version_positive CHECK (link_version >= 1)
);

-- 🔴 ONE ACTIVE HOLDER PER TEAM, enforced by Postgres rather than by the app
-- remembering to check. Two people responsible for the same gear is the state
-- the whole feature exists to end, and it is reachable by two staff adding a
-- coordinator at the same moment. Case-insensitive because "U9 Sparrows" and
-- "U9 sparrows" are one team.
CREATE UNIQUE INDEX IF NOT EXISTS equipment_holders_one_active_per_team_unq
  ON equipment_holders (organization_id, lower(team_name))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS equipment_holders_org_idx     ON equipment_holders (organization_id, status);
CREATE INDEX IF NOT EXISTS equipment_holders_contact_idx ON equipment_holders (contact_id);


-- ── Items ────────────────────────────────────────────────────────────────────
-- A line on a holder's list. Added by the holder themselves through their own
-- link ("Add + equipment"), or by staff on their behalf — `added_via` records
-- which, because whether coaches are actually maintaining their own lists is
-- the thing that tells us if this worked.
CREATE TABLE IF NOT EXISTS equipment_items (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  holder_id         integer NOT NULL REFERENCES equipment_holders(id) ON DELETE CASCADE,

  category          text NOT NULL DEFAULT 'other',
  name              text NOT NULL,
  quantity          integer NOT NULL DEFAULT 0,
  condition         text,
  storage_location  text,
  source            text NOT NULL DEFAULT 'unknown',
  acquired_on       date,

  added_via         text NOT NULL DEFAULT 'staff',   -- staff | holder
  notes             text,
  created_by        integer REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT equipment_items_quantity_nonneg CHECK (quantity >= 0)
);

CREATE INDEX IF NOT EXISTS equipment_items_holder_idx   ON equipment_items (holder_id, category);
CREATE INDEX IF NOT EXISTS equipment_items_org_cat_idx  ON equipment_items (organization_id, category);


-- ── Audit rounds ─────────────────────────────────────────────────────────────
-- One termly declaration cycle. Deliberately NOT a foreign key to `terms`:
-- those rows are org-scoped and exist for Christchurch United, MFL and
-- Gymnastics, while this register lives in the United Sports Group workspace
-- which has no term rows at all. An FK would force either a cross-workspace
-- reference or phantom USG terms. A round also carries dates a human chooses
-- (gear is counted in the first week of term, not on the day it starts), so it
-- is its own object that merely borrows the term's name.
CREATE TABLE IF NOT EXISTS equipment_audit_rounds (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  year             integer NOT NULL,
  term_number      integer NOT NULL,
  label            text NOT NULL,
  opens_on         date,
  due_on           date,
  status           text NOT NULL DEFAULT 'open',   -- open | closed

  notes            text,
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT equipment_rounds_term_sane CHECK (term_number BETWEEN 1 AND 4),
  CONSTRAINT equipment_rounds_dates_ordered CHECK (opens_on IS NULL OR due_on IS NULL OR due_on >= opens_on)
);

-- One round per term per workspace. Running Term 3 twice is a mistake, not a
-- workflow.
CREATE UNIQUE INDEX IF NOT EXISTS equipment_rounds_org_term_unq
  ON equipment_audit_rounds (organization_id, year, term_number);


-- ── Returns ──────────────────────────────────────────────────────────────────
-- One holder's declaration for one round. The row existing IS the submission —
-- there is no `status` column, because status is derived from this row's
-- presence and the round's due date (shared/equipment.ts). A stored status
-- would need un-setting when a due date is edited, and the thing that would
-- have to remember is a person.
--
-- `holder_id` is ON DELETE RESTRICT: a submitted count is a statement somebody
-- made on a date, and it must outlive tidying up the roster.
CREATE TABLE IF NOT EXISTS equipment_audit_returns (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  round_id           integer NOT NULL REFERENCES equipment_audit_rounds(id) ON DELETE CASCADE,
  holder_id          integer NOT NULL REFERENCES equipment_holders(id) ON DELETE RESTRICT,

  submitted_at       timestamptz,
  submitted_by_name  text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A holder declares once per round. A second submission edits the first.
CREATE UNIQUE INDEX IF NOT EXISTS equipment_returns_round_holder_unq
  ON equipment_audit_returns (round_id, holder_id);

CREATE INDEX IF NOT EXISTS equipment_returns_holder_idx ON equipment_audit_returns (holder_id);


-- ── Counts ───────────────────────────────────────────────────────────────────
-- One line of one declaration.
--
-- 🔴 `counted_quantity` IS NULLABLE AND NULL MEANS "NOT COUNTED". It does not
-- mean zero. A holder part-way through a form has not told us they lost
-- everything, and rendering that as a loss would accuse somebody of losing gear
-- on the strength of an unfinished screen.
--
-- 🔴 `quantity_before` is stored rather than recomputed. Submitting a return
-- updates the register to the counted numbers — that is the point of the audit —
-- so variance computed later against `equipment_items.quantity` would be zero
-- for every line, every time. Freezing the before-figure is what keeps
-- "twenty-two balls became eighteen" true in six months.
--
-- `item_id` is ON DELETE SET NULL and the name/category are snapshotted, so
-- deleting a retired item never blanks the history of counting it.
CREATE TABLE IF NOT EXISTS equipment_audit_counts (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_id         integer NOT NULL REFERENCES equipment_audit_returns(id) ON DELETE CASCADE,
  item_id           integer REFERENCES equipment_items(id) ON DELETE SET NULL,

  item_name         text NOT NULL,
  category          text NOT NULL DEFAULT 'other',
  quantity_before   integer,
  counted_quantity  integer,
  condition         text,
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT equipment_counts_counted_nonneg CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  CONSTRAINT equipment_counts_before_nonneg  CHECK (quantity_before  IS NULL OR quantity_before  >= 0)
);

CREATE INDEX IF NOT EXISTS equipment_counts_return_idx ON equipment_audit_counts (return_id);
CREATE INDEX IF NOT EXISTS equipment_counts_item_idx   ON equipment_audit_counts (item_id);


-- ── Reminders ────────────────────────────────────────────────────────────────
-- The whiteboard's "follow up + notify system to track completion". Append-only
-- in practice: who was chased, when, at what address, by whom. Without it,
-- "have we asked them?" is answered from memory.
CREATE TABLE IF NOT EXISTS equipment_audit_reminders (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  round_id         integer NOT NULL REFERENCES equipment_audit_rounds(id) ON DELETE CASCADE,
  holder_id        integer NOT NULL REFERENCES equipment_holders(id) ON DELETE CASCADE,

  sent_at          timestamptz NOT NULL DEFAULT now(),
  sent_to_email    text NOT NULL,
  sent_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  channel          text NOT NULL DEFAULT 'email',
  -- false records an attempt that failed to leave the building. A reminder that
  -- silently did not send is worse than none, because it reads as chased.
  delivered        boolean NOT NULL DEFAULT true,
  error            text
);

CREATE INDEX IF NOT EXISTS equipment_reminders_round_idx  ON equipment_audit_reminders (round_id, holder_id);


-- ── RLS ──────────────────────────────────────────────────────────────────────
-- New tables default to RLS OFF, and a Supabase anon key is public by design.
-- The app connects as postgres/service-role (rolbypassrls), so this changes
-- nothing for us — it is the second wall that catches a leaked key.
ALTER TABLE equipment_holders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_audit_rounds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_audit_returns    ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_audit_counts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_audit_reminders  ENABLE ROW LEVEL SECURITY;
