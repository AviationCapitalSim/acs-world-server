BEGIN;

CREATE TABLE IF NOT EXISTS public.acs_guardian_access_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.acs_guardian_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_type text NOT NULL,
  requested_by bigint NOT NULL,
  preview_payload jsonb NOT NULL,
  preview_fingerprint text NOT NULL,
  action_token_hash text NOT NULL UNIQUE,
  confirmation_phrase text NOT NULL,
  status text NOT NULL DEFAULT 'PREVIEWED',
  expires_at timestamp with time zone NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  result_payload jsonb,
  failure_message text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT acs_guardian_actions_status_check CHECK (
    status IN (
      'PREVIEWED',
      'EXECUTING',
      'COMPLETED',
      'CANCELLED',
      'EXPIRED',
      'FAILED'
    )
  )
);

CREATE TABLE IF NOT EXISTS public.acs_guardian_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint,
  event_type text NOT NULL,
  action_id bigint,
  source_ip text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.acs_guardian_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_key text NOT NULL UNIQUE,
  severity text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  action_type text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  first_seen_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at timestamp with time zone,

  CONSTRAINT acs_guardian_alerts_severity_check CHECK (
    severity IN ('INFO', 'WARNING', 'CRITICAL')
  ),

  CONSTRAINT acs_guardian_alerts_status_check CHECK (
    status IN ('OPEN', 'RESOLVED')
  )
);

CREATE TABLE IF NOT EXISTS public.acs_guardian_cleanup_policies (
  action_type text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  eligible_row_threshold bigint NOT NULL,
  table_byte_threshold bigint NOT NULL,
  warning_volume_percent numeric(5,2) NOT NULL DEFAULT 75.00,
  critical_volume_percent numeric(5,2) NOT NULL DEFAULT 90.00,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT acs_guardian_policy_thresholds_check CHECK (
    eligible_row_threshold >= 0
    AND table_byte_threshold >= 0
    AND warning_volume_percent > 0
    AND critical_volume_percent > warning_volume_percent
  )
);

CREATE TABLE IF NOT EXISTS public.acs_guardian_table_baselines (
  table_schema text NOT NULL,
  table_name text NOT NULL,
  total_bytes bigint NOT NULL,
  table_bytes bigint NOT NULL,
  index_bytes bigint NOT NULL,
  estimated_rows bigint,
  captured_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (table_schema, table_name)
);

CREATE TABLE IF NOT EXISTS public.occ_alert_dismissals (
  alert_id bigint PRIMARY KEY,
  dismissed_by bigint,
  dismissed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.acs_guardian_cleanup_policies (
  action_type,
  eligible_row_threshold,
  table_byte_threshold
)
VALUES
  (
    'FLIGHT_HISTORY_COMPACTION',
    20000,
    31457280
  ),
  (
    'FINANCE_CLOSED_DETAIL_COMPACTION',
    50000,
    62914560
  ),
  (
    'OCC_DELETED_ALERTS_COMPACTION',
    500,
    1048576
  )
ON CONFLICT (action_type) DO NOTHING;

CREATE INDEX IF NOT EXISTS acs_guardian_access_tokens_user_expiry_idx
  ON public.acs_guardian_access_tokens (
    user_id,
    expires_at
  );

CREATE INDEX IF NOT EXISTS acs_guardian_actions_user_status_idx
  ON public.acs_guardian_actions (
    requested_by,
    status,
    expires_at
  );

CREATE INDEX IF NOT EXISTS acs_guardian_audit_created_at_idx
  ON public.acs_guardian_audit_log (
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS acs_guardian_alerts_status_severity_idx
  ON public.acs_guardian_alerts (
    status,
    severity,
    last_seen_at DESC
  );

COMMENT ON TABLE public.acs_guardian_actions IS
  'Acciones supervisadas de ACS Guardian. Ninguna acción se ejecuta automáticamente.';

COMMENT ON TABLE public.occ_alert_dismissals IS
  'Marcadores mínimos que permiten retirar físicamente mensajes OCC ya borrados.';

COMMIT;
