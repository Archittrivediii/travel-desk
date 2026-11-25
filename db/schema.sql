-- Travel Desk schema (PostgreSQL 12 or newer)
CREATE SEQUENCE IF NOT EXISTS trip_seq START 14;
CREATE SEQUENCE IF NOT EXISTS expense_seq START 104;

CREATE TABLE IF NOT EXISTS users (
  id     text PRIMARY KEY,
  code   text NOT NULL UNIQUE,
  name   text NOT NULL,
  role   text NOT NULL CHECK (role IN ('employee','manager','admin')),  -- manager = HOD, admin = finance
  grade  text NOT NULL,
  dept   text NOT NULL,
  desig  text NOT NULL DEFAULT '',
  password_hash text,                              -- scrypt hash, never the password itself
  must_change   boolean NOT NULL DEFAULT false     -- true until the user sets their own password
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,                     -- sha256 of the cookie value
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS policy (
  grade  text PRIMARY KEY,
  cls    integer NOT NULL CHECK (cls BETWEEN 0 AND 2),   -- 0 Economy, 1 Premium Economy, 2 Business
  hotel  numeric NOT NULL CHECK (hotel >= 0),            -- hotel cap per night, INR
  da     numeric NOT NULL CHECK (da >= 0)                -- daily allowance, INR
);

CREATE TABLE IF NOT EXISTS budgets (
  dept    text PRIMARY KEY,
  amount  numeric NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS trips (
  id         text PRIMARY KEY DEFAULT ('TR-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('trip_seq')::text, 3, '0')),
  emp        text NOT NULL REFERENCES users(id),
  from_city  text NOT NULL,
  to_city    text NOT NULL,
  dep        date NOT NULL,
  ret        date NOT NULL,
  purpose    text NOT NULL,
  cls        integer NOT NULL CHECK (cls BETWEEN 0 AND 2),
  fare       numeric NOT NULL CHECK (fare >= 0),
  hotel      numeric NOT NULL CHECK (hotel >= 0),
  status     text NOT NULL CHECK (status IN ('Pending manager','Pending finance','Approved','Rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ret >= dep)
);
CREATE INDEX IF NOT EXISTS trips_emp_idx ON trips (emp);
CREATE INDEX IF NOT EXISTS trips_status_idx ON trips (status);

CREATE TABLE IF NOT EXISTS expenses (
  id         text PRIMARY KEY DEFAULT ('EX-' || nextval('expense_seq')::text),
  emp        text NOT NULL REFERENCES users(id),
  trip_id    text REFERENCES trips(id),
  section    text NOT NULL,                 -- Travel Mode, Stay, Food, DA, Misc.
  mode       text NOT NULL,
  d_from     date NOT NULL,
  d_to       date NOT NULL,
  from_loc   text NOT NULL DEFAULT '',
  to_loc     text NOT NULL DEFAULT '',
  city       text NOT NULL DEFAULT '',
  qty        numeric,
  rate       numeric,
  amt        numeric NOT NULL CHECK (amt > 0),
  cur        text NOT NULL DEFAULT 'INR',
  note       text NOT NULL DEFAULT '',
  region     text NOT NULL DEFAULT 'dom' CHECK (region IN ('dom','intl')),
  status     text NOT NULL CHECK (status IN ('Draft','Pending HOD','Approved','Rejected','Reimbursed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (d_to >= d_from)
);
CREATE INDEX IF NOT EXISTS expenses_emp_status_idx ON expenses (emp, status);
CREATE INDEX IF NOT EXISTS expenses_status_idx ON expenses (status);

-- Manager e-mail ids (shown on the final submission screen).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS l4_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS l5_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS l6_email text;

-- One travel request (claim) groups the expense rows, the task/action notes, the manager e-mail ids and the invoices.
CREATE SEQUENCE IF NOT EXISTS claim_seq START 1;
CREATE TABLE IF NOT EXISTS claims (
  id           text PRIMARY KEY DEFAULT ('TRAV' || to_char(now(), 'YY') || '-' || lpad(nextval('claim_seq')::text, 4, '0')),
  emp          text NOT NULL REFERENCES users(id),
  purpose      text NOT NULL DEFAULT '',
  planned      text NOT NULL DEFAULT '',
  action       text NOT NULL DEFAULT '',
  pending      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);
CREATE INDEX IF NOT EXISTS claims_emp_idx ON claims (emp);
CREATE TABLE IF NOT EXISTS claim_files (
  id         bigserial PRIMARY KEY,
  claim_id   text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  name       text NOT NULL,
  mime       text NOT NULL,
  size       integer NOT NULL,
  data       text NOT NULL,            -- file content, base64
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_files_claim_idx ON claim_files (claim_id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS claim_id text REFERENCES claims(id) ON DELETE SET NULL;

-- Approver e-mail ids of a travel request: one row per level (1 = L1 Manager ... 6 = L6 Manager).
CREATE TABLE IF NOT EXISTS claim_approvers (
  claim_id text     NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  level    smallint NOT NULL CHECK (level BETWEEN 1 AND 6),
  email    text     NOT NULL,
  PRIMARY KEY (claim_id, level)
);

-- Older databases kept the six e-mail ids as columns on claims: copy them over, then drop the columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'claims' AND column_name = 'l1') THEN
    INSERT INTO claim_approvers (claim_id, level, email)
      SELECT id, 1, l1 FROM claims WHERE l1 <> '' UNION ALL SELECT id, 2, l2 FROM claims WHERE l2 <> ''
      UNION ALL SELECT id, 3, l3 FROM claims WHERE l3 <> '' UNION ALL SELECT id, 4, l4 FROM claims WHERE l4 <> ''
      UNION ALL SELECT id, 5, l5 FROM claims WHERE l5 <> '' UNION ALL SELECT id, 6, l6 FROM claims WHERE l6 <> ''
      ON CONFLICT DO NOTHING;
    ALTER TABLE claims DROP COLUMN l1, DROP COLUMN l2, DROP COLUMN l3, DROP COLUMN l4, DROP COLUMN l5, DROP COLUMN l6;
  END IF;
END $$;

-- Advance taken against a trip request (INR).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS advance numeric NOT NULL DEFAULT 0 CHECK (advance >= 0);

-- Approval chain: each level approves in turn (L1, L2, ... L6). Status, date and remarks are kept per level.
ALTER TABLE claim_approvers ADD COLUMN IF NOT EXISTS status   text NOT NULL DEFAULT 'Pending';
ALTER TABLE claim_approvers ADD COLUMN IF NOT EXISTS acted_at timestamptz;
ALTER TABLE claim_approvers ADD COLUMN IF NOT EXISTS remarks  text NOT NULL DEFAULT '';

-- Every notification e-mail Travel Desk tries to send, and how it went.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         bigserial PRIMARY KEY,
  claim_id   text,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'Queued',   -- Queued, Sent, Failed, Not configured
  error      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX IF NOT EXISTS mail_outbox_claim_idx ON mail_outbox (claim_id);

-- Default L4, L5 and L6 managers for every employee (new employees get them automatically).
ALTER TABLE users ALTER COLUMN l4_email SET DEFAULT 'anurag@saritahanda.com';
ALTER TABLE users ALTER COLUMN l5_email SET DEFAULT 'soniignatius@she-in.com';
ALTER TABLE users ALTER COLUMN l6_email SET DEFAULT 'ashokyadav@saritahanda.com';
CREATE TABLE IF NOT EXISTS app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
-- Runs once: gives the existing employees those defaults. Later edits to a user's L4-L6 are kept.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'default-managers-l4-l6') THEN
    UPDATE users SET l4_email = 'anurag@saritahanda.com', l5_email = 'soniignatius@she-in.com', l6_email = 'ashokyadav@saritahanda.com';
    INSERT INTO app_migrations (name) VALUES ('default-managers-l4-l6');
  END IF;
END $$;

-- ===== Performance management (PMS) =====
-- Who reports to whom, plus the profile fields shown on the appraisal form.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reporting_to text REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS doj date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cur_role text;

CREATE SEQUENCE IF NOT EXISTS pms_seq START 1;
CREATE TABLE IF NOT EXISTS pms_appraisals (
  id         text PRIMARY KEY,                     -- e.g. PMS26-27-0001
  emp        text NOT NULL REFERENCES users(id),
  type       text NOT NULL DEFAULT 'Annual Appraisal',
  year       text NOT NULL,                        -- e.g. 2025-26
  status     text NOT NULL DEFAULT 'Draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emp, type, year)
);
-- Page 1: one row per Key Result Area (quantitative goal).
CREATE TABLE IF NOT EXISTS pms_kras (
  id           bigserial PRIMARY KEY,
  appraisal_id text NOT NULL REFERENCES pms_appraisals(id) ON DELETE CASCADE,
  sno          integer NOT NULL,
  kra          text NOT NULL DEFAULT '',           -- (B) Key Result Area
  source       text NOT NULL DEFAULT '',           -- (C) Source
  threshold    numeric NOT NULL DEFAULT 80,        -- (D) % achievement below which the score is zero
  target       numeric,                            -- (E) Planned achievement / target
  weight       numeric NOT NULL DEFAULT 0,         -- (F) Weightage, total = 100
  timeline     text NOT NULL DEFAULT 'Ongoing',    -- (G) Monthly / Daily / H1 / H2 / Yearly / Ongoing
  self_ach     numeric,                            -- (H) Actual self rating (achievement as per appraisee)
  mgr_ach      numeric,                            -- (I) Actual manager rating (achievement as per appraiser)
  remarks      text NOT NULL DEFAULT ''            -- (L) Specific remarks
);
CREATE INDEX IF NOT EXISTS pms_kras_appraisal_idx ON pms_kras (appraisal_id, sno);

-- The PMS number belongs to an employee and a year, and is shared by Setting New KRA, Mid Year and Annual.
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cycle_no text;
UPDATE pms_appraisals a SET cycle_no = (SELECT min(b.id) FROM pms_appraisals b WHERE b.emp = a.emp AND b.year = a.year) WHERE a.cycle_no IS NULL;
CREATE INDEX IF NOT EXISTS pms_appraisals_emp_year_idx ON pms_appraisals (emp, year);

-- PMS Page 2 (values assessment): the master list of attributes can be edited by the admin at any time.
-- Every appraisal keeps its own copy of the list (pms_value_rows) so that old appraisals do not change.
CREATE TABLE IF NOT EXISTS pms_settings (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS pms_value_master (
  id    serial PRIMARY KEY,
  ord   int  NOT NULL,
  lvl   int  NOT NULL CHECK (lvl IN (1, 2, 3)),   -- 1 = main value, 2 = sub heading, 3 = behaviour line
  code  text NOT NULL DEFAULT '',
  label text NOT NULL,
  marks numeric CHECK (marks IS NULL OR marks >= 0)  -- empty = heading only, nothing to rate
);
CREATE TABLE IF NOT EXISTS pms_value_rows (
  id           bigserial PRIMARY KEY,
  appraisal_id text NOT NULL REFERENCES pms_appraisals(id) ON DELETE CASCADE,
  ord          int  NOT NULL,
  lvl          int  NOT NULL,
  code         text NOT NULL DEFAULT '',
  label        text NOT NULL,
  marks        numeric,
  self_ach     numeric,
  mgr_ach      numeric,
  remarks      text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS pms_value_rows_idx ON pms_value_rows (appraisal_id, ord);
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS values_weight numeric;
DO $$
BEGIN
  -- One time: the list of attributes as per the appraisal form (version 2). After this the admin edits it on screen.
  IF NOT EXISTS (SELECT 1 FROM pms_settings WHERE key = 'values_v2') THEN
    DELETE FROM pms_value_master;
    INSERT INTO pms_value_master (ord, lvl, code, label, marks) VALUES
      (1, 1, '', 'Entrepreneurship', NULL),
      (2, 2, '1', E'Initiative :\n- Does things before being asked or being forced by events\n- Identifies and acts on opportunities for improvement in his area of work', 3),
      (3, 2, '2', E'Planning:\nPlans work systematically, anticipates obstacles, evaluates alternatives.', 3),
      (4, 2, '3', E'Work:\n- Performs high quality work on a regular basis\n- Takes repeated / different action to achieve result/overcome obstacle', 3),
      (5, 2, '4', E'Efficiency:\nLooks for / finds ways to do things faster at less cost without affecting timelines or quality.', 3),
      (6, 2, '5', E'Problem Solving:\nGenerates new solutions, switches to alternative strategy to reach goals.', 3),
      (7, 1, '', 'Integrity', NULL),
      (8, 2, '6', E'Commitment:\n- Keeps and honors work promises and timelines\n- Proactively communicated revised timelines without being asked.', 5),
      (9, 2, '7', E'Responsibility:\n- Takes responsibility for actions\n- Makes right the impact of any adverse result due to actions taken.', 5);
    INSERT INTO pms_settings (key, value) VALUES ('values_weightage', '20') ON CONFLICT (key) DO UPDATE SET value = '20';
    INSERT INTO pms_settings (key, value) VALUES ('values_seeded', '1'), ('values_v2', '1') ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- PMS Page 3 (comments & scoring key): the free-text comments written on an appraisal.
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cmt_appraiser text NOT NULL DEFAULT '';   -- Appraiser (immediate / reporting manager)
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cmt_action    text NOT NULL DEFAULT '';   -- Any specific action (training, change in role, project, PIP ...)
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cmt_reviewer  text NOT NULL DEFAULT '';   -- Reviewer (manager's manager + HOD)
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cmt_appraisee text NOT NULL DEFAULT '';   -- Appraisee (employee's feedback on the appraisal process)
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS cmt_hr        text NOT NULL DEFAULT '';   -- HR

-- PMS approval flow (Page 6 sends for approval, Page 4 shows the status).
-- stage: 0 = draft (with the employee), 1-4 = waiting for L1-L4, 5 = approved. l1-l4 are the approvers chosen when it was submitted.
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS stage smallint NOT NULL DEFAULT 0;
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS l1 text REFERENCES users(id);   -- Manager
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS l2 text REFERENCES users(id);   -- HOD
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS l3 text REFERENCES users(id);   -- Function Head
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS l4 text REFERENCES users(id);   -- CHRO
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
CREATE TABLE IF NOT EXISTS pms_approvals (
  id           bigserial PRIMARY KEY,
  appraisal_id text NOT NULL REFERENCES pms_appraisals(id) ON DELETE CASCADE,
  level        smallint NOT NULL,                 -- 0 = the employee, 1-4 = L1-L4
  actor        text NOT NULL REFERENCES users(id),
  action       text NOT NULL,                     -- submitted | approved | returned
  note         text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pms_approvals_idx ON pms_approvals (appraisal_id, id);

-- PMS: the PDF on Page 1 and the versions of a form.
-- version = number of the last version sent for approval (0 = never sent). The number goes up each time the employee submits.
-- file_id = the PDF attached now (pms_files.id). A PDF that an earlier version used stays in pms_files for the history.
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE pms_appraisals ADD COLUMN IF NOT EXISTS file_id bigint;
UPDATE pms_appraisals SET version = 1 WHERE stage > 0 AND version = 0;   -- forms that were already sent before versions existed
CREATE TABLE IF NOT EXISTS pms_files (
  id           bigserial PRIMARY KEY,
  appraisal_id text NOT NULL REFERENCES pms_appraisals(id) ON DELETE CASCADE,
  name         text NOT NULL,
  size         integer NOT NULL,
  data         text NOT NULL,                     -- file content, base64
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pms_files_idx ON pms_files (appraisal_id);
-- One row per finished round (sent back, or approved): a copy of the form as it stood when the round ended.
CREATE TABLE IF NOT EXISTS pms_versions (
  id           bigserial PRIMARY KEY,
  appraisal_id text NOT NULL REFERENCES pms_appraisals(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  submitted_at timestamptz,
  submitted_by text REFERENCES users(id),
  outcome      text NOT NULL,                     -- Returned | Approved
  ended_at     timestamptz NOT NULL DEFAULT now(),
  ended_by     text REFERENCES users(id),
  note         text NOT NULL DEFAULT '',
  snapshot     jsonb NOT NULL,                    -- goals, values, comments and the PDF of that version
  UNIQUE (appraisal_id, version)
);

-- ===== Hosted databases (Supabase) =====
-- Supabase publishes every table of the "public" schema through its web API to anyone who has the project's public key.
-- Travel Desk never uses that API: the server talks to the database directly. So every table below is locked for the API
-- (row level security on, no policies, no rights for the anon / authenticated roles). The server's own connection is not
-- affected, because it connects as the owner of the tables. On a local PostgreSQL those roles do not exist and this changes nothing.
-- IMPORTANT: when you add a table to this file, add its name to the list below.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['users','sessions','policy','budgets','trips','expenses','claims','claim_files','claim_approvers',
                         'mail_outbox','app_migrations','pms_appraisals','pms_kras','pms_settings','pms_value_master',
                         'pms_value_rows','pms_approvals','pms_files','pms_versions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('%I.%I', current_schema(), t)) IS NULL THEN CONTINUE; END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', current_schema(), t))) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
