/* ============================================================
   🟦 ACS SCHEDULE ROUTES — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   File: routes/schedule.js
   Purpose:
   - Manage Route Planning / Schedule backend endpoints
   - Read/write route_plans
   - Read/write schedule_items
   - Use PostgreSQL as authority
   - Use requireAuth and req.airline_id
   ------------------------------------------------------------
   Rules:
   - NO Finance direct modification
   - NO Time Engine modification
   - NO frontend/localStorage authority
   ============================================================ */

import express from "express";
import crypto from "crypto";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   🔹 UID HELPERS
   ============================================================ */

function ACS_generateUid(prefix) {
  if (crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ACS_normalizeSelectedDays(selectedDays) {
  if (Array.isArray(selectedDays)) return selectedDays;
  if (typeof selectedDays === "string" && selectedDays.trim()) {
    return [selectedDays.trim()];
  }
  return [];
}

function ACS_toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ============================================================
   🟢 GET /v1/schedule/health
   ------------------------------------------------------------
   Protected backend health check for Schedule module.
   ============================================================ */

router.get("/schedule/health", requireAuth, async (req, res) => {
  try {
    return res.json({
      ok: true,
      module: "schedule",
      airline_id: req.airline_id
    });
  } catch (error) {
    console.error("SCHEDULE_HEALTH_ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "SCHEDULE_ERROR",
      details: error.message
    });
  }
});

/* ============================================================
   🟦 GET /v1/schedule
   ------------------------------------------------------------
   Returns all route plans for authenticated airline.
   ============================================================ */

router.get("/schedule", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM public.route_plans
      WHERE airline_id = $1
      ORDER BY created_at DESC
      `,
      [req.airline_id]
    );

    return res.json({
      ok: true,
      route_plans: rows
    });
  } catch (error) {
    console.error("SCHEDULE_ROUTE_PLANS_GET_ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "SCHEDULE_ERROR",
      details: error.message
    });
  }
});

/* ============================================================
   🟦 ACS SCHEDULE CONTEXT — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/schedule/context

   Purpose:
   - Provide one backend-authoritative Schedule context payload
   - Return route_plans and schedule_items for req.airline_id
   - No frontend authority
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/schedule/context", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

   const routePlansResult = await pool.query(
  `
  SELECT
    id,
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
    NULL AS aircraft_registration,
    distance_nm,
    NULL AS status,
    NULL AS notes,
    created_at,
    updated_at
  FROM route_plans
  WHERE airline_id = $1
  ORDER BY created_at DESC, id DESC
  `,
  [airlineId]
);
     
    const scheduleItemsResult = await pool.query(
      `
      SELECT
        id,
        schedule_uid,
        route_plan_id,
        route_uid,
        airline_id,
        item_type,
        service_type,
        origin,
        destination,
        selected_day,
        departure,
        arrival,
        model_key,
        aircraft,
        aircraft_registration,
        flight_number,
        distance_nm,
        status,
        notes,
        created_at,
        updated_at
      FROM schedule_items
      WHERE airline_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [airlineId]
    );

    return res.json({
      ok: true,
      airline_id: airlineId,
      route_plans: routePlansResult.rows,
      schedule_items: scheduleItemsResult.rows
    });

  } catch (err) {
    console.error("ACS SCHEDULE CONTEXT ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "SCHEDULE_CONTEXT_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟨 POST /v1/schedule/route-plan
   ------------------------------------------------------------
   Creates one route plan.
   PostgreSQL is authority.
   Airline ID comes only from authenticated session.
   ============================================================ */

router.post("/schedule/route-plan", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};

    const origin = String(body.origin || "").trim().toUpperCase();
    const destination = String(body.destination || "").trim().toUpperCase();

    if (!origin || !destination) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "origin and destination are required"
      });
    }

    const routeUid =
      body.route_uid ||
      ACS_generateUid(`route_${origin}_${destination}`);

    const selectedDays = ACS_normalizeSelectedDays(body.selected_days);

    const values = [
      routeUid,
      req.airline_id,
      origin,
      destination,
      body.route_type || null,
      JSON.stringify(selectedDays),
      body.departure || null,
      body.arrival || null,
      body.model_key || null,
      body.aircraft || null,
      ACS_toNumber(body.distance_nm),
      ACS_toNumber(body.passenger_demand_y),
      ACS_toNumber(body.passenger_demand_c),
      ACS_toNumber(body.passenger_demand_f),
      ACS_toNumber(body.demand_value),
      ACS_toNumber(body.origin_slot_price),
      ACS_toNumber(body.destination_slot_price),
      ACS_toNumber(body.total_slot_price),
      body.aircraft_range_nm === undefined || body.aircraft_range_nm === null
        ? null
        : ACS_toNumber(body.aircraft_range_nm),
      body.range_margin_nm === undefined || body.range_margin_nm === null
        ? null
        : ACS_toNumber(body.range_margin_nm),
      ACS_toNumber(body.payload_penalty_pct),
      body.capability_code || "PENDING",
      body.operational_limitation || null,
      ACS_toNumber(body.setup_cost),
      ACS_toNumber(body.selected_schedule_cost),
      body.flight_number_out || null,
      body.flight_number_in || null,
      false,
      null,
      body.route_state || "planned"
    ];

    const { rows } = await pool.query(
      `
      INSERT INTO public.route_plans (
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
        distance_nm,
        passenger_demand_y,
        passenger_demand_c,
        passenger_demand_f,
        demand_value,
        origin_slot_price,
        destination_slot_price,
        total_slot_price,
        aircraft_range_nm,
        range_margin_nm,
        payload_penalty_pct,
        capability_code,
        operational_limitation,
        setup_cost,
        selected_schedule_cost,
        flight_number_out,
        flight_number_in,
        finance_applied,
        finance_transaction_id,
        route_state
      )
      VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
      )
      RETURNING *
      `,
      values
    );

    return res.status(201).json({
      ok: true,
      route_plan: rows[0]
    });
  } catch (error) {
    console.error("SCHEDULE_ROUTE_PLAN_CREATE_ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "SCHEDULE_ERROR",
      details: error.message
    });
  }
});

