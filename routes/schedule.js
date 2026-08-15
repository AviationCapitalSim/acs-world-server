/* ============================================================
   ACS SCHEDULE ROUTES — POSTGRESQL AUTHORITY v 2.4
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

async function ACS_ensureScheduleAircraftMaintenanceStatus(client, aircraftId, airlineId) {
  const result = await client.query(
    `
    INSERT INTO public.aircraft_maintenance_status (
      aircraft_id,
      airline_id,
      registration,
      aircraft_name,
      a_check_status,
      b_check_status,
      c_check_status,
      d_check_status,
      maintenance_control_status,
      maintenance_control_reason,
      created_at,
      updated_at
    )
    SELECT
      af.id,
      af.airline_id,
      af.registration,
      af.aircraft_name,
      'SCHEDULED',
      'SCHEDULED',
      'SCHEDULED',
      'SCHEDULED',
      'SERVICEABLE',
      NULL,
      NOW(),
      NOW()
    FROM public.aircraft_fleet af
    WHERE af.id = $1
      AND af.airline_id = $2
    ON CONFLICT (aircraft_id)
    DO NOTHING
    RETURNING aircraft_id
    `,
    [Number(aircraftId), Number(airlineId)]
  );

  return result.rows[0] || null;
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
  AIRCRAFT_COMMERCIAL_HOLD: 409,
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
  A_CHECK_BLOCKED_BY_OVERDUE_B: 409,
  MAINTENANCE_STATUS_NOT_ESTABLISHED: 409,
  MAINTENANCE_RESOLVER_SCOPE_REQUIRED: 400,

  COMPANY_FINANCE_NOT_FOUND: 409,
  INSUFFICIENT_CAPITAL_FOR_MAINTENANCE: 409,
  MAINTENANCE_FINANCE_STATE_CONFLICT: 409,

  MAINTENANCE_EVENT_NOT_EDITABLE: 409,
  MAINTENANCE_DURATION_INVALID: 409,
  MAINTENANCE_EDIT_STATE_CONFLICT: 409,

  MAINTENANCE_EVENT_NOT_FOUND: 404,
  MAINTENANCE_EVENT_NOT_REMOVABLE: 409,
  MAINTENANCE_EVENT_ALREADY_STARTED: 409,
  MAINTENANCE_REMOVE_FINANCE_CONFLICT: 409,
  MAINTENANCE_REMOVE_STATE_CONFLICT: 409,

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
    version: "v2.4",
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

    AND NOT EXISTS (
      SELECT 1
      FROM public.aircraft_market_listings market_listing
      WHERE market_listing.aircraft_id = af.id
        AND market_listing.status IN (
          'ACTIVE',
          'OFFER_RECEIVED',
          'SALE_PENDING'
        )
    )

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
        si.updated_at,

        ame.id AS maintenance_event_id,
        ame.event_uid AS maintenance_event_uid,
        ame.check_type AS maintenance_check_type,
        ame.event_status AS maintenance_event_status,
        ame.scheduled_start_at AS maintenance_scheduled_start_at,
        ame.scheduled_end_at AS maintenance_scheduled_end_at,
        ame.started_at AS maintenance_started_at,
        ame.expected_completion_at AS maintenance_expected_completion_at,
        ame.completed_at AS maintenance_completed_at,
        ame.duration_minutes AS maintenance_duration_minutes,
        ame.estimated_cost AS maintenance_estimated_cost,
        ame.final_cost AS maintenance_final_cost,
        ame.currency AS maintenance_currency,
        ame.finance_charged AS maintenance_finance_charged,
        ame.finance_log_id AS maintenance_finance_log_id

      FROM public.schedule_items si

      LEFT JOIN LATERAL (
        SELECT event_row.*
        FROM public.aircraft_maintenance_events event_row
        WHERE event_row.schedule_item_id = si.id
          AND event_row.airline_id = si.airline_id
          AND event_row.aircraft_id = si.aircraft_id
        ORDER BY
          CASE event_row.event_status
            WHEN 'IN_PROGRESS' THEN 1
            WHEN 'SCHEDULED' THEN 2
            WHEN 'COMPLETED' THEN 3
            WHEN 'CANCELLED' THEN 4
            ELSE 5
          END,
          event_row.id DESC
        LIMIT 1
      ) ame ON TRUE

      WHERE si.airline_id = $1
        AND LOWER(COALESCE(si.status, 'planned')) <> 'cancelled'
        AND NOT (
          LOWER(COALESCE(si.item_type, '')) = 'service'
          AND LOWER(COALESCE(si.status, '')) = 'completed'
        )
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
      version: "v2.4",
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
     
    const excludeScheduleItemId =
      req.body?.exclude_schedule_item_id === null ||
      req.body?.exclude_schedule_item_id === undefined ||
      req.body?.exclude_schedule_item_id === ""
        ? null
        : ACS_positiveBigInt(
            req.body?.exclude_schedule_item_id
          );

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

    if (
      req.body?.exclude_schedule_item_id !== null &&
      req.body?.exclude_schedule_item_id !== undefined &&
      req.body?.exclude_schedule_item_id !== "" &&
      !excludeScheduleItemId
    ) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "exclude_schedule_item_id must be a positive integer"
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
    si.id,
    si.item_type,
    si.service_type,
    si.selected_day,
    si.departure,
    si.arrival,
    si.flight_number,
    si.dep_abs_min,
    si.arr_abs_min,
    si.turnaround_min,
    si.status,

    ame.event_status

  FROM public.schedule_items si

  LEFT JOIN public.aircraft_maintenance_events ame
    ON ame.schedule_item_id = si.id
   AND ame.airline_id = si.airline_id
   AND ame.aircraft_id = si.aircraft_id

  WHERE si.airline_id = $1
    AND si.aircraft_id = $2

    AND (
      $3::BIGINT IS NULL
      OR si.id <> $3::BIGINT
    )

    AND si.item_type IN (
      'flight',
      'service'
    )

    AND LOWER(
      COALESCE(
        si.status,
        'planned'
      )
    ) NOT IN (
      'cancelled',
      'completed'
    )

    AND (
      si.item_type = 'flight'
      OR (
        si.item_type = 'service'
        AND UPPER(
          COALESCE(
            ame.event_status,
            ''
          )
        ) IN (
          'SCHEDULED',
          'IN_PROGRESS'
        )
      )
    )

  ORDER BY
    si.dep_abs_min,
    si.id
  `,
  [
    airlineId,
    aircraftId,
    excludeScheduleItemId
  ]
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

      if (conflict && checkType === "A_CHECK") {
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
   ACS AIRBUS OCC — A/B MAINTENANCE AUTHORITY

   Rules:
   - OVERDUE B + B_CHECK:
       Immediate IN_PROGRESS
       Immediate finance charge
       Aircraft enters IN_MAINTENANCE
   - OVERDUE B + A_CHECK:
       Rejected
       No event
       No schedule item
       No finance charge
   - Normal future maintenance:
       SCHEDULED
       No finance charge until resolver starts it
   - PostgreSQL authority only
   ============================================================ */

