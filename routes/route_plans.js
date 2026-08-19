/* ============================================================
   🟦 ACS ROUTE PLANS BACKEND  AUTHORITY — Airbus OCC v2.1
   ------------------------------------------------------------
   File: routes/route_plans.js

   Authority:
   - PostgreSQL time: acs_get_current_sim_time()
   - Airport history: airport_historical_profiles
   - Flight numbers: airlines + flight_number_sequences
                     + flight_number_allocations
   - Slots: airport_slot_bookings
   - Finance: company_finance + finance_log

   Rules:
   - No localStorage authority
   - No flight numbers accepted from frontend
   - No airport capacity accepted from frontend
   - No airport price accepted from frontend
   - Route, slots, schedule, numbering and finance are transactional
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const ACS_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

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

function ACS_roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function ACS_minutesFromHHMM(value) {
  const [hours, minutes] = String(value || "").trim().split(":").map(Number);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  return (hours * 60) + minutes;
}

function ACS_dayIndex(day) {
  const index = ACS_WEEKDAYS.indexOf(ACS_normalizeWeekday(day));
  return index >= 0 ? index : 0;
}

function ACS_shiftWeekday(weekday, dayOffset = 0) {
  const base = ACS_WEEKDAYS.indexOf(ACS_normalizeWeekday(weekday));

  if (base < 0) {
    return ACS_normalizeWeekday(weekday);
  }

  return ACS_WEEKDAYS[(base + dayOffset + 7) % 7];
}

function ACS_addMinutesToDayTime(weekday, timeHHMM, addMinutes = 0) {
  const totalMinutes =
    ACS_minutesFromHHMM(timeHHMM) + Number(addMinutes || 0);

  const dayOffset = Math.floor(totalMinutes / 1440);
  const minuteOfDay = ((totalMinutes % 1440) + 1440) % 1440;

  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");

  return {
    weekday: ACS_shiftWeekday(weekday, dayOffset),
    time_local: `${hours}:${minutes}`
  };
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

function ACS_buildSlotMovements({
  origin,
  destination,
  selectedDays,
  departure,
  blockTimeMin,
  turnaroundMin,
  flightNumberOut,
  flightNumberIn
}) {
  const movements = [];

  for (const dayRaw of selectedDays) {
    const weekday = ACS_normalizeWeekday(dayRaw);

    const outboundDeparture = {
      weekday,
      time_local: departure
    };

    const outboundArrival = ACS_addMinutesToDayTime(
      weekday,
      departure,
      blockTimeMin
    );

    const inboundDeparture = ACS_addMinutesToDayTime(
      outboundArrival.weekday,
      outboundArrival.time_local,
      turnaroundMin
    );

    const inboundArrival = ACS_addMinutesToDayTime(
      inboundDeparture.weekday,
      inboundDeparture.time_local,
      blockTimeMin
    );

    movements.push(
      {
        airport_icao: origin,
        movement_type: "DEP",
        weekday: outboundDeparture.weekday,
        time_local: outboundDeparture.time_local,
        origin,
        destination,
        flight_number: flightNumberOut
      },
      {
        airport_icao: destination,
        movement_type: "ARR",
        weekday: outboundArrival.weekday,
        time_local: outboundArrival.time_local,
        origin,
        destination,
        flight_number: flightNumberOut
      },
      {
        airport_icao: destination,
        movement_type: "DEP",
        weekday: inboundDeparture.weekday,
        time_local: inboundDeparture.time_local,
        origin: destination,
        destination: origin,
        flight_number: flightNumberIn
      },
      {
        airport_icao: origin,
        movement_type: "ARR",
        weekday: inboundArrival.weekday,
        time_local: inboundArrival.time_local,
        origin: destination,
        destination: origin,
        flight_number: flightNumberIn
      }
    );
  }

  return movements;
}

function ACS_sortSlotMovementsForLocking(movements) {
  return [...(movements || [])].sort((a, b) => {
    const left = [
      a.airport_icao,
      a.weekday,
      a.time_local,
      a.movement_type,
      a.flight_number
    ].map(v => String(v || "")).join("|");

    const right = [
      b.airport_icao,
      b.weekday,
      b.time_local,
      b.movement_type,
      b.flight_number
    ].map(v => String(v || "")).join("|");

    return left.localeCompare(right);
  });
}

/* ============================================================
   ACS AIRCRAFT WEEKLY ROTATION AUTHORITY
   ------------------------------------------------------------
   An aircraft may operate multiple routes when their complete
   rotations do not overlap.

   Occupied time:
   OUT flight + turnaround + IN flight + final turnaround.
   ============================================================ */

const ACS_WEEK_MINUTES = 7 * 1440;

function ACS_parseSelectedDays(value) {
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .map(ACS_normalizeWeekday)
        .filter(day => ACS_WEEKDAYS.includes(day))
    )];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return ACS_parseSelectedDays(parsed);
      }
    } catch {
      return [...new Set(
        value
          .split(",")
          .map(ACS_normalizeWeekday)
          .filter(day => ACS_WEEKDAYS.includes(day))
      )];
    }
  }

  return [];
}

function ACS_buildWeeklyRotationIntervals({
  selectedDays,
  departure,
  blockTimeMin,
  turnaroundMin
}) {
  const durationMin =
    (Number(blockTimeMin || 0) * 2)
    + (Number(turnaroundMin || 0) * 2);

  if (
    !ACS_isValidHHMM(departure)
    || !Number.isFinite(durationMin)
    || durationMin <= 0
  ) {
    return [];
  }

  return ACS_parseSelectedDays(selectedDays).map(day => ({
    day,
    departure,
    start_abs_min:
      (ACS_dayIndex(day) * 1440)
      + ACS_minutesFromHHMM(departure),
    duration_min: durationMin
  }));
}

function ACS_weeklyIntervalsOverlap(left, right) {
  for (const weekShift of [
    -ACS_WEEK_MINUTES,
    0,
    ACS_WEEK_MINUTES
  ]) {
    const rightStart =
      Number(right.start_abs_min) + weekShift;

    const leftEnd =
      Number(left.start_abs_min)
      + Number(left.duration_min);

    const rightEnd =
      rightStart
      + Number(right.duration_min);

    if (
      Number(left.start_abs_min) < rightEnd
      && rightStart < leftEnd
    ) {
      return true;
    }
  }

  return false;
}

function ACS_findInternalRotationConflict(intervals) {
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < intervals.length;
      rightIndex += 1
    ) {
      if (
        ACS_weeklyIntervalsOverlap(
          intervals[leftIndex],
          intervals[rightIndex]
        )
      ) {
        return {
          left: intervals[leftIndex],
          right: intervals[rightIndex]
        };
      }
    }
  }

  return null;
}

