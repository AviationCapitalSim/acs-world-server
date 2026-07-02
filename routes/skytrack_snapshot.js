/* ============================================================
   ACS SKYTRACK SNAPSHOT - POSTGRESQL CANONICAL AUTHORITY
   File: routes/skytrack_snapshot.js
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ACS_settleFlight } from "./flight_settlement.js";

const router = express.Router();

router.get("/snapshot", requireAuth, async (req, res) => {
  const airlineId = Number(req.airline_id);

  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    return res.status(401).json({ ok: false, error: "NO_AIRLINE_SESSION" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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

      real_schedule AS (
        SELECT
          s.id::text AS schedule_item_id,
          s.airline_id,
          s.aircraft_id,
          s.flight_number,
          s.paired_flight_number,
          UPPER(s.origin) AS origin,
          UPPER(s.destination) AS destination,
          s.dep_abs_min::int AS dep_abs_min,
          s.arr_abs_min::int AS arr_abs_min,
          s.distance_nm,
          COALESCE(s.flight_direction, 'OUTBOUND') AS flight_direction,
          s.status AS schedule_status,
          COALESCE(s.block_time_min, GREATEST(1, s.arr_abs_min - s.dep_abs_min))::int AS block_time_min,
          COALESCE(s.turnaround_min, 45)::int AS turnaround_min,
          false AS generated_return

        FROM public.schedule_items s
        WHERE
          s.item_type = 'flight'
          AND LOWER(COALESCE(s.status, 'assigned')) = 'assigned'
      ),

      generated_return AS (
        SELECT
          (rs.schedule_item_id || '_RETURN_CANONICAL')::text AS schedule_item_id,
          rs.airline_id,
          rs.aircraft_id,
          rs.paired_flight_number AS flight_number,
          rs.flight_number AS paired_flight_number,
          rs.destination AS origin,
          rs.origin AS destination,
          (rs.arr_abs_min + rs.turnaround_min)::int AS dep_abs_min,
          (rs.arr_abs_min + rs.turnaround_min + rs.block_time_min)::int AS arr_abs_min,
          rs.distance_nm,
          'RETURN' AS flight_direction,
          rs.schedule_status,
          rs.block_time_min,
          rs.turnaround_min,
          true AS generated_return

        FROM real_schedule rs
        WHERE
          rs.paired_flight_number IS NOT NULL
          AND rs.paired_flight_number <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM real_schedule r2
            WHERE
              r2.airline_id = rs.airline_id
              AND r2.aircraft_id = rs.aircraft_id
              AND r2.origin = rs.destination
              AND r2.destination = rs.origin
              AND (
                r2.flight_number = rs.paired_flight_number
                OR r2.dep_abs_min >= rs.arr_abs_min
              )
          )
      ),

      expanded_schedule AS (
        SELECT * FROM real_schedule
        UNION ALL
        SELECT * FROM generated_return
      ),

      flight_context AS (
        SELECT
          f.airline_id,
          f.aircraft_id,

          af.schedule_item_id AS active_schedule_item_id,
          af.flight_number AS active_flight_number,
          af.paired_flight_number AS active_paired_flight_number,
          af.origin AS active_origin,
          af.destination AS active_destination,
          af.dep_abs_min AS active_dep_abs_min,
          af.arr_abs_min AS active_arr_abs_min,
          af.distance_nm AS active_distance_nm,
          af.flight_direction AS active_flight_direction,
          af.schedule_status AS active_schedule_status,
          af.generated_return AS active_generated_return,

          lf.schedule_item_id AS last_schedule_item_id,
          lf.flight_number AS last_flight_number,
          lf.paired_flight_number AS last_paired_flight_number,
          lf.origin AS last_origin,
          lf.destination AS last_destination,
          lf.dep_abs_min AS last_dep_abs_min,
          lf.arr_abs_min AS last_arr_abs_min,
          lf.distance_nm AS last_distance_nm,
          lf.flight_direction AS last_flight_direction,
          lf.schedule_status AS last_schedule_status,
          lf.generated_return AS last_generated_return,

          nf.schedule_item_id AS next_schedule_item_id,
          nf.flight_number AS next_flight_number,
          nf.paired_flight_number AS next_paired_flight_number,
          nf.origin AS next_origin,
          nf.destination AS next_destination,
          nf.dep_abs_min AS next_dep_abs_min,
          nf.arr_abs_min AS next_arr_abs_min,
          nf.distance_nm AS next_distance_nm,
          nf.flight_direction AS next_flight_direction,
          nf.schedule_status AS next_schedule_status,
          nf.generated_return AS next_generated_return

        FROM fleet f
        CROSS JOIN sim

        LEFT JOIN LATERAL (
          SELECT es.*
          FROM expanded_schedule es
          WHERE
            es.airline_id = f.airline_id
            AND es.aircraft_id = f.aircraft_id
            AND sim.now_abs_min >= es.dep_abs_min
            AND sim.now_abs_min < es.arr_abs_min
          ORDER BY es.dep_abs_min ASC, es.schedule_item_id ASC
          LIMIT 1
        ) af ON true

        LEFT JOIN LATERAL (
          SELECT es.*
          FROM expanded_schedule es
          WHERE
            es.airline_id = f.airline_id
            AND es.aircraft_id = f.aircraft_id
            AND es.arr_abs_min <= sim.now_abs_min
          ORDER BY es.arr_abs_min DESC, es.schedule_item_id DESC
          LIMIT 1
        ) lf ON true

        LEFT JOIN LATERAL (
          SELECT es.*
          FROM expanded_schedule es
          WHERE
            es.airline_id = f.airline_id
            AND es.aircraft_id = f.aircraft_id
            AND es.dep_abs_min > sim.now_abs_min
          ORDER BY es.dep_abs_min ASC, es.schedule_item_id ASC
          LIMIT 1
        ) nf ON true
      )

      SELECT
        CASE WHEN f.airline_id = $1 THEN 'OWN' ELSE 'GLOBAL' END AS scope,

        f.*,

        COALESCE(fc.active_schedule_item_id, fc.next_schedule_item_id, fc.last_schedule_item_id) AS schedule_item_id,
        COALESCE(fc.active_flight_number, fc.next_flight_number, fc.last_flight_number) AS flight_number,
        COALESCE(fc.active_paired_flight_number, fc.next_paired_flight_number, fc.last_paired_flight_number) AS paired_flight_number,
        COALESCE(fc.active_origin, fc.next_origin, fc.last_origin) AS origin_icao,
        COALESCE(fc.active_destination, fc.next_destination, fc.last_destination) AS destination_icao,
        COALESCE(fc.active_dep_abs_min, fc.next_dep_abs_min, fc.last_dep_abs_min) AS dep_abs_min,
        COALESCE(fc.active_arr_abs_min, fc.next_arr_abs_min, fc.last_arr_abs_min) AS arr_abs_min,
        COALESCE(fc.active_distance_nm, fc.next_distance_nm, fc.last_distance_nm) AS distance_nm,
        COALESCE(fc.active_flight_direction, fc.next_flight_direction, fc.last_flight_direction) AS flight_direction,
        COALESCE(fc.active_schedule_status, fc.next_schedule_status, fc.last_schedule_status) AS schedule_status,
        COALESCE(fc.active_generated_return, fc.next_generated_return, fc.last_generated_return, false) AS generated_return,

        CASE
          WHEN fc.active_schedule_item_id IS NOT NULL THEN 'ACTIVE'
          WHEN fc.next_schedule_item_id IS NOT NULL THEN 'FUTURE'
          WHEN fc.last_schedule_item_id IS NOT NULL THEN 'COMPLETED'
          ELSE 'NO_FLIGHT'
        END AS flight_context,

        CASE
          WHEN UPPER(COALESCE(f.maintenance_control_status, '')) IN ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN COALESCE(NULLIF(UPPER(f.maintenance_control_reason), ''), 'MAINTENANCE')
          WHEN fc.active_schedule_item_id IS NOT NULL
          THEN 'EN_ROUTE'
          ELSE 'GROUND'
        END AS state,

        CASE
          WHEN fc.active_schedule_item_id IS NOT NULL
           AND UPPER(COALESCE(f.maintenance_control_status, '')) NOT IN ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN 'ROUTE'
          ELSE 'AIRPORT'
        END AS position_type,

        CASE
          WHEN UPPER(COALESCE(f.maintenance_control_status, '')) IN ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN COALESCE(f.current_airport, f.base_icao)

          WHEN fc.active_schedule_item_id IS NOT NULL
          THEN NULL

          WHEN fc.last_schedule_item_id IS NOT NULL
          THEN fc.last_destination

          WHEN fc.next_schedule_item_id IS NOT NULL
          THEN fc.next_origin

          ELSE COALESCE(f.current_airport, f.base_icao)
        END AS airport,

        CASE
          WHEN fc.active_schedule_item_id IS NOT NULL
           AND fc.active_arr_abs_min > fc.active_dep_abs_min
           AND UPPER(COALESCE(f.maintenance_control_status, '')) NOT IN ('IN_MAINTENANCE', 'UNSERVICEABLE')
          THEN LEAST(
            1,
            GREATEST(
              0,
              ((sim.now_abs_min - fc.active_dep_abs_min)::numeric /
               NULLIF((fc.active_arr_abs_min - fc.active_dep_abs_min), 0)::numeric)
            )
          )
          ELSE NULL
        END AS progress,

        CASE
          WHEN fc.last_schedule_item_id IS NOT NULL
           AND fc.active_schedule_item_id IS NULL
          THEN true
          ELSE false
        END AS arrived

      FROM fleet f
      CROSS JOIN sim
      LEFT JOIN flight_context fc
        ON fc.airline_id = f.airline_id
       AND fc.aircraft_id = f.aircraft_id

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
        canonicalAircraftKey: `${row.airline_id}:${rawAircraftId}`,

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
        model: row.aircraft_name || row.model_key || "-",
        aircraft: row.aircraft_name || row.model_key || "-",
        aircraftModel: row.aircraft_name || row.model_key || "-",
        modelKey: row.model_key || null,

        baseICAO: row.base_icao || null,
        base_icao: row.base_icao || null,

        state: row.state || "GROUND",
        positionType: row.position_type || "AIRPORT",

        position:
          row.position_type === "ROUTE"
            ? { progress: Number(row.progress || 0) }
            : { airport: row.airport || null },

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
        generatedReturn: row.generated_return === true,

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
    try { await client.query("ROLLBACK"); } catch {}

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