router.post(
  "/schedule/maintenance",
  requireAuth,
  async (req, res) => {

    const airlineId =
      ACS_airlineId(req);

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
        allowed_values: [
          "A_CHECK",
          "B_CHECK"
        ]
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

    const client =
      await pool.connect();

    let transactionStarted = false;

    try {

      await client.query("BEGIN");
      transactionStarted = true;

      /*
       * Prevent two simultaneous requests for the same
       * aircraft from creating duplicate maintenance
       * or duplicate financial charges.
       */
      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)
        )
        `,
        [
          `ACS_SCHEDULE_MAINTENANCE|${airlineId}|${aircraftId}`
        ]
      );

      await ACS_ensureScheduleAircraftMaintenanceStatus(
      client,
      aircraftId,
      airlineId
      );
       
      /* ========================================================
         AIRCRAFT + MAINTENANCE AUTHORITY
         ======================================================== */

      const aircraftResult =
        await client.query(
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

            ams.maintenance_control_status,
            ams.maintenance_control_reason,

            EXTRACT(
              YEAR FROM acs_get_current_sim_time()
            )::INTEGER AS sim_year,

            acs_get_current_sim_time()
              AS current_sim_time

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
          [
            aircraftId,
            airlineId
          ]
        );

      if (!aircraftResult.rows.length) {
        const error =
          new Error("AIRCRAFT_NOT_FOUND");

        error.code =
          "AIRCRAFT_NOT_FOUND";

        throw error;
      }

           const activeCommercialListingResult =
        await client.query(
          `
          SELECT
            id,
            listing_type,
            status
          FROM public.aircraft_market_listings
          WHERE aircraft_id = $1
            AND status IN (
              'ACTIVE',
              'OFFER_RECEIVED',
              'SALE_PENDING'
            )
          ORDER BY id DESC
          LIMIT 1
          `,
          [aircraftId]
        );

      if (activeCommercialListingResult.rows.length) {
        const error =
          new Error(
            "AIRCRAFT_COMMERCIAL_HOLD"
          );

        error.code =
          "AIRCRAFT_COMMERCIAL_HOLD";

        error.listing =
          activeCommercialListingResult.rows[0];

        throw error;
      }

      const aircraft =
        aircraftResult.rows[0];

      const aCheckStatus =
        ACS_text(
          aircraft.a_check_status
        ).toUpperCase();

      const bCheckStatus =
        ACS_text(
          aircraft.b_check_status
        ).toUpperCase();

      const cCheckStatus =
        ACS_text(
          aircraft.c_check_status
        ).toUpperCase();

      const dCheckStatus =
        ACS_text(
          aircraft.d_check_status
        ).toUpperCase();

      if (
        aCheckStatus === "NOT_ESTABLISHED" ||
        bCheckStatus === "NOT_ESTABLISHED"
      ) {
        const error =
          new Error(
            "MAINTENANCE_STATUS_NOT_ESTABLISHED"
          );

        error.code =
          "MAINTENANCE_STATUS_NOT_ESTABLISHED";

        throw error;
      }

      const higherCheckControlsAircraft =
  cCheckStatus === "IN_PROGRESS" ||
  dCheckStatus === "IN_PROGRESS" ||
  cCheckStatus === "OVERDUE" ||
  dCheckStatus === "OVERDUE";

/*
 * ACS OCC RULE:
 * An A-Check or B-Check may be programmed while another
 * maintenance check is already in progress.
 *
 * The new service remains SCHEDULED.
 * It does not start, does not charge and does not change
 * the aircraft's current maintenance status.
 */
const aircraftInMaintenance =
  ACS_text(
    aircraft.operational_status
  ).toUpperCase() === "IN_MAINTENANCE";

const activeCheckInProgress =
  aCheckStatus === "IN_PROGRESS" ||
  bCheckStatus === "IN_PROGRESS" ||
  cCheckStatus === "IN_PROGRESS" ||
  dCheckStatus === "IN_PROGRESS";

const higherCheckOverdue =
  cCheckStatus === "OVERDUE" ||
  dCheckStatus === "OVERDUE";

const allowABProgrammingDuringMaintenance =
  ["A_CHECK", "B_CHECK"].includes(checkType) &&
  (
    (
      aircraftInMaintenance &&
      activeCheckInProgress
    ) ||
    higherCheckControlsAircraft
  );

if (
  aircraftInMaintenance &&
  !allowABProgrammingDuringMaintenance
) {
  const error =
    new Error(
      "MAINTENANCE_EVENT_IN_PROGRESS"
    );

  error.code =
    "MAINTENANCE_EVENT_IN_PROGRESS";

  throw error;
}

  /* ========================================================
   ACS AIRBUS OCC — IMMEDIATE OVERDUE START AUTHORITY
   --------------------------------------------------------
   B_CHECK starts immediately only when:

   1. The requested check is B_CHECK.
   2. B is already technically OVERDUE.
   3. No C/D check is OVERDUE or IN_PROGRESS.
   4. No other maintenance check is IN_PROGRESS.

   Programming A while B is overdue remains allowed, but A
   never starts ahead of the dominant overdue B.

   C/D authority always dominates:
   D > C > B > A
   ======================================================== */

const bCheckIsOverdue =
  bCheckStatus === "OVERDUE";

const higherCheckBlocksImmediateStart =
  cCheckStatus === "OVERDUE" ||
  dCheckStatus === "OVERDUE" ||
  cCheckStatus === "IN_PROGRESS" ||
  dCheckStatus === "IN_PROGRESS";

const anotherCheckAlreadyInProgress =
  aCheckStatus === "IN_PROGRESS" ||
  bCheckStatus === "IN_PROGRESS" ||
  cCheckStatus === "IN_PROGRESS" ||
  dCheckStatus === "IN_PROGRESS";

const immediateStart =
  checkType === "B_CHECK" &&
  bCheckIsOverdue &&
  !higherCheckBlocksImmediateStart &&
  !anotherCheckAlreadyInProgress;

/* ========================================================
   B DOMINANCE — ACS AIRBUS OCC
   --------------------------------------------------------
   - A may remain programmed.
   - B may start immediately when B is OVERDUE.
   - B never deletes or cancels the player's A plan.
   - B resets the technical A cycle only after B completes.
   - C/D always block A/B execution.
   ======================================================== */
       
      /* ========================================================
         DUPLICATE PROTECTION
         ======================================================== */

      const duplicateResult =
        await client.query(
          `
          SELECT
            id,
            event_uid,
            check_type,
            event_status,
            scheduled_start_at,
            scheduled_end_at,
            finance_charged,
            finance_log_id

          FROM public.aircraft_maintenance_events

          WHERE airline_id = $1
            AND aircraft_id = $2
            AND check_type = $3
            AND event_status IN (
              'SCHEDULED',
              'IN_PROGRESS'
            )

          LIMIT 1

          FOR UPDATE
          `,
          [
            airlineId,
            aircraftId,
            checkType
          ]
        );

      if (duplicateResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_ALREADY_SCHEDULED"
          );

        error.code =
          "MAINTENANCE_ALREADY_SCHEDULED";

        error.event =
          duplicateResult.rows[0];

        throw error;
      }

      /* ========================================================
         MAINTENANCE POLICY
         ======================================================== */

      const sizeClass =
        ACS_resolveAircraftSizeClass(
          aircraft
        );

      const policyResult =
        await client.query(
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

          ORDER BY
            era_start_year DESC

          LIMIT 1
          `,
          [
            sizeClass,
            Number(aircraft.sim_year)
          ]
        );

      if (!policyResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_POLICY_NOT_FOUND"
          );

        error.code =
          "MAINTENANCE_POLICY_NOT_FOUND";

        throw error;
      }

      const policy =
        policyResult.rows[0];

      const durationMinutes =
        checkType === "B_CHECK"
          ? Number(
              policy.b_check_duration_minutes
            )
          : Number(
              policy.a_check_duration_minutes
            );

      const costRate =
        checkType === "B_CHECK"
          ? Number(
              policy.b_check_cost_rate
            )
          : Number(
              policy.a_check_cost_rate
            );

      if (
        !Number.isFinite(
          durationMinutes
        ) ||
        durationMinutes <= 0 ||
        !Number.isFinite(
          costRate
        ) ||
        costRate <= 0
      ) {
        const error =
          new Error(
            "MAINTENANCE_COST_RATE_INVALID"
          );

        error.code =
          "MAINTENANCE_COST_RATE_INVALID";

        throw error;
      }

      const factors =
        ACS_resolveMaintenanceFactors(
          aircraft,
          policy
        );

      const aircraftValue =
        Math.round(
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
        const error =
          new Error(
            "MAINTENANCE_COST_RATE_INVALID"
          );

        error.code =
          "MAINTENANCE_COST_RATE_INVALID";

        throw error;
      }

      /* ========================================================
         WEEKLY SCHEDULE POSITION
         ======================================================== */

      const proposedStartAbs =
        ACS_absoluteScheduleMinute(
          selectedDay,
          startTime.minutes
        );

      const proposedEndAbs =
        proposedStartAbs +
        durationMinutes;

      const endTimeText =
        ACS_formatScheduleMinute(
          proposedEndAbs
        );

      /* ========================================================
         CONFLICT VALIDATION
         ======================================================== */

      const existingItemsResult =
        await client.query(
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
            AND item_type IN (
              'flight',
              'service'
            )
            AND LOWER(
              COALESCE(
                status,
                'planned'
              )
            ) NOT IN (
              'cancelled',
              'completed'
            )

          ORDER BY
            dep_abs_min,
            id

          FOR UPDATE
          `,
          [
            airlineId,
            aircraftId
          ]
        );

      let conflict = null;

      for (
        const item
        of existingItemsResult.rows
      ) {

        const existingStart =
          Number(
            item.dep_abs_min
          );

        let existingEnd =
          Number(
            item.arr_abs_min
          );

        if (
          !Number.isFinite(
            existingStart
          ) ||
          !Number.isFinite(
            existingEnd
          )
        ) {
          continue;
        }

        if (
          ACS_text(
            item.item_type
          ).toLowerCase() === "flight"
        ) {
          existingEnd +=
            Number(
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

      if (conflict && checkType === "A_CHECK") {

        const error =
          new Error(
            "MAINTENANCE_SCHEDULE_CONFLICT"
          );

        error.code =
          "MAINTENANCE_SCHEDULE_CONFLICT";

        error.conflict =
          conflict;

        if (
          ACS_text(
            conflict.item_type
          ).toLowerCase() === "flight"
        ) {
          error.message =
            `Schedule Conflict: ` +
            `${ACS_checkDisplayName(checkType)} ` +
            `overlaps flight ` +
            `${
              ACS_text(
                conflict.flight_number
              ) || "UNNUMBERED"
            }.`;
        }

        throw error;
      }

      /* ========================================================
         ABSOLUTE ACS SCHEDULE WINDOW
         ======================================================== */

      const dayToIso = {
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6,
        sun: 7
      };

      const windowResult =
        await client.query(
          `
          WITH authority AS (
            SELECT
              acs_get_current_sim_time()
                AS current_sim_time,

              EXTRACT(
                ISODOW
                FROM acs_get_current_sim_time()
              )::INTEGER
                AS current_iso_day
          ),

          proposed AS (
            SELECT
              current_sim_time,

              date_trunc(
                'day',
                current_sim_time
              )
              +
              (
                (
                  (
                    $1::INTEGER -
                    current_iso_day +
                    7
                  ) % 7
                )
                * INTERVAL '1 day'
              )
              +
              (
                $2::INTEGER *
                INTERVAL '1 minute'
              )
              AS candidate_start

            FROM authority
          )

          SELECT
            current_sim_time,

            CASE
              WHEN candidate_start
                   <= current_sim_time
                THEN
                  candidate_start
                  + INTERVAL '7 days'
              ELSE
                candidate_start
            END
              AS scheduled_start_at,

            (
              CASE
                WHEN candidate_start
                     <= current_sim_time
                  THEN
                    candidate_start
                    + INTERVAL '7 days'
                ELSE
                  candidate_start
              END
            )
            +
            (
              $3::INTEGER *
              INTERVAL '1 minute'
            )
              AS scheduled_end_at

          FROM proposed
          `,
          [
            dayToIso[selectedDay],
            startTime.minutes,
            durationMinutes
          ]
        );

      const currentSimTime =
        windowResult.rows[0]
          ?.current_sim_time;

      const scheduledStartAt =
        windowResult.rows[0]
          ?.scheduled_start_at;

      const scheduledEndAt =
        windowResult.rows[0]
          ?.scheduled_end_at;

      const location =
        ACS_text(
          aircraft.current_airport ||
          aircraft.base_icao ||
          "MAINT"
        ).toUpperCase();

      const serviceType =
        checkType === "B_CHECK"
          ? "B"
          : "A";

      const scheduleItemStatus =
        immediateStart
          ? "in_progress"
          : "scheduled";

      /* ========================================================
         FINANCE LOCK — ONLY FOR IMMEDIATE START
         ======================================================== */

      let availableCapital = null;

      if (immediateStart) {

        const financeResult =
          await client.query(
            `
            SELECT
              capital

            FROM public.company_finance

            WHERE airline_id = $1

            FOR UPDATE
            `,
            [airlineId]
          );

        if (!financeResult.rows.length) {
          const error =
            new Error(
              "COMPANY_FINANCE_NOT_FOUND"
            );

          error.code =
            "COMPANY_FINANCE_NOT_FOUND";

          throw error;
        }

        availableCapital =
          Math.round(
            Number(
              financeResult.rows[0]
                .capital || 0
            )
          );

        if (
          availableCapital <
          estimatedCost
        ) {
          const error =
            new Error(
              "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE"
            );

          error.code =
            "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE";

          error.capital =
            availableCapital;

          error.required =
            estimatedCost;

          throw error;
        }
      }

      /* ========================================================
         CREATE SCHEDULE ITEM
         ======================================================== */

      const scheduleItemResult =
        await client.query(
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

            $10,
            $11,

            $12,

            $13,
            $14,

            $15,
            0,

            NULL,
            NULL,

            (
              CURRENT_TIMESTAMP
              AT TIME ZONE 'UTC'
            ),
            (
              CURRENT_TIMESTAMP
              AT TIME ZONE 'UTC'
            )
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
            scheduleItemStatus,

            JSON.stringify({
              source:
                "ACS_SCHEDULE_MAINTENANCE_V2",
              check_type:
                checkType,
              policy_code:
                policy.policy_code,
              immediate_start:
                immediateStart,
              selected_day:
                selectedDay,
              scheduled_start_at:
                scheduledStartAt,
              scheduled_end_at:
                scheduledEndAt
            }),

            aircraftId,
            proposedStartAbs,
            proposedEndAbs,
            durationMinutes
          ]
        );

      const scheduleItem =
        scheduleItemResult.rows[0];

      const durationDays =
  Math.floor(
    durationMinutes / 1440
  );

const eventStatus =
  immediateStart
    ? "IN_PROGRESS"
    : "SCHEDULED";

const eventStartedAt =
  immediateStart
    ? currentSimTime
    : null;

/*
 * The weekly schedule_item keeps the player's selected
 * day and time.
 *
 * The technical occurrence uses the real ACS start time
 * when an overdue B starts immediately.
 */
       
const eventScheduledStartAt =
  immediateStart
    ? currentSimTime
    : scheduledStartAt;

const immediateCompletionResult =
  immediateStart
    ? await client.query(
        `
        SELECT
          acs_get_current_sim_time()
          +
          (
            $1::INTEGER *
            INTERVAL '1 minute'
          ) AS completion_at
        `,
        [durationMinutes]
      )
    : null;

const eventScheduledEndAt =
  immediateStart
    ? immediateCompletionResult.rows[0]?.completion_at
    : scheduledEndAt;

const eventExpectedCompletionAt =
  eventScheduledEndAt;

      /* ========================================================
         CREATE MAINTENANCE EVENT
         ======================================================== */

      const eventResult =
        await client.query(
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
            $4,

            $5,
            $6,
            NULL,

            $7,
            $8,

            $9,
            $10,

            $11,

            $12,
            $13,

            $14,

            FALSE,
            NULL,

            $15,

            (
              CURRENT_TIMESTAMP
              AT TIME ZONE 'UTC'
            ),
            (
              CURRENT_TIMESTAMP
              AT TIME ZONE 'UTC'
            )
          )

          RETURNING *
          `,
          [
            airlineId,
            aircraftId,

            checkType,
            eventStatus,

            eventStartedAt,
            eventExpectedCompletionAt,

            durationDays,
            durationMinutes,

            eventScheduledStartAt,
            eventScheduledEndAt,

            scheduleItem.id,

            estimatedCost,
            immediateStart
              ? estimatedCost
              : null,

            aircraft.currency || "USD",

            JSON.stringify({
              source:
                "ACS_SCHEDULE_MAINTENANCE_V2",
              policy_code:
                policy.policy_code,
              size_class:
                sizeClass,
              aircraft_value:
                aircraftValue,
              cost_rate:
                costRate,
              condition_factor:
                factors.condition_factor,
              usage_factor:
                factors.usage_factor,
              immediate_start:
                immediateStart
            })
          ]
        );

      let maintenanceEvent =
        eventResult.rows[0];

      let financeLogId = null;

      /* ========================================================
         SYNCHRONIZE TECHNICAL PLANNING STATE
         --------------------------------------------------------
         Due dates are not reset here. A valid scheduled service
         suppresses OVERDUE only for its own check type.
         A future B does not suppress or reset A.
         ======================================================== */

      await client.query(
        `
        UPDATE public.aircraft_maintenance_status
        SET
          a_check_status = CASE
            WHEN $3 = 'A_CHECK' THEN 'SCHEDULED'
            ELSE a_check_status
          END,

          b_check_status = CASE
            WHEN $3 = 'B_CHECK' THEN 'SCHEDULED'
            ELSE b_check_status
          END,

          maintenance_control_status = CASE
            WHEN UPPER(COALESCE(d_check_status, '')) = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN UPPER(COALESCE(c_check_status, '')) = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN UPPER(COALESCE(d_check_status, '')) = 'OVERDUE'
              THEN 'UNSERVICEABLE'
            WHEN UPPER(COALESCE(c_check_status, '')) = 'OVERDUE'
              THEN 'UNSERVICEABLE'
            ELSE 'SERVICEABLE'
          END,

          maintenance_control_reason = CASE
            WHEN UPPER(COALESCE(d_check_status, '')) = 'IN_PROGRESS'
              THEN 'D_CHECK'
            WHEN UPPER(COALESCE(c_check_status, '')) = 'IN_PROGRESS'
              THEN 'C_CHECK'
            WHEN UPPER(COALESCE(d_check_status, '')) = 'OVERDUE'
              THEN 'D_CHECK_OVERDUE'
            WHEN UPPER(COALESCE(c_check_status, '')) = 'OVERDUE'
              THEN 'C_CHECK_OVERDUE'
            ELSE NULL
          END,

          updated_at =
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

        WHERE aircraft_id = $1
          AND airline_id = $2
        `,
        [aircraftId, airlineId, checkType]
      );

      /* ========================================================
         LEGACY IMMEDIATE START BRANCH
         --------------------------------------------------------
         Preserved structurally for minimal risk, but unreachable
         because all new A/B services are now created SCHEDULED.
         ======================================================== */

      if (immediateStart) {

        const financeLogResult =
          await client.query(
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
                  EPOCH
                  FROM acs_get_current_sim_time()
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
              `${
                aircraft.registration ||
                "UNREGISTERED"
              } ` +
              `${aircraft.aircraft_name}`,

              estimatedCost,

              scheduleItem.id,

              String(
                maintenanceEvent.event_uid
              ),

              `${ACS_checkDisplayName(
                checkType
              )} maintenance`
            ]
          );

        financeLogId =
          financeLogResult.rows[0].id;

        const financeUpdateResult =
          await client.query(
            `
            UPDATE public.company_finance

            SET
              capital =
                COALESCE(
                  capital,
                  0
                ) - $2,

              expenses =
                COALESCE(
                  expenses,
                  0
                ) + $2,

              profit =
                COALESCE(
                  profit,
                  0
                ) - $2,

              cost_maintenance =
                COALESCE(
                  cost_maintenance,
                  0
                ) + $2,

              updated_at =
                (
                  CURRENT_TIMESTAMP
                  AT TIME ZONE 'UTC'
                )

            WHERE airline_id = $1

            RETURNING
              airline_id,
              capital,
              expenses,
              profit,
              cost_maintenance,
              updated_at
            `,
            [
              airlineId,
              estimatedCost
            ]
          );

        if (
          !financeUpdateResult.rows.length
        ) {
          const error =
            new Error(
              "COMPANY_FINANCE_NOT_FOUND"
            );

          error.code =
            "COMPANY_FINANCE_NOT_FOUND";

          throw error;
        }

        const updatedEventResult =
          await client.query(
            `
            UPDATE public.aircraft_maintenance_events

SET
  event_status =
    'IN_PROGRESS',

  started_at =
    $2,

  scheduled_start_at =
    $2,

  scheduled_end_at =
    $5,

  expected_completion_at =
    $5,

  finance_charged =
    TRUE,

              finance_log_id =
                $3,

              final_cost =
                estimated_cost,

              updated_at =
                (
                  CURRENT_TIMESTAMP
                  AT TIME ZONE 'UTC'
                )

            WHERE id = $1
              AND airline_id = $4
              AND finance_charged = FALSE

            RETURNING *
            `,
            [
  maintenanceEvent.id,
  currentSimTime,
  financeLogId,
  airlineId,
  eventExpectedCompletionAt
]
          );

        if (
          !updatedEventResult.rows.length
        ) {
          const error =
            new Error(
              "MAINTENANCE_FINANCE_STATE_CONFLICT"
            );

          error.code =
            "MAINTENANCE_FINANCE_STATE_CONFLICT";

          throw error;
        }

        maintenanceEvent =
          updatedEventResult.rows[0];

        await client.query(
          `
          UPDATE public.aircraft_maintenance_status

          SET
            b_check_status =
              'IN_PROGRESS',

            maintenance_control_status =
              'IN_MAINTENANCE',

            maintenance_control_reason =
              'B_CHECK',

            updated_at =
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'UTC'
              )

          WHERE aircraft_id = $1
            AND airline_id = $2
          `,
          [
            aircraftId,
            airlineId
          ]
        );

        await client.query(
          `
          UPDATE public.aircraft_fleet

          SET
            status =
              'MAINTENANCE',

            operational_status =
              'IN_MAINTENANCE',

            maintenance_status =
              'CHECK_REQUIRED',

            updated_at =
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'UTC'
              )

          WHERE id = $1
            AND airline_id = $2
          `,
          [
            aircraftId,
            airlineId
          ]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        ok: true,

        endpoint:
          "ACS_SCHEDULE_CREATE_MAINTENANCE",

        version:
          "v2.2",

        authority:
          "POSTGRESQL_SCHEDULE_AUTHORITY",

        airline_id:
          airlineId,

        action:
          immediateStart
            ? "MAINTENANCE_STARTED"
            : "MAINTENANCE_SCHEDULED",

        aircraft: {
          id:
            aircraft.id,

          registration:
            aircraft.registration,

          aircraft_name:
            aircraft.aircraft_name,

          model_key:
            aircraft.model_key
        },

        maintenance: {
          check_type:
            checkType,

          selected_day:
            selectedDay,

          start_time:
            startTime.text,

          end_time:
            endTimeText,

          scheduled_start_at:
            scheduledStartAt,

          scheduled_end_at:
            scheduledEndAt,

          status:
            maintenanceEvent.event_status,

          currency:
            aircraft.currency || "USD"
        },

        schedule_item:
          scheduleItem,

        event:
          maintenanceEvent,

        finance: {
          charged:
            immediateStart,

          finance_log_id:
            financeLogId,

          amount:
            immediateStart
              ? estimatedCost
              : 0,

          charge_timing:
            immediateStart
              ? "IMMEDIATE_OVERDUE_START"
              : "AT_SCHEDULED_START"
        }
      });

    } catch (error) {

      if (transactionStarted) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (rollbackError) {
          console.error(
            "ACS SCHEDULE MAINTENANCE " +
            "ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        "ACS SCHEDULE CREATE " +
        "MAINTENANCE ERROR:",
        error
      );

      if (
        error.code ===
        "MAINTENANCE_SCHEDULE_CONFLICT"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          details: error.message,
          message: error.message,
          conflict:
            error.conflict || null
        });
      }

      if (
        error.code ===
        "MAINTENANCE_ALREADY_SCHEDULED"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          event:
            error.event || null
        });
      }

      if (
        error.code ===
        "A_CHECK_BLOCKED_BY_OVERDUE_B"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          message:
            "This aircraft requires a B-Check. " +
            "Completion of the B-Check resets both A and B."
        });
      }

      if (
        error.code ===
        "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          capital:
            error.capital,
          required:
            error.required
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
   PATCH /v1/schedule/maintenance/:scheduleItemId
   ------------------------------------------------------------
   ACS AIRBUS OCC — EDIT A/B MAINTENANCE

   Rules:
   - Updates the same schedule_item.
   - Updates the same maintenance event.
   - Never creates a second event.
   - Never creates a finance_log.
   - Never charges Company Finance.
   - Preserves SCHEDULED or IN_PROGRESS status.
   - Preserves finance_charged and finance_log_id.
   ============================================================ */

router.patch(
  "/schedule/maintenance/:scheduleItemId",
  requireAuth,
  async (req, res) => {

    const airlineId =
      ACS_airlineId(req);

    const scheduleItemId =
      ACS_positiveBigInt(
        req.params.scheduleItemId
      );

    const selectedDay =
      ACS_normalizeScheduleDay(
        req.body?.selected_day
      );

    const startTime =
      ACS_parseScheduleTime(
        req.body?.start_time
      );

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!scheduleItemId) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "scheduleItemId is required"
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

    const client =
      await pool.connect();

    let transactionStarted = false;

    try {

      await client.query("BEGIN");
      transactionStarted = true;

      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)
        )
        `,
        [
          `ACS_EDIT_MAINTENANCE|${airlineId}|${scheduleItemId}`
        ]
      );

      /* ========================================================
         LOCK ORIGINAL SERVICE + EVENT
         ======================================================== */

      const originalResult =
        await client.query(
          `
          SELECT
            si.id AS schedule_item_id,
            si.airline_id,
            si.aircraft_id,
            si.service_type,
            si.selected_day,
            si.departure,
            si.arrival,
            si.dep_abs_min,
            si.arr_abs_min,
            si.status AS schedule_status,

            ame.id AS event_id,
            ame.event_uid,
            ame.check_type,
            ame.event_status,
            ame.duration_minutes,
            ame.started_at,
            ame.completed_at,
            ame.finance_charged,
            ame.finance_log_id,
            ame.estimated_cost,
            ame.final_cost,
            ame.currency

          FROM public.schedule_items si

          JOIN public.aircraft_maintenance_events ame
            ON ame.schedule_item_id = si.id
           AND ame.airline_id = si.airline_id
           AND ame.aircraft_id = si.aircraft_id

          WHERE si.id = $1
            AND si.airline_id = $2
            AND si.item_type = 'service'
            AND ame.check_type IN (
              'A_CHECK',
              'B_CHECK'
            )
            AND ame.event_status IN (
              'SCHEDULED',
              'IN_PROGRESS'
            )

          LIMIT 1

          FOR UPDATE OF si, ame
          `,
          [
            scheduleItemId,
            airlineId
          ]
        );

      if (!originalResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_EVENT_NOT_EDITABLE"
          );

        error.code =
          "MAINTENANCE_EVENT_NOT_EDITABLE";

        throw error;
      }

      const original =
        originalResult.rows[0];

      const durationMinutes =
        Number(
          original.duration_minutes || 0
        );

      if (
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0
      ) {
        const error =
          new Error(
            "MAINTENANCE_DURATION_INVALID"
          );

        error.code =
          "MAINTENANCE_DURATION_INVALID";

        throw error;
      }

      const proposedStartAbs =
        ACS_absoluteScheduleMinute(
          selectedDay,
          startTime.minutes
        );

      const proposedEndAbs =
        proposedStartAbs +
        durationMinutes;

      const endTimeText =
        ACS_formatScheduleMinute(
          proposedEndAbs
        );

      /* ========================================================
         CONFLICT VALIDATION — EXCLUDES ORIGINAL SERVICE
         ======================================================== */

      const existingItemsResult =
  await client.query(
    `
    SELECT
      si.id,
      si.item_type,
      si.service_type,
      si.selected_day,
      si.departure,
      si.arrival,
      si.flight_number,
      si.dep_abs_min,
      si.arr_abs_min,
      si.turnaround_min,
      si.status,
      ame.event_status

    FROM public.schedule_items si

    LEFT JOIN public.aircraft_maintenance_events ame
      ON ame.schedule_item_id = si.id
     AND ame.airline_id = si.airline_id
     AND ame.aircraft_id = si.aircraft_id

    WHERE si.airline_id = $1
      AND si.aircraft_id = $2
      AND si.id <> $3

      AND si.item_type IN (
        'flight',
        'service'
      )

      AND LOWER(
        COALESCE(
          si.status,
          'planned'
        )
      ) NOT IN (
        'cancelled',
        'completed'
      )

      AND (
        si.item_type = 'flight'
        OR (
          si.item_type = 'service'
          AND UPPER(
            COALESCE(
              ame.event_status,
              ''
            )
          ) IN (
            'SCHEDULED',
            'IN_PROGRESS'
          )
        )
      )

    ORDER BY
      si.dep_abs_min,
      si.id

    FOR UPDATE OF si
    `,
    [
      airlineId,
      original.aircraft_id,
      scheduleItemId
    ]
  );
       
      let conflict = null;

      for (
        const item
        of existingItemsResult.rows
      ) {

        const existingStart =
          Number(
            item.dep_abs_min
          );

        let existingEnd =
          Number(
            item.arr_abs_min
          );

        if (
          !Number.isFinite(existingStart) ||
          !Number.isFinite(existingEnd)
        ) {
          continue;
        }

        if (
          ACS_text(
            item.item_type
          ).toLowerCase() === "flight"
        ) {
          existingEnd +=
            Number(
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

      if (conflict && checkType === "A_CHECK") {
        const error =
          new Error(
            "MAINTENANCE_SCHEDULE_CONFLICT"
          );

        error.code =
          "MAINTENANCE_SCHEDULE_CONFLICT";

        error.conflict =
          conflict;

        throw error;
      }

      /* ========================================================
         CALCULATE NEW ABSOLUTE ACS WINDOW
         ======================================================== */

      const dayToIso = {
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6,
        sun: 7
      };

      const windowResult =
        await client.query(
          `
          WITH authority AS (
            SELECT
              acs_get_current_sim_time()
                AS current_sim_time,

              EXTRACT(
                ISODOW
                FROM acs_get_current_sim_time()
              )::INTEGER
                AS current_iso_day
          ),

          proposed AS (
            SELECT
              current_sim_time,

              date_trunc(
                'day',
                current_sim_time
              )
              +
              (
                (
                  (
                    $1::INTEGER -
                    current_iso_day +
                    7
                  ) % 7
                )
                * INTERVAL '1 day'
              )
              +
              (
                $2::INTEGER *
                INTERVAL '1 minute'
              )
              AS candidate_start

            FROM authority
          )

          SELECT
            current_sim_time,

            CASE
              WHEN candidate_start
                   <= current_sim_time
                THEN
                  candidate_start
                  + INTERVAL '7 days'
              ELSE
                candidate_start
            END
              AS scheduled_start_at,

            (
              CASE
                WHEN candidate_start
                     <= current_sim_time
                  THEN
                    candidate_start
                    + INTERVAL '7 days'
                ELSE
                  candidate_start
              END
            )
            +
            (
              $3::INTEGER *
              INTERVAL '1 minute'
            )
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
        windowResult.rows[0]
          ?.scheduled_start_at;

      const scheduledEndAt =
        windowResult.rows[0]
          ?.scheduled_end_at;

      /* ========================================================
         UPDATE SAME SCHEDULE ITEM
         ======================================================== */

      const scheduleUpdateResult =
  await client.query(
    `
    UPDATE public.schedule_items

    SET
      selected_day = $3,
      departure = $4,
      arrival = $5,
      dep_abs_min = $6,
      arr_abs_min = $7,

      status = 'scheduled',

      notes = jsonb_build_object(
        'source',
        'ACS_SCHEDULE_MAINTENANCE_EDIT_V2',

        'check_type',
        $8::TEXT,

        'selected_day',
        $3::TEXT,

        'scheduled_start_at',
        $9::TIMESTAMP,

        'scheduled_end_at',
        $10::TIMESTAMP,

        'edited_from_status',
        $11::TEXT
      )::TEXT,

      updated_at =
        (
          CURRENT_TIMESTAMP
          AT TIME ZONE 'UTC'
        )

    WHERE id = $1
      AND airline_id = $2

    RETURNING *
    `,
    [
      scheduleItemId,
      airlineId,
      selectedDay,
      startTime.text,
      endTimeText,
      proposedStartAbs,
      proposedEndAbs,
      original.check_type,
      scheduledStartAt,
      scheduledEndAt,
      original.event_status
    ]
  );
       
      /* ========================================================
         UPDATE SAME MAINTENANCE EVENT
         Finance identity and status remain unchanged.
         ======================================================== */

      const eventUpdateResult =
  await client.query(
    `
    UPDATE public.aircraft_maintenance_events

    SET
      event_status = 'SCHEDULED',

      scheduled_start_at = $3,
      scheduled_end_at = $4,

      started_at = $3,
      expected_completion_at = $4,
      completed_at = NULL,

      updated_at =
        (
          CURRENT_TIMESTAMP
          AT TIME ZONE 'UTC'
        )

    WHERE id = $1
      AND airline_id = $2
      AND event_status IN (
        'SCHEDULED',
        'IN_PROGRESS'
      )

    RETURNING *
    `,
    [
      original.event_id,
      airlineId,
      scheduledStartAt,
      scheduledEndAt
    ]
  );
       
      if (
        !scheduleUpdateResult.rows.length ||
        !eventUpdateResult.rows.length
      ) {
        const error =
          new Error(
            "MAINTENANCE_EDIT_STATE_CONFLICT"
          );

        error.code =
          "MAINTENANCE_EDIT_STATE_CONFLICT";

        throw error;
      }

      /*
 * If the edited maintenance was already IN_PROGRESS,
 * stop the current execution and restore the aircraft
 * to its correct technical state.
 *
 * Finance remains untouched.
 */
if (
  ACS_text(
    original.event_status
  ).toUpperCase() === "IN_PROGRESS"
) {

  const technicalStateResult =
    await client.query(
      `
      UPDATE public.aircraft_maintenance_status

      SET
        a_check_status = CASE
          WHEN $3 = 'A_CHECK'
            THEN CASE
              WHEN a_check_due_date
                   <= acs_get_current_sim_time()
                THEN 'OVERDUE'
              ELSE 'OPEN'
            END
          ELSE a_check_status
        END,

        b_check_status = CASE
          WHEN $3 = 'B_CHECK'
            THEN CASE
              WHEN b_check_due_date
                   <= acs_get_current_sim_time()
                THEN 'OVERDUE'
              ELSE 'OPEN'
            END
          ELSE b_check_status
        END,

        maintenance_control_status = CASE
          WHEN UPPER(
            COALESCE(
              d_check_status,
              ''
            )
          ) = 'IN_PROGRESS'
            THEN 'IN_MAINTENANCE'

          WHEN UPPER(
            COALESCE(
              c_check_status,
              ''
            )
          ) = 'IN_PROGRESS'
            THEN 'IN_MAINTENANCE'

          WHEN UPPER(
            COALESCE(
              d_check_status,
              ''
            )
          ) = 'OVERDUE'
            THEN 'UNSERVICEABLE'

          WHEN UPPER(
            COALESCE(
              c_check_status,
              ''
            )
          ) = 'OVERDUE'
            THEN 'UNSERVICEABLE'

          WHEN
            $3 = 'B_CHECK'
            AND b_check_due_date
                <= acs_get_current_sim_time()
            THEN 'UNSERVICEABLE'

          WHEN
            $3 = 'A_CHECK'
            AND a_check_due_date
                <= acs_get_current_sim_time()
            THEN 'UNSERVICEABLE'

          ELSE 'SERVICEABLE'
        END,

        maintenance_control_reason = CASE
          WHEN UPPER(
            COALESCE(
              d_check_status,
              ''
            )
          ) = 'IN_PROGRESS'
            THEN 'D_CHECK'

          WHEN UPPER(
            COALESCE(
              c_check_status,
              ''
            )
          ) = 'IN_PROGRESS'
            THEN 'C_CHECK'

          WHEN UPPER(
            COALESCE(
              d_check_status,
              ''
            )
          ) = 'OVERDUE'
            THEN 'D_CHECK_OVERDUE'

          WHEN UPPER(
            COALESCE(
              c_check_status,
              ''
            )
          ) = 'OVERDUE'
            THEN 'C_CHECK_OVERDUE'

          WHEN
            $3 = 'B_CHECK'
            AND b_check_due_date
                <= acs_get_current_sim_time()
            THEN 'B_CHECK_OVERDUE'

          WHEN
            $3 = 'A_CHECK'
            AND a_check_due_date
                <= acs_get_current_sim_time()
            THEN 'A_CHECK_OVERDUE'

          ELSE NULL
        END,

        updated_at =
          (
            CURRENT_TIMESTAMP
            AT TIME ZONE 'UTC'
          )

      WHERE aircraft_id = $1
        AND airline_id = $2

      RETURNING
        a_check_status,
        b_check_status,
        c_check_status,
        d_check_status,
        maintenance_control_status,
        maintenance_control_reason
      `,
      [
        original.aircraft_id,
        airlineId,
        original.check_type
      ]
    );

  const technicalState =
    technicalStateResult.rows[0] || {};

  const stillInMaintenance =
    ACS_text(
      technicalState.maintenance_control_status
    ).toUpperCase() === "IN_MAINTENANCE";

  const stillUnserviceable =
    ACS_text(
      technicalState.maintenance_control_status
    ).toUpperCase() === "UNSERVICEABLE";

  await client.query(
    `
    UPDATE public.aircraft_fleet

    SET
      status = CASE
        WHEN $3::BOOLEAN
          THEN 'MAINTENANCE'
        ELSE 'ACTIVE'
      END,

      operational_status = CASE
        WHEN $3::BOOLEAN
          THEN 'IN_MAINTENANCE'

        WHEN $4::BOOLEAN
          THEN 'UNAVAILABLE'

        ELSE 'AVAILABLE'
      END,

      maintenance_status = CASE
        WHEN $3::BOOLEAN
          THEN 'CHECK_REQUIRED'

        WHEN $4::BOOLEAN
          THEN 'CHECK_REQUIRED'

        ELSE 'SERVICEABLE'
      END,

      updated_at =
        (
          CURRENT_TIMESTAMP
          AT TIME ZONE 'UTC'
        )

    WHERE id = $1
      AND airline_id = $2
    `,
    [
      original.aircraft_id,
      airlineId,
      stillInMaintenance,
      stillUnserviceable
    ]
  );
}
       
      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        ok: true,

        endpoint:
          "ACS_SCHEDULE_EDIT_MAINTENANCE",

        version:
          "v1.0",

        authority:
          "POSTGRESQL_SCHEDULE_AUTHORITY",

        airline_id:
          airlineId,

        action:
          "MAINTENANCE_UPDATED",

        maintenance: {
          check_type:
            original.check_type,

          selected_day:
            selectedDay,

          start_time:
            startTime.text,

          end_time:
            endTimeText,

          scheduled_start_at:
            scheduledStartAt,

          scheduled_end_at:
            scheduledEndAt,

          event_status:
            original.event_status,

          finance_charged:
            original.finance_charged,

          finance_log_id:
            original.finance_log_id
        },

        schedule_item:
          scheduleUpdateResult.rows[0],

        event:
          eventUpdateResult.rows[0]
      });

    } catch (error) {

      if (transactionStarted) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (rollbackError) {
          console.error(
            "ACS EDIT MAINTENANCE " +
            "ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        "ACS EDIT MAINTENANCE ERROR:",
        error
      );

      if (
        error.code ===
        "MAINTENANCE_SCHEDULE_CONFLICT"
      ) {
        return res.status(409).json({
          ok: false,
          error: error.code,
          details:
            "The selected maintenance window conflicts with another scheduled operation.",
          conflict:
            error.conflict || null
        });
      }

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_EDIT_FAILED"
      );

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   PATCH /v1/schedule/maintenance/:scheduleItemId/remove
   ------------------------------------------------------------
   ACS AIRBUS OCC — REMOVE A/B MAINTENANCE

   Rules:
   - SCHEDULED may be cancelled.
   - IN_PROGRESS may be stopped and cancelled.
   - COMPLETED maintenance is immutable technical history.
   - No physical DELETE.
   - No refund.
   - Existing finance_log remains untouched.
   - Aircraft technical condition is recalculated.
   ============================================================ */

router.patch(
  "/schedule/maintenance/:scheduleItemId/remove",
  requireAuth,
  async (req, res) => {

    const airlineId =
      ACS_airlineId(req);

    const scheduleItemId =
      ACS_positiveBigInt(
        req.params.scheduleItemId
      );

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!scheduleItemId) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "scheduleItemId is required"
      });
    }

    const client =
      await pool.connect();

    let transactionStarted = false;

    try {

      await client.query("BEGIN");
      transactionStarted = true;

      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)
        )
        `,
        [
          `ACS_REMOVE_MAINTENANCE|${airlineId}|${scheduleItemId}`
        ]
      );

      const maintenanceResult =
        await client.query(
          `
          SELECT
            si.id AS schedule_item_id,
            si.aircraft_id,
            si.service_type,
            si.status AS schedule_status,

            ame.id AS event_id,
            ame.event_uid,
            ame.check_type,
            ame.event_status,
            ame.finance_charged,
            ame.finance_log_id

          FROM public.schedule_items si

          JOIN public.aircraft_maintenance_events ame
            ON ame.schedule_item_id = si.id
           AND ame.airline_id = si.airline_id
           AND ame.aircraft_id = si.aircraft_id

          WHERE si.id = $1
            AND si.airline_id = $2
            AND si.item_type = 'service'
            AND ame.check_type IN (
              'A_CHECK',
              'B_CHECK'
            )

          LIMIT 1

          FOR UPDATE OF si, ame
          `,
          [
            scheduleItemId,
            airlineId
          ]
        );

      if (!maintenanceResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_EVENT_NOT_FOUND"
          );

        error.code =
          "MAINTENANCE_EVENT_NOT_FOUND";

        throw error;
      }

      const maintenance =
        maintenanceResult.rows[0];

      const originalEventStatus =
        ACS_text(
          maintenance.event_status
        ).toUpperCase();

      if (
        ![
          "SCHEDULED",
          "IN_PROGRESS"
        ].includes(originalEventStatus)
      ) {
        const error =
          new Error(
            "MAINTENANCE_EVENT_NOT_REMOVABLE"
          );

        error.code =
          "MAINTENANCE_EVENT_NOT_REMOVABLE";

        throw error;
      }

      const eventUpdateResult =
        await client.query(
          `
          UPDATE public.aircraft_maintenance_events

          SET
            event_status = 'CANCELLED',

            completed_at = NULL,

            updated_at =
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'UTC'
              )

          WHERE id = $1
            AND airline_id = $2
            AND event_status IN (
              'SCHEDULED',
              'IN_PROGRESS'
            )

          RETURNING
            id,
            event_uid,
            aircraft_id,
            check_type,
            event_status,
            schedule_item_id,
            finance_charged,
            finance_log_id
          `,
          [
            maintenance.event_id,
            airlineId
          ]
        );

      if (!eventUpdateResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_REMOVE_STATE_CONFLICT"
          );

        error.code =
          "MAINTENANCE_REMOVE_STATE_CONFLICT";

        throw error;
      }

      const scheduleUpdateResult =
        await client.query(
          `
          UPDATE public.schedule_items

          SET
            status = 'cancelled',

            updated_at =
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'UTC'
              )

          WHERE id = $1
            AND airline_id = $2
            AND LOWER(
              COALESCE(
                status,
                'scheduled'
              )
            ) IN (
              'scheduled',
              'in_progress'
            )

          RETURNING *
          `,
          [
            scheduleItemId,
            airlineId
          ]
        );

      if (!scheduleUpdateResult.rows.length) {
        const error =
          new Error(
            "MAINTENANCE_REMOVE_STATE_CONFLICT"
          );

        error.code =
          "MAINTENANCE_REMOVE_STATE_CONFLICT";

        throw error;
      }

      /*
       * Only an active event requires technical-state restoration.
       * Finance remains unchanged and no refund is generated.
       */
      if (originalEventStatus === "IN_PROGRESS") {

        const technicalStateResult =
          await client.query(
            `
            UPDATE public.aircraft_maintenance_status

            SET
              a_check_status = CASE
                WHEN $3 = 'A_CHECK'
                  THEN CASE
                    WHEN a_check_due_date
                         <= acs_get_current_sim_time()
                      THEN 'OVERDUE'
                    ELSE 'OPEN'
                  END
                ELSE a_check_status
              END,

              b_check_status = CASE
                WHEN $3 = 'B_CHECK'
                  THEN CASE
                    WHEN b_check_due_date
                         <= acs_get_current_sim_time()
                      THEN 'OVERDUE'
                    ELSE 'OPEN'
                  END
                ELSE b_check_status
              END,

              maintenance_control_status = CASE
                WHEN UPPER(
                  COALESCE(
                    d_check_status,
                    ''
                  )
                ) = 'IN_PROGRESS'
                  THEN 'IN_MAINTENANCE'

                WHEN UPPER(
                  COALESCE(
                    c_check_status,
                    ''
                  )
                ) = 'IN_PROGRESS'
                  THEN 'IN_MAINTENANCE'

                WHEN UPPER(
                  COALESCE(
                    d_check_status,
                    ''
                  )
                ) = 'OVERDUE'
                  THEN 'UNSERVICEABLE'

                WHEN UPPER(
                  COALESCE(
                    c_check_status,
                    ''
                  )
                ) = 'OVERDUE'
                  THEN 'UNSERVICEABLE'

                WHEN
                  $3 = 'B_CHECK'
                  AND b_check_due_date
                      <= acs_get_current_sim_time()
                  THEN 'UNSERVICEABLE'

                WHEN
                  $3 = 'A_CHECK'
                  AND a_check_due_date
                      <= acs_get_current_sim_time()
                  THEN 'UNSERVICEABLE'

                ELSE 'SERVICEABLE'
              END,

              maintenance_control_reason = CASE
                WHEN UPPER(
                  COALESCE(
                    d_check_status,
                    ''
                  )
                ) = 'IN_PROGRESS'
                  THEN 'D_CHECK'

                WHEN UPPER(
                  COALESCE(
                    c_check_status,
                    ''
                  )
                ) = 'IN_PROGRESS'
                  THEN 'C_CHECK'

                WHEN UPPER(
                  COALESCE(
                    d_check_status,
                    ''
                  )
                ) = 'OVERDUE'
                  THEN 'D_CHECK_OVERDUE'

                WHEN UPPER(
                  COALESCE(
                    c_check_status,
                    ''
                  )
                ) = 'OVERDUE'
                  THEN 'C_CHECK_OVERDUE'

                WHEN
                  $3 = 'B_CHECK'
                  AND b_check_due_date
                      <= acs_get_current_sim_time()
                  THEN 'B_CHECK_OVERDUE'

                WHEN
                  $3 = 'A_CHECK'
                  AND a_check_due_date
                      <= acs_get_current_sim_time()
                  THEN 'A_CHECK_OVERDUE'

                ELSE NULL
              END,

              updated_at =
                (
                  CURRENT_TIMESTAMP
                  AT TIME ZONE 'UTC'
                )

            WHERE aircraft_id = $1
              AND airline_id = $2

            RETURNING
              a_check_status,
              b_check_status,
              c_check_status,
              d_check_status,
              maintenance_control_status,
              maintenance_control_reason
            `,
            [
              maintenance.aircraft_id,
              airlineId,
              maintenance.check_type
            ]
          );

        const technicalState =
          technicalStateResult.rows[0] || {};

        const controlStatus =
          ACS_text(
            technicalState.maintenance_control_status
          ).toUpperCase();

        const aircraftStillInMaintenance =
          controlStatus === "IN_MAINTENANCE";

        const aircraftUnserviceable =
          controlStatus === "UNSERVICEABLE";

        await client.query(
          `
          UPDATE public.aircraft_fleet

          SET
            status = CASE
              WHEN $3::BOOLEAN
                THEN 'MAINTENANCE'
              ELSE 'ACTIVE'
            END,

            operational_status = CASE
              WHEN $3::BOOLEAN
                THEN 'IN_MAINTENANCE'

              WHEN $4::BOOLEAN
                THEN 'UNAVAILABLE'

              ELSE 'AVAILABLE'
            END,

            maintenance_status = CASE
              WHEN $3::BOOLEAN
                THEN 'CHECK_REQUIRED'

              WHEN $4::BOOLEAN
                THEN 'CHECK_REQUIRED'

              ELSE 'SERVICEABLE'
            END,

            updated_at =
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'UTC'
              )

          WHERE id = $1
            AND airline_id = $2
          `,
          [
            maintenance.aircraft_id,
            airlineId,
            aircraftStillInMaintenance,
            aircraftUnserviceable
          ]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        ok: true,

        endpoint:
          "ACS_SCHEDULE_REMOVE_MAINTENANCE",

        version:
          "v2.0",

        authority:
          "POSTGRESQL_SCHEDULE_AUTHORITY",

        airline_id:
          airlineId,

        action:
          "MAINTENANCE_REMOVED",

        previous_event_status:
          originalEventStatus,

        finance: {
          refund_created: false,
          original_charge_preserved:
            maintenance.finance_charged === true,
          finance_log_id:
            maintenance.finance_log_id
        },

        schedule_item:
          scheduleUpdateResult.rows[0],

        event:
          eventUpdateResult.rows[0]
      });

    } catch (error) {

      if (transactionStarted) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (rollbackError) {
          console.error(
            "ACS REMOVE MAINTENANCE " +
            "ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        "ACS REMOVE MAINTENANCE ERROR:",
        error
      );

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_REMOVE_FAILED"
      );

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   POST /v1/schedule/maintenance/resolver
   ------------------------------------------------------------
   ACS A/B maintenance lifecycle authority:
   1. Completes IN_PROGRESS events whose ACS completion time arrived.
   2. Resets A/B cycles only when the maintenance is COMPLETED.
   3. Cancels pending A when B is completed (B satisfies A).
   4. Starts due SCHEDULED events and charges them only once.
   PostgreSQL / Railway authority only.
   ============================================================ */

async function ACS_runMaintenanceResolverForAirline(airlineId) {
  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    const error = new Error("NO_AIRLINE_SESSION");
    error.code = "NO_AIRLINE_SESSION";
    throw error;
  }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const resolverLockResult = await client.query(
        `
        SELECT pg_try_advisory_xact_lock(
          hashtext($1)
        ) AS acquired
        `,
        [`ACS_AB_MAINTENANCE_RESOLVER|${airlineId}`]
      );

      if (resolverLockResult.rows[0]?.acquired !== true) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return {
          ok: true,
          endpoint: "ACS_SCHEDULE_MAINTENANCE_RESOLVER",
          version: "v2.4",
          authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
          airline_id: airlineId,
          skipped: true,
          skip_reason: "RESOLVER_ALREADY_RUNNING",
          orphan_recovered_count: 0,
          phase0_normalized_count: 0,
          phase1_candidate_count: 0,
          completed_count: 0,
          completed_events: [],
          started_count: 0,
          started_events: [],
          blocked_count: 0,
          blocked_events: []
        };
      }

          /* ========================================================
         ACS AIRBUS OCC — GLOBAL ORPHAN PLAN RECOVERY
         --------------------------------------------------------
         ACS CONTRACT:
         - schedule_items is the player's persistent A/B plan.
         - aircraft_maintenance_events is the current technical
           occurrence tracked per schedule_item_id.
         - Duplicate prevention is enforced via an explicit
           NOT EXISTS check on schedule_item_id at INSERT time.
           Therefore, a persistent plan cannot receive a second
           event row with the same schedule_item_id.
         - If the plan exists and the linked event is historical
           COMPLETED/CANCELLED, recycle that same event row into
           the next SCHEDULED occurrence.
         - No C/D mutation.
         - No frontend mutation.
         - No aircraft.js mutation.
         ======================================================== */

      const orphanRecoveryResult = await client.query(
        `
        WITH active_plans AS (
          SELECT
            si.id AS schedule_item_id,
            si.airline_id,
            si.aircraft_id,

            CASE
              WHEN UPPER(COALESCE(si.service_type, ''))
                   IN ('B', 'B_CHECK')
                THEN 'B_CHECK'
              ELSE 'A_CHECK'
            END AS check_type,

            CASE LOWER(si.selected_day)
              WHEN 'mon' THEN 1
              WHEN 'tue' THEN 2
              WHEN 'wed' THEN 3
              WHEN 'thu' THEN 4
              WHEN 'fri' THEN 5
              WHEN 'sat' THEN 6
              WHEN 'sun' THEN 7
              ELSE NULL
            END AS selected_iso_day,

            CASE
              WHEN COALESCE(si.departure, '') ~ '^\\d{2}:\\d{2}$'
                THEN
                  (
                    SPLIT_PART(si.departure, ':', 1)::INTEGER * 60
                    +
                    SPLIT_PART(si.departure, ':', 2)::INTEGER
                  )
              ELSE NULL
            END AS start_minute,

            CASE
              WHEN UPPER(COALESCE(si.service_type, ''))
                   IN ('B', 'B_CHECK')
                THEN ams.b_check_due_date
              ELSE ams.a_check_due_date
            END AS technical_due_at,

            COALESCE(
              NULLIF(linked_event.duration_minutes, 0),
              NULLIF(last_event.duration_minutes, 0),
              NULLIF(si.block_time_min, 0),
              CASE
                WHEN UPPER(COALESCE(si.service_type, ''))
                     IN ('B', 'B_CHECK')
                  THEN 1440
                ELSE 300
              END
            ) AS duration_minutes,

            COALESCE(
              linked_event.duration_days,
              last_event.duration_days,
              CASE
                WHEN UPPER(COALESCE(si.service_type, ''))
                     IN ('B', 'B_CHECK')
                  THEN 1
                ELSE 0
              END
            ) AS duration_days,

            COALESCE(
              NULLIF(linked_event.estimated_cost, 0),
              NULLIF(last_event.estimated_cost, 0),
              0
            ) AS estimated_cost,

            COALESCE(
              linked_event.currency,
              last_event.currency,
              'USD'
            ) AS currency,

            linked_event.id AS reusable_event_id,
            last_event.id AS previous_event_id

          FROM public.schedule_items si

          JOIN public.aircraft_maintenance_status ams
            ON ams.airline_id = si.airline_id
           AND ams.aircraft_id = si.aircraft_id

          LEFT JOIN LATERAL (
            SELECT
              ame.id,
              ame.duration_minutes,
              ame.duration_days,
              ame.estimated_cost,
              ame.currency,
              ame.event_status

            FROM public.aircraft_maintenance_events ame

            WHERE ame.airline_id = si.airline_id
              AND ame.aircraft_id = si.aircraft_id
              AND ame.schedule_item_id = si.id

              AND ame.check_type =
                CASE
                  WHEN UPPER(COALESCE(si.service_type, ''))
                       IN ('B', 'B_CHECK')
                    THEN 'B_CHECK'
                  ELSE 'A_CHECK'
                END

            ORDER BY ame.id DESC
            LIMIT 1
          ) linked_event ON TRUE

          LEFT JOIN LATERAL (
            SELECT
              ame.id,
              ame.duration_minutes,
              ame.duration_days,
              ame.estimated_cost,
              ame.currency

            FROM public.aircraft_maintenance_events ame

            WHERE ame.airline_id = si.airline_id
              AND ame.aircraft_id = si.aircraft_id

              AND ame.check_type =
                CASE
                  WHEN UPPER(COALESCE(si.service_type, ''))
                       IN ('B', 'B_CHECK')
                    THEN 'B_CHECK'
                  ELSE 'A_CHECK'
                END

            ORDER BY ame.id DESC
            LIMIT 1
          ) last_event ON TRUE

          WHERE si.airline_id = $1
            AND si.aircraft_id IS NOT NULL
            AND LOWER(COALESCE(si.item_type, '')) = 'service'

            AND UPPER(COALESCE(si.service_type, ''))
                IN ('A', 'A_CHECK', 'B', 'B_CHECK')

            AND LOWER(COALESCE(si.status, 'scheduled'))
                NOT IN ('cancelled', 'completed')

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_market_listings market_listing
              WHERE market_listing.aircraft_id = si.aircraft_id
                AND market_listing.status IN (
                  'ACTIVE',
                  'OFFER_RECEIVED',
                  'SALE_PENDING'
                )
            )
            
            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events live_event

              WHERE live_event.airline_id = si.airline_id
                AND live_event.aircraft_id = si.aircraft_id

                AND live_event.check_type =
                  CASE
                    WHEN UPPER(COALESCE(si.service_type, ''))
                         IN ('B', 'B_CHECK')
                      THEN 'B_CHECK'
                    ELSE 'A_CHECK'
                  END

                AND live_event.event_status IN (
                  'SCHEDULED',
                  'IN_PROGRESS'
                )
            )
        ),

        authority AS (
          SELECT
            active_plans.*,

            GREATEST(
              COALESCE(
                active_plans.technical_due_at,
                acs_get_current_sim_time()
              ),
              acs_get_current_sim_time()
            ) AS anchor_at

          FROM active_plans

          WHERE active_plans.selected_iso_day IS NOT NULL
            AND active_plans.start_minute IS NOT NULL
            AND active_plans.duration_minutes > 0
        ),

        candidate AS (
          SELECT
            authority.*,

            date_trunc('day', authority.anchor_at)
            +
            (
              (
                authority.selected_iso_day
                -
                EXTRACT(
                  ISODOW FROM authority.anchor_at
                )::INTEGER
                + 7
              ) % 7
            ) * INTERVAL '1 day'
            +
            authority.start_minute * INTERVAL '1 minute'
              AS raw_start

          FROM authority
        ),

        resolved AS (
          SELECT
            candidate.*,

            CASE
              WHEN candidate.raw_start
                   <= acs_get_current_sim_time()
                THEN candidate.raw_start + INTERVAL '7 days'
              ELSE candidate.raw_start
            END AS next_start

          FROM candidate
        ),

        recycled_events AS (
          UPDATE public.aircraft_maintenance_events ame

          SET
          event_status = 'SCHEDULED',

            started_at = NULL,
            expected_completion_at =
              resolved.next_start
              + resolved.duration_minutes * INTERVAL '1 minute',
            completed_at = NULL,

            duration_days = resolved.duration_days,
            duration_minutes = resolved.duration_minutes,

            scheduled_start_at = resolved.next_start,
            scheduled_end_at =
              resolved.next_start
              + resolved.duration_minutes * INTERVAL '1 minute',

            estimated_cost = resolved.estimated_cost,
            final_cost = NULL,
            currency = resolved.currency,

            finance_charged = FALSE,
            finance_log_id = NULL,

            notes = jsonb_build_object(
              'source',
              'ACS_AB_GLOBAL_ORPHAN_RECOVERY_V2_RECYCLE',
              'previous_event_id',
              resolved.previous_event_id,
              'persistent_schedule_item_id',
              resolved.schedule_item_id,
              'duplicate_guard',
              'explicit_not_exists_on_schedule_item_id'
            )::TEXT,

            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          FROM resolved

          WHERE resolved.reusable_event_id IS NOT NULL
            AND ame.id = resolved.reusable_event_id
            AND ame.airline_id = resolved.airline_id
            AND ame.aircraft_id = resolved.aircraft_id
            AND ame.check_type = resolved.check_type
            AND ame.event_status NOT IN (
              'SCHEDULED',
              'IN_PROGRESS'
            )

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events live_guard

              WHERE live_guard.airline_id = resolved.airline_id
                AND live_guard.aircraft_id = resolved.aircraft_id
                AND live_guard.check_type = resolved.check_type
                AND live_guard.event_status IN (
                  'SCHEDULED',
                  'IN_PROGRESS'
                )
                AND live_guard.id <> ame.id
            )

          RETURNING
            ame.id
        ),

        inserted_events AS (
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

          SELECT
            resolved.airline_id,
            resolved.aircraft_id,
            resolved.check_type,
            'SCHEDULED',

            NULL,
            resolved.next_start
              + resolved.duration_minutes * INTERVAL '1 minute',
            NULL,

            resolved.duration_days,
            resolved.duration_minutes,

            resolved.next_start,
            resolved.next_start
              + resolved.duration_minutes * INTERVAL '1 minute',

            resolved.schedule_item_id,

            resolved.estimated_cost,
            NULL,
            resolved.currency,

            FALSE,
            NULL,

            jsonb_build_object(
              'source',
              'ACS_AB_GLOBAL_ORPHAN_RECOVERY_V2_INSERT',
              'previous_event_id',
              resolved.previous_event_id,
              'persistent_schedule_item_id',
              resolved.schedule_item_id
            )::TEXT,

            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          FROM resolved

          WHERE resolved.reusable_event_id IS NULL

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events live_guard

              WHERE live_guard.airline_id = resolved.airline_id
                AND live_guard.aircraft_id = resolved.aircraft_id
                AND live_guard.check_type = resolved.check_type
                AND live_guard.event_status IN (
                  'SCHEDULED',
                  'IN_PROGRESS'
                )
            )

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events schedule_item_guard

              WHERE schedule_item_guard.schedule_item_id =
                resolved.schedule_item_id
            )

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events existing

              WHERE existing.schedule_item_id = resolved.schedule_item_id
            )

          RETURNING
            id
        )

        SELECT id FROM recycled_events
        UNION ALL
        SELECT id FROM inserted_events
        `,
        [airlineId]
      );

      /*
       * Immediate A/B status synchronization after orphan recovery.
       * A/B planning suppresses A/B OVERDUE.
       * C/D authority is preserved.
       */
      await client.query(
        `
        WITH live_ab AS (
          SELECT
            ame.airline_id,
            ame.aircraft_id,

            MAX(
              CASE
                WHEN ame.check_type = 'A_CHECK'
                 AND ame.event_status = 'IN_PROGRESS'
                  THEN 2
                WHEN ame.check_type = 'A_CHECK'
                 AND ame.event_status = 'SCHEDULED'
                  THEN 1
                ELSE 0
              END
            ) AS a_live_rank,

            MAX(
              CASE
                WHEN ame.check_type = 'B_CHECK'
                 AND ame.event_status = 'IN_PROGRESS'
                  THEN 2
                WHEN ame.check_type = 'B_CHECK'
                 AND ame.event_status = 'SCHEDULED'
                  THEN 1
                ELSE 0
              END
            ) AS b_live_rank

          FROM public.aircraft_maintenance_events ame

          WHERE ame.airline_id = $1
            AND ame.check_type IN ('A_CHECK', 'B_CHECK')
            AND ame.event_status IN (
              'SCHEDULED',
              'IN_PROGRESS'
            )

          GROUP BY
            ame.airline_id,
            ame.aircraft_id
        ),

        planned_ab AS (
          SELECT
            si.airline_id,
            si.aircraft_id,

            MAX(
              CASE
                WHEN UPPER(COALESCE(si.service_type, ''))
                     IN ('A', 'A_CHECK')
                  THEN 1
                ELSE 0
              END
            ) AS a_plan_rank,

            MAX(
              CASE
                WHEN UPPER(COALESCE(si.service_type, ''))
                     IN ('B', 'B_CHECK')
                  THEN 1
                ELSE 0
              END
            ) AS b_plan_rank

          FROM public.schedule_items si

          WHERE si.airline_id = $1
            AND si.aircraft_id IS NOT NULL
            AND LOWER(COALESCE(si.item_type, '')) = 'service'

            AND UPPER(COALESCE(si.service_type, ''))
                IN ('A', 'A_CHECK', 'B', 'B_CHECK')

            AND LOWER(COALESCE(si.status, 'scheduled'))
                NOT IN ('cancelled', 'completed')

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_market_listings market_listing
              WHERE market_listing.aircraft_id = si.aircraft_id
                AND market_listing.status IN (
                  'ACTIVE',
                  'OFFER_RECEIVED',
                  'SALE_PENDING'
                )
            )
          GROUP BY
            si.airline_id,
            si.aircraft_id
        ),

        normalized AS (
          SELECT
            ams.airline_id,
            ams.aircraft_id,

            CASE
              WHEN COALESCE(live_ab.a_live_rank, 0) = 2
                THEN 'IN_PROGRESS'
              WHEN COALESCE(live_ab.a_live_rank, 0) = 1
                THEN 'SCHEDULED'
              WHEN COALESCE(planned_ab.a_plan_rank, 0) = 1
                THEN 'SCHEDULED'
              ELSE ams.a_check_status
            END AS next_a_status,

            CASE
              WHEN COALESCE(live_ab.b_live_rank, 0) = 2
                THEN 'IN_PROGRESS'
              WHEN COALESCE(live_ab.b_live_rank, 0) = 1
                THEN 'SCHEDULED'
              WHEN COALESCE(planned_ab.b_plan_rank, 0) = 1
                THEN 'SCHEDULED'
              ELSE ams.b_check_status
            END AS next_b_status

          FROM public.aircraft_maintenance_status ams

          LEFT JOIN live_ab
            ON live_ab.airline_id = ams.airline_id
           AND live_ab.aircraft_id = ams.aircraft_id

          LEFT JOIN planned_ab
            ON planned_ab.airline_id = ams.airline_id
           AND planned_ab.aircraft_id = ams.aircraft_id

          WHERE ams.airline_id = $1
        )

        UPDATE public.aircraft_maintenance_status ams

        SET
          a_check_status = normalized.next_a_status,
          b_check_status = normalized.next_b_status,
          updated_at =
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

        FROM normalized

        WHERE ams.airline_id = normalized.airline_id
          AND ams.aircraft_id = normalized.aircraft_id
        `,
        [airlineId]
      );
       
/* ========================================================
         PHASE 1 — COMPLETE A/B EVENTS
         --------------------------------------------------------
         ACS AIRBUS OCC CONTRACT:
         - The maintenance event is the technical occurrence.
         - schedule_items is the persistent player plan.
         - Completing an occurrence never completes or cancels the plan.
         - B completion resets A and B cycles but never deletes A planning.
         - The next occurrence is generated from the same persistent plan.
         - Completed events remain immutable technical history.
         ======================================================== */

            const completionResult = await client.query(
        `
        SELECT
          ame.id,
          ame.event_uid,
          ame.aircraft_id,
          ame.check_type,
          ame.schedule_item_id,

          ame.started_at,
          ame.expected_completion_at,
          ame.scheduled_end_at,

          COALESCE(
            ame.expected_completion_at,
            ame.scheduled_end_at,
            ame.started_at
              + (
                COALESCE(
                  NULLIF(ame.duration_minutes, 0),
                  CASE
                    WHEN ame.check_type = 'B_CHECK' THEN 1440
                    ELSE 300
                  END
                ) * INTERVAL '1 minute'
              )
          ) AS technical_completion_at,

          ame.duration_days,
          ame.duration_minutes,
          ame.estimated_cost,
          ame.currency,

          af.registration,
          af.aircraft_name

        FROM public.aircraft_maintenance_events ame

        JOIN public.aircraft_fleet af
          ON af.id = ame.aircraft_id
         AND af.airline_id = ame.airline_id

        JOIN public.aircraft_maintenance_status ams
          ON ams.aircraft_id = ame.aircraft_id
         AND ams.airline_id = ame.airline_id

        WHERE ame.airline_id = $1
          AND ame.event_status = 'IN_PROGRESS'
          AND ame.check_type IN (
            'A_CHECK',
            'B_CHECK'
          )
          AND COALESCE(
            ame.expected_completion_at,
            ame.scheduled_end_at,
            ame.started_at
              + (
                COALESCE(
                  NULLIF(ame.duration_minutes, 0),
                  CASE
                    WHEN ame.check_type = 'B_CHECK' THEN 1440
                    ELSE 300
                  END
                ) * INTERVAL '1 minute'
              )
          ) <= acs_get_current_sim_time()

        ORDER BY
          technical_completion_at,
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

      const completedEvents = [];

      for (const event of completionResult.rows) {
        const checkType =
          ACS_text(event.check_type).toUpperCase();

        const completedEventResult = await client.query(
          `
          UPDATE public.aircraft_maintenance_events
          SET
            event_status = 'COMPLETED',
            completed_at = acs_get_current_sim_time(),
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE id = $1
            AND airline_id = $2
            AND event_status = 'IN_PROGRESS'
          RETURNING
            id,
            event_uid,
            aircraft_id,
            check_type,
            completed_at,
            schedule_item_id,
            duration_days,
            duration_minutes,
            estimated_cost,
            currency
          `,
          [event.id, airlineId]
        );

        if (!completedEventResult.rows.length) {
          continue;
        }

        const completedEvent =
          completedEventResult.rows[0];

        /*
         * Restore the persistent plan after the occurrence finishes.
         * The plan remains visible and editable until the player removes it.
         */
        if (completedEvent.schedule_item_id) {
          await client.query(
            `
            UPDATE public.schedule_items
            SET
              status = 'scheduled',
              updated_at =
                (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            WHERE id = $1
              AND airline_id = $2
              AND item_type = 'service'
              AND LOWER(COALESCE(status, 'scheduled'))
                  <> 'cancelled'
            `,
            [completedEvent.schedule_item_id, airlineId]
          );
        }

        const intervalDays =
          checkType === 'B_CHECK'
            ? 30
            : 7;

        const nextDueDateResult = await client.query(
          `
          SELECT
            (
              acs_get_current_sim_time()
              + ($1::INTEGER * INTERVAL '1 day')
            ) AS next_due_date
          `,
          [intervalDays]
        );

        const nextDueDate =
          nextDueDateResult.rows[0]?.next_due_date;

        const technicalStateResult = await client.query(
          `
          UPDATE public.aircraft_maintenance_status

          SET
            a_check_due_date = CASE
              WHEN $3 = 'A_CHECK'
                THEN $4::TIMESTAMP
              WHEN $3 = 'B_CHECK'
                THEN acs_get_current_sim_time()
                     + INTERVAL '7 days'
              ELSE a_check_due_date
            END,

            b_check_due_date = CASE
              WHEN $3 = 'B_CHECK'
                THEN $4::TIMESTAMP
              ELSE b_check_due_date
            END,

            a_check_status = CASE
              WHEN $3 = 'A_CHECK'
                THEN 'OPEN'
              WHEN $3 = 'B_CHECK'
                THEN 'OPEN'
              ELSE a_check_status
            END,

            b_check_status = CASE
              WHEN $3 = 'B_CHECK'
                THEN 'OPEN'
              ELSE b_check_status
            END,

            maintenance_control_status = CASE
              WHEN UPPER(COALESCE(d_check_status, '')) = 'IN_PROGRESS'
                THEN 'IN_MAINTENANCE'
              WHEN UPPER(COALESCE(c_check_status, '')) = 'IN_PROGRESS'
                THEN 'IN_MAINTENANCE'
              WHEN UPPER(COALESCE(d_check_status, '')) = 'OVERDUE'
                THEN 'UNSERVICEABLE'
              WHEN UPPER(COALESCE(c_check_status, '')) = 'OVERDUE'
                THEN 'UNSERVICEABLE'
              ELSE 'SERVICEABLE'
            END,

            maintenance_control_reason = CASE
              WHEN UPPER(COALESCE(d_check_status, '')) = 'IN_PROGRESS'
                THEN 'D_CHECK'
              WHEN UPPER(COALESCE(c_check_status, '')) = 'IN_PROGRESS'
                THEN 'C_CHECK'
              WHEN UPPER(COALESCE(d_check_status, '')) = 'OVERDUE'
                THEN 'D_CHECK_OVERDUE'
              WHEN UPPER(COALESCE(c_check_status, '')) = 'OVERDUE'
                THEN 'C_CHECK_OVERDUE'
              ELSE NULL
            END,

            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          WHERE aircraft_id = $1
            AND airline_id = $2

          RETURNING
            a_check_due_date,
            b_check_due_date,
            c_check_status,
            d_check_status,
            maintenance_control_status,
            maintenance_control_reason
          `,
          [
            completedEvent.aircraft_id,
            airlineId,
            checkType,
            nextDueDate
          ]
        );

        const technicalState =
          technicalStateResult.rows[0] || {};

        await client.query(
          `
          UPDATE public.aircraft_fleet af

          SET
            status = CASE
              WHEN ams.maintenance_control_status = 'IN_MAINTENANCE'
                THEN 'MAINTENANCE'
              ELSE 'ACTIVE'
            END,

            operational_status = CASE
              WHEN ams.maintenance_control_status = 'IN_MAINTENANCE'
                THEN 'IN_MAINTENANCE'
              WHEN ams.maintenance_control_status = 'UNSERVICEABLE'
                THEN 'UNAVAILABLE'
              ELSE 'AVAILABLE'
            END,

            maintenance_status = CASE
              WHEN ams.maintenance_control_status = 'UNSERVICEABLE'
                THEN 'CHECK_REQUIRED'
              WHEN ams.maintenance_control_status = 'IN_MAINTENANCE'
                THEN 'CHECK_REQUIRED'
              ELSE 'SERVICEABLE'
            END,

            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          FROM public.aircraft_maintenance_status ams

          WHERE af.id = ams.aircraft_id
            AND af.airline_id = ams.airline_id
            AND af.id = $1
            AND af.airline_id = $2
          `,
          [
            completedEvent.aircraft_id,
            airlineId
          ]
        );

        let nextOccurrence = null;

        /*
         * Current schema enforces one aircraft_maintenance_event per
         * schedule_item_id. Do not create recurring events with the same
         * persistent player plan until the data model is changed.
         */
        nextOccurrence = null;

        if (
          checkType === 'B_CHECK' &&
          technicalState.a_check_due_date
        ) {
          await client.query(
            `
            WITH active_a AS (
              SELECT
                ame.id AS event_id,
                ame.duration_minutes,
                si.id AS schedule_item_id,
                CASE LOWER(si.selected_day)
                  WHEN 'mon' THEN 1
                  WHEN 'tue' THEN 2
                  WHEN 'wed' THEN 3
                  WHEN 'thu' THEN 4
                  WHEN 'fri' THEN 5
                  WHEN 'sat' THEN 6
                  WHEN 'sun' THEN 7
                  ELSE NULL
                END AS selected_iso_day,
                (
                  SPLIT_PART(si.departure, ':', 1)::INTEGER * 60
                  +
                  SPLIT_PART(si.departure, ':', 2)::INTEGER
                ) AS start_minute
              FROM public.aircraft_maintenance_events ame
              JOIN public.schedule_items si
                ON si.id = ame.schedule_item_id
               AND si.airline_id = ame.airline_id
               AND si.aircraft_id = ame.aircraft_id
              WHERE ame.airline_id = $1
                AND ame.aircraft_id = $2
                AND ame.check_type = 'A_CHECK'
                AND ame.event_status = 'SCHEDULED'
                AND LOWER(COALESCE(si.status, 'scheduled'))
                    <> 'cancelled'
              ORDER BY ame.id DESC
              LIMIT 1
              FOR UPDATE OF ame, si
            ),
            candidate AS (
              SELECT
                active_a.*,
                $3::TIMESTAMP AS due_at,
                date_trunc('day', $3::TIMESTAMP)
                + (
                    (
                      active_a.selected_iso_day
                      - EXTRACT(ISODOW FROM $3::TIMESTAMP)::INTEGER
                      + 7
                    ) % 7
                  ) * INTERVAL '1 day'
                + active_a.start_minute * INTERVAL '1 minute'
                  AS raw_start
              FROM active_a
              WHERE active_a.selected_iso_day IS NOT NULL
            ),
            resolved AS (
              SELECT
                candidate.*,
                CASE
                  WHEN candidate.raw_start < candidate.due_at
                    THEN candidate.raw_start + INTERVAL '7 days'
                  ELSE candidate.raw_start
                END AS next_start
              FROM candidate
            )
            UPDATE public.aircraft_maintenance_events ame
            SET
              scheduled_start_at = resolved.next_start,
              scheduled_end_at =
                resolved.next_start
                + resolved.duration_minutes * INTERVAL '1 minute',
              expected_completion_at =
                resolved.next_start
                + resolved.duration_minutes * INTERVAL '1 minute',
              started_at = NULL,
              updated_at =
                (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            FROM resolved
            WHERE ame.id = resolved.event_id
              AND ame.airline_id = $1
              AND ame.event_status = 'SCHEDULED'
            `,
            [
              airlineId,
              completedEvent.aircraft_id,
              technicalState.a_check_due_date
            ]
          );
        }

        completedEvents.push({
          event_id: completedEvent.id,
          aircraft_id: completedEvent.aircraft_id,
          registration: event.registration,
          check_type: checkType,
          completed_at: completedEvent.completed_at,
          a_check_due_date:
            technicalState.a_check_due_date || null,
          b_check_due_date:
            technicalState.b_check_due_date || null,
          persistent_schedule_item_id:
            completedEvent.schedule_item_id || null,
          next_occurrence: nextOccurrence
        });
      }

       /* ========================================================
         PHASE 2 — AUTOMATIC START OF SCHEDULED A/B CHECKS
         --------------------------------------------------------
         ACS backend rules:
         - ACS Time is the only start authority.
         - C/D OVERDUE or IN_PROGRESS keeps A/B in SCHEDULED.
         - B has execution priority over A but never cancels its plan.
         - Only one A/B event may run per aircraft.
         - Finance is charged once, only when the event starts.
         - The OCC-visible maintenance label is A-Check/B-Check.
         ======================================================== */

      const dueEventsResult = await client.query(
        `
        WITH eligible AS (
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
            ame.finance_charged,
            af.registration,
            af.aircraft_name,
            af.operational_status,
            ams.a_check_status,
            ams.b_check_status,
            ams.c_check_status,
            ams.d_check_status,
            ROW_NUMBER() OVER (
              PARTITION BY ame.aircraft_id
              ORDER BY
                CASE ame.check_type
                  WHEN 'B_CHECK' THEN 1
                  WHEN 'A_CHECK' THEN 2
                  ELSE 3
                END,
                ame.scheduled_start_at,
                ame.id
            ) AS aircraft_priority
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

            AND NOT (
              UPPER(
                COALESCE(ams.c_check_status, '')
              ) IN ('OVERDUE', 'IN_PROGRESS')
            )

            AND NOT (
              UPPER(
                COALESCE(ams.d_check_status, '')
              ) IN ('OVERDUE', 'IN_PROGRESS')
            )

            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_market_listings market_listing
              WHERE market_listing.aircraft_id = ame.aircraft_id
                AND market_listing.status IN (
                  'ACTIVE',
                  'OFFER_RECEIVED',
                  'SALE_PENDING'
                )
            )
      
            AND NOT EXISTS (
              SELECT 1
              FROM public.aircraft_maintenance_events active_light
              WHERE active_light.airline_id = ame.airline_id
                AND active_light.aircraft_id = ame.aircraft_id
                AND active_light.check_type IN ('A_CHECK', 'B_CHECK')
                AND active_light.event_status = 'IN_PROGRESS'
            )

        )
        SELECT *
        FROM eligible
        WHERE aircraft_priority = 1
        ORDER BY scheduled_start_at, id
        `,
        [airlineId]
         
      );

      const startedEvents = [];
      const blockedEvents = [];

      for (const event of dueEventsResult.rows) {
        const checkType =
          ACS_text(event.check_type).toUpperCase();

        const cStatus =
          ACS_text(event.c_check_status).toUpperCase();

        const dStatus =
          ACS_text(event.d_check_status).toUpperCase();

        if (
          cStatus === "OVERDUE" ||
          cStatus === "IN_PROGRESS" ||
          dStatus === "OVERDUE" ||
          dStatus === "IN_PROGRESS"
        ) {
          continue;
        }

        const activeLightCheckResult = await client.query(
          `
          SELECT id
          FROM public.aircraft_maintenance_events
          WHERE airline_id = $1
            AND aircraft_id = $2
            AND check_type IN ('A_CHECK', 'B_CHECK')
            AND event_status = 'IN_PROGRESS'
          LIMIT 1
          FOR UPDATE
          `,
          [airlineId, event.aircraft_id]
        );

        if (activeLightCheckResult.rows.length) {
          continue;
        }

        if (event.finance_charged === true) {
          continue;
        }

        const cost = Math.round(
          Number(event.estimated_cost || 0)
        );

        if (!Number.isFinite(cost) || cost <= 0) {
          const error =
            new Error("MAINTENANCE_COST_RATE_INVALID");

          error.code =
            "MAINTENANCE_COST_RATE_INVALID";

          throw error;
        }

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
          const error =
            new Error("COMPANY_FINANCE_NOT_FOUND");

          error.code =
            "COMPANY_FINANCE_NOT_FOUND";

          throw error;
        }

        const capital = Math.round(
          Number(financeResult.rows[0].capital || 0)
        );

        if (capital < cost) {
          await client.query(
            `
            UPDATE public.aircraft_maintenance_status
            SET
              a_check_status = CASE
                WHEN $3 = 'A_CHECK' THEN 'OVERDUE'
                WHEN $3 = 'B_CHECK' THEN 'OPEN'
                ELSE a_check_status
              END,

              b_check_status = CASE
                WHEN $3 = 'B_CHECK' THEN 'OVERDUE'
                ELSE b_check_status
              END,

              maintenance_control_status = 'UNSERVICEABLE',
              maintenance_control_reason = CASE
                WHEN $3 = 'B_CHECK' THEN 'B_CHECK_OVERDUE'
                ELSE 'A_CHECK_OVERDUE'
              END,

              updated_at =
                (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

            WHERE aircraft_id = $1
              AND airline_id = $2
            `,
            [event.aircraft_id, airlineId, checkType]
          );

          await client.query(
            `
            UPDATE public.aircraft_fleet
            SET
              status = 'ACTIVE',
              operational_status = 'UNAVAILABLE',
              maintenance_status = 'CHECK_REQUIRED',
              updated_at =
                (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            WHERE id = $1
              AND airline_id = $2
            `,
            [event.aircraft_id, airlineId]
          );

          blockedEvents.push({
            event_id: event.id,
            aircraft_id: event.aircraft_id,
            registration: event.registration,
            check_type: checkType,
            reason:
              checkType === "B_CHECK"
                ? "OVERDUE B CHECK"
                : "OVERDUE A CHECK",
            capital,
            required: cost
          });

          break;
        }
        /*
         * FINANCE IDEMPOTENCY PER OCCURRENCE
         * ------------------------------------------------------
         * event_uid belongs to the persistent recycled event.
         * scheduled_start_at distinguishes each A/B occurrence.
         */
        const scheduledStartDate =
          new Date(event.scheduled_start_at);

        if (
          Number.isNaN(
            scheduledStartDate.getTime()
          )
        ) {
          const error =
            new Error(
              "MAINTENANCE_SCHEDULED_START_INVALID"
            );

          error.code =
            "MAINTENANCE_SCHEDULED_START_INVALID";

          throw error;
        }

        const occurrenceReferenceUid =
          `MAINTENANCE_AB:` +
          `${event.event_uid}:` +
          `${scheduledStartDate.getTime()}`;

        const financeLogResult =
          await client.query(
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
            ON CONFLICT (reference_uid)
            WHERE reference_uid IS NOT NULL
            DO NOTHING
            RETURNING id
            `,
            [
              airlineId,

              `AIRCRAFT ${checkType} — ` +
                `${event.registration || "UNREGISTERED"} ` +
                `${event.aircraft_name}`,

              cost,
              event.schedule_item_id,
              occurrenceReferenceUid,

              `${ACS_checkDisplayName(checkType)} ` +
                `started automatically by ACS Time`
            ]
          );

        if (!financeLogResult.rows.length) {
          blockedEvents.push({
            event_id: event.id,
            aircraft_id:
              event.aircraft_id,
            registration:
              event.registration,
            check_type:
              checkType,
            reason:
              "FINANCE_ALREADY_CHARGED",
            reference_uid:
              occurrenceReferenceUid
          });

          /*
           * One inconsistent occurrence must not prevent other
           * eligible aircraft of the airline from being processed.
           */
          continue;
        }

        const financeLogId =
          financeLogResult.rows[0].id;

        const financeUpdateResult = await client.query(
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
          RETURNING airline_id
          `,
          [airlineId, cost]
        );

        if (!financeUpdateResult.rows.length) {
          const error =
            new Error("COMPANY_FINANCE_NOT_FOUND");

          error.code =
            "COMPANY_FINANCE_NOT_FOUND";

          throw error;
        }

        const startedEventResult = await client.query(
          `
          UPDATE public.aircraft_maintenance_events
          SET
            event_status = 'IN_PROGRESS',
            started_at = acs_get_current_sim_time(),
            expected_completion_at =
              acs_get_current_sim_time()
              + (duration_minutes * INTERVAL '1 minute'),
            scheduled_end_at =
              acs_get_current_sim_time()
              + (duration_minutes * INTERVAL '1 minute'),
            finance_charged = TRUE,
            finance_log_id = $2,
            final_cost = estimated_cost,
            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          WHERE id = $1
            AND airline_id = $3
            AND event_status = 'SCHEDULED'
            AND finance_charged = FALSE
          RETURNING
            id,
            aircraft_id,
            check_type,
            started_at,
            expected_completion_at
          `,
          [event.id, financeLogId, airlineId]
        );

        if (!startedEventResult.rows.length) {
          const error =
            new Error(
              "MAINTENANCE_FINANCE_STATE_CONFLICT"
            );

          error.code =
            "MAINTENANCE_FINANCE_STATE_CONFLICT";

          throw error;
        }

        const startedEvent =
          startedEventResult.rows[0];

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
              WHEN $2 = 'B_CHECK' THEN 'OPEN'
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
          event_id: startedEvent.id,
          aircraft_id: startedEvent.aircraft_id,
          registration: event.registration,
          check_type: checkType,
          started_at: startedEvent.started_at,
          expected_completion_at:
            startedEvent.expected_completion_at,
          charged_amount: cost
        });
      }

       /* ========================================================
         PHASE 0 — GLOBAL A/B STATE NORMALIZATION
         --------------------------------------------------------
         ACS AIRBUS OCC CONTRACT:
         - Global formula for 700+ users.
         - Live A/B events dominate due dates.
         - IN_PROGRESS > SCHEDULED > OVERDUE > OPEN.
         - C/D authority is preserved and dominates control status.
         - No auto-assign.
         - No deletion of player schedules.
         - No finance mutation.
         ======================================================== */

      const phase0Result = await client.query(
        `
        WITH live_ab AS (
          SELECT
            ame.airline_id,
            ame.aircraft_id,

            MAX(
              CASE
                WHEN ame.check_type = 'A_CHECK'
                 AND ame.event_status = 'IN_PROGRESS'
                  THEN 2
                WHEN ame.check_type = 'A_CHECK'
                 AND ame.event_status = 'SCHEDULED'
                  THEN 1
                ELSE 0
              END
            ) AS a_live_rank,

            MAX(
              CASE
                WHEN ame.check_type = 'B_CHECK'
                 AND ame.event_status = 'IN_PROGRESS'
                  THEN 2
                WHEN ame.check_type = 'B_CHECK'
                 AND ame.event_status = 'SCHEDULED'
                  THEN 1
                ELSE 0
              END
            ) AS b_live_rank

          FROM public.aircraft_maintenance_events ame

          WHERE ame.airline_id = $1
            AND ame.check_type IN ('A_CHECK', 'B_CHECK')
            AND ame.event_status IN ('SCHEDULED', 'IN_PROGRESS')

          GROUP BY
            ame.airline_id,
            ame.aircraft_id
        ),

        normalized AS (
          SELECT
            ams.airline_id,
            ams.aircraft_id,

            CASE
              WHEN COALESCE(live_ab.a_live_rank, 0) = 2
                THEN 'IN_PROGRESS'
              WHEN COALESCE(live_ab.a_live_rank, 0) = 1
                THEN 'SCHEDULED'
              WHEN ams.a_check_due_date <= acs_get_current_sim_time()
                THEN 'OVERDUE'
              ELSE 'OPEN'
            END AS next_a_status,

            CASE
              WHEN COALESCE(live_ab.b_live_rank, 0) = 2
                THEN 'IN_PROGRESS'
              WHEN COALESCE(live_ab.b_live_rank, 0) = 1
                THEN 'SCHEDULED'
              WHEN ams.b_check_due_date <= acs_get_current_sim_time()
                THEN 'OVERDUE'
              ELSE 'OPEN'
            END AS next_b_status,

            UPPER(COALESCE(ams.c_check_status, 'OPEN')) AS c_status,
            UPPER(COALESCE(ams.d_check_status, 'OPEN')) AS d_status

          FROM public.aircraft_maintenance_status ams

          LEFT JOIN live_ab
            ON live_ab.airline_id = ams.airline_id
           AND live_ab.aircraft_id = ams.aircraft_id

          WHERE ams.airline_id = $1
        )

        UPDATE public.aircraft_maintenance_status ams

        SET
          a_check_status = normalized.next_a_status,
          b_check_status = normalized.next_b_status,

          maintenance_control_status = CASE
            WHEN normalized.d_status = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN normalized.c_status = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN normalized.d_status = 'OVERDUE'
              THEN 'UNSERVICEABLE'
            WHEN normalized.c_status = 'OVERDUE'
              THEN 'UNSERVICEABLE'
            WHEN normalized.next_b_status = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN normalized.next_a_status = 'IN_PROGRESS'
              THEN 'IN_MAINTENANCE'
            WHEN normalized.next_b_status = 'OVERDUE'
              THEN 'MAINTENANCE_REQUIRED'
            WHEN normalized.next_a_status = 'OVERDUE'
              THEN 'MAINTENANCE_REQUIRED'
            ELSE 'SERVICEABLE'
          END,

          maintenance_control_reason = CASE
            WHEN normalized.d_status = 'IN_PROGRESS'
              THEN 'D_CHECK'
            WHEN normalized.c_status = 'IN_PROGRESS'
              THEN 'C_CHECK'
            WHEN normalized.d_status = 'OVERDUE'
              THEN 'D_CHECK_OVERDUE'
            WHEN normalized.c_status = 'OVERDUE'
              THEN 'C_CHECK_OVERDUE'
            WHEN normalized.next_b_status = 'IN_PROGRESS'
              THEN 'B_CHECK'
            WHEN normalized.next_a_status = 'IN_PROGRESS'
              THEN 'A_CHECK'
            WHEN normalized.next_b_status = 'OVERDUE'
              THEN 'B_CHECK_OVERDUE'
            WHEN normalized.next_a_status = 'OVERDUE'
              THEN 'A_CHECK_OVERDUE'
            ELSE NULL
          END,

          updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

        FROM normalized

         WHERE ams.airline_id = normalized.airline_id
          AND ams.aircraft_id = normalized.aircraft_id
        `,
        [airlineId]
      );

      /* ========================================================
         PHASE 0.1 — B CHECK OVERDUE OCC ALERT
         --------------------------------------------------------
         Alert only.
         No maintenance, schedule, fleet or finance mutation.
         ======================================================== */

      await client.query(
        `
        INSERT INTO public.occ_alerts (
          airline_id,
          alert_key,
          category,
          level,
          title,
          message,
          source,
          source_ref,
          event_sim_time,
          created_at,
          updated_at
        )

        SELECT
          ams.airline_id,
          'MAINTENANCE_B_CHECK_OVERDUE:'
            || ams.aircraft_id,
          'maintenance',
          'warning',
          'B CHECK OVERDUE',
          'Aircraft '
            || COALESCE(
              NULLIF(
                BTRIM(ams.registration),
                ''
              ),
              NULLIF(
                BTRIM(ams.aircraft_name),
                ''
              ),
              'AIRCRAFT'
            )
            || ' B Check overdue.',
          'aircraft_maintenance_status',
          ams.aircraft_id::TEXT,
          COALESCE(
            ams.b_check_due_date,
            acs_get_current_sim_time()
          ),
          NOW(),
          NOW()

        FROM public.aircraft_maintenance_status ams

        WHERE ams.airline_id = $1
          AND UPPER(
            COALESCE(
              ams.b_check_status,
              ''
            )
          ) = 'OVERDUE'

          AND NOT EXISTS (
            SELECT 1
            FROM public.occ_alerts existing_alert
            WHERE existing_alert.airline_id =
                    ams.airline_id
              AND existing_alert.alert_key =
                    'MAINTENANCE_B_CHECK_OVERDUE:'
                    || ams.aircraft_id
              AND (
                existing_alert.deleted_at IS NULL
                OR
                existing_alert.deleted_sim_time IS NULL
                OR
                acs_get_current_sim_time() <
                  existing_alert.deleted_sim_time
                  + INTERVAL '7 days'
              )
          )

        ON CONFLICT (
          airline_id,
          alert_key
        )
        WHERE deleted_at IS NULL
        DO NOTHING
        `,
        [airlineId]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        ok: true,
        endpoint:
          "ACS_SCHEDULE_MAINTENANCE_RESOLVER",
        version: "v2.4",
        authority:
          "POSTGRESQL_SCHEDULE_AUTHORITY",
        airline_id: airlineId,
        orphan_recovered_count:
          orphanRecoveryResult.rowCount || 0,
        phase0_normalized_count:
          phase0Result.rowCount || 0,
        phase1_candidate_count:
          completionResult.rowCount || 0,
        auto_start_enabled: true,
        completed_count: completedEvents.length,
        completed_events: completedEvents,
        started_count: startedEvents.length,
        started_events: startedEvents,
        blocked_count: blockedEvents.length,
        blocked_events: blockedEvents
      };

    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "ACS SCHEDULE MAINTENANCE RESOLVER " +
            "ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      console.error(
        `ACS SCHEDULE MAINTENANCE RESOLVER ERROR [airline ${airlineId}]:`,
        error
      );

      throw error;

    } finally {
      client.release();
    }
}

