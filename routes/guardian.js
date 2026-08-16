/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   PRIVATE API
   ============================================================ */

import express from "express";
import rateLimit from "express-rate-limit";

import { pool }
  from "../db/pool.js";

import {
  ACS_getGuardianStorageSnapshot
} from "../services/acs_guardian_storage.js";

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
    error:
      "GUARDIAN_CREDENTIAL_RATE_LIMIT"
  }
});

function sendError(
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
   INITIAL SETUP STATUS
   ============================================================ */

router.get(
  "/guardian/setup-status",

  async (_req, res) => {
    try {
      const result =
        await ACS_getGuardianSetupStatus();

      return res.json(result);

    } catch (error) {
      return sendError(
        res,
        error,
        "GUARDIAN_SETUP_STATUS_FAILED"
      );
    }
  }
);

/* ============================================================
   CREATE FIRST GUARDIAN ADMINISTRATOR
   ------------------------------------------------------------
   Available only while no administrator exists.
   Requires the temporary setup key.
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
      return sendError(
        res,
        error,
        "GUARDIAN_SETUP_FAILED"
      );
    }
  }
);

/* ============================================================
   GUARDIAN LOGIN
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
      return sendError(
        res,
        error,
        "GUARDIAN_ACCESS_FAILED"
      );
    }
  }
);

/* ============================================================
   PROTECTED ROUTES
   ------------------------------------------------------------
   Every route below requires a valid temporary Guardian token.
   ============================================================ */

router.use(
  "/guardian",
  ACS_requireGuardianAccess
);

/* ============================================================
   CURRENT GUARDIAN SESSION
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
   GUARDIAN LOGOUT
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
      return sendError(
        res,
        error,
        "GUARDIAN_LOGOUT_FAILED"
      );
    }
  }
);

/* ============================================================
   STORAGE MONITOR
   ============================================================ */

router.get(
  "/guardian/storage",

  async (_req, res) => {
    try {
      const snapshot =
        await ACS_getGuardianStorageSnapshot();

      return res.json(snapshot);

    } catch (error) {
      return sendError(
        res,
        error,
        "GUARDIAN_STORAGE_FAILED"
      );
    }
  }
);

/* ============================================================
   GUARDIAN DASHBOARD
   ------------------------------------------------------------
   Read-only. No cleanup action is executed here.
   ============================================================ */

router.get(
  "/guardian/dashboard",

  async (_req, res) => {
    try {
      const [
        storage,
        policiesResult,
        alertsResult
      ] = await Promise.all([
        ACS_getGuardianStorageSnapshot(),

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

          WHERE status = 'OPEN'

          ORDER BY
            CASE severity
              WHEN 'CRITICAL' THEN 1
              WHEN 'WARNING' THEN 2
              ELSE 3
            END,
            last_seen_at DESC
        `)
      ]);

      return res.json({
        ok: true,

        capturedAt:
          storage.capturedAt,

        storage,

        policies:
          policiesResult.rows,

        alerts:
          alertsResult.rows,

        automaticCleanup: false
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "GUARDIAN_DASHBOARD_FAILED"
      );
    }
  }
);

/* ============================================================
   GUARDIAN AUDIT
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
            public.acs_guardian_audit_log
              audit

          LEFT JOIN
            public.acs_guardian_administrators
              administrator

            ON administrator.id =
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
      return sendError(
        res,
        error,
        "GUARDIAN_AUDIT_FAILED"
      );
    }
  }
);

export default router;
