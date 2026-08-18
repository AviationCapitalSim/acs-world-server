/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   SUPERVISED CLEANUP EXECUTOR
   ------------------------------------------------------------
   Executes only an administrator-confirmed, unexpired preview.
   Every cleanup is atomic and restricted to an explicit table
   allow-list. Any mismatch rolls the complete transaction back.
   ============================================================ */

import crypto from "crypto";
import { pool } from "../db/pool.js";

const ACTIONS = Object.freeze({
  FINANCE_CLOSED_DETAIL_COMPACTION:
    "FINANCE_CLOSED_DETAIL_COMPACTION",
  FLIGHT_HISTORY_COMPACTION:
    "FLIGHT_HISTORY_COMPACTION",
  OCC_DELETED_ALERTS_COMPACTION:
    "OCC_DELETED_ALERTS_COMPACTION"
});

const ACTION_LOCK_KEY = "ACS_GUARDIAN_SUPERVISED_CLEANUP";

function ACS_actionError(code, statusCode = 409) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function ACS_normalizePositiveId(value, errorCode) {
  const normalized = Number(value);

  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0
  ) {
    throw ACS_actionError(errorCode, 400);
  }

  return normalized;
}

function ACS_hashToken(rawToken) {
  return crypto
    .createHash("sha256")
    .update(String(rawToken || ""))
    .digest("hex");
}

function ACS_safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function ACS_quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function ACS_assertNoUnexpectedReferences(
  client,
  targetTable,
  allowedReferencingTables = []
) {
  const result = await client.query(
    `
    SELECT
      namespace.nspname AS table_schema,
      relation.relname AS table_name,
      constraint_record.conname AS constraint_name
    FROM pg_constraint constraint_record
    JOIN pg_class relation
      ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE constraint_record.contype = 'f'
      AND constraint_record.confrelid = $1::regclass
    `,
    [targetTable]
  );

  const allowed = new Set(allowedReferencingTables);
  const unexpected = result.rows.filter(
    (row) => !allowed.has(
      `${row.table_schema}.${row.table_name}`
    )
  );

  if (unexpected.length) {
    const error = ACS_actionError(
      "GUARDIAN_UNEXPECTED_FOREIGN_KEY",
      409
    );
    error.guardianDetails = { targetTable, unexpected };
    throw error;
  }
}

async function ACS_assertNoUserTriggers(client, tables) {
  const result = await client.query(
    `
    SELECT
      namespace.nspname AS table_schema,
      relation.relname AS table_name,
      trigger_record.tgname AS trigger_name
    FROM pg_trigger trigger_record
    JOIN pg_class relation
      ON relation.oid = trigger_record.tgrelid
    JOIN pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled <> 'D'
      AND trigger_record.tgrelid = ANY($1::regclass[])
    `,
    [tables]
  );

  if (result.rows.length) {
    const error = ACS_actionError(
      "GUARDIAN_TARGET_HAS_USER_TRIGGER",
      409
    );
    error.guardianDetails = { triggers: result.rows };
    throw error;
  }
}

async function ACS_getWritableColumns(client, tableName) {
  const result = await client.query(
    `
    SELECT attribute.attname AS column_name
    FROM pg_attribute attribute
    WHERE attribute.attrelid = $1::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
    ORDER BY attribute.attnum
    `,
    [tableName]
  );

  if (!result.rows.length) {
    throw ACS_actionError(
      "GUARDIAN_TARGET_COLUMNS_NOT_FOUND",
      500
    );
  }

  return result.rows.map((row) => row.column_name);
}

async function ACS_restoreTableFromSnapshot({
  client,
  tableName,
  snapshotName,
  orderColumn = "id"
}) {
  const columns = await ACS_getWritableColumns(
    client,
    tableName
  );

  const columnList = columns
    .map(ACS_quoteIdentifier)
    .join(", ");

  const target = tableName
    .split(".")
    .map(ACS_quoteIdentifier)
    .join(".");

  const snapshot = ACS_quoteIdentifier(snapshotName);
  const order = ACS_quoteIdentifier(orderColumn);

  await client.query(`
    INSERT INTO ${target} (${columnList})
    OVERRIDING SYSTEM VALUE
    SELECT ${columnList}
    FROM ${snapshot}
    ORDER BY ${order}
  `);
}

