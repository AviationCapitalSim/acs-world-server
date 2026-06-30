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

import { pool } from "../db/pool.js";

export async function ACS_settleFlight(
  client,
  airlineId,
  scheduleItemId
) {

  /* ============================================================
     1. LOCK FLIGHT
     ============================================================ */

  const scheduleResult = await client.query(
    `
    SELECT *
    FROM schedule_items
    WHERE
      id = $1
      AND airline_id = $2
    FOR UPDATE
    `,
    [scheduleItemId, airlineId]
  );

  if (!scheduleResult.rows.length) {
    return {
      ok: false,
      error: "SCHEDULE_NOT_FOUND"
    };
  }

  const schedule = scheduleResult.rows[0];

  if (schedule.finance_settled === true) {
    return {
      ok: true,
      skipped: true,
      reason: "ALREADY_SETTLED"
    };
  }

  /* ============================================================
     2. ROUTE
     ============================================================ */

  const routeResult = await client.query(
    `
    SELECT *
    FROM route_plans
    WHERE id = $1
    LIMIT 1
    `,
    [schedule.route_plan_id]
  );

  if (!routeResult.rows.length) {
    return {
      ok: false,
      error: "ROUTE_NOT_FOUND"
    };
  }

  const route = routeResult.rows[0];

  /* ============================================================
     3. AIRCRAFT
     ============================================================ */

  const aircraftResult = await client.query(
    `
    SELECT *
    FROM aircraft_catalog
    WHERE model_key = $1
    LIMIT 1
    `,
    [schedule.model_key]
  );

  if (!aircraftResult.rows.length) {
    return {
      ok: false,
      error: "AIRCRAFT_NOT_FOUND"
    };
  }

  const aircraft = aircraftResult.rows[0];

  /* ============================================================
     4. CURRENT ACS YEAR
     ============================================================ */

  const simResult = await client.query(`
    SELECT
      EXTRACT(
        YEAR
        FROM acs_get_current_sim_time()
      )::int AS sim_year
  `);

  const simYear =
    Number(simResult.rows[0]?.sim_year || 1940);

  /* ============================================================
     5. ECONOMIC PERIOD
     ============================================================ */

  const economicsResult = await client.query(
    `
    SELECT fe.*
    FROM flight_economics fe
    INNER JOIN acs_economic_periods ep
      ON ep.id = fe.period_id
    WHERE
      $1 BETWEEN
        ep.era_start_year
        AND ep.era_end_year
    LIMIT 1
    `,
    [simYear]
  );

  if (!economicsResult.rows.length) {
    return {
      ok: false,
      error: "ECONOMICS_NOT_FOUND"
    };
  }

  const economics =
    economicsResult.rows[0];

  /* ============================================================
     6. LOAD FACTOR
     ============================================================ */

  const routeAgeDays = 60;

  let loadFactor = 0.35;

  if (routeAgeDays >= 14) loadFactor = 0.50;
  if (routeAgeDays >= 28) loadFactor = 0.65;
  if (routeAgeDays >= 42) loadFactor = 0.78;
  if (routeAgeDays >= 56) loadFactor = 0.88;

  /* ============================================================
     7. PASSENGERS
     ============================================================ */

  const passengers =
    Math.max(
      1,
      Math.round(
        Number(aircraft.seats || 0) *
        loadFactor
      )
    );

  /* ============================================================
     8. REVENUE
     ============================================================ */

  const revenue =
    Math.round(
      passengers *
      Number(route.distance_nm || 0) *
      Number(
        economics.passenger_yield_usd_per_pax_mile || 0
      ) *
      Number(
        economics.demand_multiplier || 1
      )
    );

  /* ============================================================
     9. COSTS
     ============================================================ */

  const fuel =
    Math.round(
      Number(
        aircraft.fuel_burn_kgph || 0
      ) *
      Number(
        economics.fuel_price_usd_per_gallon || 0
      )
    );

  const handling =
    Math.round(
      Number(
        economics.handling_base_usd || 0
      )
    );

  const landing =
    Math.round(
      Number(
        economics.landing_fee_base_usd || 0
      )
    );

  const navigation =
    Math.round(
      Number(route.distance_nm || 0) *
      Number(
        economics.navigation_usd_per_nm || 0
      )
    );

  const overflight =
    Math.round(
      Number(route.distance_nm || 0) *
      Number(
        economics.overflight_usd_per_nm || 0
      )
    );

  const expenses =
    fuel +
    handling +
    landing +
    navigation +
    overflight;

  const profit =
    revenue -
    expenses;

  /* ============================================================
     RETURN PREVIEW
     ============================================================ */

  return {

    ok: true,

    airline_id:
      airlineId,

    schedule_item_id:
      scheduleItemId,

    sim_year:
      simYear,

    aircraft:
      aircraft.aircraft_name,

    passengers,

    load_factor:
      loadFactor,

    revenue,

    fuel,

    handling,

    landing,

    navigation,

    overflight,

    expenses,

    profit
  };
}
