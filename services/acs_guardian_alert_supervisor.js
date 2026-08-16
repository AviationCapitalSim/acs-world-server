/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   ALERT SUPERVISOR
   ------------------------------------------------------------
   Publishes and resolves internal Guardian alerts.

   IT NEVER:
   - Deletes operational records
   - Executes cleanup actions
   - Runs VACUUM, TRUNCATE or REINDEX
   ============================================================ */

import { pool } from "../db/pool.js";

import {
  ACS_getGuardianDiagnostics
} from "./acs_guardian_diagnostics.js";

import {
  ACS_getGuardianStorageSnapshot
} from "./acs_guardian_storage.js";

const ACS_GUARDIAN_ALERT_LOCK =
  1196578891;

const ACS_GUARDIAN_ALERT_KEYS =
  Object.freeze([
    "GUARDIAN:STORAGE_VOLUME",

    "GUARDIAN:CLEANUP:" +
      "FINANCE_CLOSED_DETAIL_COMPACTION",

    "GUARDIAN:CLEANUP:" +
      "FLIGHT_HISTORY_COMPACTION",

    "GUARDIAN:CLEANUP:" +
      "OCC_DELETED_ALERTS_COMPACTION"
  ]);

let ACS_guardianAlertTimer = null;
let ACS_guardianAlertScanRunning = false;
let ACS_guardianAlertIntervalSeconds = 900;

function ACS_toNumber(
  value,
  fallback = 0
) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function ACS_buildCleanupAlert(
  diagnostic,
  volumePercent,
  criticalPercent
) {
  const eligibleRows =
    ACS_toNumber(
      diagnostic.metrics?.eligibleRows
    );

  const totalMB = (
    ACS_toNumber(
      diagnostic.metrics?.totalBytes
    ) /
    (1024 * 1024)
  ).toFixed(1);

  return {
    key:
      `GUARDIAN:CLEANUP:` +
      diagnostic.actionType,

    severity:
      volumePercent >= criticalPercent
        ? "CRITICAL"
        : "WARNING",

    title:
      diagnostic.title,

    message:
      `${eligibleRows.toLocaleString("es-ES")} ` +
      `filas eliminables detectadas en ` +
      `${diagnostic.table}. ` +
      `Tamaño actual: ${totalMB} MB. ` +
      `La limpieza requiere autorización manual.`,

    actionType:
      diagnostic.actionType,

    metrics: {
      ...diagnostic.metrics,
      policy: diagnostic.policy,
      automaticCleanup: false
    }
  };
}

async function ACS_readVolumeThresholds(
  client
) {
  const result =
    await client.query(`
      SELECT
        COALESCE(
          MIN(warning_volume_percent),
          75
        )::numeric AS warning_percent,

        COALESCE(
          MIN(critical_volume_percent),
          90
        )::numeric AS critical_percent

      FROM
        public.acs_guardian_cleanup_policies

      WHERE
        enabled = TRUE
    `);

  return {
    warningPercent:
      ACS_toNumber(
        result.rows[0]?.warning_percent,
        75
      ),

    criticalPercent:
      ACS_toNumber(
        result.rows[0]?.critical_percent,
        90
      )
  };
}

async function ACS_markSupervisorRunning(
  client
) {
  await client.query(
    `
    UPDATE
      public.acs_guardian_supervisor_state
    SET
      enabled = TRUE,
      status = 'RUNNING',
      scan_interval_seconds = $2,
      last_started_at =
        CURRENT_TIMESTAMP,
      last_error = NULL,
      automatic_cleanup = FALSE,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE
      supervisor_key = $1
    `,
    [
      "GUARDIAN_ALERT_SCAN",
      ACS_guardianAlertIntervalSeconds
    ]
  );
}

async function ACS_markSupervisorSuccess(
  client,
  activeAlertCount,
  transitions
) {
  await client.query(
    `
    UPDATE
      public.acs_guardian_supervisor_state
    SET
      enabled = TRUE,
      status = 'SUCCESS',
      scan_interval_seconds = $2,
      last_completed_at =
        CURRENT_TIMESTAMP,
      last_success_at =
        CURRENT_TIMESTAMP,
      last_error = NULL,
      active_alert_count = $3,
      last_opened_count = $4,
      last_resolved_count = $5,
      automatic_cleanup = FALSE,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE
      supervisor_key = $1
    `,
    [
      "GUARDIAN_ALERT_SCAN",
      ACS_guardianAlertIntervalSeconds,
      activeAlertCount,
      transitions.openedKeys.length,
      transitions.resolvedKeys.length
    ]
  );
}

