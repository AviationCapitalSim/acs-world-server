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

/* ============================================================
   ACS A/B MAINTENANCE QUOTE HELPERS
   ------------------------------------------------------------
   Authority:
   - PostgreSQL simulated year
   - aircraft_maintenance_policy
   - Weekly Schedule Table timeline
   - No Date.now()
   - No browser clock
   ============================================================ */

const ACS_WEEK_MINUTES = 7 * 24 * 60;

const ACS_SCHEDULE_DAY_INDEX = Object.freeze({
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6
});

function ACS_normalizeCheckType(value) {
  const checkType = ACS_text(value).toUpperCase();

  if (checkType === "A" || checkType === "A_CHECK") {
    return "A_CHECK";
  }

  if (checkType === "B" || checkType === "B_CHECK") {
    return "B_CHECK";
  }

  return null;
}

function ACS_checkDisplayName(checkType) {
  return checkType === "B_CHECK" ? "B-Check" : "A-Check";
}

function ACS_normalizeScheduleDay(value) {
  const day = ACS_text(value).toLowerCase();

  return Object.prototype.hasOwnProperty.call(
    ACS_SCHEDULE_DAY_INDEX,
    day
  )
    ? day
    : null;
}

function ACS_parseScheduleTime(value) {
  const text = ACS_text(value);

  if (!/^\d{2}:\d{2}$/.test(text)) {
    return null;
  }

  const [hoursText, minutesText] = text.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return {
    text,
    minutes: (hours * 60) + minutes
  };
}

