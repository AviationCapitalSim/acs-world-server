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

        af.id AS aircraft_id,
        af.registration,
        af.model_key,
        af.current_airport,
        af.base_icao,

        si.flight_number,
        si.paired_flight_number,

        si.origin,
        si.destination,

        si.dep_abs_min,
        si.arr_abs_min,

        si.distance_nm,

        si.status,
        si.flight_direction

      FROM public.schedule_items si

      INNER JOIN public.aircraft_fleet af
        ON af.id = si.aircraft_id

      INNER JOIN public.airlines al
        ON al.airline_id = af.airline_id

      WHERE

        si.item_type = 'flight'
        AND si.status = 'assigned'

      ORDER BY
        af.airline_id,
        si.dep_abs_min
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
