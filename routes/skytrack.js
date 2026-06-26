/* ============================================================
   ACS SKYTRACK ROUTES — POSTGRESQL AUTHORITY
   ------------------------------------------------------------
   File: routes/skytrack.js

   Authority:
   - PostgreSQL only
   - req.airline_id from requireAuth
   - No localStorage
   - No browser authority
   - No finance mutation
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   ACS AIRLINE AUTHORITY
   ============================================================ */

function ACS_airlineId(req) {

  const airlineId = Number(req.airline_id);

  return Number.isInteger(airlineId) &&
         airlineId > 0
    ? airlineId
    : null;
}

/* ============================================================
   GET /v1/skytrack/context
   ------------------------------------------------------------
   SkyTrack operational context
   Authority: PostgreSQL + requireAuth
   ============================================================ */

router.get(
  "/context",
  requireAuth,
  async (req, res) => {

    const airlineId = ACS_airlineId(req);

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const client = await pool.connect();

    try {

      await client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );

      /* ========================================================
         CURRENT SIM TIME
         ======================================================== */

      const simResult =
        await client.query(`
          SELECT
            acs_get_current_sim_time()
              AS current_sim_time
        `);

      /* ========================================================
         AIRLINE
         ======================================================== */

      const airlineResult =
        await client.query(
          `
          SELECT
            airline_id,
            airline_name,
            iata,
            icao
          FROM public.airlines
          WHERE airline_id = $1
          LIMIT 1
          `,
          [airlineId]
        );

      /* ========================================================
         FLEET
         ======================================================== */

      const fleetResult =
        await client.query(
          `
          SELECT
            af.*,

            ams.a_check_status,
            ams.b_check_status,
            ams.c_check_status,
            ams.d_check_status,

            ams.maintenance_control_status,
            ams.maintenance_control_reason

          FROM public.aircraft_fleet af

          LEFT JOIN
            public.aircraft_maintenance_status ams
              ON ams.aircraft_id = af.id
             AND ams.airline_id = af.airline_id

          WHERE af.airline_id = $1

          ORDER BY af.id
          `,
          [airlineId]
        );

      /* ========================================================
         ROUTE PLANS
         ======================================================== */

      const routePlansResult =
        await client.query(
          `
          SELECT *
          FROM public.route_plans
          WHERE airline_id = $1
          ORDER BY id
          `,
          [airlineId]
        );

      /* ========================================================
         SCHEDULE ITEMS
         ======================================================== */

      const scheduleResult =
        await client.query(
          `
          SELECT *
          FROM public.schedule_items
          WHERE airline_id = $1
          ORDER BY dep_abs_min,
                   id
          `,
          [airlineId]
        );

      await client.query("COMMIT");

      return res.json({

        ok: true,

        endpoint:
          "ACS_SKYTRACK_CONTEXT",

        version:
          "v1.0",

        authority:
          "POSTGRESQL_SKYTRACK_AUTHORITY",

        airline_id:
          airlineId,

        current_sim_time:
          simResult.rows[0]
            ?.current_sim_time,

        airline:
  airlineResult.rows[0] || null,

base_icao:
  fleetResult.rows.find(a => a.base_icao)?.base_icao ||
  fleetResult.rows.find(a => a.current_airport)?.current_airport ||
  null,

fleet:
  fleetResult.rows,
         
        route_plans:
          routePlansResult.rows,

        schedule_items:
          scheduleResult.rows,

        counts: {
          fleet:
            fleetResult.rows.length,

          route_plans:
            routePlansResult.rows.length,

          schedule_items:
            scheduleResult.rows.length
        }

      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "ACS SKYTRACK CONTEXT ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "SKYTRACK_CONTEXT_FAILED",
        details:
          error.message
      });

    } finally {

      client.release();

    }
  }
);

export default router;