/* ============================================================
   🟧 POST /v1/schedule/items
   ------------------------------------------------------------
   Creates one schedule item.
   Supports flight and operational service items.
   Airline ID comes only from authenticated session.
   ============================================================ */

router.post("/schedule/items", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};

    const origin = String(body.origin || "").trim().toUpperCase();
    const destination = String(body.destination || "").trim().toUpperCase();
    const selectedDay = String(body.selected_day || "").trim();
    const departure = String(body.departure || "").trim();

    if (!origin || !destination || !selectedDay || !departure) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "origin, destination, selected_day and departure are required"
      });
    }

    const scheduleUid =
      body.schedule_uid ||
      ACS_generateUid(`schedule_${origin}_${destination}`);

    const values = [
      scheduleUid,
      body.route_plan_id || null,
      body.route_uid || null,
      req.airline_id,
      body.item_type || "flight",
      body.service_type || null,
      origin,
      destination,
      selectedDay,
      departure,
      body.arrival || null,
      body.model_key || null,
      body.aircraft || null,
      body.aircraft_registration || null,
      body.flight_number || null,
      ACS_toNumber(body.distance_nm),
      body.status || "planned",
      body.notes || null
    ];

    const { rows } = await pool.query(
      `
      INSERT INTO public.schedule_items (
        schedule_uid,
        route_plan_id,
        route_uid,
        airline_id,
        item_type,
        service_type,
        origin,
        destination,
        selected_day,
        departure,
        arrival,
        model_key,
        aircraft,
        aircraft_registration,
        flight_number,
        distance_nm,
        status,
        notes
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      RETURNING *
      `,
      values
    );

    return res.status(201).json({
      ok: true,
      schedule_item: rows[0]
    });
  } catch (error) {
    console.error("SCHEDULE_ITEM_CREATE_ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "SCHEDULE_ERROR",
      details: error.message
    });
  }
});

