/* ============================================================
   ACS OCC —  SYSTEM GUARDIAN
   PRIVATE API
   ------------------------------------------------------------
   - Independent Guardian administrator access
   - PostgreSQL storage monitoring
   - Read-only cleanup diagnostics
   - No automatic cleanup
   ============================================================ */

import express from "express";
import rateLimit from "express-rate-limit";

import { pool } from "../db/pool.js";

import {
  ACS_getGuardianStorageSnapshot
} from "../services/acs_guardian_storage.js";

import {
  ACS_getGuardianDiagnostics
} from "../services/acs_guardian_diagnostics.js";

import {
  ACS_cancelGuardianActionPreview,
  ACS_createGuardianActionPreview
} from "../services/acs_guardian_action_preview.js";

import {
  ACS_createInitialGuardianAdministrator,
  ACS_getGuardianSetupStatus,
  ACS_getRequestIP,
  ACS_issueGuardianAccess,
  ACS_readBearerToken,
  ACS_requireGuardianAccess,
  ACS_revokeGuardianAccess
} from "../services/acs_guardian_security.js";

const router = express.Router();

/* ============================================================
   RATE LIMITS
   ============================================================ */

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,

  message: {
    ok: false,
    error: "GUARDIAN_RATE_LIMIT"
  }
});

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,

  message: {
    ok: false,
    error: "GUARDIAN_CREDENTIAL_RATE_LIMIT"
  }
});

/* ============================================================
   ERROR RESPONSE
   ============================================================ */

function ACS_sendGuardianError(
  res,
  error,
  fallback
) {
  console.error(
    `[ACS Guardian] ${fallback}:`,
    error.message
  );

  return res
    .status(error.statusCode || 500)
    .json({
      ok: false,
      error:
        error.message ||
        fallback
    });
}

router.use(
  "/guardian",
  generalLimiter
);

/* ============================================================
   PUBLIC — INITIAL SETUP STATUS
   ============================================================ */

router.get(
  "/guardian/setup-status",
  async (_req, res) => {
    try {
      const result =
        await ACS_getGuardianSetupStatus();

      return res.json(result);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_SETUP_STATUS_FAILED"
      );
    }
  }
);

/* ============================================================
   PUBLIC — ONE-TIME ADMINISTRATOR SETUP
   ============================================================ */

router.post(
  "/guardian/setup",
  credentialLimiter,
  async (req, res) => {
    try {
      const result =
        await ACS_createInitialGuardianAdministrator({
          email:
            req.body?.email,

          displayName:
            req.body?.displayName,

          password:
            req.body?.password,

          setupKey:
            req.body?.setupKey,

          sourceIP:
            ACS_getRequestIP(req)
        });

      return res
        .status(201)
        .json(result);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_SETUP_FAILED"
      );
    }
  }
);

/* ============================================================
   PUBLIC — GUARDIAN ACCESS
   ============================================================ */

router.post(
  "/guardian/access",
  credentialLimiter,
  async (req, res) => {
    try {
      const result =
        await ACS_issueGuardianAccess({
          email:
            req.body?.email,

          password:
            req.body?.password,

          sourceIP:
            ACS_getRequestIP(req)
        });

      return res.json(result);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_ACCESS_FAILED"
      );
    }
  }
);

/* ============================================================
   ALL ROUTES BELOW REQUIRE GUARDIAN ADMINISTRATOR ACCESS
   ============================================================ */

router.use(
  "/guardian",
  ACS_requireGuardianAccess
);

/* ============================================================
   PRIVATE — CURRENT SESSION
   ============================================================ */

router.get(
  "/guardian/session",
  async (req, res) => {
    return res.json({
      ok: true,

      administrator:
        req.guardian_administrator,

      expiresAt:
        req.guardian_access_expires_at
    });
  }
);

/* ============================================================
   PRIVATE — LOGOUT
   ============================================================ */

