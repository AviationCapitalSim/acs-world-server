/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   SUPERVISED ACTION PREVIEW
   ------------------------------------------------------------
   Creates short-lived cleanup proposals.

   This service has no cleanup executor and cannot modify
   operational ACS data.
   ============================================================ */

import crypto from "crypto";

import { pool } from "../db/pool.js";

import {
  ACS_getGuardianDiagnostics
} from "./acs_guardian_diagnostics.js";

const ACS_PREVIEW_LIFETIME_MINUTES =
  10;

const ACS_ACTIONS = Object.freeze({
  FINANCE_CLOSED_DETAIL_COMPACTION: {
    table: "finance_log",

    confirmationLabel:
      "DETALLE FINANCIERO"
  },

  FLIGHT_HISTORY_COMPACTION: {
    table: "flight_occurrences",

    confirmationLabel:
      "HISTORIAL DE VUELOS"
  },

  OCC_DELETED_ALERTS_COMPACTION: {
    table: "occ_alerts",

    confirmationLabel:
      "MENSAJES OCC"
  }
});

function ACS_previewError(
  code,
  statusCode
) {
  const error = new Error(code);

  error.statusCode = statusCode;

  return error;
}

function ACS_hashToken(rawToken) {
  return crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
}

function ACS_createConfirmationPhrase(
  action
) {
  const confirmationCode =
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase();

  return (
    `AUTORIZO ` +
    `${action.confirmationLabel} ` +
    confirmationCode
  );
}

function ACS_buildPreviewPayload(
  diagnostic
) {
  return {
    actionType:
      diagnostic.actionType,

    title:
      diagnostic.title,

    table:
      diagnostic.table,

    capturedAt:
      new Date().toISOString(),

    eligibleRows:
      diagnostic.metrics.eligibleRows,

    relatedPassengerRows:
      diagnostic.metrics
        .relatedPassengerRows ??
      null,

    closedFlightSets:
      diagnostic.metrics
        .closedFlightSets ??
      null,

    affectedAirlines:
      diagnostic.metrics
        .affectedAirlines ??
      null,

    firstEligibleAt:
      diagnostic.metrics
        .firstEligibleAt,

    lastEligibleAt:
      diagnostic.metrics
        .lastEligibleAt,

    tableBytes:
      diagnostic.metrics.tableBytes,

    totalBytes:
      diagnostic.metrics.totalBytes,

    indexBytes:
      diagnostic.metrics.indexBytes,

    policy:
      diagnostic.policy,

    thresholdReached:
      diagnostic.thresholdReached,

    automaticCleanup: false,

    executionPerformed: false,

    protectedResources: [
      "finance_history",
      "company_finance",
      "company capital and balances",
      "current open financial period",
      "routes and schedules",
      "aircraft fleet",
      "aircraft maintenance",
      "aircraft factory slots",
      "catalogs",
      "Fuel Center",
      "insurance",
      "users",
      "WAL"
    ]
  };
}

