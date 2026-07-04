/* ============================================================
   ACS FLIGHT SETTLEMENT ENGINE
   ------------------------------------------------------------
   File: routes/flight_settlement.js

   Authority:
   - PostgreSQL only
   - ACS OCC
   - Airbus OCC
   - Backend authority only
   - 700+ players ready
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const ACS_money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};

export async function ACS_settleFlight(client, airlineId, scheduleItemId) {
  
   const scheduleResult = await client.query(
    `
    SELECT *
    FROM public.schedule_items
    WHERE id = $1
      AND airline_id = $2
    FOR UPDATE
    `,
    [scheduleItemId, airlineId]
  );

  if (!scheduleResult.rows.length) {
    return { ok: false, error: "SCHEDULE_NOT_FOUND" };
  }

  const schedule = scheduleResult.rows[0];

  if (schedule.finance_settled === true) {
    return {
      ok: true,
      skipped: true,
      reason: "ALREADY_SETTLED",
      schedule_item_id: scheduleItemId
    };
  }

  if (String(schedule.status || "").toUpperCase() === "CANCELLED") {
    return {
      ok: false,
      error: "CANNOT_SETTLE_CANCELLED_FLIGHT"
    };
  }

  const routeResult = await client.query(
    `
    SELECT *
    FROM public.route_plans
    WHERE id = $1
      AND airline_id = $2
    LIMIT 1
    `,
    [schedule.route_plan_id, airlineId]
  );

  if (!routeResult.rows.length) {
    return { ok: false, error: "ROUTE_NOT_FOUND" };
  }

  const route = routeResult.rows[0];

  const aircraftResult = await client.query(
  `
  SELECT
    af.id AS fleet_aircraft_id,
    af.airline_id,
    af.registration,
    af.aircraft_name,
    af.model_key AS fleet_model_key,

    ac.model_key AS catalog_model_key,
    ac.seats,
    ac.fuel_burn_kgph,
    ac.speed_kts,
    ac.range_nm,
    ac.aircraft_category
  FROM public.aircraft_fleet af
  LEFT JOIN public.aircraft_catalog ac
    ON ac.model_key = af.model_key
  WHERE af.id = $1
    AND af.airline_id = $2
  LIMIT 1
  `,
  [schedule.aircraft_id, airlineId]
);

if (!aircraftResult.rows.length) {
  return { ok: false, error: "AIRCRAFT_FLEET_NOT_FOUND" };
}

const aircraft = aircraftResult.rows[0];

if (!aircraft.catalog_model_key) {
  return {
    ok: false,
    error: "AIRCRAFT_CATALOG_MODEL_NOT_FOUND",
    model_key: aircraft.fleet_model_key,
    aircraft_id: schedule.aircraft_id
  };
}
   
  const simResult = await client.query(`
  
    SELECT
      acs_get_current_sim_time() AS sim_time,
      EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year
  `);

  const simYear = Number(simResult.rows[0]?.sim_year || 1940);

  const economicsResult = await client.query(
    `
    SELECT fe.*
    FROM public.flight_economics fe
    INNER JOIN public.acs_economic_periods ep
      ON ep.id = fe.period_id
    WHERE $1 BETWEEN ep.era_start_year AND ep.era_end_year
    LIMIT 1
    `,
    [simYear]
  );

  if (!economicsResult.rows.length) {
    return { ok: false, error: "ECONOMICS_NOT_FOUND" };
  }

  const economics = economicsResult.rows[0];

  const routeOrderResult = await client.query(
    `
    SELECT COUNT(*)::int AS route_number
    FROM public.route_plans
    WHERE airline_id = $1
      AND id <= $2
    `,
    [airlineId, route.id]
  );

  const routeNumber = Number(routeOrderResult.rows[0]?.route_number || 999);
  const starterBoost = routeNumber <= 4 ? 1.18 : 1.0;

  const distanceNm = ACS_money(schedule.distance_nm || route.distance_nm);
  const blockHours = Math.max(
    0.25,
    Number(schedule.block_time_min || route.block_time_min || 60) / 60
  );

  let loadFactor = 0.62;

  if (routeNumber <= 4) loadFactor = 0.74;

  loadFactor = Math.min(0.92, loadFactor * starterBoost);

  const seats = ACS_money(aircraft.seats || 0);

  const passengers = Math.max(
    1,
    Math.round(seats * loadFactor)
  );

  const revenue = ACS_money(
    passengers *
    distanceNm *
    Number(economics.passenger_yield_usd_per_pax_mile || 0) *
    Number(economics.demand_multiplier || 1)
  );

  const fuelKg = Number(aircraft.fuel_burn_kgph || 0) * blockHours;
  const fuelGallons = fuelKg / 3.04;

  const fuel = ACS_money(
    fuelGallons *
    Number(economics.fuel_price_usd_per_gallon || 0)
  );

  const handling = ACS_money(economics.handling_base_usd || 0);
  const landing = ACS_money(economics.landing_fee_base_usd || 0);

  const navigation = ACS_money(
    distanceNm *
    Number(economics.navigation_usd_per_nm || 0)
  );

  const overflight = ACS_money(
    distanceNm *
    Number(economics.overflight_usd_per_nm || 0)
  );

  const airportCost = handling + landing + navigation + overflight;
  const expenses = fuel + airportCost;
  const profit = revenue - expenses;

   const flightHoursToAdd = Math.max(
    1,
    Math.round(blockHours)
  );

  const flightCyclesToAdd = 1;

  const conditionWearPct = Math.max(
    0.1,
    Math.min(
      2.5,
      Math.round((0.2 + blockHours * 0.12) * 10) / 10
    )
  );
 
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
  VALUES
  ($1, 'INCOME',  'FLIGHT_REVENUE',    $2,  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':REVENUE'),    $6,  NOW()),
  ($1, 'EXPENSE', 'FLIGHT_FUEL',       $7,  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':FUEL'),       $8,  NOW()),
  ($1, 'EXPENSE', 'FLIGHT_HANDLING',   $9,  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':HANDLING'),   $10, NOW()),
  ($1, 'EXPENSE', 'FLIGHT_LANDING',    $11, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':LANDING'),    $12, NOW()),
  ($1, 'EXPENSE', 'FLIGHT_NAVIGATION', $13, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':NAVIGATION'), $14, NOW()),
  ($1, 'EXPENSE', 'FLIGHT_OVERFLIGHT', $15, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000, $3, $4, ($5 || ':OVERFLIGHT'), $16, NOW())
  RETURNING id, type, source
  `,
  [
    airlineId,
    revenue,
    route.id,
    schedule.id,
    schedule.schedule_uid || route.route_uid,
    `Flight revenue ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`,
    fuel,
    `Fuel cost ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`,
    handling,
    `Handling cost ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`,
    landing,
    `Landing fee ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`,
    navigation,
    `Navigation cost ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`,
    overflight,
    `Overflight cost ${schedule.origin}-${schedule.destination} ${schedule.flight_number}`
  ]
);

const mainFinanceLogId = financeLogResult.rows.find(
  r => r.type === "INCOME" && r.source === "FLIGHT_REVENUE"
)?.id;

  await client.query(
    `
    UPDATE public.company_finance
    SET
      revenue = COALESCE(revenue, 0) + $2,
      live_revenue = COALESCE(live_revenue, 0) + $2,
      weekly_revenue = COALESCE(weekly_revenue, 0) + $2,

      expenses = COALESCE(expenses, 0) + $3,
      profit = COALESCE(profit, 0) + $4,
      capital = COALESCE(capital, 0) + $4,

      cost_fuel = COALESCE(cost_fuel, 0) + $5,
      cost_handling = COALESCE(cost_handling, 0) + $6,
      cost_navigation = COALESCE(cost_navigation, 0) + $7,
      cost_overflight = COALESCE(cost_overflight, 0) + $8,
      cost_airport = COALESCE(cost_airport, 0) + $9,

      updated_at = NOW()
    WHERE airline_id = $1
    `,
    [
      airlineId,
      revenue,
      expenses,
      profit,
      fuel,
      handling + landing,
      navigation,
      overflight,
      airportCost
    ]
  );

await client.query(
  `
  UPDATE public.aircraft_fleet
  SET
    total_hours = COALESCE(total_hours, 0) + $3,
    total_cycles = COALESCE(total_cycles, 0) + $4,
    condition_pct = GREATEST(
      0,
      ROUND(
        (COALESCE(condition_pct, 100)::numeric - $5::numeric),
        1
      )
    ),
    current_airport = COALESCE($6, current_airport),
    updated_at = NOW()
  WHERE id = $1
    AND airline_id = $2
  `,
  [
    schedule.aircraft_id,
    airlineId,
    flightHoursToAdd,
    flightCyclesToAdd,
    conditionWearPct,
    schedule.destination || null
  ]
);
   
await client.query(
  `
  UPDATE public.schedule_items
  SET
    finance_settled = TRUE,
    finance_log_id = $3,
    finance_settled_at = NOW(),
    updated_at = NOW()
  WHERE id = $1
    AND airline_id = $2
  `,
  [scheduleItemId, airlineId, mainFinanceLogId]
);

  const financeResult = await client.query(
    `
    SELECT *
    FROM public.company_finance
    WHERE airline_id = $1
    `,
    [airlineId]
  );

  return {
    ok: true,
    airline_id: airlineId,
    schedule_item_id: scheduleItemId,
    route_plan_id: route.id,
    sim_year: simYear,
    flight: {
      origin: schedule.origin,
      destination: schedule.destination,
      flight_number: schedule.flight_number,
      aircraft: schedule.aircraft,
      registration: schedule.aircraft_registration
    },
    settlement: {
      passengers,
      load_factor: loadFactor,
      revenue,
      fuel,
      handling,
      landing,
      navigation,
      overflight,
      expenses,
      profit
    },
    finance: financeResult.rows[0]
  };
}

router.post("/finance/flight-settlement", requireAuth, async (req, res) => {
  const airlineId = req.airline_id;
  const scheduleItemId = Number(req.body.schedule_item_id);

  if (!Number.isInteger(scheduleItemId) || scheduleItemId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_SCHEDULE_ITEM_ID"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await ACS_settleFlight(
      client,
      airlineId,
      scheduleItemId
    );

    if (!result.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json(result);
    }

    await client.query("COMMIT");
    return res.json(result);

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS FLIGHT SETTLEMENT ERROR", err);

    return res.status(500).json({
      ok: false,
      error: "FLIGHT_SETTLEMENT_ERROR",
      message: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