async function ACS_markSupervisorFailure(
  client,
  error
) {
  await client.query(
    `
    UPDATE
      public.acs_guardian_supervisor_state
    SET
      enabled = TRUE,
      status = 'FAILED',
      last_completed_at =
        CURRENT_TIMESTAMP,
      last_failure_at =
        CURRENT_TIMESTAMP,
      last_error = $2,
      automatic_cleanup = FALSE,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE
      supervisor_key = $1
    `,
    [
      "GUARDIAN_ALERT_SCAN",

      String(
        error?.stack ||
        error?.message ||
        error ||
        "UNKNOWN_ERROR"
      ).slice(0, 2000)
    ]
  );
}

async function ACS_publishGuardianAlerts(
  client,
  activeAlerts
) {
  const currentResult =
    await client.query(
      `
      SELECT
        alert_key,
        status
      FROM
        public.acs_guardian_alerts
      WHERE
        alert_key = ANY($1::text[])
      FOR UPDATE
      `,
      [ACS_GUARDIAN_ALERT_KEYS]
    );

  const currentStatus =
    new Map(
      currentResult.rows.map(
        (row) => [
          row.alert_key,
          row.status
        ]
      )
    );

  const activeKeys =
    activeAlerts.map(
      (alert) => alert.key
    );

  const openedKeys = [];

  for (const alert of activeAlerts) {
    if (
      currentStatus.get(alert.key) !==
      "OPEN"
    ) {
      openedKeys.push(alert.key);
    }

    await client.query(
      `
      INSERT INTO
        public.acs_guardian_alerts
      (
        alert_key,
        severity,
        title,
        message,
        action_type,
        metrics,
        status,
        first_seen_at,
        last_seen_at,
        resolved_at
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        'OPEN',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        NULL
      )

      ON CONFLICT (alert_key)
      DO UPDATE SET
        severity =
          EXCLUDED.severity,

        title =
          EXCLUDED.title,

        message =
          EXCLUDED.message,

        action_type =
          EXCLUDED.action_type,

        metrics =
          EXCLUDED.metrics,

        status =
          'OPEN',

        last_seen_at =
          CURRENT_TIMESTAMP,

        resolved_at =
          NULL
      `,
      [
        alert.key,
        alert.severity,
        alert.title,
        alert.message,
        alert.actionType || null,
        JSON.stringify(
          alert.metrics || {}
        )
      ]
    );
  }

  const resolvedResult =
    await client.query(
      `
      UPDATE
        public.acs_guardian_alerts
      SET
        status = 'RESOLVED',
        resolved_at =
          CURRENT_TIMESTAMP,
        last_seen_at =
          CURRENT_TIMESTAMP
      WHERE
        alert_key = ANY($1::text[])
        AND status = 'OPEN'
        AND NOT (
          alert_key = ANY($2::text[])
        )
      RETURNING
        alert_key
      `,
      [
        ACS_GUARDIAN_ALERT_KEYS,
        activeKeys
      ]
    );

  const resolvedKeys =
    resolvedResult.rows.map(
      (row) => row.alert_key
    );

  if (
    openedKeys.length ||
    resolvedKeys.length
  ) {
    await client.query(
      `
      INSERT INTO
        public.acs_guardian_audit_log
      (
        administrator_id,
        event_type,
        details
      )
      VALUES
      (
        NULL,
        'GUARDIAN_ALERT_TRANSITIONS',
        $1::jsonb
      )
      `,
      [
        JSON.stringify({
          opened: openedKeys,
          resolved: resolvedKeys,
          automaticCleanup: false
        })
      ]
    );
  }

  return {
    openedKeys,
    resolvedKeys
  };
}

