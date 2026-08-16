/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   CLEANUP DIAGNOSTICS
   ------------------------------------------------------------
   Read-only detectors. They identify rows that are already
   represented by verified ACS history or were soft-deleted.

   IMPORTANT:
   - No rows are deleted.
   - No tables are modified.
   - No indexes are modified.
   - No VACUUM or REINDEX is executed.
   ============================================================ */

import { pool } from "../db/pool.js";

const ACTIONS = Object.freeze({
  FINANCE: "FINANCE_CLOSED_DETAIL_COMPACTION",
  FLIGHTS: "FLIGHT_HISTORY_COMPACTION",
  OCC_ALERTS: "OCC_DELETED_ALERTS_COMPACTION"
});

function ACS_toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ACS_normalizePolicy(row) {
  return {
    actionType: row.action_type,
    enabled: row.enabled === true,
    eligibleRowThreshold: ACS_toNumber(
      row.eligible_row_threshold
    ),
    tableByteThreshold: ACS_toNumber(
      row.table_byte_threshold
    )
  };
}

function ACS_buildDiagnostic({
  actionType,
  title,
  table,
  row,
  policy
}) {
  const eligibleRows = ACS_toNumber(
    row.eligible_rows
  );

  const tableBytes = ACS_toNumber(
    row.table_bytes
  );

  const totalBytes = ACS_toNumber(
    row.total_bytes
  );

  const indexBytes = ACS_toNumber(
    row.index_bytes
  );

  const rowThresholdReached =
    eligibleRows >= policy.eligibleRowThreshold;

  const tableThresholdReached =
    totalBytes >= policy.tableByteThreshold;

  const thresholdReached =
    policy.enabled &&
    eligibleRows > 0 &&
    (
      rowThresholdReached ||
      tableThresholdReached
    );

  return {
    actionType,
    title,
    table,

    readOnly: true,
    automaticCleanup: false,

    status:
      eligibleRows === 0
        ? "CLEAN"
        : thresholdReached
          ? "ATTENTION"
          : "MONITORING",

    thresholdReached,

    reasons: {
      eligibleRows: rowThresholdReached,
      tableSize: tableThresholdReached
    },

    policy,

    metrics: {
      eligibleRows,
      tableBytes,
      totalBytes,
      indexBytes,

      firstEligibleAt:
        row.first_eligible_at || null,

      lastEligibleAt:
        row.last_eligible_at || null,

      fingerprint:
        row.preview_fingerprint,

      ...(
        row.related_passenger_rows !== undefined
          ? {
              relatedPassengerRows:
                ACS_toNumber(
                  row.related_passenger_rows
                )
            }
          : {}
      ),

      ...(
        row.closed_flight_sets !== undefined
          ? {
              closedFlightSets:
                ACS_toNumber(
                  row.closed_flight_sets
                )
            }
          : {}
      )
    }
  };
}

async function ACS_readPolicies(client) {
  const result = await client.query(
    `
    SELECT
      action_type,
      enabled,
      eligible_row_threshold,
      table_byte_threshold
    FROM public.acs_guardian_cleanup_policies
    WHERE action_type = ANY($1::text[])
    `,
    [Object.values(ACTIONS)]
  );

  const policies = new Map(
    result.rows.map((row) => [
      row.action_type,
      ACS_normalizePolicy(row)
    ])
  );

  for (
    const actionType of Object.values(ACTIONS)
  ) {
    if (!policies.has(actionType)) {
      throw new Error(
        `GUARDIAN_POLICY_NOT_FOUND:${actionType}`
      );
    }
  }

  return policies;
}

/* ============================================================
   CLOSED FLIGHT HISTORY
   ------------------------------------------------------------
   Eligible only when:

   - operational_status = ARRIVED
   - dispatch_status = RELEASED
   - flight was settled
   - its financial month exists in finance_history
   - the monthly close is MONTHLY_CLOSE / VERIFIED

   Passenger results linked to those occurrences are counted,
   but nothing is deleted here.
   ============================================================ */

