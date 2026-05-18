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

export default router;
