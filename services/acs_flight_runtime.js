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
      AND occurrence.scheduled_arrival_at >
          clock.sim_time
    RETURNING occurrence.id
    `
  );

  return result.rowCount;
}