/* ============================================================
   ACS GLOBAL A/B MAINTENANCE RESOLVER DISPATCHER
   ------------------------------------------------------------
   File: routes/schedule.js

   Purpose:
   - Dispatch A/B maintenance resolver globally or by airline.
   - Required by ACS_executeMaintenanceSchedulerTick().
   - schedule.js remains A/B authority only.
   - aircraft.js remains C/D authority only.
   - No auto-assign.
   - No player schedule deletion.
   ============================================================ */

export async function ACS_runMaintenanceResolver({
  allAirlines = false,
  airlineId = null
} = {}) {
   
  if (!allAirlines) {
    const scopedAirlineId = Number(airlineId);

    if (
      !Number.isInteger(scopedAirlineId) ||
      scopedAirlineId <= 0
    ) {
      const error = new Error("MAINTENANCE_RESOLVER_SCOPE_REQUIRED");
      error.code = "MAINTENANCE_RESOLVER_SCOPE_REQUIRED";
      throw error;
    }

    return ACS_runMaintenanceResolverForAirline(scopedAirlineId);
  }

  const client = await pool.connect();

  try {
    const airlinesResult = await client.query(
      `
      SELECT DISTINCT airline_id
      FROM public.aircraft_fleet
      WHERE airline_id IS NOT NULL
      ORDER BY airline_id
      `
    );

    const results = [];
    const errors = [];

    let completedCount = 0;
    let startedCount = 0;
    let blockedCount = 0;
    let orphanRecoveredCount = 0;
    let phase0NormalizedCount = 0;
    let phase1CandidateCount = 0;

    for (const row of airlinesResult.rows) {
      const currentAirlineId = Number(row.airline_id);

      if (
        !Number.isInteger(currentAirlineId) ||
        currentAirlineId <= 0
      ) {
        continue;
      }

      try {
        const result =
          await ACS_runMaintenanceResolverForAirline(currentAirlineId);

        completedCount += Number(result?.completed_count || 0);
        startedCount += Number(result?.started_count || 0);
        blockedCount += Number(result?.blocked_count || 0);
        orphanRecoveredCount +=
          Number(result?.orphan_recovered_count || 0);
        phase0NormalizedCount +=
          Number(result?.phase0_normalized_count || 0);
        phase1CandidateCount +=
          Number(result?.phase1_candidate_count || 0);

        results.push(result);
      } catch (error) {
        errors.push({
          airline_id: currentAirlineId,
          error: error.code || error.message || "RESOLVER_FAILED"
        });

        console.error(
          `[ACS A/B MAINTENANCE] Resolver failed for airline ${currentAirlineId}:`,
          error
        );
      }
    }

    return {
      ok: errors.length === 0,
      endpoint: "ACS_GLOBAL_AB_MAINTENANCE_RESOLVER",
      version: "v2.4",
      authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
      all_airlines: true,
      airline_count: airlinesResult.rows.length,
      orphan_recovered_count: orphanRecoveredCount,
      phase0_normalized_count: phase0NormalizedCount,
      phase1_candidate_count: phase1CandidateCount,
      completed_count: completedCount,
      started_count: startedCount,
      blocked_count: blockedCount,
      error_count: errors.length,
      errors,
      results
    };
  } finally {
    client.release();
  }
}