async function ACS_detectClosedFlightHistory(
  client
) {
  const result = await client.query(`
    WITH eligible AS MATERIALIZED (
      SELECT
        occurrence.id,
        occurrence.scheduled_departure_at,
        occurrence.scheduled_arrival_at
      FROM public.flight_occurrences occurrence
      WHERE
        occurrence.operational_status = 'ARRIVED'
        AND occurrence.dispatch_status = 'RELEASED'
        AND occurrence.settled_at IS NOT NULL

        AND EXISTS (
          SELECT 1
          FROM public.finance_history history
          WHERE
            history.airline_id =
              occurrence.airline_id

            AND history.record_kind =
              'MONTHLY_CLOSE'

            AND history.data_quality =
              'VERIFIED'

            AND COALESCE(
              occurrence.arrived_at,
              occurrence.scheduled_arrival_at
            ) >= history.period_start_sim

            AND COALESCE(
              occurrence.arrived_at,
              occurrence.scheduled_arrival_at
            ) < history.period_end_sim
        )
    )

    SELECT
      COUNT(*)::bigint AS eligible_rows,

      MIN(
        scheduled_departure_at
      ) AS first_eligible_at,

      MAX(
        scheduled_arrival_at
      ) AS last_eligible_at,

      MD5(
        COALESCE(
          STRING_AGG(
            id::text,
            ','
            ORDER BY id
          ),
          ''
        )
      ) AS preview_fingerprint,

      (
        SELECT COUNT(*)::bigint
        FROM
          public.acs_passenger_flight_results
            passenger
        JOIN eligible
          ON eligible.id =
            passenger.occurrence_id
      ) AS related_passenger_rows,

      PG_RELATION_SIZE(
        'public.flight_occurrences'::regclass
      )::bigint AS table_bytes,

      PG_TOTAL_RELATION_SIZE(
        'public.flight_occurrences'::regclass
      )::bigint AS total_bytes,

      PG_INDEXES_SIZE(
        'public.flight_occurrences'::regclass
      )::bigint AS index_bytes

    FROM eligible
  `);

  return result.rows[0];
}

/* ============================================================
   CLOSED FINANCIAL FLIGHT DETAILS
   ------------------------------------------------------------
   Only the six flight settlement entries created by ACS:

   - FLIGHT_REVENUE
   - FLIGHT_FUEL
   - FLIGHT_HANDLING
   - FLIGHT_LANDING
   - FLIGHT_NAVIGATION
   - FLIGHT_OVERFLIGHT

   The corresponding month must already be closed and VERIFIED.
   Current/open financial periods remain untouched.
   ============================================================ */

async function ACS_detectClosedFinanceDetail(
  client
) {
  const result = await client.query(`
    WITH eligible AS MATERIALIZED (
      SELECT
        log.id,
        log.timestamp,
        log.reference_uid
      FROM public.finance_log log
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
          SELECT 1
          FROM public.finance_history history
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
    )

    SELECT
      COUNT(*)::bigint AS eligible_rows,

      CASE
        WHEN MIN(timestamp) IS NULL
          THEN NULL
        ELSE
          TO_TIMESTAMP(
            MIN(timestamp)::double precision
            / 1000.0
          ) AT TIME ZONE 'UTC'
      END AS first_eligible_at,

      CASE
        WHEN MAX(timestamp) IS NULL
          THEN NULL
        ELSE
          TO_TIMESTAMP(
            MAX(timestamp)::double precision
            / 1000.0
          ) AT TIME ZONE 'UTC'
      END AS last_eligible_at,

      MD5(
        COALESCE(
          STRING_AGG(
            id::text,
            ','
            ORDER BY id
          ),
          ''
        )
      ) AS preview_fingerprint,

      COUNT(
        DISTINCT SPLIT_PART(
          reference_uid,
          ':',
          2
        )
      )::bigint AS closed_flight_sets,

      PG_RELATION_SIZE(
        'public.finance_log'::regclass
      )::bigint AS table_bytes,

      PG_TOTAL_RELATION_SIZE(
        'public.finance_log'::regclass
      )::bigint AS total_bytes,

      PG_INDEXES_SIZE(
        'public.finance_log'::regclass
      )::bigint AS index_bytes

    FROM eligible
  `);

  return result.rows[0];
}

