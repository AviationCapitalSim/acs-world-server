/* ============================================================
   ACS SCHEDULE ROUTES — POSTGRESQL AUTHORITY v2.1
   ------------------------------------------------------------
   File: routes/schedule.js

   Scope:
   - Read the authenticated airline schedule context
   - Assign and unassign aircraft transactionally
   - Validate ownership, model, dispatchability and conflicts

   Authority:
   - PostgreSQL only
   - req.airline_id from requireAuth
   - No browser persistence
   - No Finance mutation in this module
   - No Time Engine mutation in this module
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_airlineId(req) {
  const airlineId = Number(req.airline_id);
  return Number.isInteger(airlineId) && airlineId > 0 ? airlineId : null;
}

function ACS_positiveBigInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function ACS_text(value) {
  return String(value ?? "").trim();
}

function ACS_modelKey(value) {
  return ACS_text(value).toLowerCase();
}

async function ACS_getOfficialSimTime(client) {
  const result = await client.query(
    `
    SELECT acs_get_current_sim_time() AS current_sim_time
    `
  );

  const date = new Date(result.rows[0]?.current_sim_time);

  if (Number.isNaN(date.getTime())) {
    const error = new Error("ACS_CURRENT_SIM_TIME_INVALID");
    error.code = "ACS_CURRENT_SIM_TIME_INVALID";
    throw error;
  }

  return date.toISOString();
}

function ACS_sendError(res, error, fallback = "SCHEDULE_OPERATION_FAILED") {
  const knownStatus = {
    NO_AIRLINE_SESSION: 401,
    AIRLINE_NOT_FOUND: 404,
    VALIDATION_ERROR: 400,
    ROUTE_PLAN_NOT_FOUND: 404,
    AIRCRAFT_NOT_FOUND: 404,
    AIRCRAFT_NOT_DISPATCHABLE: 409,
    AIRCRAFT_MODEL_MISMATCH: 409,
    AIRCRAFT_SCHEDULE_CONFLICT: 409,
    ROUTE_HAS_NO_SCHEDULE_ITEMS: 409,
    ROUTE_ALREADY_UNASSIGNED: 409,
    ROUTE_OPERATION_LOCKED: 409,
    ACS_CURRENT_SIM_TIME_INVALID: 409
  };

  const code = error.code || fallback;
  const status = knownStatus[code] || 500;

  return res.status(status).json({
    ok: false,
    error: code,
    details: error.message
  });
}

/* ============================================================
   GET /v1/schedule/health
   ============================================================ */

router.get("/schedule/health", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  return res.json({
    ok: true,
    module: "schedule",
    version: "v2.1",
    authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
    airline_id: airlineId
  });
});

/* ============================================================
   GET /v1/schedule/context
   ------------------------------------------------------------
   Returns one consistent operational payload for Schedule Table.
   ============================================================ */