router.post(
  "/guardian/logout",
  async (req, res) => {
    try {
      await ACS_revokeGuardianAccess({
        administratorId:
          req.guardian_administrator.id,

        rawToken:
          ACS_readBearerToken(req),

        sourceIP:
          ACS_getRequestIP(req)
      });

      return res.json({
        ok: true,
        status:
          "GUARDIAN_ACCESS_CLOSED"
      });
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_LOGOUT_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — STORAGE SNAPSHOT
   ============================================================ */

router.get(
  "/guardian/storage",
  async (_req, res) => {
    try {
      const storage =
        await ACS_getGuardianStorageSnapshot();

      return res.json(storage);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_STORAGE_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — READ-ONLY CLEANUP DIAGNOSTICS
   ------------------------------------------------------------
   This endpoint identifies eligible historical rows.

   It does not:
   - delete rows
   - truncate tables
   - vacuum tables
   - reindex tables
   - create cleanup actions
   ============================================================ */

router.get(
  "/guardian/diagnostics",
  async (_req, res) => {
    try {
      const diagnostics =
        await ACS_getGuardianDiagnostics();

      return res.json(diagnostics);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_DIAGNOSTICS_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — SUPERVISED CLEANUP PREVIEW
   ------------------------------------------------------------
   Creates a temporary proposal only.
   No cleanup execution exists in this route.
   ============================================================ */

router.post(
  "/guardian/actions/preview",
  async (req, res) => {
    try {
      const result =
        await ACS_createGuardianActionPreview({
          actionType:
            req.body?.actionType,

          administratorId:
            req.guardian_administrator.id,

          sourceIP:
            ACS_getRequestIP(req)
        });

      return res
        .status(201)
        .json(result);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_ACTION_PREVIEW_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — CANCEL ACTION PREVIEW
   ------------------------------------------------------------
   Cancels a temporary supervised proposal.

   It does not execute cleanup or modify operational ACS data.
   ============================================================ */

router.post(
  "/guardian/actions/:actionId/cancel",
  async (req, res) => {
    try {
      const result =
        await ACS_cancelGuardianActionPreview({
          actionId:
            req.params.actionId,

          administratorId:
            req.guardian_administrator.id,

          sourceIP:
            ACS_getRequestIP(req)
        });

      return res.json(result);
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_ACTION_CANCEL_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — COMPLETE GUARDIAN DASHBOARD
   ============================================================ */

router.get(
  "/guardian/dashboard",
  async (_req, res) => {
    try {
      const [
  storage,
  diagnostics,
  policiesResult,
  alertsResult,
  supervisorResult
] = await Promise.all([
         
        ACS_getGuardianStorageSnapshot(),

        ACS_getGuardianDiagnostics(),

        pool.query(`
          SELECT
            action_type,
            enabled,
            eligible_row_threshold,
            table_byte_threshold,
            warning_volume_percent,
            critical_volume_percent,
            updated_at
          FROM
            public.acs_guardian_cleanup_policies
          ORDER BY
            action_type
        `),

        pool.query(`
  SELECT
    id,
    alert_key,
    severity,
    title,
    message,
    action_type,
    metrics,
    status,
    first_seen_at,
    last_seen_at
  FROM
    public.acs_guardian_alerts
  WHERE
    status = 'OPEN'
  ORDER BY
    CASE severity
      WHEN 'CRITICAL' THEN 1
      WHEN 'WARNING' THEN 2
      ELSE 3
    END,
    last_seen_at DESC
`),

pool.query(`
  SELECT
    supervisor_key,
    enabled,
    status,
    scan_interval_seconds,
    last_started_at,
    last_completed_at,
    last_success_at,
    last_failure_at,
    last_error,
    active_alert_count,
    last_opened_count,
    last_resolved_count,
    automatic_cleanup,
    updated_at
  FROM
    public.acs_guardian_supervisor_state
  WHERE
    supervisor_key =
      'GUARDIAN_ALERT_SCAN'
`)
      ]);

      return res.json({
        ok: true,

        capturedAt:
          storage.capturedAt,

        storage,

        diagnostics:
          diagnostics.diagnostics,

        policies:
          policiesResult.rows,

        alerts:
  alertsResult.rows,

supervisor:
  supervisorResult.rows[0] ||
  null,

automaticCleanup: false
         
      });
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_DASHBOARD_FAILED"
      );
    }
  }
);

/* ============================================================
   PRIVATE — GUARDIAN AUDIT
   ============================================================ */

router.get(
  "/guardian/audit",
  async (_req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            audit.id,
            audit.administrator_id,
            administrator.display_name,
            administrator.email,
            audit.event_type,
            audit.action_id,
            audit.source_ip,
            audit.details,
            audit.created_at
          FROM
            public.acs_guardian_audit_log audit
          LEFT JOIN
            public.acs_guardian_administrators
              administrator
            ON
              administrator.id =
                audit.administrator_id
          ORDER BY
            audit.created_at DESC
          LIMIT 100
        `);

      return res.json({
        ok: true,
        audit: result.rows
      });
    } catch (error) {
      return ACS_sendGuardianError(
        res,
        error,
        "GUARDIAN_AUDIT_FAILED"
      );
    }
  }
);

export default router;
