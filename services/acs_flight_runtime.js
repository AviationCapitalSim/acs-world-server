/* ============================================================
   ACS FLIGHT RUNTIME — SERVER OPERATIONAL AUTHORITY
   ------------------------------------------------------------
   Owns:
   - Flight occurrence generation
   - Dispatch and maintenance holds
   - En-route and arrival transitions
   - Flight settlement orchestration

   Does not own:
   - Route planning
   - Weekly schedule editing
   - Maintenance lifecycle
   - Frontend rendering
   - ACS simulated time

   Authorities:
   - PostgreSQL
   - acs_get_current_sim_time()
   ============================================================ */

import { pool } from "../db/pool.js";

import {
  applyHROpsImpactForAirline
} from "../routes/hr.js";

/* ============================================================
   ACS HR PRE-DISPATCH RESOLVER
   ------------------------------------------------------------
   Fail-open protection:

   - Attempts to resolve pending HR decisions.
   - Never stops the global Flight Runtime.
   - A failure for one airline does not affect another airline.
   - The dispatcher remains the operational authority.
   ============================================================ */

async function ACS_ensureHRDecisionsForDueFlights() {
  try {
    const airlinesResult = await pool.query(
      `
      WITH clock AS MATERIALIZED (
        SELECT
          acs_get_current_sim_time()
            AS sim_time
      )

      SELECT DISTINCT
        occurrence.airline_id

      FROM public.flight_occurrences occurrence

      CROSS JOIN clock

      WHERE occurrence.operational_status =
            'PLANNED'

        AND occurrence.dispatch_status =
            'PENDING'

        AND occurrence.hr_impact_resolved_at
            IS NULL

        AND EXISTS (
          SELECT 1
          FROM public.schedule_items schedule
          WHERE schedule.id =
                occurrence.schedule_item_id
            AND schedule.airline_id =
                occurrence.airline_id
            AND schedule.item_type = 'flight'
            AND LOWER(
                  COALESCE(schedule.status, '')
                ) NOT IN (
                  'cancelled',
                  'canceled'
                )
        )

        AND occurrence.scheduled_departure_at >=
            DATE_TRUNC(
              'day',
              clock.sim_time
            ) - INTERVAL '1 day'

        AND occurrence.scheduled_departure_at <
            DATE_TRUNC(
              'day',
              clock.sim_time
            ) + INTERVAL '1 day'

      ORDER BY
        occurrence.airline_id

      LIMIT 40
      `
    );

    let resolvedAirlines = 0;
    let resolvedOccurrences = 0;
    const failedAirlines = [];

    const airlineIds = airlinesResult.rows
      .map(row => Number(row.airline_id))
      .filter(
        airlineId =>
          Number.isInteger(airlineId) &&
          airlineId > 0
      );

    let nextAirlineIndex = 0;

    const workerCount = Math.min(
      4,
      airlineIds.length
    );

    async function resolveNextAirline() {
      while (true) {
        const currentIndex = nextAirlineIndex;
        nextAirlineIndex += 1;

        if (currentIndex >= airlineIds.length) {
          return;
        }

        const airlineId = airlineIds[currentIndex];

        try {
          const result =
            await applyHROpsImpactForAirline(
              airlineId
            );

          resolvedAirlines += 1;

          resolvedOccurrences += Number(
            result?.applied_count || 0
          );
        } catch (error) {
          failedAirlines.push({
            airlineId,
            error:
              error?.message ||
              "HR_DECISION_RESOLUTION_FAILED"
          });

          console.error(
            "ACS_HR_PRE_DISPATCH_AIRLINE_ERROR",
            {
              airlineId,
              error
            }
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: workerCount },
        () => resolveNextAirline()
      )
    );

    return {
      ok: failedAirlines.length === 0,
      globalFailure: false,
      selectedAirlines: airlineIds.length,
      resolvedAirlines,
      resolvedOccurrences,
      failedAirlines
    };
  } catch (error) {
    console.error(
      "ACS_HR_PRE_DISPATCH_GLOBAL_ERROR",
      error
    );

    return {
      ok: false,
      globalFailure: true,
      selectedAirlines: 0,
      resolvedAirlines: 0,
      resolvedOccurrences: 0,
      failedAirlines: [],
      error:
        error?.message ||
        "HR_PRE_DISPATCH_GLOBAL_ERROR"
    };
  }
}

let ACS_HR_decisionWorkerPromise = null;

function ACS_startHRDecisionWorker() {
  if (ACS_HR_decisionWorkerPromise) {
    return false;
  }

  ACS_HR_decisionWorkerPromise = (async () => {
    while (true) {
      const result =
        await ACS_ensureHRDecisionsForDueFlights();

      if (result?.globalFailure === true) {
        break;
      }

      const selectedAirlines = Number(
        result?.selectedAirlines || 0
      );

      const resolvedOccurrences = Number(
        result?.resolvedOccurrences || 0
      );

      if (selectedAirlines <= 0) {
        break;
      }

      if (resolvedOccurrences <= 0) {
        break;
      }
    }
  })()
    .catch(error => {
      console.error(
        "ACS_HR_DECISION_WORKER_ERROR",
        error
      );
    })
    .finally(() => {
      ACS_HR_decisionWorkerPromise = null;
    });

  return true;
}

function ACS_normalizeHorizonDays(value) {
  const days = Number(value);

  if (!Number.isInteger(days)) {
    return 8;
  }

  return Math.min(
    21,
    Math.max(1, days)
  );
}

async function ACS_cancelFutureFlightOccurrences(
  client
) {
  const result = await client.query(
    `
    WITH clock AS (
      SELECT
        acs_get_current_sim_time()
          AS sim_time
    )
    UPDATE public.flight_occurrences
      AS occurrence
    SET
      operational_status = 'CANCELLED',
      dispatch_status = 'NOT_DISPATCHED',
      dispatch_reason = 'SCHEDULE_CANCELLED',
      updated_at = CURRENT_TIMESTAMP
    FROM public.schedule_items schedule
    CROSS JOIN clock
    WHERE
      occurrence.schedule_item_id =
        schedule.id
      AND LOWER(
        COALESCE(schedule.status, '')
      ) IN (
        'cancelled',
        'canceled'
      )
      AND occurrence.operational_status IN (
        'PLANNED',
        'HELD'
      )
      AND occurrence.dispatch_status IN (
        'PENDING',
        'NOT_DISPATCHED'
      )
    RETURNING occurrence.id
    `
  );

  return result.rowCount;
}

async function ACS_materializeFlightOccurrences(
  client,
  horizonSimDays
) {
  const result = await client.query(
    `
    WITH clock AS MATERIALIZED (
      SELECT
        acs_get_current_sim_time()
          AS sim_time,
        acs_get_current_sim_time()
          + (
            $1::integer *
            INTERVAL '1 day'
          ) AS horizon_end
    ),
    week_starts AS MATERIALIZED (
      SELECT generate_series(
        date_trunc(
          'week',
          clock.sim_time
        ) - INTERVAL '7 days',
        date_trunc(
          'week',
          clock.horizon_end
        ) + INTERVAL '7 days',
        INTERVAL '7 days'
      ) AS week_start
      FROM clock
    ),
    base_schedule AS MATERIALIZED (
      SELECT
        schedule.id
          AS schedule_item_id,
        schedule.schedule_uid,
        schedule.route_plan_id,
        schedule.route_uid,
        schedule.airline_id,
        UPPER(schedule.origin)
          AS origin,
        UPPER(schedule.destination)
          AS destination,
        schedule.model_key,
        schedule.aircraft_id,
        schedule.aircraft_registration,
        schedule.flight_number,
        schedule.paired_flight_number,
        schedule.distance_nm,
        schedule.dep_abs_min,
        schedule.arr_abs_min,
        schedule.block_time_min,
        schedule.turnaround_min
      FROM public.schedule_items schedule
      WHERE
        LOWER(
          COALESCE(
            schedule.item_type,
            ''
          )
        ) = 'flight'
        AND LOWER(
          COALESCE(
            schedule.status,
            ''
          )
        ) = 'assigned'
        AND schedule.route_plan_id
            IS NOT NULL
        AND schedule.aircraft_id
            IS NOT NULL
        AND schedule.dep_abs_min
            IS NOT NULL
        AND schedule.arr_abs_min
            IS NOT NULL
        AND COALESCE(
          schedule.block_time_min,
          0
        ) > 0
        AND schedule.arr_abs_min >
            schedule.dep_abs_min
    ),
    expanded_schedule AS MATERIALIZED (
      SELECT
        base.*,
        base.schedule_uid
          AS occurrence_schedule_uid,
        base.flight_number
          AS occurrence_flight_number,
        'OUTBOUND'::text
          AS occurrence_direction,
        base.origin
          AS occurrence_origin,
        base.destination
          AS occurrence_destination,
        base.dep_abs_min
          AS occurrence_dep_abs_min,
        base.arr_abs_min
          AS occurrence_arr_abs_min
      FROM base_schedule base

      UNION ALL

      SELECT
        base.*,
        base.schedule_uid || ':RETURN'
          AS occurrence_schedule_uid,
        base.paired_flight_number
          AS occurrence_flight_number,
        'RETURN'::text
          AS occurrence_direction,
        base.destination
          AS occurrence_origin,
        base.origin
          AS occurrence_destination,
        base.arr_abs_min
          + COALESCE(
              base.turnaround_min,
              0
            )
          AS occurrence_dep_abs_min,
        base.arr_abs_min
          + COALESCE(
              base.turnaround_min,
              0
            )
          + base.block_time_min
          AS occurrence_arr_abs_min
      FROM base_schedule base
      WHERE NULLIF(
        TRIM(base.paired_flight_number),
        ''
      ) IS NOT NULL
    ),
    candidates AS MATERIALIZED (
      SELECT
        expanded.*,
        weeks.week_start
          + (
            expanded.occurrence_dep_abs_min *
            INTERVAL '1 minute'
          ) AS scheduled_departure_at,
        weeks.week_start
          + (
            expanded.occurrence_arr_abs_min *
            INTERVAL '1 minute'
          ) AS scheduled_arrival_at
      FROM expanded_schedule expanded
      CROSS JOIN week_starts weeks
    )
    INSERT INTO public.flight_occurrences (
      occurrence_key,
      airline_id,
      route_plan_id,
      schedule_item_id,
      aircraft_id,
      route_uid,
      schedule_uid,
      flight_number,
      flight_direction,
      origin,
      destination,
      aircraft_registration,
      model_key,
      distance_nm,
      block_time_min,
      turnaround_min,
      scheduled_departure_at,
      scheduled_arrival_at
    )
    SELECT
      candidates.occurrence_schedule_uid
        || ':'
        || candidates.occurrence_direction
        || ':'
        || TO_CHAR(
          candidates.scheduled_departure_at,
          'YYYYMMDDHH24MI'
        ),
      candidates.airline_id,
      candidates.route_plan_id,
      candidates.schedule_item_id,
      candidates.aircraft_id,
      candidates.route_uid,
      candidates.occurrence_schedule_uid,
      candidates.occurrence_flight_number,
      candidates.occurrence_direction,
      candidates.occurrence_origin,
      candidates.occurrence_destination,
      candidates.aircraft_registration,
      candidates.model_key,
      COALESCE(
        candidates.distance_nm,
        0
      ),
      candidates.block_time_min,
      COALESCE(
        candidates.turnaround_min,
        0
      ),
      candidates.scheduled_departure_at,
      candidates.scheduled_arrival_at
    FROM candidates
    CROSS JOIN clock
    WHERE
      candidates.scheduled_arrival_at >
        clock.sim_time
      AND candidates.scheduled_departure_at <
        clock.horizon_end
    ON CONFLICT (
      schedule_item_id,
      scheduled_departure_at
    )
    DO UPDATE SET
      aircraft_id =
        EXCLUDED.aircraft_id,
      aircraft_registration =
        EXCLUDED.aircraft_registration,
      model_key =
        EXCLUDED.model_key,
      flight_number =
        EXCLUDED.flight_number,
      origin =
        EXCLUDED.origin,
      destination =
        EXCLUDED.destination,
      distance_nm =
        EXCLUDED.distance_nm,
      block_time_min =
        EXCLUDED.block_time_min,
      turnaround_min =
        EXCLUDED.turnaround_min,
      scheduled_arrival_at =
        EXCLUDED.scheduled_arrival_at,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE
      flight_occurrences.operational_status IN (
        'PLANNED',
        'HELD'
      )
      AND flight_occurrences.dispatch_status IN (
        'PENDING',
        'NOT_DISPATCHED'
      )
      AND ROW(
        flight_occurrences.aircraft_id,
        flight_occurrences.aircraft_registration,
        flight_occurrences.model_key,
        flight_occurrences.flight_number,
        flight_occurrences.origin,
        flight_occurrences.destination,
        flight_occurrences.distance_nm,
        flight_occurrences.block_time_min,
        flight_occurrences.turnaround_min,
        flight_occurrences.scheduled_arrival_at
      ) IS DISTINCT FROM ROW(
        EXCLUDED.aircraft_id,
        EXCLUDED.aircraft_registration,
        EXCLUDED.model_key,
        EXCLUDED.flight_number,
        EXCLUDED.origin,
        EXCLUDED.destination,
        EXCLUDED.distance_nm,
        EXCLUDED.block_time_min,
        EXCLUDED.turnaround_min,
        EXCLUDED.scheduled_arrival_at
      )
    RETURNING id
    `,
    [horizonSimDays]
  );

  return result.rowCount;
}
export async function ACS_dispatchFlightOccurrences({
  batchSize = 500
} = {}) {
  const hrWorkerStarted =
    ACS_startHRDecisionWorker();

  const hrResolution = {
    ok: true,
    mode: "ASYNC_NON_BLOCKING",
    workerStarted: hrWorkerStarted,
    workerRunning:
      ACS_HR_decisionWorkerPromise !== null,
    globalFailure: false,
    failedAirlines: []
  };

  const client = await pool.connect();

  const normalizedBatchSize = Math.min(
    2000,
    Math.max(
      1,
      Number.parseInt(batchSize, 10) || 500
    )
  );

  const hrGlobalFailOpen = false;
  const hrFailedAirlineIds = [];

  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `
        WITH clock AS MATERIALIZED (
          SELECT
            acs_get_current_sim_time() AS sim_time
        ),

        due_occurrences AS MATERIALIZED (
          SELECT
            occurrence.id,
            occurrence.aircraft_id,
            occurrence.airline_id,
            occurrence.origin,
            occurrence.destination,
            occurrence.scheduled_departure_at,
            occurrence.scheduled_arrival_at,
            occurrence.block_time_min,
            occurrence.turnaround_min,

            occurrence.hr_impact_resolved_at,
            occurrence.hr_impact_level,
            occurrence.hr_impact_cause,
            occurrence.hr_operational_outcome,
            occurrence.hr_delay_minutes,
            occurrence.hr_release_at,
            occurrence.hr_cancel_reason,

            clock.sim_time,

            UPPER(
              COALESCE(fleet.current_airport, '')
            ) AS fleet_current_airport,

            UPPER(
              COALESCE(occurrence.origin, '')
            ) AS occurrence_origin,

            previous_arrival.arrived_at
              AS previous_arrived_at,

            previous_arrival.turnaround_min
              AS previous_turnaround_min,

            (
              previous_arrival.arrived_at IS NULL

              OR clock.sim_time >=
                previous_arrival.arrived_at
                + (
                    previous_arrival.turnaround_min
                    * INTERVAL '1 minute'
                  )
            ) AS turnaround_ready,

            EXISTS (
              SELECT 1
              FROM public.flight_occurrences active
              WHERE active.airline_id =
                    occurrence.airline_id
                AND active.aircraft_id =
                    occurrence.aircraft_id
                AND active.id <>
                    occurrence.id
                AND active.dispatch_status =
                    'RELEASED'
                AND active.operational_status IN (
                  'DISPATCHED',
                  'EN_ROUTE'
                )
            ) AS has_active_occurrence,

            EXISTS (
              SELECT 1
              FROM public.flight_occurrences earlier
              WHERE earlier.airline_id =
                    occurrence.airline_id
                AND earlier.aircraft_id =
                    occurrence.aircraft_id
                AND earlier.id <>
                    occurrence.id
                AND (
                  (
                    earlier.operational_status =
                      'PLANNED'
                    AND earlier.dispatch_status =
                      'PENDING'
                  )
                  OR
                  (
                    earlier.operational_status =
                      'HELD'
                    AND earlier.dispatch_status =
                      'NOT_DISPATCHED'
                  )
                )
                AND earlier.scheduled_departure_at >=
                    DATE_TRUNC(
                      'day',
                      occurrence.scheduled_departure_at
                    )
                AND (
                  earlier.scheduled_departure_at <
                    occurrence.scheduled_departure_at

                  OR (
                    earlier.scheduled_departure_at =
                      occurrence.scheduled_departure_at

                    AND earlier.id <
                      occurrence.id
                  )
                )
            ) AS has_earlier_unresolved,

            maintenance_status.a_check_status,
            maintenance_status.b_check_status,
            maintenance_status.c_check_status,
            maintenance_status.d_check_status,
            maintenance_status.maintenance_control_status,
            maintenance_status.maintenance_control_reason,

            blocking_event.id
              AS maintenance_event_id,
            blocking_event.event_uid
              AS maintenance_event_uid,
            blocking_event.check_type
              AS maintenance_check_type,
            blocking_event.maintenance_start_at,
            blocking_event.maintenance_end_at

          FROM public.flight_occurrences occurrence

          CROSS JOIN clock

          INNER JOIN public.aircraft_fleet fleet
            ON fleet.id =
               occurrence.aircraft_id
           AND fleet.airline_id =
               occurrence.airline_id

          LEFT JOIN LATERAL (
            SELECT
              previous_occurrence.arrived_at,

              COALESCE(
                previous_occurrence.turnaround_min,
                0
              )::integer AS turnaround_min

            FROM public.flight_occurrences
              previous_occurrence

            WHERE previous_occurrence.airline_id =
                  occurrence.airline_id

              AND previous_occurrence.aircraft_id =
                  occurrence.aircraft_id

              AND previous_occurrence.id <>
                  occurrence.id

              AND previous_occurrence.dispatch_status =
                  'RELEASED'

              AND previous_occurrence.operational_status IN (
                'ARRIVED',
                'SETTLED'
              )

              AND previous_occurrence.arrived_at
                  IS NOT NULL

              AND previous_occurrence.arrived_at <=
                  clock.sim_time

            ORDER BY
              previous_occurrence.arrived_at DESC,
              previous_occurrence.id DESC

            LIMIT 1
          ) AS previous_arrival ON TRUE

          LEFT JOIN public.aircraft_maintenance_status
            AS maintenance_status
            ON maintenance_status.aircraft_id =
               occurrence.aircraft_id
           AND maintenance_status.airline_id =
               occurrence.airline_id

          LEFT JOIN LATERAL (
            SELECT
              event.id,
              event.event_uid,
              event.check_type,

              CASE
                WHEN event.event_status = 'IN_PROGRESS'
                  THEN COALESCE(
                    event.started_at,
                    event.scheduled_start_at
                  )
                ELSE COALESCE(
                  event.scheduled_start_at,
                  event.started_at
                )
              END AS maintenance_start_at,

              CASE
                WHEN event.event_status = 'IN_PROGRESS'
                  THEN COALESCE(
                    event.expected_completion_at,
                    event.scheduled_end_at
                  )
                ELSE COALESCE(
                  event.scheduled_end_at,
                  event.expected_completion_at
                )
              END AS maintenance_end_at

            FROM public.aircraft_maintenance_events event

            WHERE event.aircraft_id =
                  occurrence.aircraft_id

              AND event.airline_id =
                  occurrence.airline_id

              AND event.event_status IN (
                'SCHEDULED',
                'IN_PROGRESS'
              )

              AND clock.sim_time <
                CASE
                  WHEN event.event_status = 'IN_PROGRESS'
                    THEN COALESCE(
                      event.expected_completion_at,
                      event.scheduled_end_at
                    )
                  ELSE COALESCE(
                    event.scheduled_end_at,
                    event.expected_completion_at
                  )
                END

              AND (
                clock.sim_time
                + (
                    occurrence.block_time_min
                    * INTERVAL '1 minute'
                  )
              ) >
                CASE
                  WHEN event.event_status = 'IN_PROGRESS'
                    THEN COALESCE(
                      event.started_at,
                      event.scheduled_start_at
                    )
                  ELSE COALESCE(
                    event.scheduled_start_at,
                    event.started_at
                  )
                END

            ORDER BY
              maintenance_start_at,
              CASE event.check_type
                WHEN 'D_CHECK' THEN 1
                WHEN 'C_CHECK' THEN 2
                WHEN 'B_CHECK' THEN 3
                WHEN 'A_CHECK' THEN 4
                ELSE 5
              END,
              event.id

            LIMIT 1
          ) AS blocking_event ON TRUE

          WHERE (
            (
              occurrence.operational_status =
                'PLANNED'
              AND occurrence.dispatch_status =
                'PENDING'
            )
            OR
            (
              occurrence.operational_status =
                'HELD'
              AND occurrence.dispatch_status =
                'NOT_DISPATCHED'
            )
          )

            AND (
              occurrence.hr_impact_resolved_at
                IS NOT NULL

              OR $2::boolean

              OR occurrence.airline_id =
                 ANY($3::bigint[])
            )

            AND occurrence.scheduled_departure_at <=
                clock.sim_time

            AND NOT (
              occurrence.hr_impact_resolved_at
                IS NOT NULL

              AND COALESCE(
                occurrence.hr_operational_outcome,
                'ON_TIME'
              ) = 'DELAYED'

              AND COALESCE(
                occurrence.hr_release_at,
                occurrence.scheduled_departure_at
              ) > clock.sim_time
            )

          ORDER BY
            occurrence.scheduled_departure_at,
            occurrence.id

          LIMIT $1

          FOR UPDATE OF occurrence SKIP LOCKED
        ),

        classified AS MATERIALIZED (
          SELECT
            due.*,

            (
              due.hr_impact_resolved_at
                IS NOT NULL

              AND COALESCE(
                due.hr_operational_outcome,
                'ON_TIME'
              ) = 'CANCELLED'
            ) AS is_hr_cancelled,

            (
              due.maintenance_event_id IS NOT NULL

              OR UPPER(
                COALESCE(due.a_check_status, '')
              ) = 'OVERDUE'

              OR UPPER(
                COALESCE(due.b_check_status, '')
              ) = 'OVERDUE'

              OR UPPER(
                COALESCE(due.c_check_status, '')
              ) = 'OVERDUE'

              OR UPPER(
                COALESCE(due.d_check_status, '')
              ) = 'OVERDUE'

              OR UPPER(
                COALESCE(
                  due.maintenance_control_status,
                  ''
                )
              ) IN (
                'IN_MAINTENANCE',
                'MAINTENANCE_REQUIRED',
                'UNSERVICEABLE'
              )
            ) AS is_maintenance_blocked,

            (
              due.fleet_current_airport <>
              due.occurrence_origin
            ) AS is_location_blocked,

            (
              NOT due.turnaround_ready
            ) AS is_turnaround_blocked,

            due.has_active_occurrence
              AS is_active_blocked,

            due.has_earlier_unresolved
              AS is_sequence_blocked

          FROM due_occurrences due
        ),

        resolved AS MATERIALIZED (
          SELECT
            classified.*,

            (
              classified.is_maintenance_blocked
              OR classified.is_location_blocked
              OR classified.is_turnaround_blocked
              OR classified.is_active_blocked
              OR classified.is_sequence_blocked
            ) AS is_blocked,

            CASE
              WHEN classified.is_hr_cancelled
                THEN COALESCE(
                  NULLIF(
                    classified.hr_cancel_reason,
                    ''
                  ),
                  'HR_OPERATIONAL_CANCELLATION'
                )

              WHEN classified.is_active_blocked
                THEN 'AIRCRAFT_ALREADY_ACTIVE'

              WHEN classified.is_sequence_blocked
                THEN 'PREVIOUS_OCCURRENCE_UNRESOLVED'

              WHEN classified.is_location_blocked
                THEN 'AIRCRAFT_LOCATION_MISMATCH'

              WHEN classified.is_turnaround_blocked
                THEN 'TURNAROUND_NOT_COMPLETE'

              WHEN classified.maintenance_event_id
                   IS NOT NULL
                THEN classified.maintenance_check_type

              WHEN UPPER(
                COALESCE(
                  classified.d_check_status,
                  ''
                )
              ) = 'OVERDUE'
                THEN 'D_CHECK_OVERDUE'

              WHEN UPPER(
                COALESCE(
                  classified.c_check_status,
                  ''
                )
              ) = 'OVERDUE'
                THEN 'C_CHECK_OVERDUE'

              WHEN UPPER(
                COALESCE(
                  classified.b_check_status,
                  ''
                )
              ) = 'OVERDUE'
                THEN 'B_CHECK_OVERDUE'

              WHEN UPPER(
                COALESCE(
                  classified.a_check_status,
                  ''
                )
              ) = 'OVERDUE'
                THEN 'A_CHECK_OVERDUE'

              WHEN UPPER(
                COALESCE(
                  classified.maintenance_control_status,
                  ''
                )
              ) = 'UNSERVICEABLE'
                THEN COALESCE(
                  NULLIF(
                    classified.maintenance_control_reason,
                    ''
                  ),
                  'AIRCRAFT_UNSERVICEABLE'
                )

              WHEN UPPER(
                COALESCE(
                  classified.maintenance_control_status,
                  ''
                )
              ) = 'MAINTENANCE_REQUIRED'
                THEN COALESCE(
                  NULLIF(
                    classified.maintenance_control_reason,
                    ''
                  ),
                  'MAINTENANCE_REQUIRED'
                )

              WHEN UPPER(
                COALESCE(
                  classified.maintenance_control_status,
                  ''
                )
              ) = 'IN_MAINTENANCE'
                THEN COALESCE(
                  NULLIF(
                    classified.maintenance_control_reason,
                    ''
                  ),
                  'IN_MAINTENANCE'
                )

              ELSE NULL
            END AS final_dispatch_reason

          FROM classified
        )

        UPDATE public.flight_occurrences occurrence

        SET
          operational_status = CASE
            WHEN resolved.is_hr_cancelled
              THEN 'CANCELLED'

            WHEN resolved.is_blocked
              THEN 'HELD'

            ELSE 'DISPATCHED'
          END,

          dispatch_status = CASE
            WHEN resolved.is_hr_cancelled
              THEN 'NOT_DISPATCHED'

            WHEN resolved.is_blocked
              THEN 'NOT_DISPATCHED'

            ELSE 'RELEASED'
          END,

          dispatch_reason =
            resolved.final_dispatch_reason,

          blocking_maintenance_event_id = CASE
            WHEN resolved.is_maintenance_blocked
             AND NOT resolved.is_hr_cancelled
              THEN resolved.maintenance_event_id

            ELSE NULL
          END,

          blocking_maintenance_event_uid = CASE
            WHEN resolved.is_maintenance_blocked
             AND NOT resolved.is_hr_cancelled
              THEN resolved.maintenance_event_uid

            ELSE NULL
          END,

          blocking_maintenance_check_type = CASE
            WHEN resolved.is_maintenance_blocked
             AND NOT resolved.is_hr_cancelled
              THEN COALESCE(
                resolved.maintenance_check_type,

                CASE
                  WHEN UPPER(
                    COALESCE(
                      resolved.d_check_status,
                      ''
                    )
                  ) = 'OVERDUE'
                    THEN 'D_CHECK'

                  WHEN UPPER(
                    COALESCE(
                      resolved.c_check_status,
                      ''
                    )
                  ) = 'OVERDUE'
                    THEN 'C_CHECK'

                  WHEN UPPER(
                    COALESCE(
                      resolved.b_check_status,
                      ''
                    )
                  ) = 'OVERDUE'
                    THEN 'B_CHECK'

                  WHEN UPPER(
                    COALESCE(
                      resolved.a_check_status,
                      ''
                    )
                  ) = 'OVERDUE'
                    THEN 'A_CHECK'

                  ELSE NULL
                END
              )

            ELSE NULL
          END,

          blocking_maintenance_start_at = CASE
            WHEN resolved.is_maintenance_blocked
             AND NOT resolved.is_hr_cancelled
              THEN resolved.maintenance_start_at

            ELSE NULL
          END,

          blocking_maintenance_end_at = CASE
            WHEN resolved.is_maintenance_blocked
             AND NOT resolved.is_hr_cancelled
              THEN resolved.maintenance_end_at

            ELSE NULL
          END,

          held_at = CASE
            WHEN resolved.is_blocked
             AND NOT resolved.is_hr_cancelled
              THEN COALESCE(
                occurrence.held_at,
                resolved.sim_time
              )

            ELSE NULL
          END,

          dispatched_at = CASE
            WHEN resolved.is_hr_cancelled
              THEN NULL

            WHEN resolved.is_blocked
              THEN NULL

            ELSE resolved.sim_time
          END,

          departed_at = CASE
            WHEN resolved.is_hr_cancelled
              THEN NULL

            WHEN resolved.is_blocked
              THEN NULL

            ELSE resolved.sim_time
          END,

          updated_at = CURRENT_TIMESTAMP

        FROM resolved

        WHERE occurrence.id = resolved.id

        RETURNING
          occurrence.dispatch_status,
          occurrence.operational_status,
          occurrence.dispatch_reason
      `,
      [
        normalizedBatchSize,
        hrGlobalFailOpen,
        hrFailedAirlineIds
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    const heldCount = result.rows.filter(
      row =>
        row.dispatch_status === "NOT_DISPATCHED" &&
        row.operational_status === "HELD"
    ).length;

    const cancelledCount = result.rows.filter(
      row =>
        row.dispatch_status === "NOT_DISPATCHED" &&
        row.operational_status === "CANCELLED"
    ).length;

    const releasedCount = result.rows.filter(
      row => row.dispatch_status === "RELEASED"
    ).length;

    return {
      processedCount: result.rowCount,
      heldCount,
      cancelledCount,
      releasedCount,
      hrResolution
    };

  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_advanceFlightOccurrences({
  batchSize = 500
} = {}) {
  const client = await pool.connect();

  const normalizedBatchSize = Math.min(
    2000,
    Math.max(
      1,
      Number.parseInt(batchSize, 10) || 500
    )
  );

  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `
      WITH clock AS MATERIALIZED (
        SELECT acs_get_current_sim_time() AS sim_time
      ),
      due_occurrences AS MATERIALIZED (
  SELECT
    occurrence.id,
    occurrence.scheduled_departure_at,
    occurrence.scheduled_arrival_at,

    COALESCE(
      occurrence.departed_at,
      occurrence.dispatched_at,
      occurrence.scheduled_departure_at
    ) AS effective_departure_at,

    (
      COALESCE(
        occurrence.departed_at,
        occurrence.dispatched_at,
        occurrence.scheduled_departure_at
      )
      + (
          occurrence.block_time_min
          * INTERVAL '1 minute'
        )
    ) AS effective_arrival_at,

    clock.sim_time
        FROM public.flight_occurrences occurrence
        CROSS JOIN clock
        WHERE occurrence.dispatch_status = 'RELEASED'
          AND occurrence.operational_status IN (
            'DISPATCHED',
            'EN_ROUTE'
          )
          AND COALESCE(
      occurrence.departed_at,
      occurrence.dispatched_at,
      occurrence.scheduled_departure_at
    ) <= clock.sim_time

ORDER BY
  COALESCE(
    occurrence.departed_at,
    occurrence.dispatched_at,
    occurrence.scheduled_departure_at
  ),
  occurrence.id
        LIMIT $1
        FOR UPDATE OF occurrence SKIP LOCKED
      )
      UPDATE public.flight_occurrences occurrence
      SET
        operational_status = CASE
  WHEN due.effective_arrival_at <= due.sim_time
    THEN 'ARRIVED'
  ELSE 'EN_ROUTE'
END,

departed_at = COALESCE(
  occurrence.departed_at,
  due.effective_departure_at
),

arrived_at = CASE
  WHEN due.effective_arrival_at <= due.sim_time
    THEN COALESCE(
      occurrence.arrived_at,
      due.effective_arrival_at
    )
  ELSE occurrence.arrived_at
END,
        updated_at = CURRENT_TIMESTAMP
      FROM due_occurrences due
      WHERE occurrence.id = due.id
      RETURNING
      occurrence.operational_status,
      occurrence.airline_id,
      occurrence.aircraft_id,
      occurrence.destination,
occurrence.block_time_min,
occurrence.arrived_at AS scheduled_arrival_at
      `,
      [normalizedBatchSize]
    );

    const arrivedRows = result.rows.filter(
  row => row.operational_status === "ARRIVED"
);

if (arrivedRows.length > 0) {
  await client.query(
    `
    WITH arrivals AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS arrival (
        airline_id integer,
        aircraft_id integer,
        destination text,
        block_time_min integer,
        scheduled_arrival_at timestamp
      )
    ),
    aircraft_delta AS MATERIALIZED (
      SELECT
        airline_id,
        aircraft_id,
        ROUND(
          SUM(block_time_min)::numeric / 60,
          2
        ) AS hours_to_add,
        COUNT(*)::integer AS cycles_to_add,
        (
          ARRAY_AGG(
            destination
            ORDER BY scheduled_arrival_at DESC
          )
        )[1] AS current_airport
      FROM arrivals
      GROUP BY airline_id, aircraft_id
    )
    UPDATE public.aircraft_fleet fleet
    SET
      total_hours =
        COALESCE(fleet.total_hours, 0)
        + delta.hours_to_add,
      total_cycles =
        COALESCE(fleet.total_cycles, 0)
        + delta.cycles_to_add,
      current_airport =
        COALESCE(
          delta.current_airport,
          fleet.current_airport
        ),
      updated_at = CURRENT_TIMESTAMP
    FROM aircraft_delta delta
    WHERE fleet.id = delta.aircraft_id
      AND fleet.airline_id = delta.airline_id
    `,
    [JSON.stringify(arrivedRows)]
  );
}
     
    await client.query("COMMIT");
    transactionStarted = false;

    const enRouteCount = result.rows.filter(
      row => row.operational_status === "EN_ROUTE"
    ).length;

    const arrivedCount = result.rows.filter(
      row => row.operational_status === "ARRIVED"
    ).length;

    return {
      processedCount: result.rowCount,
      enRouteCount,
      arrivedCount
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_generateFlightOccurrences({
  horizonSimDays = 8
} = {}) {
  const client = await pool.connect();

  const normalizedHorizonDays =
    ACS_normalizeHorizonDays(
      horizonSimDays
    );

  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const cancelledCount =
      await ACS_cancelFutureFlightOccurrences(
        client
      );

    const insertedOrUpdatedCount =
      await ACS_materializeFlightOccurrences(
        client,
        normalizedHorizonDays
      );

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      processedCount:
        cancelledCount +
        insertedOrUpdatedCount,
      cancelledCount,
      insertedOrUpdatedCount,
      horizonSimDays:
        normalizedHorizonDays
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    throw error;
  } finally {
    client.release();
  }
}