export async function
ACS_runGuardianAlertScan() {
  if (ACS_guardianAlertScanRunning) {
    return {
      processedCount: 0,
      status: "ALREADY_RUNNING"
    };
  }

  ACS_guardianAlertScanRunning = true;

  const lockClient =
    await pool.connect();

  let lockAcquired = false;

  try {
    const lockResult =
      await lockClient.query(
        `
        SELECT
          pg_try_advisory_lock($1)
            AS locked
        `,
        [ACS_GUARDIAN_ALERT_LOCK]
      );

    lockAcquired =
      lockResult.rows[0]?.locked === true;

    if (!lockAcquired) {
      return {
        processedCount: 0,

        status:
          "LOCKED_BY_ANOTHER_INSTANCE"
      };
    }

    await ACS_markSupervisorRunning(
     lockClient
    );   
     
    const [
      storage,
      diagnostics,
      thresholds
    ] = await Promise.all([
      ACS_getGuardianStorageSnapshot(),

      ACS_getGuardianDiagnostics(),

      ACS_readVolumeThresholds(
        lockClient
      )
    ]);

    const volumePercent =
      ACS_toNumber(
        storage.volume
          ?.estimatedPercent,
        0
      );

    const activeAlerts = [];

    if (
      storage.volume
        ?.estimatedPercent !== null &&

      volumePercent >=
        thresholds.warningPercent
    ) {
      activeAlerts.push({
        key:
          "GUARDIAN:STORAGE_VOLUME",

        severity:
          volumePercent >=
          thresholds.criticalPercent
            ? "CRITICAL"
            : "WARNING",

        title:
          "Capacidad de almacenamiento Railway",

        message:
          `El volumen estimado alcanzó ` +
          `${volumePercent.toFixed(1)}%. ` +
          `Espacio disponible estimado: ` +
          `${ACS_toNumber(
            storage.volume
              ?.estimatedFreeMB
          ).toFixed(1)} MB. ` +
          `Guardian no ejecutará ninguna ` +
          `limpieza sin autorización.`,

        actionType: null,

        metrics: {
          ...storage.volume,
          automaticCleanup: false
        }
      });
    }

    for (
      const diagnostic of
      diagnostics.diagnostics
    ) {
      if (
        !diagnostic.thresholdReached
      ) {
        continue;
      }

      activeAlerts.push(
        ACS_buildCleanupAlert(
          diagnostic,
          volumePercent,
          thresholds.criticalPercent
        )
      );
    }

    await lockClient.query("BEGIN");

    const transitions =
      await ACS_publishGuardianAlerts(
        lockClient,
        activeAlerts
      );

    await lockClient.query("COMMIT");

    await ACS_markSupervisorSuccess(
    lockClient,
    activeAlerts.length,
    transitions
    );

    const processedCount =
      transitions.openedKeys.length +
      transitions.resolvedKeys.length;

    if (processedCount > 0) {
      console.log(
        "[ACS Guardian] Alert transitions:",
        transitions
      );
    }

    return {
      processedCount,
      status: "SUCCESS",

      activeAlertCount:
        activeAlerts.length,

      ...transitions
    };
  } catch (error) {
    try {
      await lockClient.query(
        "ROLLBACK"
      );
    } catch {
      // Nothing else is modified.
    }

     if (lockAcquired) {
  try {
    await ACS_markSupervisorFailure(
      lockClient,
      error
    );
  } catch (stateError) {
    console.error(
      "[ACS Guardian] Failed to publish supervisor state:",
      stateError
    );
  }
}
   
    console.error(
      "[ACS Guardian] Alert scan failed:",
      error
    );

    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await lockClient.query(
          `
          SELECT
            pg_advisory_unlock($1)
          `,
          [ACS_GUARDIAN_ALERT_LOCK]
        );
      } catch {
        // Connection release also
        // releases the session lock.
      }
    }

    lockClient.release();

    ACS_guardianAlertScanRunning =
      false;
  }
}

export function
startACSGuardianAlertSupervisor({
  intervalMs = Number(
    process.env
      .ACS_GUARDIAN_ALERT_INTERVAL_MS ||
    900000
  )
} = {}) {
  if (
    process.env
      .ACS_GUARDIAN_ALERT_SUPERVISOR_ENABLED ===
    "false"
  ) {
    console.log(
      "[ACS Guardian] Alert supervisor disabled"
    );

    return false;
  }

  if (ACS_guardianAlertTimer) {
    return false;
  }

  const normalizedInterval =
    Number.isFinite(intervalMs) &&
    intervalMs >= 60000
      ? Math.floor(intervalMs)
      : 900000;

  ACS_guardianAlertIntervalSeconds =
  Math.floor(
    normalizedInterval / 1000
  );
   
  void ACS_runGuardianAlertScan()
    .catch(() => {});

  ACS_guardianAlertTimer =
    setInterval(
      () => {
        void ACS_runGuardianAlertScan()
          .catch(() => {});
      },
      normalizedInterval
    );

  ACS_guardianAlertTimer.unref?.();

  console.log(
    `[ACS Guardian] Alert supervisor ` +
    `started (${normalizedInterval} ms)`
  );

  return true;
}

export function
stopACSGuardianAlertSupervisor() {
  if (!ACS_guardianAlertTimer) {
    return false;
  }

  clearInterval(
    ACS_guardianAlertTimer
  );

  ACS_guardianAlertTimer = null;

  console.log(
    "[ACS Guardian] Alert supervisor stopped"
  );

  return true;
}