/* ============================================================
   POST /v1/schedule/maintenance/resolver
   ------------------------------------------------------------
   Manual A/B resolver trigger for authenticated airline.

   Purpose:
   - Confirm resolver execution without waiting for scheduler tick.
   - Uses req.airline_id from requireAuth.
   - No frontend/localStorage authority.
   - No C/D mutation.
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

    try {
      const result = await ACS_runMaintenanceResolver({
        airlineId
      });

      console.log("[ACS A/B MAINTENANCE] Manual resolver:", {
        airline_id: airlineId,
        completed_count: result?.completed_count || 0,
        started_count: result?.started_count || 0,
        blocked_count: result?.blocked_count || 0,
        skipped: result?.skipped || false,
        skip_reason: result?.skip_reason || null
      });

      return res.json({
        ok: true,
        endpoint: "ACS_SCHEDULE_MAINTENANCE_RESOLVER_MANUAL",
        airline_id: airlineId,
        result
      });
    } catch (error) {
      console.error(
        "[ACS A/B MAINTENANCE] Manual resolver failed:",
        error
      );

      return ACS_sendError(
        res,
        error,
        "MAINTENANCE_RESOLVER_FAILED"
      );
    }
  }
);

/* ============================================================
   ACS GLOBAL A/B MAINTENANCE SCHEDULER
   ------------------------------------------------------------
   - PostgreSQL / ACS Time authority only.
   - No HTTP self-calls and no authenticated browser session.
   - Safe for Railway replicas through resolver advisory locks.
   - Exported here; server.js decides when to start/stop it.
   ============================================================ */