function ACS_formatScheduleMinute(value) {
  const normalized =
    ((Number(value) % 1440) + 1440) % 1440;

  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}`
  );
}

function ACS_absoluteScheduleMinute(day, timeMinutes) {
  return (
    ACS_SCHEDULE_DAY_INDEX[day] * 1440 +
    Number(timeMinutes)
  );
}

function ACS_intervalSegments(startValue, endValue) {
  let start = Number(startValue);
  let end = Number(endValue);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }

  if (end <= start) {
    end += ACS_WEEK_MINUTES;
  }

  const duration = end - start;

  if (duration >= ACS_WEEK_MINUTES) {
    return [[0, ACS_WEEK_MINUTES]];
  }

  const normalizedStart =
    ((start % ACS_WEEK_MINUTES) + ACS_WEEK_MINUTES) %
    ACS_WEEK_MINUTES;

  const normalizedEnd = normalizedStart + duration;

  if (normalizedEnd <= ACS_WEEK_MINUTES) {
    return [[normalizedStart, normalizedEnd]];
  }

  return [
    [normalizedStart, ACS_WEEK_MINUTES],
    [0, normalizedEnd - ACS_WEEK_MINUTES]
  ];
}

function ACS_intervalsOverlap(
  proposedStart,
  proposedEnd,
  existingStart,
  existingEnd
) {
  const proposedSegments =
    ACS_intervalSegments(proposedStart, proposedEnd);

  const existingSegments =
    ACS_intervalSegments(existingStart, existingEnd);

  return proposedSegments.some(([proposedFrom, proposedTo]) =>
    existingSegments.some(([existingFrom, existingTo]) =>
      proposedFrom < existingTo &&
      existingFrom < proposedTo
    )
  );
}

function ACS_resolveAircraftSizeClass(aircraft) {
  const category =
    ACS_text(aircraft?.aircraft_category).toUpperCase();

  const aircraftName =
    ACS_text(aircraft?.aircraft_name).toUpperCase();

  const seats = Number(aircraft?.seats || 0);

  if (
    category.includes("WIDEBODY") ||
    aircraftName.includes("747") ||
    aircraftName.includes("DC-10") ||
    aircraftName.includes("L-1011") ||
    aircraftName.includes("A300") ||
    aircraftName.includes("A310") ||
    seats >= 220
  ) {
    return "HEAVY";
  }

  if (
    category.includes("NARROWBODY") ||
    category.includes("REGIONAL") ||
    aircraftName.includes("707") ||
    aircraftName.includes("720") ||
    aircraftName.includes("727") ||
    aircraftName.includes("737") ||
    aircraftName.includes("DC-8") ||
    aircraftName.includes("DC-9") ||
    aircraftName.includes("CONSTELLATION") ||
    aircraftName.includes("DC-6") ||
    aircraftName.includes("DC-7") ||
    seats >= 80
  ) {
    return "MEDIUM";
  }

  return "LIGHT";
}

function ACS_resolveMaintenanceFactors(aircraft, policy) {
  const conditionPct = Number(aircraft?.condition_pct || 80);
  const totalHours = Number(aircraft?.total_hours || 0);
  const totalCycles = Number(aircraft?.total_cycles || 0);

  let conditionFactor =
    Number(policy?.condition_factor_good || 1);

  if (conditionPct < 70) {
    conditionFactor =
      Number(policy?.condition_factor_low || 1.25);
  } else if (conditionPct < 85) {
    conditionFactor =
      Number(policy?.condition_factor_medium || 1.12);
  }

  let usageFactor =
    Number(policy?.usage_factor_normal || 1);

  if (totalHours > 20000 || totalCycles > 12000) {
    usageFactor =
      Number(policy?.usage_factor_high || 1.18);
  } else if (totalHours > 10000 || totalCycles > 6000) {
    usageFactor =
      Number(policy?.usage_factor_medium || 1.10);
  }

  return {
    condition_pct: conditionPct,
    total_hours: totalHours,
    total_cycles: totalCycles,
    condition_factor: conditionFactor,
    usage_factor: usageFactor
  };
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
    MAINTENANCE_CHECK_TYPE_INVALID: 400,
    MAINTENANCE_DAY_INVALID: 400,
    MAINTENANCE_TIME_INVALID: 400,
    MAINTENANCE_POLICY_NOT_FOUND: 409,
    MAINTENANCE_COST_RATE_INVALID: 409,
    MAINTENANCE_SCHEDULE_CONFLICT: 409,
    MAINTENANCE_ALREADY_SCHEDULED: 409,
    MAINTENANCE_EVENT_IN_PROGRESS: 409,
    MAINTENANCE_STATUS_NOT_ESTABLISHED: 409,
    COMPANY_FINANCE_NOT_FOUND: 409,
    INSUFFICIENT_CAPITAL_FOR_MAINTENANCE: 409,
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
    af.updated_at,

    ams.a_check_due_date,
    ams.a_check_status,

    ams.b_check_due_date,
    ams.b_check_status,

    ams.c_check_due_date,
    ams.c_check_status,

    ams.d_check_due_date,
    ams.d_check_status,

    ams.maintenance_control_status,
    ams.maintenance_control_reason

  FROM public.aircraft_fleet af

  LEFT JOIN public.aircraft_maintenance_status ams
    ON ams.aircraft_id = af.id
   AND ams.airline_id = af.airline_id

  WHERE af.airline_id = $1

  ORDER BY
    af.registration NULLS LAST,
    af.id
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
   POST /v1/schedule/maintenance/quote
   ------------------------------------------------------------
   Body:
   {
     "aircraft_id": 45,
     "check_type": "A_CHECK",
     "selected_day": "mon",
     "start_time": "10:00"
   }

   Purpose:
   - Calculate A/B duration and cost
   - Validate weekly flight/service conflicts
   - No maintenance creation
   - No finance charge
   - No aircraft mutation
   - PostgreSQL / ACS Time Authority only
   ============================================================ */

router.post(
  "/schedule/maintenance/quote",
  requireAuth,
  async (req, res) => {
    const airlineId = ACS_airlineId(req);
    const aircraftId =
      ACS_positiveBigInt(req.body?.aircraft_id);

    const checkType =
      ACS_normalizeCheckType(req.body?.check_type);

    const selectedDay =
      ACS_normalizeScheduleDay(req.body?.selected_day);

    const startTime =
      ACS_parseScheduleTime(req.body?.start_time);

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!aircraftId) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "aircraft_id is required"
      });
    }

    if (!checkType) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_CHECK_TYPE_INVALID",
        allowed_values: ["A_CHECK", "B_CHECK"]
      });
    }

    if (!selectedDay) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_DAY_INVALID",
        allowed_values: [
          "mon",
          "tue",
          "wed",
          "thu",
          "fri",
          "sat",
          "sun"
        ]
      });
    }

    if (!startTime) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_TIME_INVALID",
        format: "HH:MM"
      });
    }

    const client = await pool.connect();

    try {
      await client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );

      const aircraftResult = await client.query(
        `
        SELECT
          af.id,
          af.airline_id,
          af.registration,
          af.aircraft_name,
          af.manufacturer,
          af.model_key,
          af.status,
          af.operational_status,
          af.maintenance_status,
          af.total_hours,
          af.total_cycles,
          af.condition_pct,
          af.current_value,
          af.purchase_price,
          af.currency,

          ac.aircraft_category,
          ac.seats,
          ac.price_acs_usd,

          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::INTEGER AS sim_year,

          acs_get_current_sim_time() AS current_sim_time

        FROM public.aircraft_fleet af

        LEFT JOIN public.aircraft_catalog ac
          ON ac.model_key = af.model_key

        WHERE af.id = $1
          AND af.airline_id = $2

        LIMIT 1
        `,
        [aircraftId, airlineId]
      );

      if (!aircraftResult.rows.length) {
        const error = new Error("AIRCRAFT_NOT_FOUND");
        error.code = "AIRCRAFT_NOT_FOUND";
        throw error;
      }

      const aircraft = aircraftResult.rows[0];
      const sizeClass =
        ACS_resolveAircraftSizeClass(aircraft);

      const policyResult = await client.query(
        `
        SELECT
          policy_code,
          aircraft_size_class,
          aircraft_category,
          era_start_year,
          era_end_year,

          a_check_interval_days,
          b_check_interval_days,
          a_check_duration_minutes,
          b_check_duration_minutes,
          a_check_cost_rate,
          b_check_cost_rate,

          condition_factor_low,
          condition_factor_medium,
          condition_factor_good,
          usage_factor_high,
          usage_factor_medium,
          usage_factor_normal

        FROM public.aircraft_maintenance_policy

        WHERE is_active = TRUE
          AND aircraft_size_class = $1
          AND aircraft_category = 'ANY'
          AND era_start_year <= $2
          AND era_end_year >= $2

        ORDER BY era_start_year DESC
        LIMIT 1
        `,
        [sizeClass, Number(aircraft.sim_year)]
      );

      if (!policyResult.rows.length) {
        const error = new Error(
          "MAINTENANCE_POLICY_NOT_FOUND"
        );

        error.code = "MAINTENANCE_POLICY_NOT_FOUND";
        throw error;
      }

      const policy = policyResult.rows[0];

      const durationMinutes =
        checkType === "B_CHECK"
          ? Number(policy.b_check_duration_minutes)
          : Number(policy.a_check_duration_minutes);

      const costRate =
        checkType === "B_CHECK"
          ? Number(policy.b_check_cost_rate)
          : Number(policy.a_check_cost_rate);

      if (
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0 ||
        !Number.isFinite(costRate) ||
        costRate <= 0
      ) {
        const error = new Error(
          "MAINTENANCE_COST_RATE_INVALID"
        );

        error.code = "MAINTENANCE_COST_RATE_INVALID";
        throw error;
      }

      const factors =
        ACS_resolveMaintenanceFactors(aircraft, policy);

      const aircraftValue = Math.round(
        Number(
          aircraft.current_value ||
          aircraft.purchase_price ||
          aircraft.price_acs_usd ||
          0
        )
      );

      const estimatedCost =
        aircraftValue > 0
          ? Math.round(
              aircraftValue *
              costRate *
              factors.condition_factor *
              factors.usage_factor
            )
          : 0;

      if (estimatedCost <= 0) {
        const error = new Error(
          "MAINTENANCE_COST_RATE_INVALID"
        );

        error.code = "MAINTENANCE_COST_RATE_INVALID";
        throw error;
      }

      const proposedStartAbs =
        ACS_absoluteScheduleMinute(
          selectedDay,
          startTime.minutes
        );

      const proposedEndAbs =
        proposedStartAbs + durationMinutes;

      const endTimeText =
        ACS_formatScheduleMinute(proposedEndAbs);

      const existingItemsResult = await client.query(
        `
        SELECT
          id,
          item_type,
          service_type,
          selected_day,
          departure,
          arrival,
          flight_number,
          dep_abs_min,
          arr_abs_min,
          turnaround_min,
          status

        FROM public.schedule_items

        WHERE airline_id = $1
          AND aircraft_id = $2
          AND item_type IN ('flight', 'service')
          AND LOWER(COALESCE(status, 'planned'))
              NOT IN ('cancelled', 'completed')

        ORDER BY dep_abs_min, id
        `,
        [airlineId, aircraftId]
      );

      let conflict = null;

      for (const item of existingItemsResult.rows) {
        const existingStart =
          Number(item.dep_abs_min);

        let existingEnd =
          Number(item.arr_abs_min);

        if (
          !Number.isFinite(existingStart) ||
          !Number.isFinite(existingEnd)
        ) {
          continue;
        }

        if (
          ACS_text(item.item_type).toLowerCase() ===
          "flight"
        ) {
          existingEnd += Number(
            item.turnaround_min || 0
          );
        }

        if (
          ACS_intervalsOverlap(
            proposedStartAbs,
            proposedEndAbs,
            existingStart,
            existingEnd
          )
        ) {
          conflict = item;
          break;
        }
      }

      if (conflict) {
        await client.query("ROLLBACK");

        const checkLabel =
          ACS_checkDisplayName(checkType);

        const conflictItemType =
          ACS_text(conflict.item_type).toLowerCase();

        if (conflictItemType === "flight") {
          const flightNumber =
            ACS_text(conflict.flight_number) ||
            "UNNUMBERED";

          return res.status(409).json({
            ok: false,
            error: "MAINTENANCE_SCHEDULE_CONFLICT",
            message:
              `⚠ Schedule Conflict\n` +
              `${checkLabel} ${startTime.text}–${endTimeText} ` +
              `overlaps flight ${flightNumber} ` +
              `${ACS_text(conflict.departure)}–` +
              `${ACS_text(conflict.arrival)}.`,
            conflict
          });
        }

        return res.status(409).json({
          ok: false,
          error: "MAINTENANCE_SCHEDULE_CONFLICT",
          conflict
        });
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        endpoint: "ACS_SCHEDULE_MAINTENANCE_QUOTE",
        version: "v1.0",
        authority: {
          schedule: "schedule_items",
          fleet: "aircraft_fleet",
          policy: "aircraft_maintenance_policy",
          time: "acs_get_current_sim_time"
        },

        aircraft: {
          id: aircraft.id,
          registration: aircraft.registration,
          aircraft_name: aircraft.aircraft_name,
          model_key: aircraft.model_key,
          size_class: sizeClass,
          current_value: aircraftValue,
          currency: aircraft.currency || "USD"
        },

        maintenance: {
          check_type: checkType,
          display_name:
            ACS_checkDisplayName(checkType),

          selected_day: selectedDay,
          start_time: startTime.text,
          end_time: endTimeText,

          dep_abs_min: proposedStartAbs,
          arr_abs_min: proposedEndAbs,

          duration_minutes: durationMinutes,
          estimated_cost: estimatedCost,
          currency: aircraft.currency || "USD"
        },

        policy: {
          policy_code: policy.policy_code,
          era_start_year:
            Number(policy.era_start_year),
          era_end_year:
            Number(policy.era_end_year),
          cost_rate: costRate,
          condition_factor:
            factors.condition_factor,
          usage_factor:
            factors.usage_factor
        },

        current_sim_time: aircraft.current_sim_time,
        conflict: null
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "ACS MAINTENANCE QUOTE ROLLBACK ERROR:",
          rollbackError
        );
      }

      console.error(
        "ACS SCHEDULE MAINTENANCE QUOTE ERROR:",
        error
      );

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_QUOTE_FAILED"
      );

    } finally {
      client.release();
    }
  }
);


/* ============================================================
   POST /v1/schedule/maintenance
   ------------------------------------------------------------
   Schedules A/B maintenance for the exact selected ACS day/time.
   Programming does not start maintenance, charge finance or
   change aircraft technical status before the scheduled time.
   ============================================================ */

router.post(
  "/schedule/maintenance",
  requireAuth,
  async (req, res) => {
    const airlineId = ACS_airlineId(req);
    const aircraftId = ACS_positiveBigInt(req.body?.aircraft_id);
    const checkType = ACS_normalizeCheckType(req.body?.check_type);
    const selectedDay = ACS_normalizeScheduleDay(req.body?.selected_day);
    const startTime = ACS_parseScheduleTime(req.body?.start_time);

    if (!airlineId) {
      return res.status(401).json({ ok: false, error: "NO_AIRLINE_SESSION" });
    }

    if (!aircraftId) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "aircraft_id is required"
      });
    }

    if (!checkType) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_CHECK_TYPE_INVALID",
        allowed_values: ["A_CHECK", "B_CHECK"]
      });
    }

    if (!selectedDay) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_DAY_INVALID"
      });
    }

    if (!startTime) {
      return res.status(400).json({
        ok: false,
        error: "MAINTENANCE_TIME_INVALID",
        format: "HH:MM"
      });
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`ACS_SCHEDULE_MAINTENANCE|${airlineId}|${aircraftId}`]
      );

      const aircraftResult = await client.query(
        `
        SELECT
          af.id,
          af.airline_id,
          af.registration,
          af.aircraft_name,
          af.manufacturer,
          af.model_key,
          af.status,
          af.operational_status,
          af.maintenance_status,
          af.base_icao,
          af.current_airport,
          af.total_hours,
          af.total_cycles,
          af.condition_pct,
          af.current_value,
          af.purchase_price,
          af.currency,

          ac.aircraft_category,
          ac.seats,
          ac.price_acs_usd,

          ams.a_check_status,
          ams.b_check_status,
          ams.c_check_status,
          ams.d_check_status,

          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::INTEGER AS sim_year

        FROM public.aircraft_fleet af

        LEFT JOIN public.aircraft_catalog ac
          ON ac.model_key = af.model_key

        JOIN public.aircraft_maintenance_status ams
          ON ams.aircraft_id = af.id
         AND ams.airline_id = af.airline_id

        WHERE af.id = $1
          AND af.airline_id = $2

        LIMIT 1
        FOR UPDATE OF af, ams
        `,
        [aircraftId, airlineId]
      );

      if (!aircraftResult.rows.length) {
        const error = new Error("AIRCRAFT_NOT_FOUND");
        error.code = "AIRCRAFT_NOT_FOUND";
        throw error;
      }

      const aircraft = aircraftResult.rows[0];

      if (
        ACS_text(aircraft.a_check_status).toUpperCase() === "NOT_ESTABLISHED" ||
        ACS_text(aircraft.b_check_status).toUpperCase() === "NOT_ESTABLISHED"
      ) {
        const error = new Error("MAINTENANCE_STATUS_NOT_ESTABLISHED");
        error.code = "MAINTENANCE_STATUS_NOT_ESTABLISHED";
        throw error;
      }

      if (
        ACS_text(aircraft.c_check_status).toUpperCase() === "IN_PROGRESS" ||
        ACS_text(aircraft.d_check_status).toUpperCase() === "IN_PROGRESS" ||
        ACS_text(aircraft.operational_status).toUpperCase() === "IN_MAINTENANCE"
      ) {
        const error = new Error("MAINTENANCE_EVENT_IN_PROGRESS");
        error.code = "MAINTENANCE_EVENT_IN_PROGRESS";
        throw error;
      }

      const duplicateResult = await client.query(
        `
        SELECT id, event_uid, check_type, event_status,
               scheduled_start_at, scheduled_end_at
        FROM public.aircraft_maintenance_events
        WHERE airline_id = $1
          AND aircraft_id = $2
          AND check_type = $3
          AND event_status IN ('SCHEDULED', 'IN_PROGRESS')
        LIMIT 1
        FOR UPDATE
        `,
        [airlineId, aircraftId, checkType]
      );

      if (duplicateResult.rows.length) {
        const error = new Error("MAINTENANCE_ALREADY_SCHEDULED");
        error.code = "MAINTENANCE_ALREADY_SCHEDULED";
        error.event = duplicateResult.rows[0];
        throw error;
      }

      const sizeClass = ACS_resolveAircraftSizeClass(aircraft);

      const policyResult = await client.query(
        `
        SELECT
          policy_code,
          aircraft_size_class,
          aircraft_category,
          era_start_year,
          era_end_year,
          a_check_interval_days,
          b_check_interval_days,
          a_check_duration_minutes,
          b_check_duration_minutes,
          a_check_cost_rate,
          b_check_cost_rate,
          condition_factor_low,
          condition_factor_medium,
          condition_factor_good,
          usage_factor_high,
          usage_factor_medium,
          usage_factor_normal
        FROM public.aircraft_maintenance_policy
        WHERE is_active = TRUE
          AND aircraft_size_class = $1
          AND aircraft_category = 'ANY'
          AND era_start_year <= $2
          AND era_end_year >= $2
        ORDER BY era_start_year DESC
        LIMIT 1
        `,
        [sizeClass, Number(aircraft.sim_year)]
      );

      if (!policyResult.rows.length) {
        const error = new Error("MAINTENANCE_POLICY_NOT_FOUND");
        error.code = "MAINTENANCE_POLICY_NOT_FOUND";
        throw error;
      }

      const policy = policyResult.rows[0];

      const durationMinutes =
        checkType === "B_CHECK"
          ? Number(policy.b_check_duration_minutes)
          : Number(policy.a_check_duration_minutes);

      const costRate =
        checkType === "B_CHECK"
          ? Number(policy.b_check_cost_rate)
          : Number(policy.a_check_cost_rate);

      if (
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0 ||
        !Number.isFinite(costRate) ||
        costRate <= 0
      ) {
        const error = new Error("MAINTENANCE_COST_RATE_INVALID");
        error.code = "MAINTENANCE_COST_RATE_INVALID";
        throw error;
      }

      const factors = ACS_resolveMaintenanceFactors(aircraft, policy);

      const aircraftValue = Math.round(
        Number(
          aircraft.current_value ||
          aircraft.purchase_price ||
          aircraft.price_acs_usd ||
          0
        )
      );

      const estimatedCost =
        aircraftValue > 0
          ? Math.round(
              aircraftValue *
              costRate *
              factors.condition_factor *
              factors.usage_factor
            )
          : 0;

      if (estimatedCost <= 0) {
        const error = new Error("MAINTENANCE_COST_RATE_INVALID");
        error.code = "MAINTENANCE_COST_RATE_INVALID";
        throw error;
      }

      const proposedStartAbs =
        ACS_absoluteScheduleMinute(selectedDay, startTime.minutes);

      const proposedEndAbs =
        proposedStartAbs + durationMinutes;

      const endTimeText =
        ACS_formatScheduleMinute(proposedEndAbs);

      const existingItemsResult = await client.query(
        `
        SELECT
          id,
          item_type,
          service_type,
          selected_day,
          departure,
          arrival,
          flight_number,
          dep_abs_min,
          arr_abs_min,
          turnaround_min,
          status
        FROM public.schedule_items
        WHERE airline_id = $1
          AND aircraft_id = $2
          AND item_type IN ('flight', 'service')
          AND LOWER(COALESCE(status, 'planned'))
              NOT IN ('cancelled', 'completed')
        ORDER BY dep_abs_min, id
        FOR UPDATE
        `,
        [airlineId, aircraftId]
      );

      let conflict = null;

      for (const item of existingItemsResult.rows) {
        const existingStart = Number(item.dep_abs_min);
        let existingEnd = Number(item.arr_abs_min);

        if (
          !Number.isFinite(existingStart) ||
          !Number.isFinite(existingEnd)
        ) {
          continue;
        }

        if (ACS_text(item.item_type).toLowerCase() === "flight") {
          existingEnd += Number(item.turnaround_min || 0);
        }

        if (
          ACS_intervalsOverlap(
            proposedStartAbs,
            proposedEndAbs,
            existingStart,
            existingEnd
          )
        ) {
          conflict = item;
          break;
        }
      }

      if (conflict) {
        const error = new Error("MAINTENANCE_SCHEDULE_CONFLICT");
        error.code = "MAINTENANCE_SCHEDULE_CONFLICT";
        error.conflict = conflict;

        if (ACS_text(conflict.item_type).toLowerCase() === "flight") {
          error.message =
            `⚠ Schedule Conflict\n` +
            `${ACS_checkDisplayName(checkType)} ` +
            `${startTime.text}–${endTimeText} ` +
            `overlaps flight ` +
            `${ACS_text(conflict.flight_number) || "UNNUMBERED"} ` +
            `${ACS_text(conflict.departure)}–` +
            `${ACS_text(conflict.arrival)}.`;
        }

        throw error;
      }

      const dayToIso = {
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6,
        sun: 7
      };

      const windowResult = await client.query(
        `
        WITH authority AS (
          SELECT
            acs_get_current_sim_time() AS current_sim_time,
            EXTRACT(
              ISODOW FROM acs_get_current_sim_time()
            )::INTEGER AS current_iso_day
        ),
        proposed AS (
          SELECT
            current_sim_time,
            date_trunc('day', current_sim_time)
            +
            (
              (($1::INTEGER - current_iso_day + 7) % 7)
              * INTERVAL '1 day'
            )
            +
            ($2::INTEGER * INTERVAL '1 minute')
            AS candidate_start
          FROM authority
        )
        SELECT
          CASE
            WHEN candidate_start <= current_sim_time
              THEN candidate_start + INTERVAL '7 days'
            ELSE candidate_start
          END AS scheduled_start_at,
          (
            CASE
              WHEN candidate_start <= current_sim_time
                THEN candidate_start + INTERVAL '7 days'
              ELSE candidate_start
            END
          ) + ($3::INTEGER * INTERVAL '1 minute')
          AS scheduled_end_at
        FROM proposed
        `,
        [
          dayToIso[selectedDay],
          startTime.minutes,
          durationMinutes
        ]
      );

      const scheduledStartAt =
        windowResult.rows[0]?.scheduled_start_at;

      const scheduledEndAt =
        windowResult.rows[0]?.scheduled_end_at;

      const location =
        ACS_text(
          aircraft.current_airport ||
          aircraft.base_icao ||
          "MAINT"
        ).toUpperCase();

      const serviceType =
        checkType === "B_CHECK" ? "B" : "A";

      const scheduleItemResult = await client.query(
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
          notes,
          aircraft_id,
          dep_abs_min,
          arr_abs_min,
          block_time_min,
          turnaround_min,
          flight_direction,
          paired_flight_number,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid()::TEXT,
          NULL,
          NULL,
          $1,
          'service',
          $2,
          $3,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          NULL,
          0,
          'scheduled',
          $10,
          $11,
          $12,
          $13,
          $14,
          0,
          NULL,
          NULL,
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        )
        RETURNING *
        `,
        [
          airlineId,
          serviceType,
          location,
          selectedDay,
          startTime.text,
          endTimeText,
          aircraft.model_key,
          aircraft.aircraft_name,
          aircraft.registration,
          JSON.stringify({
            source: "ACS_SCHEDULE_MAINTENANCE_V1",
            check_type: checkType,
            policy_code: policy.policy_code,
            scheduled_start_at: scheduledStartAt,
            scheduled_end_at: scheduledEndAt
          }),
          aircraftId,
          proposedStartAbs,
          proposedEndAbs,
          durationMinutes
        ]
      );

      const scheduleItem = scheduleItemResult.rows[0];
      const durationDays = Math.floor(durationMinutes / 1440);

      const eventResult = await client.query(
        `
        INSERT INTO public.aircraft_maintenance_events (
          airline_id,
          aircraft_id,
          check_type,
          event_status,
          started_at,
          expected_completion_at,
          completed_at,
          duration_days,
          duration_minutes,
          scheduled_start_at,
          scheduled_end_at,
          schedule_item_id,
          estimated_cost,
          final_cost,
          currency,
          finance_charged,
          finance_log_id,
          notes,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          'SCHEDULED',
          $4,
          $5,
          NULL,
          $6,
          $7,
          $4,
          $5,
          $8,
          $9,
          NULL,
          $10,
          FALSE,
          NULL,
          $11,
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        )
        RETURNING *
        `,
        [
          airlineId,
          aircraftId,
          checkType,
          scheduledStartAt,
          scheduledEndAt,
          durationDays,
          durationMinutes,
          scheduleItem.id,
          estimatedCost,
          aircraft.currency || "USD",
          JSON.stringify({
            source: "ACS_SCHEDULE_MAINTENANCE_V1",
            policy_code: policy.policy_code,
            size_class: sizeClass,
            aircraft_value: aircraftValue,
            cost_rate: costRate,
            condition_factor: factors.condition_factor,
            usage_factor: factors.usage_factor
          })
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        ok: true,
        endpoint: "ACS_SCHEDULE_CREATE_MAINTENANCE",
        version: "v1.0",
        authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
        airline_id: airlineId,
        action: "MAINTENANCE_SCHEDULED",
        aircraft: {
          id: aircraft.id,
          registration: aircraft.registration,
          aircraft_name: aircraft.aircraft_name,
          model_key: aircraft.model_key
        },
        maintenance: {
          check_type: checkType,
          selected_day: selectedDay,
          start_time: startTime.text,
          end_time: endTimeText,
          scheduled_start_at: scheduledStartAt,
          scheduled_end_at: scheduledEndAt,
          duration_minutes: durationMinutes,
          estimated_cost: estimatedCost,
          currency: aircraft.currency || "USD"
        },
        schedule_item: scheduleItem,
        event: eventResult.rows[0],
        finance: {
          charged: false,
          charge_timing: "AT_SCHEDULED_START"
        }
      });

    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "ACS SCHEDULE MAINTENANCE ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        "ACS SCHEDULE CREATE MAINTENANCE ERROR:",
        error
      );

      if (error.code === "MAINTENANCE_SCHEDULE_CONFLICT") {
        return res.status(409).json({
          ok: false,
          error: error.code,
          details: error.message,
          message: error.message,
          conflict: error.conflict || null
        });
      }

      if (error.code === "MAINTENANCE_ALREADY_SCHEDULED") {
        return res.status(409).json({
          ok: false,
          error: error.code,
          event: error.event || null
        });
      }

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_CREATE_FAILED"
      );

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   POST /v1/schedule/maintenance/resolver
   ------------------------------------------------------------
   Starts scheduled A/B maintenance only when programmed ACS time
   has arrived. B has priority over A at the same operational time.
   ============================================================ */

