BEGIN;

CREATE TABLE IF NOT EXISTS
public.acs_guardian_supervisor_state (
  supervisor_key text PRIMARY KEY,

  enabled boolean
    NOT NULL
    DEFAULT true,

  status text
    NOT NULL
    DEFAULT 'STARTING',

  scan_interval_seconds integer
    NOT NULL
    DEFAULT 900,

  last_started_at
    timestamp with time zone,

  last_completed_at
    timestamp with time zone,

  last_success_at
    timestamp with time zone,

  last_failure_at
    timestamp with time zone,

  last_error text,

  active_alert_count integer
    NOT NULL
    DEFAULT 0,

  last_opened_count integer
    NOT NULL
    DEFAULT 0,

  last_resolved_count integer
    NOT NULL
    DEFAULT 0,

  automatic_cleanup boolean
    NOT NULL
    DEFAULT false,

  updated_at
    timestamp with time zone
    NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT
    acs_guardian_supervisor_status_check
  CHECK (
    status IN (
      'STARTING',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'STANDBY',
      'DISABLED'
    )
  ),

  CONSTRAINT
    acs_guardian_supervisor_interval_check
  CHECK (
    scan_interval_seconds >= 60
  ),

  CONSTRAINT
    acs_guardian_supervisor_counts_check
  CHECK (
    active_alert_count >= 0
    AND last_opened_count >= 0
    AND last_resolved_count >= 0
  ),

  CONSTRAINT
    acs_guardian_supervisor_no_auto_cleanup
  CHECK (
    automatic_cleanup = false
  )
);

INSERT INTO
public.acs_guardian_supervisor_state
(
  supervisor_key,
  enabled,
  status,
  scan_interval_seconds,
  automatic_cleanup
)
VALUES
(
  'GUARDIAN_ALERT_SCAN',
  true,
  'STARTING',
  900,
  false
)
ON CONFLICT (supervisor_key)
DO NOTHING;

COMMENT ON TABLE
public.acs_guardian_supervisor_state
IS
  'Estado operativo del supervisor ACS Guardian. No concede capacidad de limpieza automática.';

COMMIT;