let ACS_maintenanceSchedulerTimer = null;
let ACS_maintenanceSchedulerRunning = false;

async function ACS_executeMaintenanceSchedulerTick() {
  if (ACS_maintenanceSchedulerRunning) {
    return;
  }

  ACS_maintenanceSchedulerRunning = true;

  try {
    const result = await ACS_runMaintenanceResolver({
      allAirlines: true
    });

    if (
      Number(result?.started_count || 0) > 0 ||
      Number(result?.completed_count || 0) > 0 ||
      Number(result?.blocked_count || 0) > 0 ||
      Number(result?.error_count || 0) > 0
    ) {
      console.log("[ACS A/B MAINTENANCE] Resolver tick:", {
  airline_count: result?.airline_count || 0,
  orphan_recovered_count: result?.orphan_recovered_count || 0,
  phase0_normalized_count: result?.phase0_normalized_count || 0,
  phase1_candidate_count: result?.phase1_candidate_count || 0,
  started_count: result?.started_count || 0,
  completed_count: result?.completed_count || 0,
  blocked_count: result?.blocked_count || 0,
  error_count: result?.error_count || 0,
  errors: result?.errors || []
});
    }
  } catch (error) {
    console.error(
      "[ACS A/B MAINTENANCE] Scheduler tick failed:",
      error
    );
  } finally {
    ACS_maintenanceSchedulerRunning = false;
  }
}

