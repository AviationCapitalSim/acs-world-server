/* ============================================================
   ACS SKYTRACK SNAPSHOT -  POSTGRESQL CANONICAL AUTHORITY
   File: routes/skytrack_snapshot.js
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   ACS SKYTRACK — CANONICAL AIRLINE IDENTITY COLOR
   ------------------------------------------------------------
   Stable color generated from PostgreSQL airline_id.
   Same airline, same color, on every browser and session.
   ============================================================ */

function ACS_hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;

  const a =
    s * Math.min(l, 1 - l);

  const channel = n => {
    const k = (n + hue / 30) % 12;

    const value =
      l -
      a *
        Math.max(
          -1,
          Math.min(k - 3, 9 - k, 1)
        );

    return Math.round(255 * value)
      .toString(16)
      .padStart(2, "0");
  };

  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function ACS_buildSkyTrackAirlineColor(airlineId) {
  const id =
    Math.max(
      1,
      Math.trunc(Number(airlineId) || 1)
    );

  const hue =
    (id * 137.50776405) % 360;

  const saturation =
    82 + ((id % 3) * 5);

  const lightness =
    43 + ((id % 4) * 5);

  return {
    hex: ACS_hslToHex(
      hue,
      saturation,
      lightness
    ),

    hsl:
      `hsl(${hue.toFixed(3)}, ` +
      `${saturation}%, ${lightness}%)`,

    index: id
  };
}

