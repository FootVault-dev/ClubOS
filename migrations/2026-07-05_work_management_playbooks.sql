-- ─────────────────────────────────────────────────────────────────────────────
-- Work Management System — Phase 2: event Playbooks (task templates) with
-- backward planning.
--
-- A Playbook is a reusable checklist for a recurring event (run a tournament,
-- launch a league term, onboard a sponsor). Applying it to an anchor date
-- generates real tasks whose due dates = anchor_date + offset_days
-- (negative = before the event → prep; 0 = event day; positive = wrap-up).
-- So the prep back-plans itself and nothing lands last-minute.
--
-- Additive only. Safe to run against the live app (new tables + seed rows;
-- seeds are idempotent via NOT EXISTS guards keyed on org + name).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_templates (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  anchor_label    text NOT NULL DEFAULT 'Event day',
  department_id   integer REFERENCES departments(id) ON DELETE SET NULL,
  brand_tags      text[] NOT NULL DEFAULT ARRAY[]::text[],
  color           text NOT NULL DEFAULT '#3b82f6',
  archived        boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 0,
  created_by      integer REFERENCES users(id),
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_template_items (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id   integer NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  -- Days relative to the anchor date. Negative = before the event.
  offset_days   integer NOT NULL DEFAULT 0,
  priority      task_priority NOT NULL DEFAULT 'medium',
  department_id integer REFERENCES departments(id) ON DELETE SET NULL,
  brand_tags    text[] NOT NULL DEFAULT ARRAY[]::text[],
  next_step     text,
  sort_order    integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS task_template_items_template_idx ON task_template_items(template_id);

-- ── Seed 3 starter Playbooks for United Sports Group ─────────────────────────
-- Idempotent: each block only inserts if a template of that name doesn't already
-- exist for the org. Departments are resolved by slug (created in the phase-1
-- migration); a missing match just leaves department_id NULL (still valid).
DO $$
DECLARE
  v_org        integer;
  v_tpl        integer;
  d_events     integer;
  d_marketing  integer;
  d_commercial integer;
  d_football   integer;
  d_facilities integer;
  d_finance    integer;
BEGIN
  SELECT id INTO v_org FROM organizations WHERE slug = 'united-sports-group' LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'united-sports-group org not found — skipping playbook seed';
    RETURN;
  END IF;

  SELECT id INTO d_events     FROM departments WHERE organization_id = v_org AND slug = 'events' LIMIT 1;
  SELECT id INTO d_marketing  FROM departments WHERE organization_id = v_org AND slug = 'marketing' LIMIT 1;
  SELECT id INTO d_commercial FROM departments WHERE organization_id = v_org AND slug = 'commercial' LIMIT 1;
  SELECT id INTO d_football   FROM departments WHERE organization_id = v_org AND slug = 'football-ops' LIMIT 1;
  SELECT id INTO d_facilities FROM departments WHERE organization_id = v_org AND slug = 'facilities' LIMIT 1;
  SELECT id INTO d_finance    FROM departments WHERE organization_id = v_org AND slug = 'finance' LIMIT 1;

  -- ── Playbook 1: Run a tournament (CIC) ──────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM task_templates WHERE organization_id = v_org AND name = 'Run a tournament') THEN
    INSERT INTO task_templates (organization_id, name, description, anchor_label, department_id, brand_tags, color, sort_order)
    VALUES (v_org, 'Run a tournament', 'Everything to deliver a tournament — from open registrations to the post-event wrap. Anchor = tournament day.', 'Tournament day', d_events, ARRAY['cic']::text[], '#a855f7', 0)
    RETURNING id INTO v_tpl;
    INSERT INTO task_template_items (template_id, title, offset_days, priority, department_id, brand_tags, next_step, sort_order) VALUES
      (v_tpl, 'Confirm dates, venue & field allocation',            -90, 'high',   d_events,     ARRAY['cic']::text[], 'Lock the date with facilities', 0),
      (v_tpl, 'Open registrations & publish the entry page',        -75, 'high',   d_events,     ARRAY['cic']::text[], 'Registration link live',        1),
      (v_tpl, 'Confirm tournament sponsors & signage',              -60, 'medium', d_commercial, ARRAY['cic','sponsorship']::text[], 'Sponsor pack out', 2),
      (v_tpl, 'Launch marketing push (socials, EDM, ads)',          -45, 'high',   d_marketing,  ARRAY['cic']::text[], 'First campaign scheduled',      3),
      (v_tpl, 'Order kit, medals, trophies & merchandise',          -35, 'medium', d_events,     ARRAY['cic']::text[], 'Purchase orders sent',          4),
      (v_tpl, 'Referees, volunteers & staff roster confirmed',      -21, 'high',   d_football,   ARRAY['cic']::text[], 'Roster filled',                 5),
      (v_tpl, 'Build the draw & publish fixtures',                  -14, 'high',   d_events,     ARRAY['cic']::text[], 'Fixtures published',            6),
      (v_tpl, 'Final headcount, catering & food-truck confirm',     -10, 'medium', d_facilities, ARRAY['cic']::text[], 'Vendors confirmed',             7),
      (v_tpl, 'Print run sheets, signage & site map',               -5,  'medium', d_events,     ARRAY['cic']::text[], 'Run sheet approved',            8),
      (v_tpl, 'Site setup, line-marking & equipment check',         -1,  'high',   d_facilities, ARRAY['cic']::text[], 'Site walked & signed off',      9),
      (v_tpl, 'Tournament day — deliver',                            0,   'urgent', d_events,     ARRAY['cic']::text[], NULL,                            10),
      (v_tpl, 'Pack down & venue reset',                            1,   'medium', d_facilities, ARRAY['cic']::text[], 'Venue handed back',             11),
      (v_tpl, 'Send thank-yous, results & photo gallery',           3,   'medium', d_marketing,  ARRAY['cic']::text[], 'Recap sent',                    12),
      (v_tpl, 'Reconcile finances & sponsor delivery report',       10,  'medium', d_finance,    ARRAY['cic','sponsorship']::text[], 'P&L closed',       13);
  END IF;

  -- ── Playbook 2: Launch a league term (MFL) ──────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM task_templates WHERE organization_id = v_org AND name = 'Launch a league term') THEN
    INSERT INTO task_templates (organization_id, name, description, anchor_label, department_id, brand_tags, color, sort_order)
    VALUES (v_org, 'Launch a league term', 'Open, fill and kick off a new Mini Football League term. Anchor = first game day.', 'First game day', d_football, ARRAY['mfl']::text[], '#06b6d4', 1)
    RETURNING id INTO v_tpl;
    INSERT INTO task_template_items (template_id, title, offset_days, priority, department_id, brand_tags, next_step, sort_order) VALUES
      (v_tpl, 'Set term dates, pricing & capacity',                -56, 'high',   d_football,   ARRAY['mfl']::text[], 'Dates & price locked',    0),
      (v_tpl, 'Open registrations & deposit-weekly checkout',      -49, 'high',   d_football,   ARRAY['mfl']::text[], 'Registration live',       1),
      (v_tpl, 'Re-engage last term''s teams (retention push)',     -42, 'high',   d_marketing,  ARRAY['mfl']::text[], 'Returning-team EDM out',  2),
      (v_tpl, 'Run acquisition ads for new teams',                 -35, 'high',   d_marketing,  ARRAY['mfl']::text[], 'Ad set live',             3),
      (v_tpl, 'Monitor fill & trigger waitlist / scarcity',        -21, 'medium', d_football,   ARRAY['mfl']::text[], 'Fill on track',           4),
      (v_tpl, 'Confirm referees & venue blocks',                   -14, 'high',   d_football,   ARRAY['mfl']::text[], 'Refs & venue booked',     5),
      (v_tpl, 'Build the draw & publish the schedule',             -7,  'high',   d_football,   ARRAY['mfl']::text[], 'Schedule published',      6),
      (v_tpl, 'Send welcome pack & week-1 kick-off details',       -3,  'medium', d_marketing,  ARRAY['mfl']::text[], 'Welcome email sent',      7),
      (v_tpl, 'First game day — kick off',                          0,   'urgent', d_football,   ARRAY['mfl']::text[], NULL,                      8),
      (v_tpl, 'Week-1 review & chase incomplete payments',         3,   'medium', d_finance,    ARRAY['mfl']::text[], 'Payments reconciled',     9);
  END IF;

  -- ── Playbook 3: Onboard a new sponsor ───────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM task_templates WHERE organization_id = v_org AND name = 'Onboard a new sponsor') THEN
    INSERT INTO task_templates (organization_id, name, description, anchor_label, department_id, brand_tags, color, sort_order)
    VALUES (v_org, 'Onboard a new sponsor', 'From signed deal to a delivering, happy sponsor. Anchor = deal signed date.', 'Deal signed', d_commercial, ARRAY['sponsorship']::text[], '#ef4444', 2)
    RETURNING id INTO v_tpl;
    INSERT INTO task_template_items (template_id, title, offset_days, priority, department_id, brand_tags, next_step, sort_order) VALUES
      (v_tpl, 'Countersign contract & file agreement',             0,  'high',   d_commercial, ARRAY['sponsorship']::text[], 'Contract filed',          0),
      (v_tpl, 'Raise invoice & confirm payment terms',             1,  'high',   d_finance,    ARRAY['sponsorship']::text[], 'Invoice sent',            1),
      (v_tpl, 'Welcome call & collect brand assets',               3,  'medium', d_commercial, ARRAY['sponsorship']::text[], 'Assets received',         2),
      (v_tpl, 'Deliver signage, digital & activation assets',      14, 'high',   d_marketing,  ARRAY['sponsorship']::text[], 'Deliverables live',       3),
      (v_tpl, 'Publish announcement across channels',              21, 'medium', d_marketing,  ARRAY['sponsorship']::text[], 'Announcement posted',     4),
      (v_tpl, 'First delivery report to sponsor',                  45, 'medium', d_commercial, ARRAY['sponsorship']::text[], 'Report sent',             5),
      (v_tpl, 'Mid-term check-in & upsell conversation',           90, 'medium', d_commercial, ARRAY['sponsorship']::text[], 'Check-in booked',         6);
  END IF;
END $$;