export function startMaintenanceScheduler({
  intervalMs = Number(
    process.env.ACS_MAINTENANCE_RESOLVER_INTERVAL_MS || 5000
  )
} = {}) {
  if (process.env.ACS_MAINTENANCE_SCHEDULER_ENABLED !== "true") {
    console.log(
      "[ACS A/B MAINTENANCE] Scheduler disabled " +
      "(set ACS_MAINTENANCE_SCHEDULER_ENABLED=true to enable)"
    );
    return false;
  }

  if (ACS_maintenanceSchedulerTimer) {
    return false;
  }

  const normalizedIntervalMs =
    Number.isFinite(intervalMs) && intervalMs >= 1000
      ? Math.floor(intervalMs)
      : 5000;

  void ACS_executeMaintenanceSchedulerTick();

  ACS_maintenanceSchedulerTimer = setInterval(
    () => {
      void ACS_executeMaintenanceSchedulerTick();
    },
    normalizedIntervalMs
  );

  ACS_maintenanceSchedulerTimer.unref?.();

  console.log(
    `[ACS A/B MAINTENANCE] Scheduler started (${normalizedIntervalMs} ms)`
  );

  return true;
}

export function stopMaintenanceScheduler() {
  if (!ACS_maintenanceSchedulerTimer) {
    return false;
  }

  clearInterval(ACS_maintenanceSchedulerTimer);
  ACS_maintenanceSchedulerTimer = null;

  console.log("[ACS A/B MAINTENANCE] Scheduler stopped");

  return true;
}
       