/* ============================================================
   POSTGRESQL WORLD TIME AUTHORITY
   ============================================================ */

async function ACS_getOfficialSimTime(client) {
  const result = await client.query(
    `
    SELECT
      id,
      status,
      sim_start,
      sim_end,
      acs_get_current_sim_time() AS current_sim_time
    FROM public.acs_world
    WHERE id = 1
    LIMIT 1
    `
  );

  if (!result.rows.length) {
    const error = new Error("ACS_WORLD_NOT_FOUND");
    error.code = "ACS_WORLD_NOT_FOUND";
    throw error;
  }

  const world = result.rows[0];
  const currentSimTime = new Date(world.current_sim_time);

  if (Number.isNaN(currentSimTime.getTime())) {
    const error = new Error("ACS_CURRENT_SIM_TIME_INVALID");
    error.code = "ACS_CURRENT_SIM_TIME_INVALID";
    throw error;
  }

  const simYear = currentSimTime.getUTCFullYear();

  if (simYear < 1940 || simYear > 2030) {
    const error = new Error("ACS_SIM_YEAR_OUT_OF_RANGE");
    error.code = "ACS_SIM_YEAR_OUT_OF_RANGE";
    throw error;
  }

  return {
    world_id: Number(world.id),
    world_status: ACS_normalizeText(world.status).toUpperCase(),
    current_sim_time_iso: currentSimTime.toISOString(),
    sim_year: simYear,
    authority: "POSTGRESQL_TIME_AUTHORITY"
  };
}

/* ============================================================
   ACS GLOBAL PASSENGER MARKET AUTHORITY
   ------------------------------------------------------------
   - PostgreSQL canonical time
   - Global airport-pair demand
   - Independent from airline and aircraft
   - Directional Y / C / F demand
   ============================================================ */

async function ACS_getCanonicalPassengerMarket(
  client,
  originIcao,
  destinationIcao
) {
  const origin = ACS_normalizeIcao(originIcao);
  const destination = ACS_normalizeIcao(destinationIcao);

  if (!origin || !destination) {
    const error = new Error("ORIGIN_DESTINATION_REQUIRED");
    error.code = "ORIGIN_DESTINATION_REQUIRED";
    throw error;
  }

  if (origin === destination) {
    const error = new Error("ORIGIN_DESTINATION_CANNOT_MATCH");
    error.code = "ORIGIN_DESTINATION_CANNOT_MATCH";
    throw error;
  }

  const result = await client.query(
    `
    WITH active_model AS MATERIALIZED (
      SELECT
        id AS model_id,
        version_code AS model_version
      FROM public.acs_passenger_demand_models
      WHERE model_status = 'ACTIVE'
      LIMIT 1
    ),
    clock AS MATERIALIZED (
      SELECT
        acs_get_current_sim_time()::timestamp AS sim_time
    )
    SELECT
      active_model.model_id,
      active_model.model_version,
      clock.sim_time AS current_sim_time,
      daily.origin_icao,
      daily.destination_icao,
      daily.sim_date,
      daily.sim_year,
      daily.period_code,
      daily.market_scope,
      daily.distance_nm,
      daily.weekday_iso,
      daily.day_weight,
      daily.daily_y,
      daily.daily_c,
      daily.daily_f,
      daily.daily_total,
      weekly.weekly_y,
      weekly.weekly_c,
      weekly.weekly_f,
      weekly.weekly_total
    FROM active_model
    CROSS JOIN clock
    CROSS JOIN LATERAL
      public.acs_calculate_passenger_demand_daily(
        $1,
        $2,
        clock.sim_time
      ) daily
    CROSS JOIN LATERAL
      public.acs_calculate_passenger_demand(
        $1,
        $2,
        clock.sim_time
      ) weekly
    `,
    [origin, destination]
  );

  if (!result.rows.length) {
    const error = new Error(
      `PASSENGER_MARKET_NOT_FOUND_${origin}_${destination}`
    );

    error.code = "PASSENGER_MARKET_NOT_FOUND";
    error.origin_icao = origin;
    error.destination_icao = destination;
    throw error;
  }

  return {
    ...result.rows[0],
    authority: "POSTGRESQL_PASSENGER_MARKET_AUTHORITY"
  };
}

/* ============================================================
   AIRPORT HISTORICAL AUTHORITY
   ============================================================ */

async function ACS_getAirportHistoricalAuthority(
  client,
  airportIcao,
  simYear
) {
  const icao = ACS_normalizeIcao(airportIcao);

  const result = await client.query(
    `
    SELECT
      ac.id AS airport_catalog_id,
      ac.icao,
      ac.city,
      ac.country,
      ac.continent,

      ac.slot_capacity AS slot_capacity_base,
      ahp.slot_capacity::INTEGER AS slot_capacity,

      ac.slot_cost_usd AS slot_cost_base_usd,
      ahp.slot_cost_usd::NUMERIC(12,2) AS slot_cost_usd,

     ac.landing_fee_usd AS landing_fee_base_usd,
     ahp.landing_fee_usd::NUMERIC(12,2) AS landing_fee_usd,

      ac.runway_m AS runway_m_base,
      ahp.runway_m::INTEGER AS runway_m,

      ac.category AS category_base,
      ahp.category,

      ac.aircraft_limit AS aircraft_limit_base,
      ahp.aircraft_limit,

      ahp.id AS historical_profile_id,
      ahp.era_from,
      ahp.era_to,
      ahp.era_label,
      ahp.expansion_stage,
      ahp.airport_status,
      ahp.source AS historical_profile_source

    FROM public.airport_catalog ac

    LEFT JOIN LATERAL (
      SELECT hp.*
      FROM public.airport_historical_profiles hp
      WHERE hp.airport_icao = ac.icao
        AND $2::INTEGER BETWEEN hp.era_from AND hp.era_to
      ORDER BY hp.era_from DESC
      LIMIT 1
    ) ahp
      ON TRUE

    WHERE ac.icao = $1
    LIMIT 1
    `,
    [icao, simYear]
  );

  if (!result.rows.length) {
    const error = new Error(`AIRPORT_NOT_FOUND_${icao}`);
    error.code = "AIRPORT_NOT_FOUND";
    error.airport_icao = icao;
    throw error;
  }

  const airport = result.rows[0];

  if (!airport.historical_profile_id) {
    const error = new Error(
      `AIRPORT_HISTORICAL_PROFILE_NOT_FOUND_${icao}_${simYear}`
    );

    error.code = "AIRPORT_HISTORICAL_PROFILE_NOT_FOUND";
    error.airport_icao = icao;
    error.sim_year = simYear;
    throw error;
  }

  const slotCapacity = Number(airport.slot_capacity);
  const slotCostUsd = Number(airport.slot_cost_usd);

  if (!Number.isInteger(slotCapacity) || slotCapacity < 0) {
    const error = new Error(`INVALID_HISTORICAL_SLOT_CAPACITY_${icao}`);
    error.code = "INVALID_HISTORICAL_SLOT_CAPACITY";
    throw error;
  }

  if (!Number.isFinite(slotCostUsd) || slotCostUsd < 0) {
    const error = new Error(`INVALID_HISTORICAL_SLOT_COST_${icao}`);
    error.code = "INVALID_HISTORICAL_SLOT_COST";
    throw error;
  }

  return {
    ...airport,
    slot_capacity: slotCapacity,
    slot_cost_usd: ACS_roundMoney(slotCostUsd),
    sim_year: simYear,
    authority: "AIRPORT_HISTORICAL_PROFILES"
  };
}