router.get("/schedule/context", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const currentSimTime = await ACS_getOfficialSimTime(client);

    const airlineResult = await client.query(
      `
      SELECT
        airline_id,
        airline_name,
        UPPER(TRIM(iata)) AS iata,
        UPPER(TRIM(icao)) AS icao
      FROM public.airlines
      WHERE airline_id = $1
      LIMIT 1
      `,
      [airlineId]
    );

    if (!airlineResult.rows.length) {
      const error = new Error("AIRLINE_NOT_FOUND");
      error.code = "AIRLINE_NOT_FOUND";
      throw error;
    }

    const fleetResult = await client.query(
      `
      SELECT
        af.id,
        af.aircraft_uid,
        af.airline_id,
        af.source,
        af.ownership_type,
        af.manufacturer,
        af.model_key,
        af.aircraft_name,
        af.registration,
        af.serial_number,
        af.status,
        af.operational_status,
        af.maintenance_status,
        af.base_icao,
        af.current_airport,
        af.year_built,
        af.delivery_date,
        af.entry_into_service_date,
        af.total_hours,
        af.total_cycles,
        af.condition_pct,
        af.updated_at
      FROM public.aircraft_fleet af
      WHERE af.airline_id = $1
      ORDER BY af.registration NULLS LAST, af.id
      `,
      [airlineId]
    );

    const routePlansResult = await client.query(
      `
      SELECT
        rp.id,
        rp.route_uid,
        rp.airline_id,
        rp.origin,
        rp.destination,
        rp.route_type,
        rp.selected_days,
        rp.departure,
        rp.arrival,
        rp.model_key,
        rp.aircraft,
        rp.aircraft_id,
        rp.registration,
        rp.distance_nm,
        rp.flight_number_out,
        rp.flight_number_in,
        rp.block_time_min,
        rp.turnaround_min,
        rp.total_rotation_min,
        rp.route_state,
        rp.created_at,
        rp.updated_at
      FROM public.route_plans rp
      WHERE rp.airline_id = $1
        AND UPPER(COALESCE(rp.route_state, 'ACTIVE')) <> 'CANCELLED'
      ORDER BY rp.created_at DESC, rp.id DESC
      `,
      [airlineId]
    );

    const scheduleItemsResult = await client.query(
      `
      SELECT
        si.id,
        si.schedule_uid,
        si.route_plan_id,
        si.route_uid,
        si.airline_id,
        si.item_type,
        si.service_type,
        si.origin,
        si.destination,
        si.selected_day,
        si.departure,
        si.arrival,
        si.model_key,
        si.aircraft,
        si.aircraft_id,
        si.aircraft_registration,
        si.flight_number,
        si.paired_flight_number,
        si.flight_direction,
        si.distance_nm,
        si.dep_abs_min,
        si.arr_abs_min,
        si.block_time_min,
        si.turnaround_min,
        si.status,
        si.notes,
        si.created_at,
        si.updated_at
      FROM public.schedule_items si
      WHERE si.airline_id = $1
        AND LOWER(COALESCE(si.status, 'planned')) <> 'cancelled'
      ORDER BY
        CASE LOWER(si.selected_day)
          WHEN 'mon' THEN 1
          WHEN 'tue' THEN 2
          WHEN 'wed' THEN 3
          WHEN 'thu' THEN 4
          WHEN 'fri' THEN 5
          WHEN 'sat' THEN 6
          WHEN 'sun' THEN 7
          ELSE 8
        END,
        COALESCE(si.dep_abs_min, 0),
        si.id
      `,
      [airlineId]
    );

    await client.query("COMMIT");

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });

    return res.json({
      ok: true,
      endpoint: "ACS_SCHEDULE_CONTEXT",
      version: "v2.1",
      authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
      airline_id: airlineId,
      current_sim_time: currentSimTime,
      airline: airlineResult.rows[0],
      fleet: fleetResult.rows,
      route_plans: routePlansResult.rows,
      schedule_items: scheduleItemsResult.rows,
      counts: {
        fleet: fleetResult.rows.length,
        route_plans: routePlansResult.rows.length,
        schedule_items: scheduleItemsResult.rows.length
      }
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("ACS SCHEDULE CONTEXT ROLLBACK ERROR:", rollbackError);
    }

    console.error("ACS SCHEDULE CONTEXT ERROR:", error);
    return ACS_sendError(res, error, "SCHEDULE_CONTEXT_FAILED");
  } finally {
    client.release();
  }
});

/* ============================================================
   POST /v1/schedule/assign-aircraft
   ------------------------------------------------------------
   Body:
   {
     "route_plan_id": 123,
     "aircraft_id": 45
   }
   ============================================================ */