router.get("/snapshot", requireAuth, async (req, res) => {
   
  const airlineId = Number(req.airline_id);

  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  try {
    const simResult = await pool.query(`
      SELECT
        acs_get_current_sim_time() AS current_sim_time,
        (
          EXTRACT(DOW FROM acs_get_current_sim_time())::int * 1440
          + EXTRACT(HOUR FROM acs_get_current_sim_time())::int * 60
          + EXTRACT(MINUTE FROM acs_get_current_sim_time())::int
        )::int AS now_abs_min
    `);

    const simRow = simResult.rows[0] || {};

    if (!simRow.current_sim_time) {
      throw new Error("SKYTRACK_SIM_TIME_INVALID");
    }

    const result = await pool.query(
      `
      WITH sim AS MATERIALIZED (
        SELECT $2::timestamp AS sim_time
      ),

      fleet AS MATERIALIZED (
        SELECT
          af.airline_id,
          al.airline_name,
          al.iata,
          al.icao,
          COALESCE(al.color_hex, '#3A5FFF') AS color_hex,
          COALESCE(al.color_hsl, 'hsl(220,70%,50%)') AS color_hsl,
          COALESCE(al.color_index, 0) AS color_index,

          af.id AS aircraft_id,
          af.registration,
          af.aircraft_name,
          af.model_key,
          af.current_airport,
          af.base_icao,

          ams.maintenance_control_status,
          ams.maintenance_control_reason

        FROM public.aircraft_fleet af

        INNER JOIN public.airlines al
          ON al.airline_id = af.airline_id

        LEFT JOIN public.aircraft_maintenance_status ams
          ON ams.aircraft_id = af.id
         AND ams.airline_id = af.airline_id

        WHERE UPPER(COALESCE(af.status, '')) <> 'SCRAPPED'
      )

      SELECT
        CASE
          WHEN fleet.airline_id = $1 THEN 'OWN'
          ELSE 'GLOBAL'
        END AS scope,

        fleet.*,

        occurrence.id AS occurrence_id,
        occurrence.schedule_item_id,
        occurrence.flight_number,
        occurrence.flight_direction,
        occurrence.origin AS origin_icao,
        occurrence.destination AS destination_icao,
        occurrence.distance_nm,
        occurrence.scheduled_departure_at,
        occurrence.scheduled_arrival_at,
        occurrence.operational_status,
        occurrence.dispatch_status,
        occurrence.dispatch_reason,
        occurrence.flight_context,

        (
          EXTRACT(DOW FROM occurrence.scheduled_departure_at)::int * 1440
          + EXTRACT(HOUR FROM occurrence.scheduled_departure_at)::int * 60
          + EXTRACT(MINUTE FROM occurrence.scheduled_departure_at)::int
        )::int AS dep_abs_min,

        (
          EXTRACT(DOW FROM occurrence.scheduled_arrival_at)::int * 1440
          + EXTRACT(HOUR FROM occurrence.scheduled_arrival_at)::int * 60
          + EXTRACT(MINUTE FROM occurrence.scheduled_arrival_at)::int
        )::int AS arr_abs_min,

        CASE
          WHEN occurrence.flight_context = 'ACTIVE'
            THEN 'EN_ROUTE'

          WHEN occurrence.flight_context = 'HELD'
            THEN COALESCE(
              NULLIF(occurrence.dispatch_reason, ''),
              'NOT_DISPATCHED'
            )

          WHEN UPPER(
            COALESCE(fleet.maintenance_control_status, '')
          ) IN (
            'IN_MAINTENANCE',
            'MAINTENANCE_REQUIRED',
            'UNSERVICEABLE'
          )
            THEN COALESCE(
              NULLIF(
                UPPER(fleet.maintenance_control_reason),
                ''
              ),
              'MAINTENANCE'
            )

          ELSE 'GROUND'
        END AS state,

        CASE
          WHEN occurrence.flight_context = 'ACTIVE'
            THEN 'ROUTE'
          ELSE 'AIRPORT'
        END AS position_type,

        CASE
          WHEN occurrence.flight_context = 'ACTIVE'
            THEN NULL

          WHEN occurrence.flight_context = 'HELD'
            THEN occurrence.origin

          WHEN UPPER(
            COALESCE(fleet.maintenance_control_status, '')
          ) IN (
            'IN_MAINTENANCE',
            'MAINTENANCE_REQUIRED',
            'UNSERVICEABLE'
          )
            THEN COALESCE(
             fleet.base_icao,
             fleet.current_airport,
             occurrence.origin
          )

          WHEN occurrence.flight_context = 'LAST'
            THEN occurrence.destination

          WHEN occurrence.flight_context = 'FUTURE'
            THEN occurrence.origin

          ELSE COALESCE(
            fleet.current_airport,
            fleet.base_icao
          )
        END AS airport,

        CASE
          WHEN occurrence.flight_context = 'ACTIVE'
          THEN LEAST(
            1,
            GREATEST(
              0,
              EXTRACT(
                EPOCH FROM (
                  sim.sim_time
                  - occurrence.scheduled_departure_at
                )
              )
              /
              NULLIF(
                EXTRACT(
                  EPOCH FROM (
                    occurrence.scheduled_arrival_at
                    - occurrence.scheduled_departure_at
                  )
                ),
                0
              )
            )
          )
          ELSE NULL
        END AS progress,

        (
          occurrence.flight_context <> 'ACTIVE'
          AND EXISTS (
            SELECT 1
            FROM public.flight_occurrences arrived_occurrence
            WHERE arrived_occurrence.airline_id =
                  fleet.airline_id
              AND arrived_occurrence.aircraft_id =
                  fleet.aircraft_id
              AND arrived_occurrence.dispatch_status =
                  'RELEASED'
              AND arrived_occurrence.scheduled_arrival_at <=
                  sim.sim_time
          )
        ) AS arrived

      FROM fleet

      CROSS JOIN sim

      LEFT JOIN LATERAL (
        SELECT
          candidate.*,

          CASE
            WHEN candidate.dispatch_status = 'RELEASED'
             AND candidate.operational_status IN (
               'DISPATCHED',
               'EN_ROUTE'
             )
             AND candidate.scheduled_departure_at <= sim.sim_time
             AND candidate.scheduled_arrival_at > sim.sim_time
              THEN 'ACTIVE'

            WHEN candidate.dispatch_status = 'NOT_DISPATCHED'
             AND candidate.operational_status IN (
               'HELD',
               'NOT_DISPATCHED'
             )
             AND candidate.scheduled_departure_at <= sim.sim_time
             AND candidate.scheduled_arrival_at > sim.sim_time
              THEN 'HELD'

            WHEN candidate.dispatch_status = 'PENDING'
             AND candidate.operational_status = 'PLANNED'
             AND candidate.scheduled_departure_at > sim.sim_time
              THEN 'FUTURE'

            ELSE 'LAST'
          END AS flight_context

        FROM public.flight_occurrences candidate

                WHERE candidate.airline_id = fleet.airline_id
          AND candidate.aircraft_id = fleet.aircraft_id

          AND NOT (
            UPPER(
              COALESCE(
                fleet.maintenance_control_status,
                ''
              )
            ) IN (
              'IN_MAINTENANCE',
              'MAINTENANCE_REQUIRED',
              'UNSERVICEABLE'
            )

            OR UPPER(
              COALESCE(
                fleet.maintenance_control_reason,
                ''
              )
            ) IN (
              'A_CHECK',
              'B_CHECK',
              'C_CHECK',
              'D_CHECK',
              'A_CHECK_OVERDUE',
              'B_CHECK_OVERDUE',
              'C_CHECK_OVERDUE',
              'D_CHECK_OVERDUE'
            )
          )

          AND (
            (
              candidate.dispatch_status = 'RELEASED'
              AND candidate.operational_status IN (
                'DISPATCHED',
                'EN_ROUTE'
              )
              AND candidate.scheduled_departure_at <= sim.sim_time
              AND candidate.scheduled_arrival_at > sim.sim_time
            )

            OR

            (
              candidate.dispatch_status = 'NOT_DISPATCHED'
              AND candidate.operational_status IN (
                'HELD',
                'NOT_DISPATCHED'
              )
              AND candidate.scheduled_departure_at <= sim.sim_time
              AND candidate.scheduled_arrival_at > sim.sim_time
            )

            OR

            (
              candidate.dispatch_status = 'PENDING'
              AND candidate.operational_status = 'PLANNED'
              AND candidate.scheduled_departure_at > sim.sim_time

              /*
                A future occurrence is operational only while its
                Schedule item still belongs to the same aircraft.
                This prevents edited or reassigned flights from
                remaining attached to the previous aircraft.
              */
              AND EXISTS (
                SELECT 1
                FROM public.schedule_items current_schedule
                WHERE current_schedule.id =
                      candidate.schedule_item_id
                  AND current_schedule.airline_id =
                      candidate.airline_id
                  AND current_schedule.aircraft_id =
                      candidate.aircraft_id
                  AND LOWER(
                    COALESCE(
                      current_schedule.item_type,
                      ''
                    )
                  ) = 'flight'
                  AND LOWER(
                    COALESCE(
                      current_schedule.status,
                      'planned'
                    )
                  ) NOT IN (
                    'cancelled',
                    'completed'
                  )
              )

              /*
                The Route Plan must also retain the same aircraft.
                This is the second global guard against stale
                occurrences left by route edits or reassignment.
              */
              AND EXISTS (
                SELECT 1
                FROM public.route_plans current_route
                WHERE current_route.id =
                      candidate.route_plan_id
                  AND current_route.airline_id =
                      candidate.airline_id
                  AND current_route.aircraft_id =
                      candidate.aircraft_id
                  AND UPPER(
                    COALESCE(
                      current_route.route_state,
                      'ACTIVE'
                    )
                  ) <> 'CANCELLED'
              )
            )
          )

        ORDER BY
          CASE
            WHEN candidate.dispatch_status = 'RELEASED'
             AND candidate.scheduled_departure_at <= sim.sim_time
             AND candidate.scheduled_arrival_at > sim.sim_time
              THEN 1

            WHEN candidate.dispatch_status = 'NOT_DISPATCHED'
             AND candidate.scheduled_departure_at <= sim.sim_time
             AND candidate.scheduled_arrival_at > sim.sim_time
              THEN 2

            WHEN candidate.dispatch_status = 'PENDING'
             AND candidate.scheduled_departure_at > sim.sim_time
              THEN 3

            ELSE 4
          END,

          CASE
            WHEN candidate.dispatch_status = 'PENDING'
              THEN candidate.scheduled_departure_at
          END ASC,

          CASE
            WHEN candidate.dispatch_status <> 'PENDING'
              THEN candidate.scheduled_departure_at
          END DESC,

          candidate.id DESC

        LIMIT 1
      ) occurrence ON TRUE

      ORDER BY
        CASE
          WHEN fleet.airline_id = $1 THEN 0
          ELSE 1
        END,
        fleet.airline_id,
        fleet.aircraft_id
      `,
      [
        airlineId,
        simRow.current_sim_time
      ]
    );

    const flights = result.rows.map(row => {
  const rawAircraftId =
    String(row.aircraft_id);

  const airlineIdentityColor =
    ACS_buildSkyTrackAirlineColor(
      row.airline_id
    );

  return {
     
        aircraftId:
          row.scope === "GLOBAL"
            ? `GLOBAL_${row.airline_id}_${rawAircraftId}`
            : rawAircraftId,

        rawAircraftId,
        canonicalAircraftKey:
          `${row.airline_id}:${rawAircraftId}`,

        scope: row.scope,

        airlineId: String(row.airline_id),
        airline_id: String(row.airline_id),
        airlineName: row.airline_name || null,
        airlineIata: row.iata || null,
        airlineIcao: row.icao || null,

        airlineColorHex:
        airlineIdentityColor.hex,

        airlineColorHsl:
        airlineIdentityColor.hsl,
   
        airlineColorIndex:
        airlineIdentityColor.index,
     
        registration: row.registration || "-",
        model:
          row.aircraft_name || row.model_key || "-",
        aircraft:
          row.aircraft_name || row.model_key || "-",
        aircraftModel:
          row.aircraft_name || row.model_key || "-",
        modelKey: row.model_key || null,

        baseICAO: row.base_icao || null,
        base_icao: row.base_icao || null,

        state: row.state || "GROUND",
        positionType:
          row.position_type || "AIRPORT",

        position:
          row.position_type === "ROUTE"
            ? {
                progress: Number(row.progress || 0)
              }
            : {
                airport: row.airport || null
              },

        airport: row.airport || null,

        progress:
          Number.isFinite(Number(row.progress))
            ? Number(row.progress)
            : null,

        occurrenceId: row.occurrence_id || null,
        scheduleItemId:
          row.schedule_item_id || null,

        flightNumber: row.flight_number || null,
        pairedFlightNumber: null,

        originICAO: row.origin_icao || null,
        destinationICAO:
          row.destination_icao || null,

        depAbsMin:
          Number.isFinite(Number(row.dep_abs_min))
            ? Number(row.dep_abs_min)
            : null,

        arrAbsMin:
          Number.isFinite(Number(row.arr_abs_min))
            ? Number(row.arr_abs_min)
            : null,

        scheduledDepartureAt:
          row.scheduled_departure_at || null,
        scheduledArrivalAt:
          row.scheduled_arrival_at || null,

        distanceNM: Number(row.distance_nm || 0),
        flightDirection:
          row.flight_direction || null,

        scheduleStatus:
          row.operational_status || null,
        dispatchStatus:
          row.dispatch_status || null,
        dispatchReason:
          row.dispatch_reason || null,

        flightContext:
          row.flight_context || "NO_FLIGHT",

        generatedReturn:
          row.flight_direction === "RETURN",

        arrived: row.arrived === true,

        opsStatus: "ON_TIME",
        delayed: false,
        delayMinutes: 0,

        __canonicalBackend: true,
        __snapshotAuthority: true,
        __occurrenceAuthority: true
      };
    });

    return res.json({
      ok: true,
      authority:
      "POSTGRESQL_SKYTRACK_SNAPSHOT_CANONICAL",
      airline_id: airlineId,
      current_sim_time:
        simRow.current_sim_time,
      now_abs_min:
        Number(simRow.now_abs_min),
      flights,
      count: flights.length
    });
  } catch (err) {
    console.error(
      "SKYTRACK_SNAPSHOT_OCCURRENCE_ERROR",
      err
    );

    return res.status(500).json({
      ok: false,
      error:
        "SKYTRACK_SNAPSHOT_OCCURRENCE_ERROR",
      details: err.message
    });
  }
});

export default router;