router.post(
  "/schedule/maintenance/resolver",
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
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const dueEventsResult = await client.query(
        `
        SELECT
          ame.id,
          ame.event_uid,
          ame.aircraft_id,
          ame.check_type,
          ame.estimated_cost,
          ame.currency,
          ame.schedule_item_id,
          ame.scheduled_start_at,
          ame.scheduled_end_at,
          af.registration,
          af.aircraft_name,
          ams.a_check_status,
          ams.b_check_status,
          ams.c_check_status,
          ams.d_check_status
        FROM public.aircraft_maintenance_events ame
        JOIN public.aircraft_fleet af
          ON af.id = ame.aircraft_id
         AND af.airline_id = ame.airline_id
        JOIN public.aircraft_maintenance_status ams
          ON ams.aircraft_id = ame.aircraft_id
         AND ams.airline_id = ame.airline_id
        WHERE ame.airline_id = $1
          AND ame.event_status = 'SCHEDULED'
          AND ame.check_type IN ('A_CHECK', 'B_CHECK')
          AND ame.scheduled_start_at
              <= acs_get_current_sim_time()
        ORDER BY
          ame.scheduled_start_at,
          CASE ame.check_type
            WHEN 'B_CHECK' THEN 1
            WHEN 'A_CHECK' THEN 2
            ELSE 3
          END,
          ame.id
        FOR UPDATE OF ame, af, ams
        `,
        [airlineId]
      );

      const startedEvents = [];

      for (const event of dueEventsResult.rows) {
        const checkType =
          ACS_text(event.check_type).toUpperCase();

        if (
          ACS_text(event.c_check_status).toUpperCase() === "IN_PROGRESS" ||
          ACS_text(event.d_check_status).toUpperCase() === "IN_PROGRESS"
        ) {
          continue;
        }

        if (
          checkType === "A_CHECK" &&
          dueEventsResult.rows.some(other =>
            Number(other.aircraft_id) === Number(event.aircraft_id) &&
            ACS_text(other.check_type).toUpperCase() === "B_CHECK" &&
            Number(other.id) !== Number(event.id)
          )
        ) {
          continue;
        }

        const cost = Math.round(
          Number(event.estimated_cost || 0)
        );

        const financeResult = await client.query(
          `
          SELECT capital
          FROM public.company_finance
          WHERE airline_id = $1
          FOR UPDATE
          `,
          [airlineId]
        );

        if (!financeResult.rows.length) {
          const error = new Error("COMPANY_FINANCE_NOT_FOUND");
          error.code = "COMPANY_FINANCE_NOT_FOUND";
          throw error;
        }

        const capital = Math.round(
          Number(financeResult.rows[0].capital || 0)
        );

        if (capital < cost) {
          const error = new Error(
            "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE"
          );
          error.code = "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE";
          error.capital = capital;
          error.required = cost;
          throw error;
        }

        const financeLogResult = await client.query(
          `
          INSERT INTO public.finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            schedule_item_id,
            reference_uid,
            description
          )
          VALUES (
            $1,
            'EXPENSE',
            $2,
            $3,
            (
              EXTRACT(
                EPOCH FROM acs_get_current_sim_time()
              ) * 1000
            )::BIGINT,
            $4,
            $5,
            $6
          )
          RETURNING id
          `,
          [
            airlineId,
            `AIRCRAFT ${checkType} — ` +
              `${event.registration || "UNREGISTERED"} ` +
              `${event.aircraft_name}`,
            cost,
            event.schedule_item_id,
            String(event.event_uid),
            `${ACS_checkDisplayName(checkType)} ` +
              `started from Schedule Table`
          ]
        );

        const financeLogId =
          financeLogResult.rows[0].id;

        await client.query(
          `
          UPDATE public.company_finance
          SET
            capital = COALESCE(capital, 0) - $2,
            expenses = COALESCE(expenses, 0) + $2,
            profit = COALESCE(profit, 0) - $2,
            cost_maintenance =
              COALESCE(cost_maintenance, 0) + $2,
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE airline_id = $1
          `,
          [airlineId, cost]
        );

        await client.query(
          `
          UPDATE public.aircraft_maintenance_events
          SET
            event_status = 'IN_PROGRESS',
            started_at = scheduled_start_at,
            expected_completion_at = scheduled_end_at,
            finance_charged = TRUE,
            finance_log_id = $2,
            final_cost = estimated_cost,
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE id = $1
            AND airline_id = $3
          `,
          [event.id, financeLogId, airlineId]
        );

        await client.query(
          `
          UPDATE public.schedule_items
          SET
            status = 'in_progress',
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE id = $1
            AND airline_id = $2
          `,
          [event.schedule_item_id, airlineId]
        );

        await client.query(
          `
          UPDATE public.aircraft_maintenance_status
          SET
            a_check_status = CASE
              WHEN $2 = 'A_CHECK' THEN 'IN_PROGRESS'
              ELSE a_check_status
            END,
            b_check_status = CASE
              WHEN $2 = 'B_CHECK' THEN 'IN_PROGRESS'
              ELSE b_check_status
            END,
            maintenance_control_status = 'IN_MAINTENANCE',
            maintenance_control_reason = $2,
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE aircraft_id = $1
            AND airline_id = $3
          `,
          [event.aircraft_id, checkType, airlineId]
        );

        await client.query(
          `
          UPDATE public.aircraft_fleet
          SET
            status = 'MAINTENANCE',
            operational_status = 'IN_MAINTENANCE',
            maintenance_status = 'CHECK_REQUIRED',
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE id = $1
            AND airline_id = $2
          `,
          [event.aircraft_id, airlineId]
        );

        startedEvents.push({
          event_id: event.id,
          aircraft_id: event.aircraft_id,
          registration: event.registration,
          check_type: checkType,
          started_at: event.scheduled_start_at,
          expected_completion_at: event.scheduled_end_at,
          charged_amount: cost
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        ok: true,
        endpoint: "ACS_SCHEDULE_MAINTENANCE_RESOLVER",
        version: "v1.0",
        authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
        airline_id: airlineId,
        started_count: startedEvents.length,
        started_events: startedEvents
      });

    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "ACS SCHEDULE MAINTENANCE RESOLVER ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        "ACS SCHEDULE MAINTENANCE RESOLVER ERROR:",
        error
      );

      if (
        error.code ===
        "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          capital: error.capital,
          required: error.required
        });
      }

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_RESOLVER_FAILED"
      );

    } finally {
      client.release();
    }
  }
);

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