export async function
ACS_createGuardianActionPreview({
  actionType,
  administratorId,
  sourceIP = null
}) {
  const normalizedActionType =
    String(actionType || "")
      .trim()
      .toUpperCase();

  const action =
    ACS_ACTIONS[
      normalizedActionType
    ];

  if (!action) {
    throw ACS_previewError(
      "GUARDIAN_ACTION_TYPE_NOT_ALLOWED",
      400
    );
  }

  const normalizedAdministratorId =
    Number(administratorId);

  if (
    !Number.isSafeInteger(
      normalizedAdministratorId
    ) ||
    normalizedAdministratorId <= 0
  ) {
    throw ACS_previewError(
      "GUARDIAN_ADMINISTRATOR_INVALID",
      401
    );
  }

  const diagnostics =
    await ACS_getGuardianDiagnostics();

  const diagnostic =
    diagnostics.diagnostics.find(
      (item) =>
        item.actionType ===
        normalizedActionType
    );

  if (!diagnostic) {
    throw ACS_previewError(
      "GUARDIAN_DIAGNOSTIC_NOT_AVAILABLE",
      503
    );
  }

  if (!diagnostic.policy?.enabled) {
    throw ACS_previewError(
      "GUARDIAN_CLEANUP_POLICY_DISABLED",
      409
    );
  }

  if (!diagnostic.thresholdReached) {
    throw ACS_previewError(
      "GUARDIAN_ACTION_THRESHOLD_NOT_REACHED",
      409
    );
  }

  if (
    Number(
      diagnostic.metrics
        ?.eligibleRows ||
      0
    ) <= 0
  ) {
    throw ACS_previewError(
      "GUARDIAN_ACTION_HAS_NO_ELIGIBLE_ROWS",
      409
    );
  }

  if (
    !diagnostic.metrics
      ?.fingerprint
  ) {
    throw ACS_previewError(
      "GUARDIAN_PREVIEW_FINGERPRINT_UNAVAILABLE",
      503
    );
  }

  const rawActionToken =
    crypto
      .randomBytes(32)
      .toString("base64url");

  const actionTokenHash =
    ACS_hashToken(
      rawActionToken
    );

  const confirmationPhrase =
    ACS_createConfirmationPhrase(
      action
    );

  const previewPayload =
    ACS_buildPreviewPayload(
      diagnostic
    );

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      UPDATE
        public.acs_guardian_actions
      SET
        status = 'EXPIRED'
      WHERE
        status = 'PREVIEWED'
        AND expires_at <=
          CURRENT_TIMESTAMP
    `);

    await client.query(
      `
      UPDATE
        public.acs_guardian_actions
      SET
        status = 'CANCELLED'
      WHERE
        requested_by_administrator_id =
          $1
        AND action_type = $2
        AND status = 'PREVIEWED'
      `,
      [
        normalizedAdministratorId,
        normalizedActionType
      ]
    );

    const inserted =
      await client.query(
        `
        INSERT INTO
          public.acs_guardian_actions
        (
          action_type,
          requested_by_administrator_id,
          preview_payload,
          preview_fingerprint,
          action_token_hash,
          confirmation_phrase,
          status,
          expires_at
        )
        VALUES
        (
          $1,
          $2,
          $3::jsonb,
          $4,
          $5,
          $6,
          'PREVIEWED',

          CURRENT_TIMESTAMP +
            (
              $7::integer *
              INTERVAL '1 minute'
            )
        )
        RETURNING
          id,
          action_type,
          status,
          expires_at,
          created_at
        `,
        [
          normalizedActionType,
          normalizedAdministratorId,

          JSON.stringify(
            previewPayload
          ),

          diagnostic.metrics
            .fingerprint,

          actionTokenHash,
          confirmationPhrase,
          ACS_PREVIEW_LIFETIME_MINUTES
        ]
      );

    const savedAction =
      inserted.rows[0];

    await client.query(
      `
      INSERT INTO
        public.acs_guardian_audit_log
      (
        administrator_id,
        event_type,
        action_id,
        source_ip,
        details
      )
      VALUES
      (
        $1,
        'GUARDIAN_ACTION_PREVIEW_CREATED',
        $2,
        $3,
        $4::jsonb
      )
      `,
      [
        normalizedAdministratorId,
        savedAction.id,
        sourceIP,

        JSON.stringify({
          actionType:
            normalizedActionType,

          eligibleRows:
            previewPayload
              .eligibleRows,

          table:
            action.table,

          expiresAt:
            savedAction.expires_at,

          automaticCleanup: false,
          executionPerformed: false
        })
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,

      action: {
        id:
          savedAction.id,

        actionType:
          savedAction.action_type,

        status:
          savedAction.status,

        createdAt:
          savedAction.created_at,

        expiresAt:
          savedAction.expires_at,

        preview:
          previewPayload,

        confirmationPhrase,

        actionToken:
          rawActionToken,

        automaticCleanup: false,

        executionAvailable: false
      }
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {
      // No operational data was modified.
    }

    throw error;
  } finally {
    client.release();
  }
}
