BEGIN;

CREATE TABLE IF NOT EXISTS public.acs_guardian_administrators (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamp with time zone,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT acs_guardian_admin_email_check CHECK (
    LENGTH(TRIM(email)) BETWEEN 3 AND 320
  ),

  CONSTRAINT acs_guardian_admin_display_name_check CHECK (
    LENGTH(TRIM(display_name)) BETWEEN 2 AND 120
  ),

  CONSTRAINT acs_guardian_admin_failed_attempts_check CHECK (
    failed_login_attempts >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  acs_guardian_administrators_email_unique_idx
ON public.acs_guardian_administrators (
  LOWER(email)
);

DO $acs_guardian_migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'acs_guardian_access_tokens'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.acs_guardian_access_tokens
      RENAME COLUMN user_id TO administrator_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'acs_guardian_actions'
      AND column_name = 'requested_by'
  ) THEN
    ALTER TABLE public.acs_guardian_actions
      RENAME COLUMN requested_by
      TO requested_by_administrator_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'acs_guardian_audit_log'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.acs_guardian_audit_log
      RENAME COLUMN user_id TO administrator_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'occ_alert_dismissals'
      AND column_name = 'dismissed_by'
  ) THEN
    ALTER TABLE public.occ_alert_dismissals
      RENAME COLUMN dismissed_by
      TO dismissed_by_administrator_id;
  END IF;
END
$acs_guardian_migration$;

ALTER INDEX IF EXISTS
  public.acs_guardian_access_tokens_user_expiry_idx
RENAME TO
  acs_guardian_access_tokens_admin_expiry_idx;

ALTER INDEX IF EXISTS
  public.acs_guardian_actions_user_status_idx
RENAME TO
  acs_guardian_actions_admin_status_idx;

DO $acs_guardian_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'acs_guardian_access_tokens_admin_fkey'
  ) THEN
    ALTER TABLE public.acs_guardian_access_tokens
      ADD CONSTRAINT
        acs_guardian_access_tokens_admin_fkey
      FOREIGN KEY (administrator_id)
      REFERENCES
        public.acs_guardian_administrators(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'acs_guardian_actions_admin_fkey'
  ) THEN
    ALTER TABLE public.acs_guardian_actions
      ADD CONSTRAINT
        acs_guardian_actions_admin_fkey
      FOREIGN KEY (
        requested_by_administrator_id
      )
      REFERENCES
        public.acs_guardian_administrators(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'acs_guardian_audit_admin_fkey'
  ) THEN
    ALTER TABLE public.acs_guardian_audit_log
      ADD CONSTRAINT
        acs_guardian_audit_admin_fkey
      FOREIGN KEY (administrator_id)
      REFERENCES
        public.acs_guardian_administrators(id)
      ON DELETE SET NULL;
  END IF;
END
$acs_guardian_constraints$;

COMMENT ON TABLE
  public.acs_guardian_administrators IS
  'Administradores privados de ACS Guardian. No son jugadores ni compañías de ACS.';

COMMIT;