async function ACS_syncIdentitySequence(
  client,
  tableName,
  columnName = "id"
) {
  const sequenceResult = await client.query(
    `SELECT PG_GET_SERIAL_SEQUENCE($1, $2) AS sequence_name`,
    [tableName, columnName]
  );

  const sequenceName = sequenceResult.rows[0]?.sequence_name;

  if (!sequenceName) {
    return;
  }

  const table = tableName
    .split(".")
    .map(ACS_quoteIdentifier)
    .join(".");

  const column = ACS_quoteIdentifier(columnName);
  const maximumResult = await client.query(
    `SELECT MAX(${column})::bigint AS maximum_id FROM ${table}`
  );

  const maximumId = maximumResult.rows[0]?.maximum_id;

  if (maximumId === null || maximumId === undefined) {
    await client.query(
      `SELECT SETVAL($1::regclass, 1, false)`,
      [sequenceName]
    );
  } else {
    await client.query(
      `SELECT SETVAL($1::regclass, $2::bigint, true)`,
      [sequenceName, maximumId]
    );
  }
}

async function ACS_readCandidateSignature(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::bigint AS eligible_rows,
      MD5(
        COALESCE(
          STRING_AGG(id::text, ',' ORDER BY id),
          ''
        )
      ) AS fingerprint
    FROM acs_guardian_candidate_ids
  `);

  return {
    eligibleRows: Number(result.rows[0].eligible_rows || 0),
    fingerprint: result.rows[0].fingerprint
  };
}

function ACS_assertPreviewMatches(action, signature) {
  const previewRows = Number(
    action.preview_payload?.eligibleRows || 0
  );

  if (
    signature.eligibleRows !== previewRows ||
    signature.fingerprint !== action.preview_fingerprint
  ) {
    throw ACS_actionError(
      "GUARDIAN_PREVIEW_DATA_CHANGED",
      409
    );
  }

  if (signature.eligibleRows <= 0) {
    throw ACS_actionError(
      "GUARDIAN_ACTION_HAS_NO_ELIGIBLE_ROWS",
      409
    );
  }
}

async function ACS_measureTable(client, tableName) {
  const result = await client.query(
    `
    SELECT
      PG_RELATION_SIZE($1::regclass)::bigint AS table_bytes,
      PG_INDEXES_SIZE($1::regclass)::bigint AS index_bytes,
      PG_TOTAL_RELATION_SIZE($1::regclass)::bigint AS total_bytes
    `,
    [tableName]
  );

  return {
    tableBytes: Number(result.rows[0].table_bytes || 0),
    indexBytes: Number(result.rows[0].index_bytes || 0),
    totalBytes: Number(result.rows[0].total_bytes || 0)
  };
}

async function ACS_assertPolicyStillAllowsAction(
  client,
  actionType,
  signature,
  targetTable
) {
  const result = await client.query(
    `
    SELECT
      enabled,
      eligible_row_threshold,
      table_byte_threshold
    FROM public.acs_guardian_cleanup_policies
    WHERE action_type = $1
    FOR SHARE
    `,
    [actionType]
  );

  if (!result.rows.length || result.rows[0].enabled !== true) {
    throw ACS_actionError(
      "GUARDIAN_CLEANUP_POLICY_DISABLED",
      409
    );
  }

  const size = await ACS_measureTable(client, targetTable);
  const rowThreshold = Number(
    result.rows[0].eligible_row_threshold || 0
  );
  const byteThreshold = Number(
    result.rows[0].table_byte_threshold || 0
  );

  if (
    signature.eligibleRows < rowThreshold &&
    size.totalBytes < byteThreshold
  ) {
    throw ACS_actionError(
      "GUARDIAN_ACTION_THRESHOLD_NOT_REACHED",
      409
    );
  }

  return size;
}

async function ACS_compactClosedFinance(client, action) {
  await ACS_assertNoUnexpectedReferences(
    client,
    "public.finance_log",
    ["public.corporate_tax"]
  );

  await ACS_assertNoUserTriggers(
    client,
    ["public.finance_log"]
  );

  /*
   * El bloqueo impide que aparezcan nuevos movimientos
   * financieros o vínculos fiscales durante la limpieza.
   *
   * Si alguna tabla está ocupada, el lock_timeout general
   * cancela la operación sin modificar datos.
   */
  await client.query(`
    LOCK TABLE
      public.finance_log,
      public.corporate_tax
    IN ACCESS EXCLUSIVE MODE
  `);

  /*
   * Reconstruye exactamente la misma selección presentada
   * en la propuesta aprobada por el administrador.
   */
  await client.query(`
    CREATE TEMP TABLE acs_guardian_candidate_ids
    ON COMMIT DROP
    AS
    SELECT
      log.id
    FROM
      public.finance_log log
    WHERE
      log.source = ANY(
        ARRAY[
          'FLIGHT_REVENUE',
          'FLIGHT_FUEL',
          'FLIGHT_HANDLING',
          'FLIGHT_LANDING',
          'FLIGHT_NAVIGATION',
          'FLIGHT_OVERFLIGHT'
        ]::text[]
      )
      AND log.reference_uid LIKE
        'FLIGHT_OCCURRENCE:%'
      AND EXISTS (
        SELECT
          1
        FROM
          public.finance_history history
        WHERE
          history.airline_id =
            log.airline_id
          AND history.record_kind =
            'MONTHLY_CLOSE'
          AND history.data_quality =
            'VERIFIED'
          AND log.timestamp >= FLOOR(
            EXTRACT(
              EPOCH FROM
              history.period_start_sim
            ) * 1000
          )::bigint
          AND log.timestamp < FLOOR(
            EXTRACT(
              EPOCH FROM
              history.period_end_sim
            ) * 1000
          )::bigint
      )
  `);

  await client.query(`
    ALTER TABLE
      acs_guardian_candidate_ids
    ADD PRIMARY KEY (id)
  `);

  /*
   * La cantidad y la huella deben coincidir exactamente
   * con la propuesta temporal autorizada.
   */
  const signature =
    await ACS_readCandidateSignature(
      client
    );

  ACS_assertPreviewMatches(
    action,
    signature
  );

  const beforeSize =
    await ACS_assertPolicyStillAllowsAction(
      client,
      action.action_type,
      signature,
      "public.finance_log"
    );

  /*
   * Guarda una fotografía de todas las estructuras
   * financieras protegidas.
   */
  const protectedBefore =
    await client.query(`
      SELECT
        (
          SELECT COUNT(*)
          FROM public.finance_history
        )::bigint
          AS finance_history_rows,

        (
          SELECT COUNT(*)
          FROM public.company_finance
        )::bigint
          AS company_finance_rows,

        (
          SELECT COUNT(*)
          FROM public.corporate_tax
        )::bigint
          AS corporate_tax_rows,

        (
          SELECT MD5(
            COALESCE(
              STRING_AGG(
                tax.id::text ||
                ':' ||
                COALESCE(
                  tax.finance_log_id::text,
                  'NULL'
                ),
                ','
                ORDER BY tax.id
              ),
              ''
            )
          )
          FROM
            public.corporate_tax tax
        )
          AS corporate_tax_fingerprint
    `);

  /*
   * Comprueba que ningún impuesto apunte a una fila
   * incluida en la limpieza.
   */
  const counts =
    await client.query(`
      SELECT
        (
          SELECT COUNT(*)
          FROM public.finance_log
        )::bigint
          AS original_rows,

        (
          SELECT COUNT(*)
          FROM
            public.corporate_tax tax
          JOIN
            acs_guardian_candidate_ids candidate
          ON
            candidate.id =
              tax.finance_log_id
        )::bigint
          AS protected_tax_references
    `);

  const originalRows =
    Number(
      counts.rows[0].original_rows
    );

  const protectedTaxReferences =
    Number(
      counts.rows[0]
        .protected_tax_references
    );

  const keptRows =
    originalRows -
    signature.eligibleRows;

  if (
    protectedTaxReferences !== 0
  ) {
    throw ACS_actionError(
      "GUARDIAN_FINANCE_PROTECTED_REFERENCE_FOUND",
      409
    );
  }

  /*
   * Elimina exclusivamente las filas incluidas
   * en la propuesta autorizada.
   */
  const deletion =
    await client.query(`
      DELETE FROM
        public.finance_log log
      USING
        acs_guardian_candidate_ids candidate
      WHERE
        log.id = candidate.id
    `);

  if (
    deletion.rowCount !==
    signature.eligibleRows
  ) {
    throw ACS_actionError(
      "GUARDIAN_FINANCE_DELETE_COUNT_MISMATCH",
      409
    );
  }

  /*
   * Reconstruye físicamente finance_log y sus índices
   * sin vaciar la tabla y sin romper corporate_tax.
   */
  await client.query(`
    CLUSTER
      public.finance_log
    USING
      finance_log_pkey
  `);

  /*
   * Comprueba que las filas conservadas, los cierres,
   * las finanzas de las compañías y los 52 vínculos
   * fiscales permanezcan exactamente iguales.
   */
  const verification =
    await client.query(`
      SELECT
        (
          SELECT COUNT(*)
          FROM public.finance_log
        )::bigint
          AS restored_rows,

        (
          SELECT COUNT(*)
          FROM public.finance_history
        )::bigint
          AS finance_history_rows,

        (
          SELECT COUNT(*)
          FROM public.company_finance
        )::bigint
          AS company_finance_rows,

        (
          SELECT COUNT(*)
          FROM public.corporate_tax
        )::bigint
          AS corporate_tax_rows,

        (
          SELECT MD5(
            COALESCE(
              STRING_AGG(
                tax.id::text ||
                ':' ||
                COALESCE(
                  tax.finance_log_id::text,
                  'NULL'
                ),
                ','
                ORDER BY tax.id
              ),
              ''
            )
          )
          FROM
            public.corporate_tax tax
        )
          AS corporate_tax_fingerprint
    `);

  if (
    Number(
      verification.rows[0]
        .restored_rows
    ) !== keptRows ||

    String(
      verification.rows[0]
        .finance_history_rows
    ) !==
      String(
        protectedBefore.rows[0]
          .finance_history_rows
      ) ||

    String(
      verification.rows[0]
        .company_finance_rows
    ) !==
      String(
        protectedBefore.rows[0]
          .company_finance_rows
      ) ||

    String(
      verification.rows[0]
        .corporate_tax_rows
    ) !==
      String(
        protectedBefore.rows[0]
          .corporate_tax_rows
      ) ||

    verification.rows[0]
      .corporate_tax_fingerprint !==
      protectedBefore.rows[0]
        .corporate_tax_fingerprint
  ) {
    throw ACS_actionError(
      "GUARDIAN_FINANCE_POSTCHECK_FAILED",
      500
    );
  }

  await client.query(`
    ANALYZE
      public.finance_log
  `);

  const afterSize =
    await ACS_measureTable(
      client,
      "public.finance_log"
    );

  return {
    targetTable:
      "finance_log",

    removedRows:
      signature.eligibleRows,

    preservedRows:
      keptRows,

    relatedPassengerRowsRemoved:
      0,

    beforeSize,

    afterSize,

    releasedBytesEstimate:
      Math.max(
        0,
        beforeSize.totalBytes -
        afterSize.totalBytes
      ),

    protectedChecks: {
      financeHistory:
        "UNCHANGED",

      companyFinance:
        "UNCHANGED",

      corporateTax:
        "UNCHANGED"
    }
  };
}

async function ACS_compactClosedFlights(client, action) {
  await ACS_assertNoUnexpectedReferences(
    client,
    "public.flight_occurrences",
    ["public.acs_passenger_flight_results"]
  );
  await ACS_assertNoUnexpectedReferences(
    client,
    "public.acs_passenger_flight_results"
  );
  await ACS_assertNoUserTriggers(
    client,
    [
      "public.flight_occurrences",
      "public.acs_passenger_flight_results"
    ]
  );

  await client.query(`
    LOCK TABLE
      public.flight_occurrences,
      public.acs_passenger_flight_results
    IN ACCESS EXCLUSIVE MODE
  `);

  await client.query(`
    CREATE TEMP TABLE acs_guardian_candidate_ids
    ON COMMIT DROP
    AS
    SELECT occurrence.id
    FROM public.flight_occurrences occurrence
    WHERE occurrence.operational_status = 'ARRIVED'
      AND occurrence.dispatch_status = 'RELEASED'
      AND occurrence.settled_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.finance_history history
        WHERE history.airline_id = occurrence.airline_id
          AND history.record_kind = 'MONTHLY_CLOSE'
          AND history.data_quality = 'VERIFIED'
          AND COALESCE(
            occurrence.arrived_at,
            occurrence.scheduled_arrival_at
          ) >= history.period_start_sim
          AND COALESCE(
            occurrence.arrived_at,
            occurrence.scheduled_arrival_at
          ) < history.period_end_sim
      )
  `);

  await client.query(`
    ALTER TABLE acs_guardian_candidate_ids
    ADD PRIMARY KEY (id)
  `);

  const signature = await ACS_readCandidateSignature(client);
  ACS_assertPreviewMatches(action, signature);

  const beforeSize = await ACS_assertPolicyStillAllowsAction(
    client,
    action.action_type,
    signature,
    "public.flight_occurrences"
  );
  const passengerBeforeSize = await ACS_measureTable(
    client,
    "public.acs_passenger_flight_results"
  );

  await client.query(`
    CREATE TEMP TABLE acs_guardian_flights_keep
    ON COMMIT DROP
    AS
    SELECT occurrence.*
    FROM public.flight_occurrences occurrence
    WHERE NOT EXISTS (
      SELECT 1
      FROM acs_guardian_candidate_ids candidate
      WHERE candidate.id = occurrence.id
    )
  `);

  await client.query(`
    CREATE TEMP TABLE acs_guardian_passengers_keep
    ON COMMIT DROP
    AS
    SELECT passenger.*
    FROM public.acs_passenger_flight_results passenger
    WHERE NOT EXISTS (
      SELECT 1
      FROM acs_guardian_candidate_ids candidate
      WHERE candidate.id = passenger.occurrence_id
    )
  `);

  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.flight_occurrences)::bigint
        AS original_flights,
      (SELECT COUNT(*) FROM acs_guardian_flights_keep)::bigint
        AS kept_flights,
      (SELECT COUNT(*) FROM public.acs_passenger_flight_results)::bigint
        AS original_passengers,
      (SELECT COUNT(*) FROM acs_guardian_passengers_keep)::bigint
        AS kept_passengers
  `);

  const originalFlights = Number(counts.rows[0].original_flights);
  const keptFlights = Number(counts.rows[0].kept_flights);
  const originalPassengers = Number(
    counts.rows[0].original_passengers
  );
  const keptPassengers = Number(counts.rows[0].kept_passengers);
  const removedPassengers = originalPassengers - keptPassengers;

  if (originalFlights - keptFlights !== signature.eligibleRows) {
    throw ACS_actionError(
      "GUARDIAN_FLIGHT_SNAPSHOT_COUNT_MISMATCH",
      409
    );
  }

  const previewPassengerRows = Number(
    action.preview_payload?.relatedPassengerRows || 0
  );

  if (removedPassengers !== previewPassengerRows) {
    throw ACS_actionError(
      "GUARDIAN_PASSENGER_SNAPSHOT_COUNT_MISMATCH",
      409
    );
  }

  await client.query(`
    TRUNCATE TABLE
      public.acs_passenger_flight_results,
      public.flight_occurrences
  `);

  await ACS_restoreTableFromSnapshot({
    client,
    tableName: "public.flight_occurrences",
    snapshotName: "acs_guardian_flights_keep"
  });

  await ACS_restoreTableFromSnapshot({
    client,
    tableName: "public.acs_passenger_flight_results",
    snapshotName: "acs_guardian_passengers_keep"
  });

  await ACS_syncIdentitySequence(
    client,
    "public.flight_occurrences"
  );
  await ACS_syncIdentitySequence(
    client,
    "public.acs_passenger_flight_results"
  );

  const verification = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.flight_occurrences)::bigint
        AS restored_flights,
      (SELECT COUNT(*) FROM public.acs_passenger_flight_results)::bigint
        AS restored_passengers,
      (
        SELECT COUNT(*)
        FROM public.acs_passenger_flight_results passenger
        LEFT JOIN public.flight_occurrences occurrence
          ON occurrence.id = passenger.occurrence_id
        WHERE occurrence.id IS NULL
      )::bigint AS orphan_passengers
  `);

  if (
    Number(verification.rows[0].restored_flights) !== keptFlights ||
    Number(verification.rows[0].restored_passengers) !== keptPassengers ||
    Number(verification.rows[0].orphan_passengers) !== 0
  ) {
    throw ACS_actionError(
      "GUARDIAN_FLIGHT_POSTCHECK_FAILED",
      500
    );
  }

  await client.query("ANALYZE public.flight_occurrences");
  await client.query(
    "ANALYZE public.acs_passenger_flight_results"
  );

  const afterSize = await ACS_measureTable(
    client,
    "public.flight_occurrences"
  );
  const passengerAfterSize = await ACS_measureTable(
    client,
    "public.acs_passenger_flight_results"
  );

  return {
    targetTable: "flight_occurrences",
    companionTable: "acs_passenger_flight_results",
    removedRows: signature.eligibleRows,
    preservedRows: keptFlights,
    relatedPassengerRowsRemoved: removedPassengers,
    relatedPassengerRowsPreserved: keptPassengers,
    beforeSize,
    afterSize,
    passengerBeforeSize,
    passengerAfterSize,
    releasedBytesEstimate:
      Math.max(0, beforeSize.totalBytes - afterSize.totalBytes) +
      Math.max(
        0,
        passengerBeforeSize.totalBytes -
          passengerAfterSize.totalBytes
      ),
    orphanPassengerRows: 0
  };
}

async function ACS_compactDeletedOccAlerts(client, action) {
  await ACS_assertNoUnexpectedReferences(
    client,
    "public.occ_alerts"
  );
  await ACS_assertNoUserTriggers(
    client,
    ["public.occ_alerts"]
  );

  await client.query(`
    LOCK TABLE
      public.occ_alerts,
      public.occ_alert_dismissals
    IN ACCESS EXCLUSIVE MODE
  `);

  await client.query(`
    CREATE TEMP TABLE acs_guardian_candidate_ids
    ON COMMIT DROP
    AS
    SELECT alert.id
    FROM public.occ_alerts alert
    WHERE alert.deleted_at IS NOT NULL
  `);

  await client.query(`
    ALTER TABLE acs_guardian_candidate_ids
    ADD PRIMARY KEY (id)
  `);

  const signature = await ACS_readCandidateSignature(client);
  ACS_assertPreviewMatches(action, signature);

  const beforeSize = await ACS_assertPolicyStillAllowsAction(
    client,
    action.action_type,
    signature,
    "public.occ_alerts"
  );

  await client.query(`
    CREATE TEMP TABLE acs_guardian_occ_alerts_keep
    ON COMMIT DROP
    AS
    SELECT alert.*
    FROM public.occ_alerts alert
    WHERE NOT EXISTS (
      SELECT 1
      FROM acs_guardian_candidate_ids candidate
      WHERE candidate.id = alert.id
    )
  `);

  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.occ_alerts)::bigint
        AS original_rows,
      (SELECT COUNT(*) FROM acs_guardian_occ_alerts_keep)::bigint
        AS kept_rows
  `);

  const originalRows = Number(counts.rows[0].original_rows);
  const keptRows = Number(counts.rows[0].kept_rows);

  if (originalRows - keptRows !== signature.eligibleRows) {
    throw ACS_actionError(
      "GUARDIAN_OCC_ALERT_SNAPSHOT_COUNT_MISMATCH",
      409
    );
  }

  const dismissalDelete = await client.query(`
    DELETE FROM public.occ_alert_dismissals dismissal
    USING acs_guardian_candidate_ids candidate
    WHERE dismissal.alert_id = candidate.id
  `);

  await client.query("TRUNCATE TABLE public.occ_alerts");

  await ACS_restoreTableFromSnapshot({
    client,
    tableName: "public.occ_alerts",
    snapshotName: "acs_guardian_occ_alerts_keep"
  });

  await ACS_syncIdentitySequence(
    client,
    "public.occ_alerts"
  );

  const verification = await client.query(`
    SELECT COUNT(*)::bigint AS restored_rows
    FROM public.occ_alerts
  `);

  if (Number(verification.rows[0].restored_rows) !== keptRows) {
    throw ACS_actionError(
      "GUARDIAN_OCC_ALERT_POSTCHECK_FAILED",
      500
    );
  }

  await client.query("ANALYZE public.occ_alerts");
  const afterSize = await ACS_measureTable(
    client,
    "public.occ_alerts"
  );

  return {
    targetTable: "occ_alerts",
    removedRows: signature.eligibleRows,
    preservedRows: keptRows,
    dismissalMarkersRemoved: dismissalDelete.rowCount,
    beforeSize,
    afterSize,
    releasedBytesEstimate:
      Math.max(0, beforeSize.totalBytes - afterSize.totalBytes)
  };
}

