/* ============================================================
   ACS SKYTRACK SNAPSHOT - POSTGRESQL CANONICAL AUTHORITY
   ------------------------------------------------------------
   File: routes/skytrack_snapshot.js

   Authority:
   - PostgreSQL
   - Server sim time
   - Backend-resolved operational state
   - Backend-resolved position/progress
   - Backend airline colors

   Endpoint:
   GET /v1/skytrack/snapshot
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/snapshot", requireAuth, async (req, res) => {
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

    const simResult = await client.query(`
      SELECT
        acs_get_current_sim_time() AS current_sim_time,
        (
          EXTRACT(DOW FROM acs_get_current_sim_time())::int * 1440
          + EXTRACT(HOUR FROM acs_get_current_sim_time())::int * 60
          + EXTRACT(MINUTE FROM acs_get_current_sim_time())::int
        )::int AS now_abs_min
    `);

    const simRow = simResult.rows[0] || {};
    const nowAbsMin = Number(simRow.now_abs_min);

    if (!Number.isFinite(nowAbsMin)) {
      throw new Error("SKYTRACK_SIM_TIME_INVALID");
    }

    const result = await client.query(
      `
      WITH sim AS (
        SELECT $2::int AS now_abs_min
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

        WHERE UPPER(COALESCE(af.status, '')) <> 'SCRAPPED'
      ),

      selected_flight AS (
        SELECT
          f.airline_id,
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
          s.status AS schedule_status,

          CASE
            WHEN sim.now_abs_min >= s.dep_abs_min
             AND sim.now_abs_min < s.arr_abs_min
            THEN 'ACTIVE'

            WHEN s.arr_abs_min <= sim.now_abs_min
            THEN 'COMPLETED'

            WHEN s.dep_abs_min > sim.now_abs_min
            THEN 'FUTURE'

            ELSE 'CONTEXT'
          END AS flight_context

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

              WHEN s.arr_abs_min <= sim.now_abs_min
              THEN 1

              WHEN s.dep_abs_min > sim.now_abs_min
              THEN 2

              ELSE 3
            END,

            CASE
              WHEN s.arr_abs_min <= sim.now_abs_min
              THEN s.arr_abs_min
            END DESC,

            CASE
              WHEN s.dep_abs_min > sim.now_abs_min
              THEN s.dep_abs_min
            END ASC,

            s.id ASC

          LIMIT 1
        ) s ON true
      )

      SELECT
        CASE
          WHEN f.airline_id = $1 THEN 'OWN'
          ELSE 'GLOBAL'
        END AS scope,

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
        sf.flight_context,

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
        END AS state,

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
        END AS position_type,

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

          WHEN sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min <= sim.now_abs_min
          THEN COALESCE(
            f.current_airport,
            sf.destination,
            f.base_icao
          )

          ELSE COALESCE(
            f.current_airport,
            f.base_icao,
            sf.origin,
            sf.destination
          )
        END AS airport,

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
        END AS progress,

        sf.origin AS origin_icao,
        sf.destination AS destination_icao,
        sf.dep_abs_min AS dep_abs_min,
        sf.arr_abs_min AS arr_abs_min,

        CASE
          WHEN sf.schedule_item_id IS NOT NULL
           AND sf.arr_abs_min IS NOT NULL
           AND sf.arr_abs_min <= sim.now_abs_min
          THEN true
          ELSE false
        END AS arrived

      FROM fleet f
      CROSS JOIN sim
      LEFT JOIN selected_flight sf
        ON sf.airline_id = f.airline_id
       AND sf.aircraft_id = f.aircraft_id

      ORDER BY
        CASE WHEN f.airline_id = $1 THEN 0 ELSE 1 END,
        f.airline_id,
        f.aircraft_id
      `,
      [airlineId, nowAbsMin]
    );

    await client.query("COMMIT");

    const flights = result.rows.map(row => {
      const rawAircraftId = String(row.aircraft_id);

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

        airlineColorHex: row.color_hex || "#3A5FFF",
        airlineColorHsl: row.color_hsl || "hsl(220,70%,50%)",
        airlineColorIndex: Number(row.color_index || 0),

        registration: row.registration || "-",
        model:
          row.aircraft_name ||
          row.model_key ||
          "-",
        aircraft:
          row.aircraft_name ||
          row.model_key ||
          "-",
        aircraftModel:
          row.aircraft_name ||
          row.model_key ||
          "-",
        modelKey: row.model_key || null,

        state: row.state || "GROUND",
        positionType: row.position_type || "AIRPORT",

        position:
          row.position_type === "ROUTE"
            ? {
                progress: Number.isFinite(Number(row.progress))
                  ? Number(row.progress)
                  : 0
              }
            : {
                airport: row.airport || null
              },

        airport: row.airport || null,
        progress: Number.isFinite(Number(row.progress))
          ? Number(row.progress)
          : null,

        flightNumber: row.flight_number || null,
        pairedFlightNumber: row.paired_flight_number || null,

        originICAO: row.origin_icao || null,
        destinationICAO: row.destination_icao || null,

        depAbsMin: Number.isFinite(Number(row.dep_abs_min))
          ? Number(row.dep_abs_min)
          : null,

        arrAbsMin: Number.isFinite(Number(row.arr_abs_min))
          ? Number(row.arr_abs_min)
          : null,

        distanceNM: Number(row.distance_nm || 0),
        flightDirection: row.flight_direction || null,
        scheduleStatus: row.schedule_status || null,
        flightContext: row.flight_context || null,

        arrived: row.arrived === true,

        opsStatus: "ON_TIME",
        delayed: false,
        delayMinutes: 0,

        __canonicalBackend: true,
        __snapshotAuthority: true
      };
    });

    return res.json({
      ok: true,
      authority: "POSTGRESQL_SKYTRACK_SNAPSHOT_CANONICAL",
      airline_id: airlineId,
      current_sim_time: simRow.current_sim_time || null,
      now_abs_min: nowAbsMin,
      flights,
      count: flights.length
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("SKYTRACK_SNAPSHOT_CANONICAL_ERROR", err);

    return res.status(500).json({
      ok: false,
      error: "SKYTRACK_SNAPSHOT_CANONICAL_ERROR",
      details: err.message
    });
  } finally {
    client.release();
  }
});

export default router;
