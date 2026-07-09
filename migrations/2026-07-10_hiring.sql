-- ─────────────────────────────────────────────────────────────────────────────
-- Hiring — job postings and the people who apply to them.
--
-- The careers engine behind every brand site's job adverts. A job is owned by
-- the workspace that MANAGES the hiring (organization_id — United Sports Group
-- recruits for the group) and advertised under a public `brand` key, which is
-- what that brand's website posts to. One Hiring tab therefore runs recruitment
-- for every brand without each brand needing its own tab.
--
-- Named hiring_* on purpose: bare `jobs` already means print-production jobs in
-- this schema, and bare `applications` already means grant applications and
-- Football Institute enrolment applications.
--
-- Deliberately NOT the volunteers tables. A volunteer signs up once as a person
-- and is rostered onto task-types by day; an applicant applies to one specific
-- posting and moves through a selection pipeline for it.
--
-- ADDITIVE ONLY — safe on the live DB. CREATE TABLE / CREATE INDEX IF NOT
-- EXISTS only, no drops, no enums (statuses are validated in the app to dodge
-- prod enum-drift). Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS hiring_jobs (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand            text NOT NULL,                       -- cufc | mfl | cic | cugc | unitedprints | siu
  slug             text NOT NULL,                       -- url-safe, unique within a brand
  title            text NOT NULL,
  tagline          text,
  description      text,
  employment_type  text,
  positions        integer NOT NULL DEFAULT 1,
  pay_label        text,                                -- free text; pay is not always a number
  location         text,
  status           text NOT NULL DEFAULT 'draft',       -- draft | open | closed
  closes_at        timestamptz,
  advert_url       text,
  notify_email     text,
  questions        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,label,type,required?,help?,options?,…}]
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hiring_jobs_brand_slug_unq ON hiring_jobs (brand, slug);
CREATE INDEX IF NOT EXISTS hiring_jobs_org_idx ON hiring_jobs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hiring_applications (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id                 integer NOT NULL REFERENCES hiring_jobs(id) ON DELETE CASCADE,
  organization_id        integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  first_name             text NOT NULL,
  last_name              text,
  email                  text NOT NULL,
  phone                  text NOT NULL,                 -- phone is mandatory on every form we run
  date_of_birth          date,
  city                   text,

  -- Decided server-side from date_of_birth, never trusted from the browser.
  guardian_required      boolean NOT NULL DEFAULT false,
  guardian_name          text,
  guardian_relationship  text,
  guardian_email         text,
  guardian_phone         text,
  guardian_consent       boolean NOT NULL DEFAULT false,

  answers                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- keyed by question id

  -- The audition: a pasted link, an uploaded file in object storage, or both.
  -- audition_object_path is private and only streamed back through the
  -- tab-gated admin endpoint, never the public /objects/ ACL route.
  audition_url           text,
  audition_object_path   text,
  audition_filename      text,
  audition_mime          text,
  audition_bytes         integer,

  status                 text NOT NULL DEFAULT 'new',   -- new|reviewing|shortlisted|trial|offered|hired|declined|withdrawn
  rating                 integer,                       -- 1–5
  reviewer_notes         text,
  reviewed_by            integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at             timestamptz,

  consent_contact        boolean NOT NULL DEFAULT false,
  consent_broadcast      boolean NOT NULL DEFAULT false,
  right_to_work          boolean NOT NULL DEFAULT false,

  source_url             text,
  user_agent             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hiring_applications_job_idx ON hiring_applications (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hiring_applications_org_idx ON hiring_applications (organization_id, created_at DESC);

-- One application per email per job. A second attempt is a friendly 409, never
-- a duplicate row a reviewer has to reconcile by hand.
CREATE UNIQUE INDEX IF NOT EXISTS hiring_applications_job_email_unq ON hiring_applications (job_id, email);

COMMIT;