const EXECUTORS = Object.freeze({
  [ACTIONS.FINANCE_CLOSED_DETAIL_COMPACTION]:
    ACS_compactClosedFinance,
  [ACTIONS.FLIGHT_HISTORY_COMPACTION]:
    ACS_compactClosedFlights,
  [ACTIONS.OCC_DELETED_ALERTS_COMPACTION]:
    ACS_compactDeletedOccAlerts
});

async function ACS_recordExecutionFailure({
  actionId,
  administratorId,
  sourceIP,
  error
}) {
  const details = {
    error: error.message,
    guardianDetails: error.guardianDetails || null,
    automaticCleanup: false
  };

  await pool.query(
    `
    WITH failed_action AS (
      UPDATE public.acs_guardian_actions
      SET
        status = 'FAILED',
        completed_at = CURRENT_TIMESTAMP,
        failure_message = $3
      WHERE id = $1
        AND requested_by_administrator_id = $2
        AND status = 'PREVIEWED'
      RETURNING id
    )
    INSERT INTO public.acs_guardian_audit_log (
      administrator_id,
      event_type,
      action_id,
      source_ip,
      details
    )
    SELECT
      $2,
      'GUARDIAN_ACTION_EXECUTION_FAILED',
      id,
      $4,
      $5::jsonb
    FROM failed_action
    `,
    [
      actionId,
      administratorId,
      String(error.message || "GUARDIAN_EXECUTION_FAILED")
        .slice(0, 1000),
      sourceIP,
      JSON.stringify(details)
    ]
  );
}