/* ============================================================
   🟦 ACS FLIGHT NUMBER ALLOCATION — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/schedule/flight-number/allocate

   Purpose:
   - Allocate unique flight numbers per airline IATA code
   - Use req.airline_id from requireAuth
   - Use PostgreSQL as authority
   - No frontend-generated flight numbers
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.post("/schedule/flight-number/allocate", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = req.airline_id;
    const {
      route_plan_id,
      schedule_item_id = null,
      direction = "OUTBOUND"
    } = req.body || {};

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    if (!route_plan_id) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "route_plan_id is required"
      });
    }

    await client.query("BEGIN");

    const airlineResult = await client.query(
      `
      SELECT
        airline_id,
        airline_name,
        iata,
        icao
      FROM airlines
      WHERE airline_id = $1
      LIMIT 1
      `,
      [airlineId]
    );

    if (airlineResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRLINE_NOT_FOUND",
        details: "Authenticated airline was not found"
      });
    }

    const airline = airlineResult.rows[0];
    const iataCode = String(airline.iata || "").trim().toUpperCase();

    if (!iataCode) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "MISSING_IATA_CODE",
        details: "Airline does not have an IATA code assigned"
      });
    }

    const routePlanResult = await client.query(
      `
      SELECT
        id,
        route_uid,
        airline_id,
        origin,
        destination
      FROM route_plans
      WHERE id = $1
        AND airline_id = $2
      LIMIT 1
      `,
      [route_plan_id, airlineId]
    );

    if (routePlanResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "ROUTE_PLAN_NOT_FOUND",
        details: "Route plan was not found for this airline"
      });
    }

    const routePlan = routePlanResult.rows[0];

    if (schedule_item_id) {
      const scheduleItemResult = await client.query(
        `
        SELECT
          id,
          schedule_uid,
          airline_id,
          route_plan_id
        FROM schedule_items
        WHERE id = $1
          AND airline_id = $2
          AND route_plan_id = $3
        LIMIT 1
        `,
        [schedule_item_id, airlineId, route_plan_id]
      );

      if (scheduleItemResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "SCHEDULE_ITEM_NOT_FOUND",
          details: "Schedule item was not found for this route plan"
        });
      }
    }

    let sequenceResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        iata_code,
        last_number
      FROM flight_number_sequences
      WHERE airline_id = $1
        AND iata_code = $2
      FOR UPDATE
      `,
      [airlineId, iataCode]
    );

    if (sequenceResult.rows.length === 0) {
      sequenceResult = await client.query(
        `
        INSERT INTO flight_number_sequences (
          airline_id,
          iata_code,
          last_number
        )
        VALUES ($1, $2, 0)
        RETURNING
          id,
          airline_id,
          iata_code,
          last_number
        `,
        [airlineId, iataCode]
      );
    }

    const currentLastNumber = Number(sequenceResult.rows[0].last_number || 0);
    const nextNumber = currentLastNumber + 1;
    const formattedNumber = String(nextNumber).padStart(3, "0");
    const flightNumber = `${iataCode}${formattedNumber}`;
    const allocationUid = crypto.randomUUID();

    await client.query(
      `
      UPDATE flight_number_sequences
      SET
        last_number = $1,
        updated_at = now()
      WHERE airline_id = $2
        AND iata_code = $3
      `,
      [nextNumber, airlineId, iataCode]
    );

    const allocationResult = await client.query(
      `
      INSERT INTO flight_number_allocations (
        allocation_uid,
        airline_id,
        route_plan_id,
        schedule_item_id,
        iata_code,
        flight_number,
        direction,
        origin,
        destination
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        allocation_uid,
        airline_id,
        route_plan_id,
        schedule_item_id,
        iata_code,
        flight_number,
        direction,
        origin,
        destination,
        created_at,
        updated_at
      `,
      [
        allocationUid,
        airlineId,
        route_plan_id,
        schedule_item_id,
        iataCode,
        flightNumber,
        direction,
        routePlan.origin,
        routePlan.destination
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      airline_id: airlineId,
      iata_code: iataCode,
      flight_number: flightNumber,
      allocation: allocationResult.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS FLIGHT NUMBER ALLOCATION ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FLIGHT_NUMBER_ALLOCATION_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
