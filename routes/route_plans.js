/* ============================================================
   🟦 ACS ROUTE PLANS BACKEND AUTHORITY — Airbus OCC v1.0
   ------------------------------------------------------------
   File: routes/route_plans.js
   Purpose:
   - Store operational route plans in PostgreSQL
   - Backend authority for route creation
   - Validate aircraft ownership and dispatchability
   - No localStorage authority
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   POST /v1/routes/plans
   ------------------------------------------------------------
   Creates a route plan from route_schedule.html.
   ============================================================ */

router.post("/routes/plans", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const b = req.body || {};

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const origin = String(b.origin || "").trim().toUpperCase();
    const destination = String(b.destination || "").trim().toUpperCase();

    const aircraftId = Number(b.aircraft_id || b.aircraftId || 0);

    const selectedDays = Array.isArray(b.selected_days)
      ? b.selected_days
      : Array.isArray(b.days)
        ? b.days
        : [];

    const departure = String(b.departure || "").trim();
    const arrival = String(b.arrival || "").trim();

    const distanceNm = Math.round(Number(b.distance_nm || b.distanceNM || 0));
    const blockTimeMin = Math.round(Number(b.block_time_min || b.blockTimeMin || 0));
    const turnaroundMin = Math.round(Number(b.turnaround_min || b.turnaroundMin || 0));
    const totalRotationMin = Math.round(Number(b.total_rotation_min || b.totalRotationMin || 0));

    const flightNumberOut = String(b.flight_number_out || b.flightNumberOut || "").trim().toUpperCase();
    const flightNumberIn = String(b.flight_number_in || b.flightNumberIn || "").trim().toUpperCase();

    const routeType = String(b.route_type || "PASSENGER").trim().toUpperCase();

    if (!origin || !destination) {
      return res.status(400).json({
        ok: false,
        error: "ORIGIN_DESTINATION_REQUIRED"
      });
    }

    if (origin === destination) {
      return res.status(400).json({
        ok: false,
        error: "ORIGIN_DESTINATION_CANNOT_MATCH"
      });
    }

    if (!aircraftId || !Number.isInteger(aircraftId)) {
      return res.status(400).json({
        ok: false,
        error: "AIRCRAFT_ID_REQUIRED"
      });
    }

    if (!selectedDays.length) {
      return res.status(400).json({
        ok: false,
        error: "SELECTED_DAYS_REQUIRED"
      });
    }

    if (!departure || !arrival) {
      return res.status(400).json({
        ok: false,
        error: "DEPARTURE_ARRIVAL_REQUIRED"
      });
    }

    if (!distanceNm || distanceNm <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_DISTANCE_NM"
      });
    }

    if (!blockTimeMin || blockTimeMin <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_BLOCK_TIME_MIN"
      });
    }

    if (!flightNumberOut || !flightNumberIn) {
      return res.status(400).json({
        ok: false,
        error: "FLIGHT_NUMBERS_REQUIRED"
      });
    }

    await client.query("BEGIN");

    const aircraftResult = await client.query(
      `
      SELECT
        af.id,
        af.airline_id,
        af.registration,
        af.aircraft_name,
        af.model_key,
        af.status,
        af.operational_status,
        af.maintenance_status,
        af.condition_pct,

        ams.maintenance_control_status,

        ac.range_nm,
        ac.speed_kts,
        ac.aircraft_category
      FROM aircraft_fleet af

      LEFT JOIN aircraft_maintenance_status ams
        ON ams.aircraft_id = af.id

      LEFT JOIN aircraft_catalog ac
        ON ac.model_key = af.model_key

      WHERE af.id = $1
        AND af.airline_id = $2

      LIMIT 1

      FOR UPDATE OF af
      `,
      [aircraftId, airlineId]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_FOUND_OR_NOT_OWNED"
      });
    }

    const aircraft = aircraftResult.rows[0];

    const aircraftStatus = String(aircraft.status || "").trim().toUpperCase();
    const operationalStatus = String(aircraft.operational_status || "").trim().toUpperCase();
    const maintenanceStatus = String(aircraft.maintenance_status || "").trim().toUpperCase();
    const maintenanceControlStatus = String(aircraft.maintenance_control_status || "").trim().toUpperCase();

    const isServiceable =
      maintenanceStatus === "SERVICEABLE" ||
      maintenanceControlStatus === "SERVICEABLE";

    if (
      aircraftStatus !== "ACTIVE" ||
      operationalStatus !== "AVAILABLE" ||
      !isServiceable
    ) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_NOT_DISPATCHABLE",
        aircraft: {
          id: aircraft.id,
          registration: aircraft.registration,
          status: aircraft.status,
          operational_status: aircraft.operational_status,
          maintenance_status: aircraft.maintenance_status,
          maintenance_control_status: aircraft.maintenance_control_status
        }
      });
    }

    const aircraftRangeNm = Math.round(Number(aircraft.range_nm || b.aircraft_range_nm || b.rangeNm || 0));
    const speedKts = Math.round(Number(aircraft.speed_kts || b.speed_kts || b.speedKts || 0));

    if (!aircraftRangeNm || aircraftRangeNm <= 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_RANGE_NOT_AVAILABLE"
      });
    }

    const rangeMarginNm = aircraftRangeNm - distanceNm;

    if (rangeMarginNm < 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "ROUTE_CHECK_NOT_DISPATCHABLE",
        route_check: {
          route_distance_nm: distanceNm,
          aircraft_max_range_nm: aircraftRangeNm,
          excess_nm: Math.abs(rangeMarginNm)
        }
      });
    }

    const capabilityCode = "DISPATCHABLE";
    const operationalLimitation = "NONE";

    const insertResult = await client.query(
      `
      INSERT INTO route_plans (
        route_uid,
        airline_id,
        origin,
        destination,
        route_type,
        selected_days,
        departure,
        arrival,
        model_key,
        aircraft,
        aircraft_id,
        registration,
        distance_nm,
        aircraft_range_nm,
        range_margin_nm,
        payload_penalty_pct,
        capability_code,
        operational_limitation,
        setup_cost,
        selected_schedule_cost,
        block_time_min,
        turnaround_min,
        total_rotation_min,
        speed_kts,
        flight_number_out,
        flight_number_in,
        finance_applied,
        finance_transaction_id,
        route_state,
        source,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid()::TEXT,
        $1,
        $2,
        $3,
        $4,
        $5::JSONB,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        0,
        $15,
        $16,
        0,
        0,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        FALSE,
        '',
        'ACTIVE',
        'ACS_ROUTE_PLANS_BACKEND_AUTHORITY_V1',
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        airlineId,
        origin,
        destination,
        routeType,
        JSON.stringify(selectedDays),
        departure,
        arrival,
        String(aircraft.model_key || b.model_key || b.modelKey || "").trim().toUpperCase(),
        String(aircraft.aircraft_name || b.aircraft || b.aircraftName || "").trim(),
        aircraftId,
        String(aircraft.registration || b.registration || "").trim(),
        distanceNm,
        aircraftRangeNm,
        rangeMarginNm,
        capabilityCode,
        operationalLimitation,
        blockTimeMin,
        turnaroundMin,
        totalRotationMin,
        speedKts || null,
        flightNumberOut,
        flightNumberIn
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_ROUTE_PLAN_CREATE",
      version: "v1.0",
      message: "ROUTE_PLAN_CREATED",
      route_plan: insertResult.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS ROUTE PLAN CREATE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "ROUTE_PLAN_CREATE_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
