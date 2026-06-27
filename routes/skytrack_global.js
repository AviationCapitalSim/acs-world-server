/* ============================================================
   ACS SKYTRACK GLOBAL
   ------------------------------------------------------------
   Global visible traffic for SkyTrack
   Authority: PostgreSQL
   Read-only endpoint
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET /v1/skytrack/global
   ------------------------------------------------------------
   Returns all active scheduled aircraft
   visible in SkyTrack.
   ============================================================ */

router.get("/global", async (req, res) => {

  const client = await pool.connect();

  try {

    const result = await client.query(`
    
  SELECT

    af.airline_id,

al.airline_name,
al.iata,
al.icao,

al.color_hex,
al.color_hsl,
al.color_index,

af.id                 AS aircraft_id,
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
    ams.maintenance_control_reason,

    si.flight_number,
    si.paired_flight_number,

    si.origin,
    si.destination,

    si.dep_abs_min,
    si.arr_abs_min,

    si.distance_nm,

    si.flight_direction

FROM public.aircraft_fleet af

INNER JOIN public.airlines al
  ON al.airline_id = af.airline_id

LEFT JOIN public.aircraft_maintenance_status ams
  ON ams.aircraft_id = af.id
 AND ams.airline_id = af.airline_id

LEFT JOIN LATERAL (

    SELECT *

    FROM public.schedule_items s

    CROSS JOIN (
      SELECT
        (
          EXTRACT(DOW FROM acs_get_current_sim_time())::int * 1440
          + EXTRACT(HOUR FROM acs_get_current_sim_time())::int * 60
          + EXTRACT(MINUTE FROM acs_get_current_sim_time())::int
        ) AS now_abs_min
    ) t

    WHERE
      s.aircraft_id = af.id
      AND s.item_type = 'flight'
      AND s.status = 'assigned'

    ORDER BY
      CASE
        WHEN t.now_abs_min >= s.dep_abs_min
         AND t.now_abs_min < s.arr_abs_min
        THEN 0

        WHEN s.dep_abs_min > t.now_abs_min
        THEN 1

        ELSE 2
      END,

      CASE
        WHEN s.dep_abs_min > t.now_abs_min
        THEN s.dep_abs_min
      END ASC,

      CASE
        WHEN s.arr_abs_min <= t.now_abs_min
        THEN s.arr_abs_min
      END DESC

    LIMIT 1

) si ON true

WHERE

    af.status <> 'SCRAPPED'

ORDER BY

    af.airline_id,
    af.id;
    `);

    return res.json({

      ok: true,

      authority:
        "POSTGRESQL_GLOBAL_SKYTRACK",

      flights:
        result.rows,

      count:
        result.rows.length

    });

  } catch (err) {

    console.error(
      "SKYTRACK_GLOBAL_ERROR",
      err
    );

    return res.status(500).json({
      ok: false,
      error: "SKYTRACK_GLOBAL_ERROR"
    });

  } finally {

    client.release();

  }

});

export default router;