/* ============================================================
   FLIGHT NUMBER AUTHORITY
   ============================================================ */

async function ACS_getAirlineIata(client, airlineId) {
  const result = await client.query(
    `
    SELECT
      airline_id,
      airline_name,
      UPPER(TRIM(iata)) AS iata
    FROM public.airlines
    WHERE airline_id = $1
    LIMIT 1
    `,
    [airlineId]
  );

  if (!result.rows.length) {
    const error = new Error("AIRLINE_NOT_FOUND");
    error.code = "AIRLINE_NOT_FOUND";
    throw error;
  }

  const airline = result.rows[0];
  const iata = ACS_normalizeText(airline.iata).toUpperCase();

  if (!/^[A-Z0-9]{2}$/.test(iata)) {
    const error = new Error("AIRLINE_IATA_NOT_CONFIGURED");
    error.code = "AIRLINE_IATA_NOT_CONFIGURED";
    throw error;
  }

  return {
    airline_id: Number(airline.airline_id),
    airline_name: airline.airline_name,
    iata
  };
}

async function ACS_flightNumberExists(client, airlineId, outNumber, inNumber) {
  const result = await client.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM public.flight_number_allocations fna
      WHERE fna.airline_id = $1
        AND fna.flight_number IN ($2, $3)

      UNION ALL

      SELECT 1
      FROM public.route_plans rp
      WHERE rp.airline_id = $1
        AND (
          rp.flight_number_out IN ($2, $3)
          OR rp.flight_number_in IN ($2, $3)
        )

      UNION ALL

      SELECT 1
      FROM public.schedule_items si
      WHERE si.airline_id = $1
        AND (
          si.flight_number IN ($2, $3)
          OR si.paired_flight_number IN ($2, $3)
        )
    ) AS exists
    `,
    [airlineId, outNumber, inNumber]
  );

  return result.rows[0]?.exists === true;
}

async function ACS_allocateFlightNumberPair(client, airlineId) {
  const airline = await ACS_getAirlineIata(client, airlineId);

      await client.query(
      `
      SELECT pg_advisory_xact_lock(hashtext($1))
      `,
      [`ACS_ROUTE_PLAN_CREATE|${airlineId}`]
    );

  await client.query(
    `
    INSERT INTO public.flight_number_sequences (
      airline_id,
      iata_code,
      last_number,
      created_at,
      updated_at
    )
    VALUES ($1, $2, 0, NOW(), NOW())
    ON CONFLICT (airline_id, iata_code)
    DO NOTHING
    `,
    [airlineId, airline.iata]
  );

  const sequenceResult = await client.query(
    `
    SELECT
      id,
      airline_id,
      iata_code,
      last_number
    FROM public.flight_number_sequences
    WHERE airline_id = $1
      AND iata_code = $2
    FOR UPDATE
    `,
    [airlineId, airline.iata]
  );

  if (!sequenceResult.rows.length) {
    const error = new Error("FLIGHT_NUMBER_SEQUENCE_NOT_FOUND");
    error.code = "FLIGHT_NUMBER_SEQUENCE_NOT_FOUND";
    throw error;
  }

  let outboundNumeric = Math.max(
    100,
    Number(sequenceResult.rows[0].last_number || 0) + 1
  );

  if (outboundNumeric % 2 !== 0) {
    outboundNumeric += 1;
  }

  let outbound;
  let inbound;
  let attempts = 0;

  while (attempts < 5000) {
    outbound = `${airline.iata}${outboundNumeric}`;
    inbound = `${airline.iata}${outboundNumeric + 1}`;

    const exists = await ACS_flightNumberExists(
      client,
      airlineId,
      outbound,
      inbound
    );

    if (!exists) {
      break;
    }

    outboundNumeric += 2;
    attempts += 1;
  }

  if (!outbound || !inbound || attempts >= 5000) {
    const error = new Error("FLIGHT_NUMBER_RANGE_EXHAUSTED");
    error.code = "FLIGHT_NUMBER_RANGE_EXHAUSTED";
    throw error;
  }

  await client.query(
    `
    UPDATE public.flight_number_sequences
    SET
      iata_code = $2,
      last_number = $3,
      updated_at = NOW()
    WHERE airline_id = $1
      AND iata_code = $2
    `,
    [airlineId, airline.iata, outboundNumeric + 1]
  );

  return {
    iata_code: airline.iata,
    flight_number_out: outbound,
    flight_number_in: inbound,
    outbound_numeric: outboundNumeric,
    inbound_numeric: outboundNumeric + 1,
    authority: "POSTGRESQL_FLIGHT_NUMBER_AUTHORITY"
  };
}

async function ACS_storeFlightNumberAllocations(
  client,
  {
    airlineId,
    routePlanId,
    iataCode,
    flightNumberOut,
    flightNumberIn,
    origin,
    destination
  }
) {
  const result = await client.query(
    `
    INSERT INTO public.flight_number_allocations (
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
    )
    VALUES
      (
        gen_random_uuid()::TEXT,
        $1,
        $2,
        NULL,
        $3,
        $4,
        'OUTBOUND',
        $6,
        $7,
        NOW(),
        NOW()
      ),
      (
        gen_random_uuid()::TEXT,
        $1,
        $2,
        NULL,
        $3,
        $5,
        'INBOUND',
        $7,
        $6,
        NOW(),
        NOW()
      )
    RETURNING *
    `,
    [
      airlineId,
      routePlanId,
      iataCode,
      flightNumberOut,
      flightNumberIn,
      origin,
      destination
    ]
  );

  return result.rows;
}

/* ============================================================
   SLOT AUTHORITY
   ============================================================ */

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
    FROM public.airport_slot_bookings
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

/* ============================================================
   GET /v1/routes/passenger-demand
   ------------------------------------------------------------
   Returns the current canonical market in both directions.
   The same PostgreSQL simulation instant is used throughout.
   ============================================================ */

router.get(
  "/routes/passenger-demand",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const origin =
        ACS_normalizeIcao(req.query.origin);

      const destination =
        ACS_normalizeIcao(req.query.destination);

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

      const result = await client.query(
        `
        WITH active_model AS MATERIALIZED (
          SELECT
            id AS model_id,
            version_code AS model_version
          FROM public.acs_passenger_demand_models
          WHERE model_status = 'ACTIVE'
          LIMIT 1
        ),
        clock AS MATERIALIZED (
          SELECT
            acs_get_current_sim_time()::timestamp
              AS sim_time
        ),
        directional_markets AS (
          SELECT
            1 AS direction_order,
            'OUTBOUND'::text AS direction,

            active_model.model_id,
            active_model.model_version,

            clock.sim_time AS current_sim_time,

            daily.*,

            weekly.weekly_y,
            weekly.weekly_c,
            weekly.weekly_f,

            week_data.week_days

          FROM active_model
          CROSS JOIN clock

          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand_daily(
              $1,
              $2,
              clock.sim_time
            ) daily

          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand(
              $1,
              $2,
              clock.sim_time
            ) weekly

          CROSS JOIN LATERAL (
            SELECT
              COALESCE(
                jsonb_agg(
                  to_jsonb(week_day)
                  ORDER BY week_day.weekday_iso
                ),
                '[]'::jsonb
              ) AS week_days

            FROM generate_series(0, 6)
              AS week_offset(day_offset)

            CROSS JOIN LATERAL
              public.acs_calculate_passenger_demand_daily(
                $1,
                $2,
                (
                  date_trunc(
                    'week',
                    clock.sim_time
                  )
                  +
                  week_offset.day_offset
                    * interval '1 day'
                )::timestamp
              ) week_day
          ) week_data

          UNION ALL

          SELECT
            2 AS direction_order,
            'INBOUND'::text AS direction,

            active_model.model_id,
            active_model.model_version,

            clock.sim_time AS current_sim_time,

            daily.*,

            weekly.weekly_y,
            weekly.weekly_c,
            weekly.weekly_f,

            week_data.week_days

          FROM active_model
          CROSS JOIN clock

          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand_daily(
              $2,
              $1,
              clock.sim_time
            ) daily

          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand(
              $2,
              $1,
              clock.sim_time
            ) weekly

          CROSS JOIN LATERAL (
            SELECT
              COALESCE(
                jsonb_agg(
                  to_jsonb(week_day)
                  ORDER BY week_day.weekday_iso
                ),
                '[]'::jsonb
              ) AS week_days

            FROM generate_series(0, 6)
              AS week_offset(day_offset)

            CROSS JOIN LATERAL
              public.acs_calculate_passenger_demand_daily(
                $2,
                $1,
                (
                  date_trunc(
                    'week',
                    clock.sim_time
                  )
                  +
                  week_offset.day_offset
                    * interval '1 day'
                )::timestamp
              ) week_day
          ) week_data
        )

        SELECT *
        FROM directional_markets
        ORDER BY direction_order
        `,
        [origin, destination]
      );

      const outbound = result.rows.find(
        row => row.direction === "OUTBOUND"
      );

      const inbound = result.rows.find(
        row => row.direction === "INBOUND"
      );

      if (!outbound || !inbound) {
        return res.status(404).json({
          ok: false,
          error: "PASSENGER_MARKET_NOT_FOUND",
          origin,
          destination
        });
      }

      const outboundWeek =
        Array.isArray(outbound.week_days)
          ? outbound.week_days
          : [];

      const inboundWeek =
        Array.isArray(inbound.week_days)
          ? inbound.week_days
          : [];

      delete outbound.week_days;
      delete inbound.week_days;

      return res.json({
        ok: true,
        endpoint:
          "ACS_GLOBAL_PASSENGER_DEMAND",
        version:
          outbound.model_version,
        authority:
          "POSTGRESQL_PASSENGER_MARKET_AUTHORITY",
        current_sim_time:
          outbound.current_sim_time,
        origin,
        destination,

        outbound,
        inbound,

        outbound_week: outboundWeek,
        inbound_week: inboundWeek
      });

    } catch (error) {
      console.error(
        "ACS PASSENGER DEMAND ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.code ||
          "PASSENGER_DEMAND_QUERY_FAILED",
        details: error.message
      });

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   GET /v1/routes/passenger-demand/markets
   ------------------------------------------------------------
   Global passenger markets for one origin and one continent.

   Authority:
   - PostgreSQL simulation time
   - Active ACS passenger-demand model
   - Historical airport operational authority
   - No airline or aircraft allocation
   ============================================================ */

router.get(
  "/routes/passenger-demand/markets",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const origin = ACS_normalizeIcao(req.query.origin);
      const continent = ACS_normalizeText(req.query.continent);

      if (!origin) {
        return res.status(400).json({
          ok: false,
          error: "ORIGIN_REQUIRED"
        });
      }

      if (!continent || continent.length > 64) {
        return res.status(400).json({
          ok: false,
          error: "VALID_CONTINENT_REQUIRED"
        });
      }

      const result = await client.query(
        `
        WITH active_model AS MATERIALIZED (
          SELECT
            id AS model_id,
            version_code AS model_version
          FROM public.acs_passenger_demand_models
          WHERE model_status = 'ACTIVE'
          LIMIT 1
        ),
        clock AS MATERIALIZED (
          SELECT
            acs_get_current_sim_time()::timestamp AS sim_time
        ),
        origin_airport AS MATERIALIZED (
          SELECT
            icao,
            city,
            country,
            continent,
            region,
            category
          FROM public.v_acs_airport_authority_current
          WHERE UPPER(TRIM(icao)) = $1
            AND passenger_route_allowed = TRUE
          LIMIT 1
        ),
        destinations AS MATERIALIZED (
          SELECT
            airport.icao,
            airport.iata,
            airport.city,
            airport.country,
            airport.continent,
            airport.region,
            airport.category
          FROM public.v_acs_airport_authority_current airport
          WHERE airport.passenger_route_allowed = TRUE
            AND UPPER(TRIM(airport.icao)) <> $1
            AND LOWER(TRIM(airport.continent)) =
                LOWER(TRIM($2))
        ),
        markets AS (
          SELECT
            destination.icao AS destination_icao,
            destination.iata AS destination_iata,
            destination.city AS destination_city,
            destination.country AS destination_country,
            destination.continent AS destination_continent,
            destination.region AS destination_region,
            destination.category AS destination_category,

            active_model.model_id,
            active_model.model_version,
            clock.sim_time AS current_sim_time,

            daily.sim_date,
            daily.sim_year,
            daily.period_code,
            daily.market_scope,
            daily.distance_nm,
            daily.weekday_iso,
            daily.day_weight,
            daily.daily_y,
            daily.daily_c,
            daily.daily_f,
            daily.daily_total,

            weekly.weekly_y,
            weekly.weekly_c,
            weekly.weekly_f,
            weekly.weekly_total,

            ROUND(
              weekly.weekly_total::numeric / 7,
              2
            ) AS average_daily

          FROM destinations destination
          CROSS JOIN active_model
          CROSS JOIN clock
          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand_daily(
              $1,
              destination.icao,
              clock.sim_time
            ) daily
          CROSS JOIN LATERAL
            public.acs_calculate_passenger_demand(
              $1,
              destination.icao,
              clock.sim_time
            ) weekly
        )
        SELECT
          origin_airport.icao AS origin_icao,
          origin_airport.city AS origin_city,
          origin_airport.country AS origin_country,
          origin_airport.continent AS origin_continent,
          origin_airport.region AS origin_region,
          origin_airport.category AS origin_category,
          markets.*
        FROM origin_airport
        CROSS JOIN markets
        ORDER BY
          markets.weekly_total DESC,
          markets.destination_icao
        `,
        [origin, continent]
      );

      if (!result.rows.length) {
        const originResult = await client.query(
          `
          SELECT
            icao
          FROM public.v_acs_airport_authority_current
          WHERE UPPER(TRIM(icao)) = $1
            AND passenger_route_allowed = TRUE
          LIMIT 1
          `,
          [origin]
        );

        if (!originResult.rows.length) {
          return res.status(404).json({
            ok: false,
            error: "ORIGIN_NOT_AVAILABLE_FOR_PASSENGER_ROUTES",
            origin
          });
        }
      }

      const firstMarket = result.rows[0] || null;

      const marketsWithDemand = result.rows.filter(
        market => Number(market.weekly_total || 0) > 0
      ).length;

      return res.json({
        ok: true,
        endpoint: "ACS_GLOBAL_PASSENGER_MARKETS",
        version:
          firstMarket?.model_version || null,
        authority:
          "POSTGRESQL_PASSENGER_MARKET_AUTHORITY",
        current_sim_time:
          firstMarket?.current_sim_time || null,
        origin,
        continent,
        summary: {
          evaluated_markets: result.rows.length,
          markets_with_demand: marketsWithDemand,
          zero_demand_markets:
            result.rows.length - marketsWithDemand
        },
        markets: result.rows
      });

    } catch (error) {
      console.error(
        "ACS PASSENGER MARKETS ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.code ||
          "PASSENGER_MARKETS_QUERY_FAILED",
        details: error.message
      });

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   🟦 GET NEXT FLIGHT NUMBER PAIR — BACKEND AUTHORITY
   ------------------------------------------------------------
   Route:
   GET /v1/routes/flight-number-preview

   Purpose:
   - Read official airline IATA from PostgreSQL
   - Preview next available OUT / IN pair
   - No localStorage
   - Does not reserve or increment sequence
   - Final allocation remains transactional on POST /routes/plans
   ============================================================ */

router.get(
  "/routes/flight-number-preview",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const airlineId = Number(req.airline_id);

      if (!Number.isInteger(airlineId) || airlineId <= 0) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      const airline = await ACS_getAirlineIata(
        client,
        airlineId
      );

      const sequenceResult = await client.query(
        `
        SELECT
          last_number
        FROM public.flight_number_sequences
        WHERE airline_id = $1
          AND iata_code = $2
        LIMIT 1
        `,
        [
          airlineId,
          airline.iata
        ]
      );

      let outboundNumeric = Math.max(
        100,
        Number(
          sequenceResult.rows[0]?.last_number || 0
        ) + 1
      );

      if (outboundNumeric % 2 !== 0) {
        outboundNumeric += 1;
      }

      let flightNumberOut = "";
      let flightNumberIn = "";
      let attempts = 0;

      while (attempts < 5000) {
        flightNumberOut =
          `${airline.iata}${outboundNumeric}`;

        flightNumberIn =
          `${airline.iata}${outboundNumeric + 1}`;

        const exists = await ACS_flightNumberExists(
          client,
          airlineId,
          flightNumberOut,
          flightNumberIn
        );

        if (!exists) {
          break;
        }

        outboundNumeric += 2;
        attempts += 1;
      }

      if (
        !flightNumberOut ||
        !flightNumberIn ||
        attempts >= 5000
      ) {
        return res.status(409).json({
          ok: false,
          error: "FLIGHT_NUMBER_RANGE_EXHAUSTED"
        });
      }

      return res.json({
        ok: true,
        endpoint: "ACS_FLIGHT_NUMBER_PREVIEW",
        version: "v1.0",
        authority: "POSTGRESQL_FLIGHT_NUMBER_AUTHORITY",
        airline_id: airlineId,
        iata_code: airline.iata,
        flight_number_out: flightNumberOut,
        flight_number_in: flightNumberIn,
        display: `${flightNumberOut} ➜ ${flightNumberIn}`
      });

    } catch (error) {
      console.error(
        "ACS FLIGHT NUMBER PREVIEW ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.code ||
          "FLIGHT_NUMBER_PREVIEW_FAILED",
        details: error.message
      });

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   POST /v1/routes/plans
   ============================================================ */

async function ACS_createRoutePlanOnce(req, res) {
   
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const airlineId = Number(req.airline_id);
    const body = req.body || {};

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const origin = ACS_normalizeIcao(body.origin);
    const destination = ACS_normalizeIcao(body.destination);
    let aircraftId = Number(body.aircraft_id || body.aircraftId || 0);

    const selectedDaysRaw = Array.isArray(body.selected_days)
      ? body.selected_days
      : Array.isArray(body.days)
        ? body.days
        : [];

    const selectedDays = [...new Set(
      selectedDaysRaw
        .map(ACS_normalizeWeekday)
        .filter(day => ACS_WEEKDAYS.includes(day))
    )];

    const departure = ACS_normalizeText(body.departure);
    const arrival = ACS_normalizeText(body.arrival);
    const routeType = ACS_normalizeText(
      body.route_type || "PASSENGER"
    ).toUpperCase();

    const distanceNm = Math.round(
      Number(body.distance_nm || body.distanceNM || 0)
    );

    const blockTimeMin = Math.round(
      Number(body.block_time_min || body.blockTimeMin || 0)
    );

    const turnaroundMin = Math.round(
      Number(body.turnaround_min || body.turnaroundMin || 0)
    );

    const totalRotationMin = Math.round(
      Number(body.total_rotation_min || body.totalRotationMin || 0)
    );

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

    if (!Number.isInteger(aircraftId) || aircraftId <= 0) {
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

    if (!Number.isFinite(distanceNm) || distanceNm <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_DISTANCE_NM"
      });
    }

    if (!Number.isFinite(blockTimeMin) || blockTimeMin <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_BLOCK_TIME_MIN"
      });
    }

    if (!Number.isFinite(turnaroundMin) || turnaroundMin < 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_TURNAROUND_MIN"
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

        await client.query(
      `
      SELECT pg_advisory_xact_lock(hashtext($1))
      `,
      [`ACS_ROUTE_PLAN_CREATE|${airlineId}`]
    );

    const financeResult = await client.query(
  `
  SELECT
    airline_id,
    capital,
    expenses,
    cost_slots
  FROM public.company_finance
  WHERE airline_id = $1
  FOR UPDATE
  `,
  [airlineId]
);

if (!financeResult.rows.length) {
  await client.query("ROLLBACK");
  transactionStarted = false;

  return res.status(404).json({
    ok: false,
    error: "COMPANY_FINANCE_NOT_FOUND"
  });
}

const currentCapital =
  Number(financeResult.rows[0].capital || 0);
     
    const officialTime = await ACS_getOfficialSimTime(client);

    const originAirport = await ACS_getAirportHistoricalAuthority(
      client,
      origin,
      officialTime.sim_year
    );

    const destinationAirport = await ACS_getAirportHistoricalAuthority(
      client,
      destination,
      officialTime.sim_year
    );

    const flightNumbers = await ACS_allocateFlightNumberPair(
      client,
      airlineId
    );

    const flightNumberOut = flightNumbers.flight_number_out;
    const flightNumberIn = flightNumbers.flight_number_in;

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

      FROM public.aircraft_fleet af

      LEFT JOIN public.aircraft_maintenance_status ams
        ON ams.aircraft_id = af.id

      LEFT JOIN public.aircraft_catalog ac
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
      transactionStarted = false;

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_FOUND_OR_NOT_OWNED"
      });
    }

    let aircraft = aircraftResult.rows[0];

    const aircraftStatus =
      ACS_normalizeText(aircraft.status).toUpperCase();

    const operationalStatus =
      ACS_normalizeText(aircraft.operational_status).toUpperCase();

    const maintenanceStatus =
      ACS_normalizeText(aircraft.maintenance_status).toUpperCase();

    const maintenanceControlStatus =
      ACS_normalizeText(aircraft.maintenance_control_status).toUpperCase();

    const serviceable =
      maintenanceStatus === "SERVICEABLE"
      || maintenanceControlStatus === "SERVICEABLE";

     const routePlanningBlockedStatuses = new Set([
     "SOLD", 
     "SCRAPPED",
     "RETIRED",
     "PENDING_DELIVERY",
     "CANCELLED"
    ]);

if (routePlanningBlockedStatuses.has(aircraftStatus)) {
       
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_NOT_DISPATCHABLE",
        aircraft: {
          id: aircraft.id,
          registration: aircraft.registration,
          status: aircraft.status,
          operational_status: aircraft.operational_status,
          maintenance_status: aircraft.maintenance_status,
          maintenance_control_status:
            aircraft.maintenance_control_status
        }
      });
    }

    const aircraftRangeNm = Math.round(
    Number(
    aircraft.range_nm
    || body.aircraft_range_nm
    || body.aircraftRangeNm
    || 0
    )
   );     
     
    const speedKts = Math.round(
      Number(
        aircraft.speed_kts
        || body.speed_kts
        || body.speedKts
        || 0
      )
    );

    if (!Number.isFinite(aircraftRangeNm) || aircraftRangeNm <= 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_RANGE_NOT_AVAILABLE"
      });
    }

    const rangeMarginNm = aircraftRangeNm - distanceNm;

    if (rangeMarginNm < 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

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

    /* ============================================================
   AIRCRAFT SCHEDULE CONFLICT AUTHORITY
   ============================================================ */

const proposedIntervals =
  ACS_buildWeeklyRotationIntervals({
    selectedDays,
    departure,
    blockTimeMin,
    turnaroundMin
  });

if (!proposedIntervals.length) {
  await client.query("ROLLBACK");
  transactionStarted = false;

  return res.status(400).json({
    ok: false,
    error: "INVALID_PROPOSED_ROTATION"
  });
}

/*
  Also prevent the new route from overlapping itself.
  This matters when a long rotation crosses into the next
  selected operating day.
*/

const internalConflict =
  ACS_findInternalRotationConflict(proposedIntervals);

if (internalConflict) {
  await client.query("ROLLBACK");
  transactionStarted = false;

  return res.status(409).json({
    ok: false,
    error: "AIRCRAFT_SCHEDULE_CONFLICT",
    conflict_type: "PROPOSED_ROUTE_INTERNAL_OVERLAP",
    aircraft: {
      id: aircraft.id,
      registration: aircraft.registration
    },
    proposed_rotation: internalConflict
  });
}


    const slotMovements = ACS_sortSlotMovementsForLocking(
  ACS_buildSlotMovements({
    origin,
    destination,
    selectedDays,
    departure,
    blockTimeMin,
    turnaroundMin,
    flightNumberOut,
    flightNumberIn
  })
);
     
    if (!slotMovements.length) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        ok: false,
        error: "NO_SLOT_MOVEMENTS_BUILT"
      });
    }

    for (const movement of slotMovements) {
      await ACS_lockSlotKey(client, movement);

      const used = await ACS_getReservedSlotCount(client, movement);

      const capacity =
        movement.airport_icao === origin
          ? originAirport.slot_capacity
          : destinationAirport.slot_capacity;

      if (used >= capacity) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error: "SLOT_UNAVAILABLE",
          slot: {
            airport_icao: movement.airport_icao,
            weekday: movement.weekday,
            time_local: movement.time_local,
            movement_type: movement.movement_type,
            used,
            max: capacity,
            free: Math.max(0, capacity - used)
          }
        });
      }
    }

    const originSlotFee = ACS_roundMoney(originAirport.slot_cost_usd);
    const destinationSlotFee =
    
    ACS_roundMoney(destinationAirport.slot_cost_usd);

    const totalSlotPrice = Math.round(
      (
        (originSlotFee * 2)
        + (destinationSlotFee * 2)
      ) * selectedDays.length
    );

    if (currentCapital < totalSlotPrice) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        ok: false,
        error: "INSUFFICIENT_CAPITAL_FOR_AIRPORT_SLOT_FEE",
        finance: {
          capital: currentCapital,
          required: totalSlotPrice,
          missing: ACS_roundMoney(totalSlotPrice - currentCapital)
        }
      });
    }

    const capabilityCode = "DISPATCHABLE";
    const operationalLimitation = "NONE";

    const insertRouteResult = await client.query(
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
        'ACS_ROUTE_PLANS_BACKEND_AUTHORITY_V2_1',
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
        ACS_normalizeText(
          aircraft.model_key || body.model_key || body.modelKey
        ).toUpperCase(),
        ACS_normalizeText(
          aircraft.aircraft_name
          || body.aircraft
          || body.aircraftName
        ),
        aircraftId,
        ACS_normalizeText(
          aircraft.registration || body.registration
        ),
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

    let routePlan = insertRouteResult.rows[0];

    const flightNumberAllocations =
      await ACS_storeFlightNumberAllocations(
        client,
        {
          airlineId,
          routePlanId: routePlan.id,
          iataCode: flightNumbers.iata_code,
          flightNumberOut,
          flightNumberIn,
          origin,
          destination
        }
      );

    const insertedSlots = [];

    for (const movement of slotMovements) {
      const result = await client.query(
        `
        INSERT INTO public.airport_slot_bookings (
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
          reserved_sim_time,
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
          'ACS_ROUTE_PLAN_SLOT_RESERVATION_V2_1',
          acs_get_current_sim_time(),
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
          movement.origin,
          movement.destination,
          movement.flight_number,
          routePlan.registration,
          routePlan.model_key,
        ]
      );

      insertedSlots.push(result.rows[0]);
    }

    const insertedScheduleItems = [];

    for (const day of selectedDays) {
      const abs = ACS_buildAbsMinutes(day, departure, arrival);

      const result = await client.query(
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
          'Created by ACS Route Plans Backend Authority v2.1',
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

      insertedScheduleItems.push(result.rows[0]);
    }

    let financeLog = null;

    if (totalSlotPrice > 0) {
  const financeLogResult = await client.query(
    `
    INSERT INTO public.finance_log (
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
      `Airport slot fee for route ${origin}-${destination} flights ${flightNumberOut}/${flightNumberIn} — ACS year ${officialTime.sim_year}`
    ]
  );

  financeLog = financeLogResult.rows[0];

  await client.query(
    `
    UPDATE public.company_finance
    SET
      capital = COALESCE(capital,0) - $2,
      expenses = COALESCE(expenses,0) + $2,
      profit = COALESCE(profit,0) - $2,
      cost_slots = COALESCE(cost_slots,0) + $2,
      updated_at = NOW()
    WHERE airline_id = $1
    `,
    [
      airlineId,
      totalSlotPrice
    ]
  );

  const updatedRouteResult = await client.query(
    `
    UPDATE public.route_plans
    SET
      origin_slot_price = $1,
      destination_slot_price = $2,
      total_slot_price = $3,
      selected_schedule_cost = $3,
      finance_applied = TRUE,
      finance_transaction_id = $4,
      updated_at = NOW()
    WHERE id = $5
    RETURNING *
    `,
    [
      originSlotFee,
      destinationSlotFee,
      totalSlotPrice,
      String(financeLog.id),
      routePlan.id
    ]
  );

  routePlan = updatedRouteResult.rows[0];
}
     
    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_ROUTE_PLAN_CREATE",
      version: "v2.1",
      message:
        "ROUTE_PLAN_CREATED_WITH_OFFICIAL_FLIGHT_NUMBERS_HISTORICAL_SLOTS_SCHEDULE_AND_FINANCE",

      simulation: {
        current_sim_time: officialTime.current_sim_time_iso,
        sim_year: officialTime.sim_year,
        authority: officialTime.authority
      },

      flight_numbers: {
        iata_code: flightNumbers.iata_code,
        outbound: flightNumberOut,
        inbound: flightNumberIn,
        authority: flightNumbers.authority,
        allocations: flightNumberAllocations
      },

      airport_authority: {
        origin: {
          icao: originAirport.icao,
          historical_profile_id:
            originAirport.historical_profile_id,
          era_from: originAirport.era_from,
          era_to: originAirport.era_to,
          era_label: originAirport.era_label,
          slot_capacity: originAirport.slot_capacity,
          slot_cost_usd: originAirport.slot_cost_usd
        },
        destination: {
          icao: destinationAirport.icao,
          historical_profile_id:
            destinationAirport.historical_profile_id,
          era_from: destinationAirport.era_from,
          era_to: destinationAirport.era_to,
          era_label: destinationAirport.era_label,
          slot_capacity: destinationAirport.slot_capacity,
          slot_cost_usd: destinationAirport.slot_cost_usd
        }
      },

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
        dep: insertedSlots.filter(
          slot => slot.movement_type === "DEP"
        ).length,
        arr: insertedSlots.filter(
          slot => slot.movement_type === "ARR"
        ).length
      }
    });

  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "ACS ROUTE PLAN ROLLBACK ERROR:",
          rollbackError
        );
      }
    }

    console.error("ACS ROUTE PLAN CREATE ERROR:", error);

    if (["40P01", "40001"].includes(String(error.code || ""))) {
     throw error;
     }
     
    const knownClientErrors = new Set([
      "AIRLINE_NOT_FOUND",
      "AIRLINE_IATA_NOT_CONFIGURED",
      "AIRPORT_NOT_FOUND",
      "AIRPORT_HISTORICAL_PROFILE_NOT_FOUND",
      "INVALID_HISTORICAL_SLOT_CAPACITY",
      "INVALID_HISTORICAL_SLOT_COST",
      "FLIGHT_NUMBER_SEQUENCE_NOT_FOUND",
      "FLIGHT_NUMBER_RANGE_EXHAUSTED",
      "ACS_WORLD_NOT_FOUND",
      "ACS_CURRENT_SIM_TIME_INVALID",
      "ACS_SIM_YEAR_OUT_OF_RANGE"
    ]);

    const status = knownClientErrors.has(error.code) ? 409 : 500;

    return res.status(status).json({
      ok: false,
      error: error.code || "ROUTE_PLAN_CREATE_FAILED",
      details: error.message
    });

    } finally {
    client.release();
  }
}

router.post("/routes/plans", requireAuth, async (req, res) => {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ACS_createRoutePlanOnce(req, res);

    } catch (error) {
      if (res.headersSent) {
        return;
      }

      const dbCode = String(error.code || "");
      const retryable = dbCode === "40P01" || dbCode === "40001";

      console.error("ACS ROUTE PLAN CREATE ATTEMPT FAILED:", {
        attempt,
        max_attempts: maxAttempts,
        retryable,
        code: dbCode || null,
        message: error.message
      });

      if (retryable && attempt < maxAttempts) {
        continue;
      }

      return res.status(retryable ? 409 : 500).json({
        ok: false,
        error:
          dbCode ||
          "ROUTE_CONFIRMATION_FAILED",
        details:
          error.message ||
          "Route confirmation failed.",
        db_code:
          dbCode || null,
        attempts:
          attempt
      });
    }
  }

  return res.status(409).json({
    ok: false,
    error: "ROUTE_CONFIRMATION_RETRY_EXHAUSTED",
    details: "Route confirmation retry limit exhausted.",
    attempts: maxAttempts
  });
});

/* ============================================================
   🟦 PUT /v1/routes/plans/:route_plan_id — EDIT ROUTE
   ------------------------------------------------------------
   Purpose:
   - Update the original route_plan
   - Replace its flight schedule_items
   - Preserve original flight numbers
   - Prevent duplicate edited routes
   ============================================================ */

router.put("/routes/plans/:route_plan_id", requireAuth, async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const airlineId = Number(req.airline_id);
    const routePlanId = Number(req.params.route_plan_id);
    const body = req.body || {};

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!Number.isInteger(routePlanId) || routePlanId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ROUTE_PLAN_ID_REQUIRED"
      });
    }

    const selectedDaysRaw = Array.isArray(body.selected_days)
      ? body.selected_days
      : Array.isArray(body.days)
        ? body.days
        : [];

    const selectedDays = [...new Set(
      selectedDaysRaw
        .map(ACS_normalizeWeekday)
        .filter(day => ACS_WEEKDAYS.includes(day))
    )];

    const departure = ACS_normalizeText(body.departure);
    const arrival = ACS_normalizeText(body.arrival);

    const aircraftId = Number(body.aircraft_id || body.aircraftId || 0);

    const distanceNm = Math.round(Number(body.distance_nm || 0));
    const blockTimeMin = Math.round(Number(body.block_time_min || 0));
    const turnaroundMin = Math.round(Number(body.turnaround_min || 0));
    const totalRotationMin = Math.round(Number(body.total_rotation_min || 0));

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

    if (!Number.isInteger(aircraftId) || aircraftId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "AIRCRAFT_ID_REQUIRED"
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    /* ========================================================
       1) LOCK ORIGINAL ROUTE
       ======================================================== */

    const routeResult = await client.query(
      `
      SELECT *
      FROM public.route_plans
      WHERE id = $1
        AND airline_id = $2
        AND UPPER(COALESCE(route_state, 'ACTIVE')) <> 'CANCELLED'
      LIMIT 1
      FOR UPDATE
      `,
      [routePlanId, airlineId]
    );

    if (!routeResult.rows.length) {
      const error = new Error("ROUTE_PLAN_NOT_FOUND");
      error.code = "ROUTE_PLAN_NOT_FOUND";
      throw error;
    }

    const oldRoute = routeResult.rows[0];

    /* ========================================================
       2) LOCK SELECTED AIRCRAFT
       ======================================================== */

    const aircraftResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        registration,
        aircraft_name,
        manufacturer,
        model_key,
        status,
        operational_status,
        maintenance_status
      FROM public.aircraft_fleet
      WHERE id = $1
        AND airline_id = $2
      LIMIT 1
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

    const modelKey = ACS_normalizeText(
      aircraft.model_key || body.model_key || body.modelKey
    ).toUpperCase();

    const aircraftName = ACS_normalizeText(
      aircraft.aircraft_name || body.aircraft || body.aircraftName
    );

    const registration = ACS_normalizeText(
      aircraft.registration || body.registration
    );

    /* ========================================================
       3) UPDATE ROUTE PLAN — SAME ROUTE, SAME FLIGHT NUMBERS
       ======================================================== */

    const updatedRouteResult = await client.query(
      `
      UPDATE public.route_plans
      SET
        selected_days = $1,
        departure = $2,
        arrival = $3,
        aircraft_id = $4,
        model_key = $5,
        aircraft = $6,
        registration = $7,
        distance_nm = $8,
        block_time_min = $9,
        turnaround_min = $10,
        total_rotation_min = $11,
        updated_at = NOW()
      WHERE id = $12
        AND airline_id = $13
      RETURNING *
      `,
      [
        JSON.stringify(selectedDays),
        departure,
        arrival,
        aircraftId,
        modelKey,
        aircraftName,
        registration,
        distanceNm || Number(oldRoute.distance_nm || 0),
        blockTimeMin || Number(oldRoute.block_time_min || 0),
        turnaroundMin || Number(oldRoute.turnaround_min || 0),
        totalRotationMin || Number(oldRoute.total_rotation_min || 0),
        routePlanId,
        airlineId
      ]
    );

    const routePlan = updatedRouteResult.rows[0];

    /* ========================================================
       4) REMOVE OLD FLIGHT ITEMS FOR THIS ROUTE
       ======================================================== */

    await client.query(
      `
      UPDATE public.schedule_items
      SET
        status = 'cancelled',
        updated_at = NOW()
      WHERE route_plan_id = $1
        AND airline_id = $2
        AND item_type = 'flight'
        AND LOWER(COALESCE(status, 'planned')) <> 'cancelled'
      `,
      [routePlanId, airlineId]
    );

    await client.query(
      `
      UPDATE public.airport_slot_bookings
      SET
        slot_status = 'CANCELLED',
        updated_at = NOW()
      WHERE route_plan_id = $1
        AND airline_id = $2
        AND slot_status = 'RESERVED'
      `,
      [routePlanId, airlineId]
    );

    /* ========================================================
       5) CREATE NEW FLIGHT ITEMS FOR SAME ROUTE
       ======================================================== */

    const insertedScheduleItems = [];

    for (const day of selectedDays) {
      const abs = ACS_buildAbsMinutes(day, departure, arrival);

      const itemResult = await client.query(
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
          'Edited by ACS Route Plans Backend Authority',
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          routePlan.id,
          routePlan.route_uid,
          airlineId,
          routePlan.origin,
          routePlan.destination,
          day,
          departure,
          arrival,
          routePlan.model_key,
          routePlan.aircraft,
          aircraftId,
          routePlan.registration,
          routePlan.flight_number_out,
          routePlan.flight_number_in,
          Number(routePlan.distance_nm || 0),
          abs.depAbsMin,
          abs.arrAbsMin,
          Number(routePlan.block_time_min || 0),
          Number(routePlan.turnaround_min || 0)
        ]
      );

      insertedScheduleItems.push(itemResult.rows[0]);
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      ok: true,
      endpoint: "ACS_ROUTE_PLAN_EDIT",
      version: "v1.0",
      route_plan: routePlan,
      schedule_items: insertedScheduleItems
    });

  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ACS ROUTE PLAN EDIT ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("ACS ROUTE PLAN EDIT ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: error.code || "ROUTE_PLAN_EDIT_FAILED",
      details: error.message
    });

  } finally {
    client.release();
  }
});


export default router;
