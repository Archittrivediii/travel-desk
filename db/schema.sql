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

