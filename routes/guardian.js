/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   PRIVATE API ROUTES
   ------------------------------------------------------------
   Final route prefix after server registration:
   /v1/guardian
   ============================================================ */

import express from "express";
import rateLimit from "express-rate-limit";

import { pool }
  from "../db/pool.js";

import { requireAuth }
  from "../middleware/auth.js";

import {
  ACS_getRequestIP,
  ACS_issueGuardianAccess,
  ACS_readBearerToken,
  ACS_requireGuardianAccess,
  ACS_revokeGuardianAccess
} from "../services/acs_guardian_security.js";

import {
  ACS_getGuardianStorageSnapshot
} from "../services/acs_guardian_storage.js";

const router = express.Router();

/* ============================================================
   GUARDIAN ACCESS RATE LIMIT
   ============================================================ */

const guardianAccessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,

  message: {
    ok: false,
    error: "GUARDIAN_ACCESS_RATE_LIMIT"
  }
});

function ACS_guardianErrorResponse(
  res,
  error,
  fallbackCode
) {
  console.error(
    `[ACS Guardian] ${fallbackCode}:`,
    error.message
  );

  return res
    .status(error.statusCode || 500)
    .json({
      ok: false,
      error:
        error.message ||
        fallbackCode
    });
}

/* ============================================================
   REAUTHENTICATE AND OPEN GUARDIAN
   ------------------------------------------------------------
   A valid ACS session is required before checking the password.
   The returned Guardian token expires after 30 minutes.
   ============================================================ */

router.post(
  "/guardian/access",
  guardianAccessLimiter,
  requireAuth,

  async (req, res) => {
    try {
      const result =
        await ACS_issueGuardianAccess({
          userId: req.user_id,

          password:
            req.body?.password,

          sourceIP:
            ACS_getRequestIP(req)
        });

      return res
        .status(200)
        .json(result);

    } catch (error) {
      return ACS_guardianErrorResponse(
        res,
        error,
        "GUARDIAN_ACCESS_FAILED"
      );
    }
  }
);

/* ============================================================
   CLOSE CURRENT GUARDIAN ACCESS
   ============================================================ */

router.post(
  "/guardian/logout",
  requireAuth,
  ACS_requireGuardianAccess,

  async (req, res) => {
    try {
      await ACS_revokeGuardianAccess({
        userId: req.user_id,

        rawToken:
          ACS_readBearerToken(req),

        sourceIP:
          ACS_getRequestIP(req)
      });

      return res.status(200).json({
        ok: true,
        status:
          "GUARDIAN_ACCESS_CLOSED"
      });

    } catch (error) {
      return ACS_guardianErrorResponse(
        res,
        error,
        "GUARDIAN_LOGOUT_FAILED"
      );
    }
  }
);

/* ============================================================
   READ-ONLY STORAGE SNAPSHOT
   ============================================================ */

router.get(
  "/guardian/storage",
  requireAuth,
  ACS_requireGuardianAccess,

  async (_req, res) => {
    try {
      const snapshot =
        await ACS_getGuardianStorageSnapshot();

      return res
        .status(200)
        .json(snapshot);

    } catch (error) {
      return ACS_guardianErrorResponse(
        res,
        error,
        "GUARDIAN_STORAGE_FAILED"
      );
    }
  }
);

/* ============================================================
   GUARDIAN DASHBOARD DATA
   ------------------------------------------------------------
   Combines storage, configured policies and active alerts.
   It does not run cleanup actions.
   ============================================================ */

router.get(
  "/guardian/dashboard",
  requireAuth,
  ACS_requireGuardianAccess,

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

      return res.status(200).json({
        ok: true,
        capturedAt:
          storage.capturedAt,

        storage,
        policies:
          policiesResult.rows,

        alerts:
          alertsResult.rows
      });

    } catch (error) {
      return ACS_guardianErrorResponse(
        res,
        error,
        "GUARDIAN_DASHBOARD_FAILED"
      );
    }
  }
);

/* ============================================================
   RECENT GUARDIAN AUDIT
   ============================================================ */

router.get(
  "/guardian/audit",
  requireAuth,
  ACS_requireGuardianAccess,

  async (_req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            user_id,
            event_type,
            action_id,
            source_ip,
            details,
            created_at

          FROM
            public.acs_guardian_audit_log

          ORDER BY
            created_at DESC

          LIMIT 100
        `);

      return res.status(200).json({
        ok: true,
        audit: result.rows
      });

    } catch (error) {
      return ACS_guardianErrorResponse(
        res,
        error,
        "GUARDIAN_AUDIT_FAILED"
      );
    }
  }
);

export default router;
