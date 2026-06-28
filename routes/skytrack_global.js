/* ============================================================
   ACS SKYTRACK GLOBAL — CANONICAL BACKEND SNAPSHOT
   ------------------------------------------------------------
   Authority:
   - PostgreSQL
   - Server sim time
   - Backend-resolved operational state
   - Frontend only renders
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/global", requireAuth, async (req, res) => {
  const airlineId = Number(req.airline_id);

  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const result = await client.query(
      `
      WITH sim AS (
        SELECT
          acs_get_current_sim_time() AS current_sim_time,
          (
            EXTRACT(DOW FROM acs_get_current_sim_time())::int * 1440
            + EXTRACT(HOUR FROM acs_get_current_sim_time())::int * 60
            + EXTRACT(MINUTE FROM acs_get_current_sim_time())::int
          )::int AS now_abs_min
      ),

      fleet AS (
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

          af.status,
          af.operational_status,
          af.maintenance_status,
          af.current_airport,
          af.base_icao,

          ams.a_check_status,
          ams.b_check_status,
          ams.c_check_status,
          ams.d_check_status,
          ams.maintenance_control_status,
          ams.maintenance_control_reason

        FROM public.aircraft_fleet af

        INNER JOIN public.airlines al
          ON al.airline_id = af.airline_id

        LEFT JOIN public.aircraft_maintenance_status ams
          ON ams.aircraft_id = af.id
         AND ams.airline_id = af.airline_id

        WHERE
          af.airline_id <> $1
          AND UPPER(COALESCE(af.status, '')) <> 'SCRAPPED'
      ),

      active_or_context_flight AS (
        SELECT
          f.aircraft_id,

          s.id AS schedule_item_id,
          s.flight_number,
          s.paired_flight_number,
          s.origin,
          s.destination,
          s.dep_abs_min,
          s.arr_abs_min,
          s.distance_nm,
          s.flight_direction,
          s.status AS schedule_status

        FROM fleet f
        CROSS JOIN sim

        LEFT JOIN LATERAL (
          SELECT s.*
          FROM public.schedule_items s
          WHERE
            s.aircraft_id = f.aircraft_id
            AND s.airline_id = f.airline_id
            AND s.item_type = 'flight'
            AND LOWER(COALESCE(s.status, 'assigned')) = 'assigned'

          ORDER BY
            CASE
              WHEN sim.now_abs_min >= s.dep_abs_min
               AND sim.now_abs_min < s.arr_abs_min
              THEN 0

              WHEN s.dep_abs_min > sim.now_abs_min
              THEN 1

              ELSE 2
            END,

            CASE
              WHEN s.dep_abs_min > sim.now_abs_min
              THEN s.dep_abs_min
            END ASC,

            CASE
              WHEN s.arr_abs_min <= sim.now_abs_min
              THEN s.arr_abs_min
            END DESC

          LIMIT 1
        ) s ON true
      )

      SELECT
        sim.current_sim_time,
        sim.now_abs_min,

        f.airline_id,
        f.airline_name,
        f.iata,
        f.icao,
        f.color_hex,
        f.color_hsl,
        f.color_index,

        f.aircraft_id,
        f.registration,
        f.aircraft_name,
        f.model_key,

        f.status,
        f.operational_status,
        f.maintenance_status,
        f.current_airport,
        f.base_icao,

        f.a_check_status,
        f.b_check_status,
        f.c_check_status,
        f.d_check_status,
        f.maintenance_control_status,
        f.maintenance_control_reason,

        sf.schedule_item_id,
        sf.flight_number,
        sf.paired_flight_number,
        sf.origin,
        sf.destination,
        sf.dep_abs_min,
        sf.arr_abs_min,
        sf.distance_nm,
        sf.flight_direction,
        sf.schedule_status,

        CASE
          WHEN UPPER(COALESCE(f.maintenance_control_status, '')) IN
            ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN COALESCE(
            NULLIF(UPPER(f.maintenance_control_reason), ''),
            NULLIF(UPPER(f.maintenance_control_status), ''),
            'MAINTENANCE'
          )

          WHEN sf.dep_abs_min IS NOT NULL
           AND sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min > sf.dep_abs_min
           AND sim.now_abs_min >= sf.dep_abs_min
           AND sim.now_abs_min < sf.arr_abs_min
          THEN 'EN_ROUTE'

          ELSE 'GROUND'
        END AS canonical_state,

        CASE
          WHEN sf.dep_abs_min IS NOT NULL
           AND sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min > sf.dep_abs_min
           AND sim.now_abs_min >= sf.dep_abs_min
           AND sim.now_abs_min < sf.arr_abs_min
           AND UPPER(COALESCE(f.maintenance_control_status, '')) NOT IN
             ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN 'ROUTE'

          ELSE 'AIRPORT'
        END AS canonical_position_type,

        CASE
          WHEN UPPER(COALESCE(f.maintenance_control_status, '')) IN
            ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN COALESCE(f.current_airport, f.base_icao)

          WHEN sf.dep_abs_min IS NOT NULL
           AND sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min > sf.dep_abs_min
           AND sim.now_abs_min >= sf.dep_abs_min
           AND sim.now_abs_min < sf.arr_abs_min
          THEN NULL

          ELSE COALESCE(
            f.current_airport,
            sf.destination,
            f.base_icao,
            sf.origin
          )
        END AS canonical_airport,

        CASE
          WHEN sf.dep_abs_min IS NOT NULL
           AND sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min > sf.dep_abs_min
           AND sim.now_abs_min >= sf.dep_abs_min
           AND sim.now_abs_min < sf.arr_abs_min
           AND UPPER(COALESCE(f.maintenance_control_status, '')) NOT IN
             ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN LEAST(
            1,
            GREATEST(
              0,
              ((sim.now_abs_min - sf.dep_abs_min)::numeric /
               NULLIF((sf.arr_abs_min - sf.dep_abs_min), 0)::numeric)
            )
          )

          ELSE NULL
        END AS canonical_progress,

        sf.origin AS canonical_origin,
        sf.destination AS canonical_destination,
        sf.dep_abs_min AS canonical_dep_abs_min,
        sf.arr_abs_min AS canonical_arr_abs_min

      FROM fleet f
      CROSS JOIN sim
      LEFT JOIN active_or_context_flight sf
        ON sf.aircraft_id = f.aircraft_id

      ORDER BY
        f.airline_id,
        f.aircraft_id
      `,
      [airlineId]
    );

    await client.query("COMMIT");

    const first = result.rows[0] || {};

    return res.json({
      ok: true,
      authority: "POSTGRESQL_GLOBAL_SKYTRACK_CANONICAL",
      airline_id: airlineId,
      current_sim_time: first.current_sim_time || null,
      now_abs_min: Number.isFinite(Number(first.now_abs_min))
        ? Number(first.now_abs_min)
        : null,
      flights: result.rows,
      count: result.rows.length
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("SKYTRACK_GLOBAL_CANONICAL_ERROR", err);

    return res.status(500).json({
      ok: false,
      error: "SKYTRACK_GLOBAL_CANONICAL_ERROR",
      details: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