router.post("/schedule/assign-aircraft", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);
  const routePlanId = ACS_positiveBigInt(req.body?.route_plan_id);
  const aircraftId = ACS_positiveBigInt(req.body?.aircraft_id);

  if (!airlineId) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  if (!routePlanId || !aircraftId) {
    return res.status(400).json({
      ok: false,
      error: "VALIDATION_ERROR",
      details: "route_plan_id and aircraft_id are required"
    });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`ACS_SCHEDULE_ASSIGN|${airlineId}|${aircraftId}`]
    );

    const routeResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        route_uid,
        model_key,
        aircraft_id,
        registration,
        route_state
      FROM public.route_plans
      WHERE id = $1
        AND airline_id = $2
      FOR UPDATE
      `,
      [routePlanId, airlineId]
    );

    if (!routeResult.rows.length) {
      const error = new Error("ROUTE_PLAN_NOT_FOUND");
      error.code = "ROUTE_PLAN_NOT_FOUND";
      throw error;
    }

    const routePlan = routeResult.rows[0];

    if (["COMPLETED", "CANCELLED", "IN_PROGRESS"].includes(
      ACS_text(routePlan.route_state).toUpperCase()
    )) {
      const error = new Error("ROUTE_OPERATION_LOCKED");
      error.code = "ROUTE_OPERATION_LOCKED";
      throw error;
    }

    const aircraftResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        model_key,
        aircraft_name,
        registration,
        status,
        operational_status,
        maintenance_status
      FROM public.aircraft_fleet
      WHERE id = $1
        AND airline_id = $2
      FOR UPDATE
      `,
      [aircraftId, airlineId]
    );

    if (!aircraftResult.rows.length) {
      const error = new Error("AIRCRAFT_NOT_FOUND");
      error.code = "AIRCRAFT_NOT_FOUND";
      throw error;
    }

    const aircraft = aircraftResult.rows[0];

    const dispatchable =
      ACS_text(aircraft.status).toUpperCase() === "ACTIVE" &&
      ACS_text(aircraft.operational_status).toUpperCase() === "AVAILABLE" &&
      ACS_text(aircraft.maintenance_status).toUpperCase() === "SERVICEABLE";

    if (!dispatchable) {
      const error = new Error("AIRCRAFT_NOT_DISPATCHABLE");
      error.code = "AIRCRAFT_NOT_DISPATCHABLE";
      throw error;
    }

    if (ACS_modelKey(routePlan.model_key) !== ACS_modelKey(aircraft.model_key)) {
      const error = new Error("AIRCRAFT_MODEL_MISMATCH");
      error.code = "AIRCRAFT_MODEL_MISMATCH";
      throw error;
    }

    const targetItemsResult = await client.query(
      `
      SELECT
        id,
        dep_abs_min,
        arr_abs_min,
        selected_day,
        departure,
        arrival,
        status
      FROM public.schedule_items
      WHERE route_plan_id = $1
        AND airline_id = $2
        AND item_type = 'flight'
        AND LOWER(COALESCE(status, 'planned')) <> 'cancelled'
      FOR UPDATE
      `,
      [routePlanId, airlineId]
    );

    if (!targetItemsResult.rows.length) {
      const error = new Error("ROUTE_HAS_NO_SCHEDULE_ITEMS");
      error.code = "ROUTE_HAS_NO_SCHEDULE_ITEMS";
      throw error;
    }

    const conflictResult = await client.query(
      `
      SELECT DISTINCT
        existing.id,
        existing.route_plan_id,
        existing.flight_number,
        existing.selected_day,
        existing.departure,
        existing.arrival
      FROM public.schedule_items target
      JOIN public.schedule_items existing
        ON existing.airline_id = target.airline_id
       AND existing.aircraft_id = $3
       AND existing.route_plan_id <> target.route_plan_id
       AND existing.item_type IN ('flight', 'service')
       AND LOWER(COALESCE(existing.status, 'planned'))
           NOT IN ('cancelled', 'completed')
       AND target.dep_abs_min IS NOT NULL
       AND target.arr_abs_min IS NOT NULL
       AND existing.dep_abs_min IS NOT NULL
       AND existing.arr_abs_min IS NOT NULL
       AND target.dep_abs_min < existing.arr_abs_min
       AND existing.dep_abs_min < target.arr_abs_min
      WHERE target.route_plan_id = $1
        AND target.airline_id = $2
        AND target.item_type = 'flight'
      LIMIT 1
      `,
      [routePlanId, airlineId, aircraftId]
    );

    if (conflictResult.rows.length) {
      const error = new Error("AIRCRAFT_SCHEDULE_CONFLICT");
      error.code = "AIRCRAFT_SCHEDULE_CONFLICT";
      error.conflict = conflictResult.rows[0];
      throw error;
    }

    await client.query(
      `
      UPDATE public.route_plans
      SET
        aircraft_id = $1,
        registration = $2,
        aircraft = $3,
        updated_at = NOW()
      WHERE id = $4
        AND airline_id = $5
      `,
      [
        aircraft.id,
        aircraft.registration,
        aircraft.aircraft_name,
        routePlanId,
        airlineId
      ]
    );

    const updatedItemsResult = await client.query(
      `
      UPDATE public.schedule_items
      SET
        aircraft_id = $1,
        aircraft_registration = $2,
        aircraft = $3,
        status = CASE
          WHEN LOWER(COALESCE(status, 'planned')) = 'planned'
            THEN 'assigned'
          ELSE status
        END,
        updated_at = NOW()
      WHERE route_plan_id = $4
        AND airline_id = $5
        AND item_type = 'flight'
        AND LOWER(COALESCE(status, 'planned')) <> 'cancelled'
      RETURNING *
      `,
      [
        aircraft.id,
        aircraft.registration,
        aircraft.aircraft_name,
        routePlanId,
        airlineId
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      ok: true,
      endpoint: "ACS_SCHEDULE_ASSIGN_AIRCRAFT",
      version: "v2.1",
      authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
      route_plan_id: routePlanId,
      aircraft: {
        id: aircraft.id,
        registration: aircraft.registration,
        model_key: aircraft.model_key,
        aircraft_name: aircraft.aircraft_name
      },
      schedule_items: updatedItemsResult.rows
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ACS SCHEDULE ASSIGN ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("ACS SCHEDULE ASSIGN ERROR:", error);

    if (error.code === "AIRCRAFT_SCHEDULE_CONFLICT") {
      return res.status(409).json({
        ok: false,
        error: error.code,
        details: error.message,
        conflict: error.conflict || null
      });
    }

    return ACS_sendError(res, error, "SCHEDULE_ASSIGN_FAILED");
  } finally {
    client.release();
  }
});

