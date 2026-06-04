/* ============================================================
   🟦 ACS ROUTE PLANS BACKEND AUTHORITY — Airbus OCC v1.1
   ------------------------------------------------------------
   File: routes/route_plans.js
   Purpose:
   - Store operational route plans in PostgreSQL
   - Reserve airport slots transactionally
   - Backend authority for route creation
   - No localStorage authority
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_normalizeIcao(value) {
  return String(value || "").trim().toUpperCase();
}

function ACS_normalizeText(value) {
  return String(value || "").trim();
}

function ACS_normalizeWeekday(value) {
  return String(value || "").trim().toLowerCase().slice(0, 3);
}

function ACS_isValidHHMM(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

function ACS_getMaxSlotsByCategory(category = "") {
  const c = String(category || "").trim().toUpperCase();

  if (c.includes("PRIMARY")) return 36;
  if (c.includes("HUB")) return 36;

  if (c.includes("MAJOR")) return 24;
  if (c.includes("INTERN")) return 24;

  if (c.includes("REGIONAL")) return 12;

  return 6;
}

function ACS_getSlotCapacityFromPayload(payload, prefix) {
  const direct = Number(
    payload?.[`${prefix}_slot_capacity`] ||
    payload?.[`${prefix}SlotCapacity`] ||
    payload?.[`${prefix}_max_slots`] ||
    payload?.[`${prefix}MaxSlots`] ||
    0
  );

  if (Number.isFinite(direct) && direct > 0) {
    return Math.round(direct);
  }

  const category =
    payload?.[`${prefix}_airport_category`] ||
    payload?.[`${prefix}AirportCategory`] ||
    payload?.[`${prefix}_category`] ||
    payload?.[`${prefix}Category`] ||
    "";

  return ACS_getMaxSlotsByCategory(category);
}

function ACS_shiftWeekday(weekday, dayOffset = 0) {
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const base = days.indexOf(ACS_normalizeWeekday(weekday));

  if (base === -1) return ACS_normalizeWeekday(weekday);

  const next = (base + dayOffset + 7) % 7;
  return days[next];
}

function ACS_addMinutesToDayTime(weekday, timeHHMM, addMinutes = 0) {
  const baseMin = ACS_minutesFromHHMM(timeHHMM);
  const totalMin = baseMin + Number(addMinutes || 0);

  const dayOffset = Math.floor(totalMin / 1440);
  const minuteOfDay = ((totalMin % 1440) + 1440) % 1440;

  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");

  return {
    weekday: ACS_shiftWeekday(weekday, dayOffset),
    time_local: `${hh}:${mm}`
  };
}

function ACS_buildSlotMovements({
  origin,
  destination,
  selectedDays,
  departure,
  arrival,
  blockTimeMin,
  turnaroundMin,
  flightNumberOut,
  flightNumberIn
}) {
  const movements = [];

  selectedDays.forEach(dayRaw => {
    const weekday = ACS_normalizeWeekday(dayRaw);

    const outboundDep = {
      weekday,
      time_local: departure
    };

    const outboundArr = ACS_addMinutesToDayTime(
      weekday,
      departure,
      blockTimeMin
    );

    const inboundDep = ACS_addMinutesToDayTime(
      outboundArr.weekday,
      outboundArr.time_local,
      turnaroundMin
    );

    const inboundArr = ACS_addMinutesToDayTime(
      inboundDep.weekday,
      inboundDep.time_local,
      blockTimeMin
    );

    movements.push({
      airport_icao: origin,
      movement_type: "DEP",
      weekday: outboundDep.weekday,
      time_local: outboundDep.time_local,
      origin,
      destination,
      flight_number: flightNumberOut
    });

    movements.push({
      airport_icao: destination,
      movement_type: "ARR",
      weekday: outboundArr.weekday,
      time_local: outboundArr.time_local,
      origin,
      destination,
      flight_number: flightNumberOut
    });

    movements.push({
      airport_icao: destination,
      movement_type: "DEP",
      weekday: inboundDep.weekday,
      time_local: inboundDep.time_local,
      origin: destination,
      destination: origin,
      flight_number: flightNumberIn
    });

    movements.push({
      airport_icao: origin,
      movement_type: "ARR",
      weekday: inboundArr.weekday,
      time_local: inboundArr.time_local,
      origin: destination,
      destination: origin,
      flight_number: flightNumberIn
    });
  });

  return movements;
}

async function ACS_lockSlotKey(client, movement) {
  const lockKey = [
    "ACS_SLOT",
    movement.airport_icao,
    movement.weekday,
    movement.time_local
  ].join("|");

  await client.query(
    `
    SELECT pg_advisory_xact_lock(hashtext($1))
    `,
    [lockKey]
  );
}

async function ACS_getReservedSlotCount(client, movement) {
  const result = await client.query(
    `
    SELECT COUNT(*)::INTEGER AS used
    FROM airport_slot_bookings
    WHERE airport_icao = $1
      AND weekday = $2
      AND time_local = $3
      AND slot_status = 'RESERVED'
    `,
    [
      movement.airport_icao,
      movement.weekday,
      movement.time_local
    ]
  );

  return Number(result.rows[0]?.used || 0);
}

async function ACS_getAirportSlotFee(client, airportIcao) {
  const result = await client.query(
    `
    SELECT
      slot_cost_usd
    FROM airport_catalog
    WHERE icao = $1
    LIMIT 1
    `,
    [airportIcao]
  );

  return Math.round(Number(result.rows[0]?.slot_cost_usd || 0));
}

function ACS_minutesFromHHMM(value) {
  const text = String(value || "").trim();
  const [h, m] = text.split(":").map(Number);

  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return 0;
  }

  return (h * 60) + m;
}

function ACS_dayIndex(day) {
  const key = ACS_normalizeWeekday(day);

  return {
    mon: 0,
    tue: 1,
    wed: 2,
    thu: 3,
    fri: 4,
    sat: 5,
    sun: 6
  }[key] ?? 0;
}

function ACS_buildAbsMinutes(day, departure, arrival) {
  const base = ACS_dayIndex(day) * 1440;

  const depAbsMin = base + ACS_minutesFromHHMM(departure);
  let arrAbsMin = base + ACS_minutesFromHHMM(arrival);

  if (arrAbsMin <= depAbsMin) {
    arrAbsMin += 1440;
  }

  return {
    depAbsMin,
    arrAbsMin
  };
}

/* ============================================================
   POST /v1/routes/plans
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

    const origin = ACS_normalizeIcao(b.origin);
    const destination = ACS_normalizeIcao(b.destination);

    const aircraftId = Number(b.aircraft_id || b.aircraftId || 0);

    const selectedDaysRaw = Array.isArray(b.selected_days)
      ? b.selected_days
      : Array.isArray(b.days)
        ? b.days
        : [];

    const selectedDays = [...new Set(
      selectedDaysRaw
        .map(ACS_normalizeWeekday)
        .filter(day => ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(day))
    )];

    const departure = ACS_normalizeText(b.departure);
    const arrival = ACS_normalizeText(b.arrival);

    const distanceNm = Math.round(Number(b.distance_nm || b.distanceNM || 0));
    const blockTimeMin = Math.round(Number(b.block_time_min || b.blockTimeMin || 0));
    const turnaroundMin = Math.round(Number(b.turnaround_min || b.turnaroundMin || 0));
    const totalRotationMin = Math.round(Number(b.total_rotation_min || b.totalRotationMin || 0));

    const flightNumberOut = ACS_normalizeText(b.flight_number_out || b.flightNumberOut).toUpperCase();
    const flightNumberIn = ACS_normalizeText(b.flight_number_in || b.flightNumberIn).toUpperCase();

    const routeType = ACS_normalizeText(b.route_type || "PASSENGER").toUpperCase();

    const originSlotCapacity = ACS_getSlotCapacityFromPayload(b, "origin");
    const destinationSlotCapacity = ACS_getSlotCapacityFromPayload(b, "destination");

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

    if (!ACS_isValidHHMM(departure) || !ACS_isValidHHMM(arrival)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_DEPARTURE_OR_ARRIVAL_TIME"
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

    const aircraftStatus = ACS_normalizeText(aircraft.status).toUpperCase();
    const operationalStatus = ACS_normalizeText(aircraft.operational_status).toUpperCase();
    const maintenanceStatus = ACS_normalizeText(aircraft.maintenance_status).toUpperCase();
    const maintenanceControlStatus = ACS_normalizeText(aircraft.maintenance_control_status).toUpperCase();

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

    const aircraftRangeNm = Math.round(Number(
      aircraft.range_nm ||
      b.aircraft_range_nm ||
      b.rangeNm ||
      0
    ));

    const speedKts = Math.round(Number(
      aircraft.speed_kts ||
      b.speed_kts ||
      b.speedKts ||
      0
    ));

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

    const slotMovements = ACS_buildSlotMovements({
  origin,
  destination,
  selectedDays,
  departure,
  arrival,
  blockTimeMin,
  turnaroundMin,
  flightNumberOut,
  flightNumberIn
  });

    if (!slotMovements.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "NO_SLOT_MOVEMENTS_BUILT"
      });
    }

    for (const movement of slotMovements) {
      await ACS_lockSlotKey(client, movement);

      const used = await ACS_getReservedSlotCount(client, movement);

      const max =
        movement.airport_icao === origin
          ? originSlotCapacity
          : destinationSlotCapacity;

      if (used >= max) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "SLOT_UNAVAILABLE",
          slot: {
            airport_icao: movement.airport_icao,
            weekday: movement.weekday,
            time_local: movement.time_local,
            movement_type: movement.movement_type,
            used,
            max,
            free: Math.max(0, max - used)
          }
        });
      }
    }

   const originSlotFee = await ACS_getAirportSlotFee(client, origin);
const destinationSlotFee = await ACS_getAirportSlotFee(client, destination);

const totalSlotPrice =
  Math.round(((originSlotFee * 2) + (destinationSlotFee * 2)) * selectedDays.length);
     
const financeResult = await client.query(
  `
  SELECT
    airline_id,
    capital,
    expenses,
    cost_slots
  FROM company_finance
  WHERE airline_id = $1
  FOR UPDATE
  `,
  [airlineId]
);

if (!financeResult.rows.length) {
  await client.query("ROLLBACK");

  return res.status(404).json({
    ok: false,
    error: "COMPANY_FINANCE_NOT_FOUND"
  });
}

const currentCapital = Number(financeResult.rows[0].capital || 0);

if (currentCapital < totalSlotPrice) {
  await client.query("ROLLBACK");

  return res.status(409).json({
    ok: false,
    error: "INSUFFICIENT_CAPITAL_FOR_AIRPORT_SLOT_FEE",
    finance: {
      capital: currentCapital,
      required: totalSlotPrice,
      missing: totalSlotPrice - currentCapital
    }
  });
}
     
    const capabilityCode = "DISPATCHABLE";
    const operationalLimitation = "NONE";

    const insertRouteResult = await client.query(
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
        'ACS_ROUTE_PLANS_BACKEND_AUTHORITY_V1_1',
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
        ACS_normalizeText(aircraft.model_key || b.model_key || b.modelKey).toUpperCase(),
        ACS_normalizeText(aircraft.aircraft_name || b.aircraft || b.aircraftName),
        aircraftId,
        ACS_normalizeText(aircraft.registration || b.registration),
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

    const routePlan = insertRouteResult.rows[0];

    const insertedSlots = [];

    for (const movement of slotMovements) {
      const insertSlotResult = await client.query(
        `
        INSERT INTO airport_slot_bookings (
          airline_id,
          route_plan_id,
          aircraft_id,
          airport_icao,
          movement_type,
          weekday,
          time_local,
          origin,
          destination,
          flight_number,
          registration,
          model_key,
          slot_status,
          source,
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
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          'RESERVED',
          'ACS_ROUTE_PLAN_SLOT_RESERVATION_V1_1',
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          airlineId,
          routePlan.id,
          aircraftId,
          movement.airport_icao,
          movement.movement_type,
          movement.weekday,
          movement.time_local,
          origin,
          destination,
          movement.flight_number,
          routePlan.registration,
          routePlan.model_key
        ]
      );

      insertedSlots.push(insertSlotResult.rows[0]);
    }

    const insertedScheduleItems = [];

for (const day of selectedDays) {
  const abs = ACS_buildAbsMinutes(day, departure, arrival);

  const scheduleItemResult = await client.query(
    `
    INSERT INTO schedule_items (
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
      aircraft_id,
      aircraft_registration,
      flight_number,
      paired_flight_number,
      flight_direction,
      distance_nm,
      dep_abs_min,
      arr_abs_min,
      block_time_min,
      turnaround_min,
      status,
      notes,
      created_at,
      updated_at
    )
    VALUES (
      gen_random_uuid()::TEXT,
      $1,
      $2,
      $3,
      'flight',
      NULL,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      'OUTBOUND',
      $15,
      $16,
      $17,
      $18,
      $19,
      'planned',
      'Created from Route Schedule confirm route',
      NOW(),
      NOW()
    )
    RETURNING *
    `,
    [
      routePlan.id,
      routePlan.route_uid,
      airlineId,
      origin,
      destination,
      day,
      departure,
      arrival,
      routePlan.model_key,
      routePlan.aircraft,
      aircraftId,
      routePlan.registration,
      flightNumberOut,
      flightNumberIn,
      distanceNm,
      abs.depAbsMin,
      abs.arrAbsMin,
      blockTimeMin,
      turnaroundMin
    ]
  );

  insertedScheduleItems.push(scheduleItemResult.rows[0]);
}

let financeLog = null;

if (totalSlotPrice > 0) {
  await client.query(
    `
    UPDATE company_finance
    SET
      capital = COALESCE(capital, 0) - $2,
      expenses = COALESCE(expenses, 0) + $2,
      cost_slots = COALESCE(cost_slots, 0) + $2,
      updated_at = NOW()
    WHERE airline_id = $1
    `,
    [airlineId, totalSlotPrice]
  );

  const financeLogResult = await client.query(
    `
    INSERT INTO finance_log (
      airline_id,
      type,
      source,
      amount,
      timestamp,
      route_plan_id,
      schedule_item_id,
      reference_uid,
      description,
      created_at
    )
    VALUES (
      $1,
      'EXPENSE',
      'AIRPORT SLOT FEE',
      $2,
      EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      $3,
      NULL,
      $4,
      $5,
      NOW()
    )
    RETURNING *
    `,
    [
      airlineId,
      totalSlotPrice,
      routePlan.id,
      routePlan.route_uid,
      `Airport slot fee for route ${origin}-${destination} flights ${flightNumberOut}/${flightNumberIn}`
    ]
  );

  financeLog = financeLogResult.rows[0];

  await client.query(
    `
    UPDATE route_plans
    SET
      origin_slot_price = $1,
      destination_slot_price = $2,
      total_slot_price = $3,
      selected_schedule_cost = $3,
      finance_applied = TRUE,
      finance_transaction_id = $4,
      updated_at = NOW()
    WHERE id = $5
    `,
    [
      originSlotFee,
      destinationSlotFee,
      totalSlotPrice,
      String(financeLog.id),
      routePlan.id
    ]
  );
}
     
    await client.query("COMMIT");

        return res.status(201).json({
      ok: true,
      endpoint: "ACS_ROUTE_PLAN_CREATE",
      version: "v1.2",
      message: "ROUTE_PLAN_CREATED_WITH_SLOTS_SCHEDULE_AND_FINANCE",

      route_plan: routePlan,

      slot_bookings: insertedSlots,

      schedule_items: insertedScheduleItems,

      finance: {
        applied: totalSlotPrice > 0,
        airport_slot_fee: totalSlotPrice,
        origin_slot_fee: originSlotFee,
        destination_slot_fee: destinationSlotFee,
        finance_log: financeLog
      },

      slot_summary: {
        total: insertedSlots.length,
        dep: insertedSlots.filter(s => s.movement_type === "DEP").length,
        arr: insertedSlots.filter(s => s.movement_type === "ARR").length
      }
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