export async function ACS_executeGuardianAction({
  actionId,
  actionToken,
  confirmationPhrase,
  administratorId,
  sourceIP = null
}) {
  const normalizedActionId = ACS_normalizePositiveId(
    actionId,
    "GUARDIAN_ACTION_ID_INVALID"
  );
  const normalizedAdministratorId = ACS_normalizePositiveId(
    administratorId,
    "GUARDIAN_ADMINISTRATOR_INVALID"
  );

  const normalizedToken = String(actionToken || "");
  const normalizedPhrase = String(confirmationPhrase || "");

  if (!normalizedToken) {
    throw ACS_actionError(
      "GUARDIAN_ACTION_TOKEN_REQUIRED",
      400
    );
  }

  if (!normalizedPhrase) {
    throw ACS_actionError(
      "GUARDIAN_CONFIRMATION_PHRASE_REQUIRED",
      400
    );
  }

  const client = await pool.connect();
  let executionStarted = false;

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");

    const lockResult = await client.query(
      `SELECT PG_TRY_ADVISORY_XACT_LOCK(HASHTEXT($1)) AS acquired`,
      [ACTION_LOCK_KEY]
    );

    if (lockResult.rows[0]?.acquired !== true) {
      throw ACS_actionError(
        "GUARDIAN_ANOTHER_ACTION_IS_RUNNING",
        409
      );
    }

    const actionResult = await client.query(
      `
      SELECT
        id,
        action_type,
        requested_by_administrator_id,
        preview_payload,
        preview_fingerprint,
        action_token_hash,
        confirmation_phrase,
        status,
        expires_at,
        created_at
      FROM public.acs_guardian_actions
      WHERE id = $1
        AND requested_by_administrator_id = $2
      FOR UPDATE
      `,
      [normalizedActionId, normalizedAdministratorId]
    );

    if (!actionResult.rows.length) {
      throw ACS_actionError(
        "GUARDIAN_ACTION_NOT_FOUND",
        404
      );
    }

    const action = actionResult.rows[0];

    if (action.status !== "PREVIEWED") {
      throw ACS_actionError(
        "GUARDIAN_ACTION_NOT_PREVIEWED",
        409
      );
    }

    if (new Date(action.expires_at).getTime() <= Date.now()) {
      throw ACS_actionError(
        "GUARDIAN_ACTION_PREVIEW_EXPIRED",
        409
      );
    }

    if (
      !ACS_safeEqual(
        ACS_hashToken(normalizedToken),
        action.action_token_hash
      )
    ) {
      throw ACS_actionError(
        "GUARDIAN_ACTION_TOKEN_INVALID",
        403
      );
    }

    if (
      !ACS_safeEqual(
        normalizedPhrase,
        action.confirmation_phrase
      )
    ) {
      throw ACS_actionError(
        "GUARDIAN_CONFIRMATION_PHRASE_INVALID",
        403
      );
    }

    const executor = EXECUTORS[action.action_type];

    if (!executor) {
      throw ACS_actionError(
        "GUARDIAN_ACTION_TYPE_NOT_ALLOWED",
        400
      );
    }

    await client.query(
      `
      UPDATE public.acs_guardian_actions
      SET
        status = 'EXECUTING',
        started_at = CURRENT_TIMESTAMP,
        failure_message = NULL
      WHERE id = $1
      `,
      [normalizedActionId]
    );

    executionStarted = true;
    const result = await executor(client, action);

    await client.query(
      `
      UPDATE public.acs_guardian_actions
      SET
        status = 'COMPLETED',
        completed_at = CURRENT_TIMESTAMP,
        result_payload = $2::jsonb,
        failure_message = NULL
      WHERE id = $1
      `,
      [normalizedActionId, JSON.stringify(result)]
    );

    await client.query(
      `
      INSERT INTO public.acs_guardian_audit_log (
        administrator_id,
        event_type,
        action_id,
        source_ip,
        details
      )
      VALUES (
        $1,
        'GUARDIAN_ACTION_COMPLETED',
        $2,
        $3,
        $4::jsonb
      )
      `,
      [
        normalizedAdministratorId,
        normalizedActionId,
        sourceIP,
        JSON.stringify({
          actionType: action.action_type,
          result,
          automaticCleanup: false,
          administratorConfirmed: true
        })
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      action: {
        id: normalizedActionId,
        actionType: action.action_type,
        status: "COMPLETED",
        result,
        automaticCleanup: false,
        administratorConfirmed: true
      }
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    if (executionStarted) {
      try {
        await ACS_recordExecutionFailure({
          actionId: normalizedActionId,
          administratorId: normalizedAdministratorId,
          sourceIP,
          error
        });
      } catch (auditError) {
        console.error(
          "[ACS Guardian] failure audit failed:",
          auditError.message
        );
      }
    }

    if (error.code === "55P03") {
      throw ACS_actionError(
        "GUARDIAN_OPERATIONAL_TABLE_BUSY",
        409
      );
    }

    throw error;
  } finally {
    client.release();
  }
}