/* ============================================================
   POST /v1/schedule/unassign-aircraft
   ------------------------------------------------------------
   Body:
   {
     "route_plan_id": 123
   }
   ============================================================ */

router.post("/schedule/unassign-aircraft", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);
  const routePlanId = ACS_positiveBigInt(req.body?.route_plan_id);

  if (!airlineId) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  if (!routePlanId) {
    return res.status(400).json({
      ok: false,
      error: "VALIDATION_ERROR",
      details: "route_plan_id is required"
    });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const routeResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        aircraft_id,
        route_state
      FROM public.route_plans
      WHERE id = $1
        AND airline_id = $2
      FOR UPDATE
      `,
      [routePlanId, airlineId]
    );

    if (!routeResult.rows.length) {
      const error = new Error("ROUTE_PLAN_NOT_FOUND");
      error.code = "ROUTE_PLAN_NOT_FOUND";
      throw error;
    }

    const routePlan = routeResult.rows[0];

    if (!routePlan.aircraft_id) {
      const error = new Error("ROUTE_ALREADY_UNASSIGNED");
      error.code = "ROUTE_ALREADY_UNASSIGNED";
      throw error;
    }

    const lockedItemsResult = await client.query(
      `
      SELECT id, status
      FROM public.schedule_items
      WHERE route_plan_id = $1
        AND airline_id = $2
        AND UPPER(COALESCE(status, 'PLANNED'))
            IN ('IN_PROGRESS', 'COMPLETED')
      LIMIT 1
      `,
      [routePlanId, airlineId]
    );

    if (lockedItemsResult.rows.length) {
      const error = new Error("ROUTE_OPERATION_LOCKED");
      error.code = "ROUTE_OPERATION_LOCKED";
      throw error;
    }

    await client.query(
      `
      UPDATE public.route_plans
      SET
        aircraft_id = NULL,
        registration = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND airline_id = $2
      `,
      [routePlanId, airlineId]
    );

    const updatedItemsResult = await client.query(
      `
      UPDATE public.schedule_items
      SET
        aircraft_id = NULL,
        aircraft_registration = NULL,
        status = CASE
          WHEN LOWER(COALESCE(status, 'planned')) = 'assigned'
            THEN 'planned'
          ELSE status
        END,
        updated_at = NOW()
      WHERE route_plan_id = $1
        AND airline_id = $2
        AND item_type = 'flight'
        AND LOWER(COALESCE(status, 'planned')) <> 'cancelled'
      RETURNING *
      `,
      [routePlanId, airlineId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      ok: true,
      endpoint: "ACS_SCHEDULE_UNASSIGN_AIRCRAFT",
      version: "v2.1",
      authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
      route_plan_id: routePlanId,
      schedule_items: updatedItemsResult.rows
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ACS SCHEDULE UNASSIGN ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("ACS SCHEDULE UNASSIGN ERROR:", error);
    return ACS_sendError(res, error, "SCHEDULE_UNASSIGN_FAILED");
  } finally {
    client.release();
  }
});

export default router;