/* ============================================================
   ACS OCC — COMMERCIAL AIRCRAFT UNASSIGN AUTHORITY v1.0
   ------------------------------------------------------------
   Used by:
   - Sell Aircraft
   - Lease Aircraft (future)

   Authority:
   - Caller provides an active PostgreSQL transaction.
   - Locks affected Schedule records.
   - Blocks operations IN_PROGRESS.
   - Preserves routes and airport slots.
   - Removes the aircraft from planning and slots.
   - Removes future generated flight occurrences.
   - Preserves completed operational history.
   ============================================================ */

export async function
ACS_unassignAircraftForCommercialAction(
  client,
  {
    airlineId,
    aircraftId,
    source = "ACS_COMMERCIAL_ACTION"
  }
) {
  const normalizedAirlineId =
    Number(airlineId);

  const normalizedAircraftId =
    Number(aircraftId);

  if (
    !Number.isInteger(normalizedAirlineId) ||
    normalizedAirlineId <= 0
  ) {
    const error =
      new Error("NO_AIRLINE_SESSION");

    error.code =
      "NO_AIRLINE_SESSION";

    throw error;
  }

  if (
    !Number.isInteger(normalizedAircraftId) ||
    normalizedAircraftId <= 0
  ) {
    const error =
      new Error("AIRCRAFT_NOT_FOUND");

    error.code =
      "AIRCRAFT_NOT_FOUND";

    throw error;
  }

  /*
    Serialize this operation against the standard
    Schedule aircraft-assignment endpoint.
  */

  await client.query(
    `
    SELECT pg_advisory_xact_lock(
      hashtext($1)
    )
    `,
    [
      `ACS_SCHEDULE_ASSIGN|` +
      `${normalizedAirlineId}|` +
      `${normalizedAircraftId}`
    ]
  );

  /*
    Lock every active route currently assigned
    to the aircraft.
  */

  const routePlansResult =
    await client.query(
      `
      SELECT
        id,
        route_uid,
        origin,
        destination,
        route_state,
        aircraft_id,
        registration
      FROM public.route_plans
      WHERE airline_id = $1
        AND aircraft_id = $2

        AND UPPER(
          COALESCE(
            route_state,
            'ACTIVE'
          )
        ) <> 'CANCELLED'

      ORDER BY id

      FOR UPDATE
      `,
      [
        normalizedAirlineId,
        normalizedAircraftId
      ]
    );

  const assignedRoutePlans =
    routePlansResult.rows;

  if (!assignedRoutePlans.length) {
    return {
      had_assigned_routes: false,

      assigned_routes_count: 0,

      unassigned_route_plans_count: 0,

      unassigned_schedule_items_count: 0,

      removed_future_occurrences_count: 0,

      released_slot_bookings_count: 0,

      preserved_slot_bookings: false,

      slots_must_be_purchased_again: false,

      route_plans: [],

      schedule_items: [],

      released_slot_bookings: []
    };
  }

  const routePlanIds =
    assignedRoutePlans.map(
      route => Number(route.id)
    );

  /*
    Route-level operation guard.
  */

  const activeRoute =
    assignedRoutePlans.find(
      route =>
        ACS_text(
          route.route_state
        ).toUpperCase() ===
        "IN_PROGRESS"
    );

  if (activeRoute) {
    const error =
      new Error(
        "AIRCRAFT_OPERATION_IN_PROGRESS"
      );

    error.code =
      "AIRCRAFT_OPERATION_IN_PROGRESS";

    error.route_plan =
      activeRoute;

    throw error;
  }

  /*
    Schedule-item operation guard.

    Completed rows remain historical and do not
    prevent future planning from being unassigned.
  */

  const activeScheduleItemResult =
    await client.query(
      `
      SELECT
        id,
        route_plan_id,
        route_uid,
        flight_number,
        selected_day,
        departure,
        arrival,
        status
      FROM public.schedule_items
      WHERE airline_id = $1

        AND route_plan_id =
          ANY($2::BIGINT[])

        AND aircraft_id = $3

        AND item_type = 'flight'

        AND UPPER(
          COALESCE(
            status,
            ''
          )
        ) = 'IN_PROGRESS'

      ORDER BY id

      LIMIT 1

      FOR UPDATE
      `,
      [
        normalizedAirlineId,
        routePlanIds,
        normalizedAircraftId
      ]
    );

  if (
    activeScheduleItemResult.rows.length
  ) {
    const error =
      new Error(
        "AIRCRAFT_OPERATION_IN_PROGRESS"
      );

    error.code =
      "AIRCRAFT_OPERATION_IN_PROGRESS";

    error.schedule_item =
      activeScheduleItemResult.rows[0];

    throw error;
  }

  /*
    Flight-occurrence operation guard.
  */

  const activeOccurrenceResult =
    await client.query(
      `
      SELECT
        id,
        route_plan_id,
        schedule_item_id,
        scheduled_departure_at,
        scheduled_arrival_at,
        operational_status
      FROM public.flight_occurrences
      WHERE airline_id = $1
        AND aircraft_id = $2

        AND UPPER(
          COALESCE(
            operational_status,
            ''
          )
        ) = 'IN_PROGRESS'

      ORDER BY scheduled_departure_at

      LIMIT 1

      FOR UPDATE
      `,
      [
        normalizedAirlineId,
        normalizedAircraftId
      ]
    );

  if (
    activeOccurrenceResult.rows.length
  ) {
    const error =
      new Error(
        "AIRCRAFT_OPERATION_IN_PROGRESS"
      );

    error.code =
      "AIRCRAFT_OPERATION_IN_PROGRESS";

    error.flight_occurrence =
      activeOccurrenceResult.rows[0];

    throw error;
  }

  /*
    Unassign the aircraft from Route Plans.

    Routes remain active and retain their operational
    identity, selected days, flight numbers and slots.
  */

  const unassignedRoutePlansResult =
    await client.query(
      `
      UPDATE public.route_plans
      SET
        aircraft_id = NULL,
        registration = NULL,
        aircraft = NULL,
        updated_at = NOW()

      WHERE airline_id = $1

        AND id =
          ANY($2::BIGINT[])

        AND aircraft_id = $3

      RETURNING
        id,
        route_uid,
        origin,
        destination,
        route_state
      `,
      [
        normalizedAirlineId,
        routePlanIds,
        normalizedAircraftId
      ]
    );

  /*
    Unassign editable Schedule items.

    Completed and cancelled history is preserved.
  */

  const unassignedScheduleItemsResult =
    await client.query(
      `
      UPDATE public.schedule_items
      SET
        aircraft_id = NULL,
        aircraft_registration = NULL,
        aircraft = NULL,

        status = CASE
          WHEN LOWER(
            COALESCE(
              status,
              'planned'
            )
          ) = 'assigned'
            THEN 'planned'

          ELSE status
        END,

        notes = jsonb_build_object(
          'source',
          $4::TEXT,

          'action',
          'AIRCRAFT_UNASSIGNED',

          'previous_aircraft_id',
          $3::BIGINT,

          'unassigned_at',
          NOW()
        )::TEXT,

        updated_at = NOW()

      WHERE airline_id = $1

        AND route_plan_id =
          ANY($2::BIGINT[])

        AND aircraft_id = $3

        AND item_type = 'flight'

        AND LOWER(
          COALESCE(
            status,
            'planned'
          )
        ) NOT IN (
          'cancelled',
          'completed',
          'in_progress'
        )

      RETURNING
        id,
        route_plan_id,
        route_uid,
        flight_number,
        selected_day,
        status
      `,
      [
        normalizedAirlineId,
        routePlanIds,
        normalizedAircraftId,
        source
      ]
    );

  /*
    Preserve each slot reservation but detach the
    aircraft identity from it.

    The route retains the slot. The aircraft does not.
  */

  const releasedSlotBookingsResult =
  await client.query(
    `
    UPDATE public.airport_slot_bookings
    SET
      slot_status = 'CANCELLED',

      source =
        'ACS_COMMERCIAL_AIRCRAFT_SLOT_RELEASE',

      updated_at = NOW()

    WHERE airline_id = $1

      AND route_plan_id =
        ANY($2::BIGINT[])

      AND aircraft_id = $3

      AND UPPER(
        COALESCE(
          slot_status,
          'RESERVED'
        )
      ) = 'RESERVED'

    RETURNING
      id,
      route_plan_id,
      aircraft_id,
      registration,
      airport_icao,
      movement_type,
      weekday,
      time_local,
      slot_status
    `,
    [
      normalizedAirlineId,
      routePlanIds,
      normalizedAircraftId
    ]
  );
   
  /*
    Remove future generated occurrences belonging
    to the old aircraft assignment.

    ACS Flight Runtime will not regenerate them while
    the Schedule items remain without aircraft_id.

    Completed and cancelled history is preserved.
  */

  const removedOccurrencesResult =
    await client.query(
      `
      DELETE FROM public.flight_occurrences
      WHERE airline_id = $1
        AND aircraft_id = $2

        AND route_plan_id =
          ANY($3::BIGINT[])

        AND scheduled_departure_at >=
          acs_get_current_sim_time()

        AND UPPER(
          COALESCE(
            operational_status,
            'SCHEDULED'
          )
        ) NOT IN (
          'IN_PROGRESS',
          'COMPLETED',
          'CANCELLED'
        )

      RETURNING
        id,
        route_plan_id,
        schedule_item_id,
        scheduled_departure_at
      `,
      [
        normalizedAirlineId,
        normalizedAircraftId,
        routePlanIds
      ]
    );

  return {
    had_assigned_routes: true,

    assigned_routes_count:
      assignedRoutePlans.length,

    unassigned_route_plans_count:
      unassignedRoutePlansResult.rowCount,

    unassigned_schedule_items_count:
      unassignedScheduleItemsResult.rowCount,

    removed_future_occurrences_count:
      removedOccurrencesResult.rowCount,

    released_slot_bookings_count:
      releasedSlotBookingsResult.rowCount,

    preserved_slot_bookings: false,

    slots_must_be_purchased_again: true,

    route_plans:
      unassignedRoutePlansResult.rows,

    schedule_items:
      unassignedScheduleItemsResult.rows,

    released_slot_bookings:
      releasedSlotBookingsResult.rows
  };
}

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

   /*
  Aircraft listed in the commercial market cannot
  receive new Schedule assignments.
*/