/* ============================================================
   DELETED OCC MESSAGES
   ------------------------------------------------------------
   OCC already hides these messages from players by setting
   deleted_at. Guardian only counts the physically retained rows.
   ============================================================ */

async function ACS_detectDeletedOccAlerts(
  client
) {
  const result = await client.query(`
    WITH eligible AS MATERIALIZED (
      SELECT
        alert.id,
        alert.deleted_at
      FROM public.occ_alerts alert
      WHERE alert.deleted_at IS NOT NULL
    )

    SELECT
      COUNT(*)::bigint AS eligible_rows,

      MIN(
        deleted_at
      ) AS first_eligible_at,

      MAX(
        deleted_at
      ) AS last_eligible_at,

      MD5(
        COALESCE(
          STRING_AGG(
            id::text,
            ','
            ORDER BY id
          ),
          ''
        )
      ) AS preview_fingerprint,

      PG_RELATION_SIZE(
        'public.occ_alerts'::regclass
      )::bigint AS table_bytes,

      PG_TOTAL_RELATION_SIZE(
        'public.occ_alerts'::regclass
      )::bigint AS total_bytes,

      PG_INDEXES_SIZE(
        'public.occ_alerts'::regclass
      )::bigint AS index_bytes

    FROM eligible
  `);

  return result.rows[0];
}

/* ============================================================
   COMPLETE GUARDIAN DIAGNOSTIC
   ------------------------------------------------------------
   A REPEATABLE READ / READ ONLY transaction guarantees that
   every detector observes the same PostgreSQL snapshot.
   ============================================================ */

export async function ACS_getGuardianDiagnostics() {
  const client = await pool.connect();

  try {
    await client.query(`
      BEGIN TRANSACTION
      ISOLATION LEVEL REPEATABLE READ
      READ ONLY
    `);

    const policies =
      await ACS_readPolicies(client);

    const flights =
      await ACS_detectClosedFlightHistory(
        client
      );

    const finance =
      await ACS_detectClosedFinanceDetail(
        client
      );

    const occAlerts =
      await ACS_detectDeletedOccAlerts(
        client
      );

    await client.query("COMMIT");

    return {
      ok: true,

      authority:
        "POSTGRESQL_READ_ONLY",

      capturedAt:
        new Date().toISOString(),

      automaticCleanup: false,

      diagnostics: [
        ACS_buildDiagnostic({
          actionType:
            ACTIONS.FINANCE,

          title:
            "Detalle financiero de vuelos cerrados",

          table:
            "finance_log",

          row:
            finance,

          policy:
            policies.get(
              ACTIONS.FINANCE
            )
        }),

        ACS_buildDiagnostic({
          actionType:
            ACTIONS.FLIGHTS,

          title:
            "Historial de vuelos cerrados",

          table:
            "flight_occurrences",

          row:
            flights,

          policy:
            policies.get(
              ACTIONS.FLIGHTS
            )
        }),

        ACS_buildDiagnostic({
          actionType:
            ACTIONS.OCC_ALERTS,

          title:
            "Mensajes OCC borrados",

          table:
            "occ_alerts",

          row:
            occAlerts,

          policy:
            policies.get(
              ACTIONS.OCC_ALERTS
            )
        })
      ]
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "[ACS Guardian] diagnostics rollback failed:",
        rollbackError.message
      );
    }

    throw error;
  } finally {
    client.release();
  }
}