const aircraftCommercialStatus =
  ACS_text(
    aircraft.status
  ).toUpperCase();

if (
  [
    "FOR_SALE",
    "FOR_LEASE",
    "SOLD",
    "LEASED_OUT"
  ].includes(
    aircraftCommercialStatus
  )
) {
  const error =
    new Error(
      "AIRCRAFT_COMMERCIAL_HOLD"
    );

  error.code =
    "AIRCRAFT_COMMERCIAL_HOLD";

  throw error;
}

const activeCommercialListingResult =
  await client.query(
    `
    SELECT
      id,
      listing_type,
      status
    FROM public.aircraft_market_listings
    WHERE aircraft_id = $1

      AND status IN (
        'ACTIVE',
        'OFFER_RECEIVED',
        'SALE_PENDING'
      )

    ORDER BY id DESC
    LIMIT 1
    `,
    [aircraftId]
  );

if (
  activeCommercialListingResult.rows.length
) {
  const error =
    new Error(
      "AIRCRAFT_COMMERCIAL_HOLD"
    );

  error.code =
    "AIRCRAFT_COMMERCIAL_HOLD";

  error.listing =
    activeCommercialListingResult.rows[0];

  throw error;
}
     
 /* ========================================================
   ACS OCC — PLANNING ASSIGNMENT RULE
   --------------------------------------------------------
   Assign Route is planning, not dispatch.

   The aircraft may be assigned to future flying even if it
   is not dispatchable right now.

   Dispatchability is validated later by the flight execution
   layer, not here.
   ======================================================== */

    const planningAssignment = true;

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

/* ============================================================
   ACS OCC — PHYSICAL DELETE OF SCHEDULE FLIGHTS / ROUTES
   ------------------------------------------------------------
   Replace ONLY the two existing DELETE endpoints at the end of
   routes/schedule.js with this complete block:

   - DELETE /v1/schedule/flights/:scheduleItemId
   - DELETE /v1/schedule/flights

   Behaviour:
   - Physical deletion; never writes status='cancelled'.
   - Partial selection removes only the selected operating days.
   - The last operating day removes the complete route_plan.
   - All work is atomic inside the caller's transaction.
   ============================================================ */

async function ACS_deleteScheduleFlightsPhysically(
  client,
  airlineId,
  requestedScheduleItemIds
) {
  const scheduleItemIds = [...new Set(
    requestedScheduleItemIds
      .map(ACS_positiveBigInt)
      .filter(Boolean)
  )].sort((left, right) => left - right);

  if (!scheduleItemIds.length) {
    const error = new Error("schedule_item_ids is required");
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  const flightsResult = await client.query(
    `
    SELECT
      id,
      route_plan_id,
      route_uid,
      airline_id,
      item_type,
      selected_day,
      flight_number,
      paired_flight_number,
      status
    FROM public.schedule_items
    WHERE airline_id = $1
      AND id = ANY($2::BIGINT[])
      AND item_type = 'flight'
    ORDER BY id
    FOR UPDATE
    `,
    [airlineId, scheduleItemIds]
  );

  if (flightsResult.rows.length !== scheduleItemIds.length) {
    const error = new Error("One or more selected flights were not found");
    error.code = "FLIGHTS_NOT_FOUND";
    throw error;
  }

  const lockedFlights = flightsResult.rows;
  const protectedFlight = lockedFlights.find(flight =>
    ["in_progress", "completed"].includes(
      ACS_text(flight.status).toLowerCase()
    )
  );

  if (protectedFlight) {
    const error = new Error("In-progress or completed flights cannot be deleted");
    error.code = "FLIGHT_NOT_DELETABLE";
    error.flight = protectedFlight;
    throw error;
  }

  const routePlanIds = [...new Set(
    lockedFlights
      .map(flight => Number(flight.route_plan_id))
      .filter(id => Number.isSafeInteger(id) && id > 0)
  )].sort((left, right) => left - right);

  if (!routePlanIds.length) {
    const error = new Error("Selected flights have no route_plan_id");
    error.code = "ROUTE_PLAN_ID_MISSING";
    throw error;
  }

  const lockedRoutesResult = await client.query(
    `
    SELECT id
    FROM public.route_plans
    WHERE airline_id = $1
      AND id = ANY($2::BIGINT[])
    ORDER BY id
    FOR UPDATE
    `,
    [airlineId, routePlanIds]
  );

  if (lockedRoutesResult.rows.length !== routePlanIds.length) {
    const error = new Error("One or more route plans were not found");
    error.code = "ROUTE_PLAN_NOT_FOUND";
    throw error;
  }

  /* Delete dependent results before their flight occurrences. */
  const deletedPassengerResults = await client.query(
    `
    DELETE FROM public.acs_passenger_flight_results result
    USING public.flight_occurrences occurrence
    WHERE result.occurrence_id = occurrence.id
      AND occurrence.airline_id = $1
      AND occurrence.schedule_item_id = ANY($2::BIGINT[])
    RETURNING result.id
    `,
    [airlineId, scheduleItemIds]
  );

  const deletedOccurrences = await client.query(
    `
    DELETE FROM public.flight_occurrences
    WHERE airline_id = $1
      AND schedule_item_id = ANY($2::BIGINT[])
    RETURNING id
    `,
    [airlineId, scheduleItemIds]
  );

  /* Preserve the slot-selection behaviour that already works in ACS,
     but remove the rows physically instead of retaining CANCELLED rows. */
  let deletedSlotsCount = 0;

  for (const flight of lockedFlights) {
    const slotsResult = await client.query(
      `
      DELETE FROM public.airport_slot_bookings
      WHERE airline_id = $1
        AND route_plan_id = $2
        AND LOWER(weekday) = LOWER($3)
        AND flight_number IN ($4, $5)
      RETURNING id
      `,
      [
        airlineId,
        flight.route_plan_id,
        ACS_text(flight.selected_day),
        ACS_text(flight.flight_number),
        ACS_text(flight.paired_flight_number)
      ]
    );

    deletedSlotsCount += slotsResult.rows.length;
  }

  const deletedFlightsResult = await client.query(
    `
    DELETE FROM public.schedule_items
    WHERE airline_id = $1
      AND id = ANY($2::BIGINT[])
      AND item_type = 'flight'
    RETURNING *
    `,
    [airlineId, scheduleItemIds]
  );

  const weekdayOrder = [
    "mon", "tue", "wed", "thu", "fri", "sat", "sun"
  ];

  const updatedRoutePlans = [];
  const deletedRoutePlanIds = [];
  let deletedFlightNumbersCount = 0;

  for (const routePlanId of routePlanIds) {
    /* Remove old EDIT residues belonging to this affected route. */
    const cancelledItemsResult = await client.query(
      `
      SELECT id
      FROM public.schedule_items
      WHERE airline_id = $1
        AND route_plan_id = $2
        AND item_type = 'flight'
        AND LOWER(COALESCE(status, 'planned')) = 'cancelled'
      ORDER BY id
      FOR UPDATE
      `,
      [airlineId, routePlanId]
    );

    const cancelledItemIds = cancelledItemsResult.rows.map(row => Number(row.id));

    if (cancelledItemIds.length) {
      await client.query(
        `
        DELETE FROM public.acs_passenger_flight_results result
        USING public.flight_occurrences occurrence
        WHERE result.occurrence_id = occurrence.id
          AND occurrence.airline_id = $1
          AND occurrence.schedule_item_id = ANY($2::BIGINT[])
        `,
        [airlineId, cancelledItemIds]
      );

      await client.query(
        `
        DELETE FROM public.flight_occurrences
        WHERE airline_id = $1
          AND schedule_item_id = ANY($2::BIGINT[])
        `,
        [airlineId, cancelledItemIds]
      );

      await client.query(
        `
        DELETE FROM public.schedule_items
        WHERE airline_id = $1
          AND id = ANY($2::BIGINT[])
        `,
        [airlineId, cancelledItemIds]
      );

      await client.query(
        `
        DELETE FROM public.airport_slot_bookings
        WHERE airline_id = $1
          AND route_plan_id = $2
          AND UPPER(COALESCE(slot_status, 'RESERVED')) = 'CANCELLED'
        `,
        [airlineId, routePlanId]
      );
    }

    const remainingResult = await client.query(
      `
      SELECT DISTINCT LOWER(selected_day) AS selected_day
      FROM public.schedule_items
      WHERE airline_id = $1
        AND route_plan_id = $2
        AND item_type = 'flight'
      ORDER BY LOWER(selected_day)
      `,
      [airlineId, routePlanId]
    );

    const remainingDays = remainingResult.rows
      .map(row => ACS_text(row.selected_day).toLowerCase())
      .filter(day => weekdayOrder.includes(day))
      .sort(
        (left, right) =>
          weekdayOrder.indexOf(left) - weekdayOrder.indexOf(right)
      );

    if (remainingDays.length) {
      const updatedRouteResult = await client.query(
        `
        UPDATE public.route_plans
        SET
          selected_days = $1::JSONB,
          updated_at = NOW()
        WHERE id = $2
          AND airline_id = $3
        RETURNING *
        `,
        [JSON.stringify(remainingDays), routePlanId, airlineId]
      );

      if (updatedRouteResult.rows[0]) {
        updatedRoutePlans.push(updatedRouteResult.rows[0]);
      }

      continue;
    }

    /* Last operating day: remove every remaining dependency and route. */
    const routePassengerResults = await client.query(
      `
      DELETE FROM public.acs_passenger_flight_results result
      USING public.flight_occurrences occurrence
      WHERE result.occurrence_id = occurrence.id
        AND occurrence.airline_id = $1
        AND occurrence.route_plan_id = $2
      RETURNING result.id
      `,
      [airlineId, routePlanId]
    );

    const routeOccurrences = await client.query(
      `
      DELETE FROM public.flight_occurrences
      WHERE airline_id = $1
        AND route_plan_id = $2
      RETURNING id
      `,
      [airlineId, routePlanId]
    );

    const remainingSlots = await client.query(
      `
      DELETE FROM public.airport_slot_bookings
      WHERE airline_id = $1
        AND route_plan_id = $2
      RETURNING id
      `,
      [airlineId, routePlanId]
    );

    deletedSlotsCount += remainingSlots.rows.length;

    await client.query(
      `
      DELETE FROM public.schedule_items
      WHERE airline_id = $1
        AND route_plan_id = $2
      `,
      [airlineId, routePlanId]
    );

    const flightNumbersResult = await client.query(
      `
      DELETE FROM public.flight_number_allocations
      WHERE airline_id = $1
        AND route_plan_id = $2
      RETURNING id
      `,
      [airlineId, routePlanId]
    );

    deletedFlightNumbersCount += flightNumbersResult.rows.length;

    const deletedRouteResult = await client.query(
      `
      DELETE FROM public.route_plans
      WHERE id = $1
        AND airline_id = $2
      RETURNING id
      `,
      [routePlanId, airlineId]
    );

    if (deletedRouteResult.rows[0]) {
      deletedRoutePlanIds.push(Number(deletedRouteResult.rows[0].id));
    }

    /* Include full-route dependency counts in the response totals. */
    deletedPassengerResults.rows.push(...routePassengerResults.rows);
    deletedOccurrences.rows.push(...routeOccurrences.rows);
  }

  return {
    deletedFlights: deletedFlightsResult.rows,
    deletedPassengerResultsCount: deletedPassengerResults.rows.length,
    deletedOccurrencesCount: deletedOccurrences.rows.length,
    deletedSlotsCount,
    deletedFlightNumbersCount,
    updatedRoutePlans,
    deletedRoutePlanIds
  };
}

async function ACS_runPhysicalScheduleDelete(
  req,
  res,
  scheduleItemIds,
  endpoint
) {
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

    const normalizedIds = [...new Set(
      scheduleItemIds
        .map(ACS_positiveBigInt)
        .filter(Boolean)
    )].sort((left, right) => left - right);

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`ACS_PHYSICAL_SCHEDULE_DELETE|${airlineId}|${normalizedIds.join(",")}`]
    );

    const result = await ACS_deleteScheduleFlightsPhysically(
      client,
      airlineId,
      normalizedIds
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      ok: true,
      endpoint,
      authority: "POSTGRESQL_SCHEDULE_AUTHORITY",
      airline_id: airlineId,
      deleted_count: result.deletedFlights.length,
      deleted_flights: result.deletedFlights,
      deleted_passenger_results_count:
        result.deletedPassengerResultsCount,
      deleted_occurrences_count:
        result.deletedOccurrencesCount,
      deleted_slots_count: result.deletedSlotsCount,
      deleted_flight_numbers_count:
        result.deletedFlightNumbersCount,
      updated_route_plans: result.updatedRoutePlans,
      deleted_route_plan_ids: result.deletedRoutePlanIds
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ACS PHYSICAL DELETE ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("ACS PHYSICAL DELETE ERROR:", error);
    return ACS_sendError(res, error, "DELETE_FLIGHT_FAILED");
  } finally {
    client.release();
  }
}

router.delete(
  "/schedule/flights/:scheduleItemId",
  requireAuth,
  async (req, res) => {
    const scheduleItemId = ACS_positiveBigInt(req.params.scheduleItemId);

    if (!scheduleItemId) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "scheduleItemId is required"
      });
    }

    return ACS_runPhysicalScheduleDelete(
      req,
      res,
      [scheduleItemId],
      "ACS_PHYSICAL_DELETE_FLIGHT"
    );
  }
);

router.delete(
  "/schedule/flights",
  requireAuth,
  async (req, res) => {
    const scheduleItemIds = Array.isArray(req.body?.schedule_item_ids)
      ? req.body.schedule_item_ids
      : [];

    if (!scheduleItemIds.length) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "schedule_item_ids is required"
      });
    }

    return ACS_runPhysicalScheduleDelete(
      req,
      res,
      scheduleItemIds,
      "ACS_PHYSICAL_DELETE_FLIGHTS"
    );
  }
);

export default router;
