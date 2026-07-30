/* ============================================================
   ACS MY ROUTES OCC — READ AUTHORITY v1.0
   ------------------------------------------------------------
   File: routes/my_routes.js

   Purpose:
   - Read and aggregate the authenticated airline route network.
   - Keep outbound and return performance separate.
   - Read canonical PostgreSQL passenger demand.
   - Compare the last 7 ACS days with the previous 7 ACS days.
   - Expose competitors operating the same directional market.

   Authority:
   - PostgreSQL
   - acs_get_current_sim_time()
   - Existing ACS route, flight and settlement authorities

   This module is read-only.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_MR_number(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function ACS_MR_integer(value) {
  return Math.trunc(ACS_MR_number(value));
}

function ACS_MR_directionKey(value) {
  const direction = String(value || "").trim().toUpperCase();
  return direction === "RETURN" ? "return" : "outbound";
}

function ACS_MR_emptyPeriod() {
  return {
    flights: 0,
    passengers: 0,
    available_seats: 0,
    load_factor: 0,
    revenue: 0,
    expenses: 0,
    profit: 0
  };
}

function ACS_MR_normalizePeriod(row, prefix) {
  const flights = ACS_MR_integer(row?.[`${prefix}_flights`]);
  const passengers = ACS_MR_integer(row?.[`${prefix}_passengers`]);
  const availableSeats = ACS_MR_integer(row?.[`${prefix}_available_seats`]);

  return {
    flights,
    passengers,
    available_seats: availableSeats,
    load_factor:
      availableSeats > 0
        ? Math.round((passengers / availableSeats) * 10000) / 10000
        : 0,
    revenue: ACS_MR_integer(row?.[`${prefix}_revenue`]),
    expenses: ACS_MR_integer(row?.[`${prefix}_expenses`]),
    profit: ACS_MR_integer(row?.[`${prefix}_profit`])
  };
}

function ACS_MR_buildTrend(current, previous) {
  const fields = [
    "flights",
    "passengers",
    "available_seats",
    "revenue",
    "expenses",
    "profit"
  ];

  const change = {};

  for (const field of fields) {
    change[field] =
      ACS_MR_number(current[field]) -
      ACS_MR_number(previous[field]);
  }

  change.load_factor =
    Math.round(
      (
        ACS_MR_number(current.load_factor) -
        ACS_MR_number(previous.load_factor)
      ) * 10000
    ) / 10000;

  return {
    last_7_days: current,
    previous_7_days: previous,
    change
  };
}

function ACS_MR_normalizeDemand(row, prefix) {
  return {
    origin: row?.[`${prefix}_origin_icao`] || null,
    destination: row?.[`${prefix}_destination_icao`] || null,
    sim_year: ACS_MR_integer(row?.[`${prefix}_sim_year`]),
    period_code: row?.[`${prefix}_period_code`] || null,
    market_scope: row?.[`${prefix}_market_scope`] || null,
    distance_nm: ACS_MR_integer(row?.[`${prefix}_distance_nm`]),
    weekly_y: ACS_MR_integer(row?.[`${prefix}_weekly_y`]),
    weekly_c: ACS_MR_integer(row?.[`${prefix}_weekly_c`]),
    weekly_f: ACS_MR_integer(row?.[`${prefix}_weekly_f`]),
    weekly_total: ACS_MR_integer(row?.[`${prefix}_weekly_total`]),
    average_daily: ACS_MR_number(row?.[`${prefix}_average_daily`]),
    authority: "POSTGRESQL_PASSENGER_MARKET_AUTHORITY"
  };
}

router.get(
  "/routes/my-routes-occ",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const client = await pool.connect();

    try {
      const clockResult = await client.query(`
        SELECT acs_get_current_sim_time() AS current_sim_time
      `);

      const currentSimTime =
        clockResult.rows[0]?.current_sim_time || null;

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_AUTHORITY_UNAVAILABLE"
        });
      }

      const airlineResult = await client.query(
  `
  SELECT
    airline_id,
    airline_name,
    iata,
    icao,
    color_hex
  FROM public.airlines
  WHERE airline_id = $1
  LIMIT 1
  `,
  [airlineId]
);

const airline = airlineResult.rows[0] || null;

if (!airline) {
  return res.status(404).json({
    ok: false,
    error: "AIRLINE_NOT_FOUND"
  });
}
     
      const routeResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          route.id AS route_plan_id,
          route.route_uid,
          route.airline_id,
          route.origin,
          route.destination,
          route.route_type,
          route.route_state,
          route.selected_days,
          route.departure,
          route.arrival,
          route.flight_number_out,
          route.flight_number_in,
          route.distance_nm,
          route.block_time_min,
          route.turnaround_min,
          route.total_rotation_min,
          route.aircraft_id,
          route.registration,
          route.model_key,
          route.aircraft,
          route.created_at,
          route.updated_at,

          fleet.aircraft_uid,
          fleet.model_key AS fleet_model_key,
          fleet.manufacturer AS fleet_manufacturer,
          fleet.aircraft_name AS fleet_aircraft_name,
          fleet.status AS aircraft_status,
          fleet.operational_status AS aircraft_operational_status,
          fleet.maintenance_status AS aircraft_maintenance_status,
          fleet.condition_pct,
          fleet.base_icao,
          fleet.current_airport,

          catalog.manufacturer AS catalog_manufacturer,
          catalog.model_key AS catalog_model_key,
          catalog.model AS catalog_model,
          catalog.aircraft_name AS catalog_aircraft_name,
          catalog.seats AS catalog_seats,
          catalog.range_nm AS catalog_range_nm,
          catalog.speed_kts AS catalog_speed_kts,
          catalog.aircraft_category,
          catalog.image_filename,

          outbound.origin_icao AS outbound_origin_icao,
          outbound.destination_icao AS outbound_destination_icao,
          outbound.sim_year AS outbound_sim_year,
          outbound.period_code AS outbound_period_code,
          outbound.market_scope AS outbound_market_scope,
          outbound.distance_nm AS outbound_distance_nm,
          outbound.weekly_y AS outbound_weekly_y,
          outbound.weekly_c AS outbound_weekly_c,
          outbound.weekly_f AS outbound_weekly_f,
          outbound.weekly_total AS outbound_weekly_total,
          outbound.average_daily AS outbound_average_daily,

          inbound.origin_icao AS return_origin_icao,
          inbound.destination_icao AS return_destination_icao,
          inbound.sim_year AS return_sim_year,
          inbound.period_code AS return_period_code,
          inbound.market_scope AS return_market_scope,
          inbound.distance_nm AS return_distance_nm,
          inbound.weekly_y AS return_weekly_y,
          inbound.weekly_c AS return_weekly_c,
          inbound.weekly_f AS return_weekly_f,
          inbound.weekly_total AS return_weekly_total,
          inbound.average_daily AS return_average_daily

        FROM public.route_plans route
        CROSS JOIN clock

        LEFT JOIN public.aircraft_fleet fleet
          ON fleet.id = route.aircraft_id
         AND fleet.airline_id = route.airline_id

        LEFT JOIN public.aircraft_catalog catalog
        ON LOWER(catalog.model_key) = LOWER(
        COALESCE(fleet.model_key, route.model_key)
        )

        CROSS JOIN LATERAL
          public.acs_calculate_passenger_demand(
            route.origin,
            route.destination,
            clock.sim_time
          ) outbound

        CROSS JOIN LATERAL
          public.acs_calculate_passenger_demand(
            route.destination,
            route.origin,
            clock.sim_time
          ) inbound

        WHERE route.airline_id = $1
          AND UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'

        ORDER BY
          route.origin,
          route.destination,
          route.id
        `,
        [airlineId, currentSimTime]
      );

      const performanceResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          occurrence.route_plan_id,
          occurrence.flight_direction,

          COUNT(*) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          )::integer AS current_flights,

          COALESCE(SUM(occurrence.settled_passengers) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_passengers,

          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_available_seats,

          COALESCE(SUM(occurrence.settled_revenue) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_revenue,

          COALESCE(SUM(occurrence.settled_expenses) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_expenses,

          COALESCE(SUM(occurrence.settled_profit) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_profit,

          COUNT(*) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          )::integer AS previous_flights,

          COALESCE(SUM(occurrence.settled_passengers) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_passengers,

          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_available_seats,

          COALESCE(SUM(occurrence.settled_revenue) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_revenue,

          COALESCE(SUM(occurrence.settled_expenses) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_expenses,

          COALESCE(SUM(occurrence.settled_profit) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_profit

        FROM public.flight_occurrences occurrence
        CROSS JOIN clock
        WHERE occurrence.airline_id = $1
          AND occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
          AND occurrence.arrived_at < clock.sim_time
        GROUP BY
          occurrence.route_plan_id,
          occurrence.flight_direction
        `,
        [airlineId, currentSimTime]
      );

      const competitorResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        ),
        my_routes AS MATERIALIZED (
          SELECT
            id AS my_route_plan_id,
            UPPER(origin) AS origin,
            UPPER(destination) AS destination
          FROM public.route_plans
          WHERE airline_id = $1
            AND UPPER(COALESCE(route_state, 'ACTIVE')) = 'ACTIVE'
            AND UPPER(COALESCE(route_type, 'PASSENGER')) = 'PASSENGER'
        )
        SELECT
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          occurrence.airline_id AS competitor_airline_id,
          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,
          occurrence.aircraft_registration,
          occurrence.model_key,
          COUNT(*)::integer AS flights,
          COALESCE(SUM(occurrence.settled_passengers), 0)::bigint
            AS passengers,
          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ), 0)::bigint AS available_seats

        FROM my_routes mine
        CROSS JOIN clock
        JOIN public.flight_occurrences occurrence
          ON LEAST(
               UPPER(occurrence.origin),
               UPPER(occurrence.destination)
             ) = LEAST(mine.origin, mine.destination)
         AND GREATEST(
               UPPER(occurrence.origin),
               UPPER(occurrence.destination)
             ) = GREATEST(mine.origin, mine.destination)
         AND occurrence.airline_id <> $1
         AND occurrence.operational_status = 'ARRIVED'
         AND occurrence.settled_at IS NOT NULL
         AND occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
         AND occurrence.arrived_at < clock.sim_time

        JOIN public.airlines airline
          ON airline.airline_id = occurrence.airline_id

        GROUP BY
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          occurrence.airline_id,
          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,
          occurrence.aircraft_registration,
          occurrence.model_key

        ORDER BY
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          passengers DESC,
          occurrence.airline_id
        `,
        [airlineId, currentSimTime]
      );

      const performanceByRoute = new Map();

      for (const row of performanceResult.rows) {
        const routeId = String(row.route_plan_id);
        const direction = ACS_MR_directionKey(row.flight_direction);

        if (!performanceByRoute.has(routeId)) {
          performanceByRoute.set(routeId, {
            outbound: null,
            return: null
          });
        }

        performanceByRoute.get(routeId)[direction] = row;
      }

      const competitorsByRoute = new Map();

      for (const row of competitorResult.rows) {
        const routeId = String(row.my_route_plan_id);

        if (!competitorsByRoute.has(routeId)) {
          competitorsByRoute.set(routeId, []);
        }

        const availableSeats = ACS_MR_integer(row.available_seats);
        const passengers = ACS_MR_integer(row.passengers);

        competitorsByRoute.get(routeId).push({
          direction: {
            origin: row.origin,
            destination: row.destination
          },
          airline: {
            airline_id: ACS_MR_integer(row.competitor_airline_id),
            airline_name: row.airline_name || null,
            iata: row.iata || null,
            icao: row.icao || null,
            color_hex: row.color_hex || null,
            color_hsl: row.color_hsl || null,
            color_index:
              row.color_index === null
                ? null
                : ACS_MR_integer(row.color_index)
          },
          aircraft: {
            registration: row.aircraft_registration || null,
            model_key: row.model_key || null
          },
          last_7_days: {
            flights: ACS_MR_integer(row.flights),
            passengers,
            available_seats: availableSeats,
            load_factor:
              availableSeats > 0
                ? Math.round((passengers / availableSeats) * 10000) / 10000
                : 0
          },
          passenger_data_status: "LEGACY_SETTLEMENT"
        });
      }

      const summaryCurrent = ACS_MR_emptyPeriod();
      const summaryPrevious = ACS_MR_emptyPeriod();

      const routes = routeResult.rows.map(row => {
        const routeId = String(row.route_plan_id);
        const routePerformance =
          performanceByRoute.get(routeId) || {};

        const outboundCurrent = ACS_MR_normalizePeriod(
          routePerformance.outbound,
          "current"
        );
        const outboundPrevious = ACS_MR_normalizePeriod(
          routePerformance.outbound,
          "previous"
        );
        const returnCurrent = ACS_MR_normalizePeriod(
          routePerformance.return,
          "current"
        );
        const returnPrevious = ACS_MR_normalizePeriod(
          routePerformance.return,
          "previous"
        );

        for (const field of [
          "flights",
          "passengers",
          "available_seats",
          "revenue",
          "expenses",
          "profit"
        ]) {
          summaryCurrent[field] +=
            outboundCurrent[field] + returnCurrent[field];
          summaryPrevious[field] +=
            outboundPrevious[field] + returnPrevious[field];
        }

        return {
          route_plan_id: ACS_MR_integer(row.route_plan_id),
          route_uid: row.route_uid || null,
          route_type: row.route_type,
          route_state: row.route_state,
          origin: row.origin,
          destination: row.destination,
          selected_days:
            Array.isArray(row.selected_days)
              ? row.selected_days
              : [],
          frequency_per_week:
            Array.isArray(row.selected_days)
              ? row.selected_days.length
              : 0,
          departure: row.departure,
          arrival: row.arrival,
          flight_numbers: {
            outbound: row.flight_number_out,
            return: row.flight_number_in
          },
          distance_nm: ACS_MR_integer(row.distance_nm),
          block_time_min: ACS_MR_integer(row.block_time_min),
          turnaround_min: ACS_MR_integer(row.turnaround_min),
          total_rotation_min: ACS_MR_integer(row.total_rotation_min),
          aircraft: {
            aircraft_id:
              row.aircraft_id === null
                ? null
                : ACS_MR_integer(row.aircraft_id),
            aircraft_uid: row.aircraft_uid || null,
            registration: row.registration || null,
            model_key:
            row.catalog_model_key ||
            row.fleet_model_key ||
            row.model_key,
            manufacturer:
              row.catalog_manufacturer ||
              row.fleet_manufacturer ||
              null,
            model: row.catalog_model || null,
            aircraft_name:
              row.catalog_aircraft_name ||
              row.fleet_aircraft_name ||
              row.aircraft ||
              null,
            status: row.aircraft_status || null,
            operational_status:
              row.aircraft_operational_status || null,
            maintenance_status:
              row.aircraft_maintenance_status || null,
            condition_pct: ACS_MR_number(row.condition_pct),
            base_icao: row.base_icao || null,
            current_airport: row.current_airport || null,
            reference_capacity: ACS_MR_integer(row.catalog_seats),
            range_nm: ACS_MR_integer(row.catalog_range_nm),
            speed_kts: ACS_MR_integer(row.catalog_speed_kts),
            category: row.aircraft_category || null,
            image_filename: row.image_filename || null,
            cabin_configuration: null,
            cabin_configuration_status: "PENDING_CABIN_FINANCE_AUTHORITY"
          },
          demand: {
            outbound: ACS_MR_normalizeDemand(row, "outbound"),
            return: ACS_MR_normalizeDemand(row, "return")
          },
          performance: {
            outbound: ACS_MR_buildTrend(
              outboundCurrent,
              outboundPrevious
            ),
            return: ACS_MR_buildTrend(
              returnCurrent,
              returnPrevious
            ),
            passenger_data_status: "LEGACY_SETTLEMENT"
          },
          competitors:
            competitorsByRoute.get(routeId) || [],
          created_at: row.created_at,
          updated_at: row.updated_at
        };
      });

      summaryCurrent.load_factor =
        summaryCurrent.available_seats > 0
          ? Math.round(
              (
                summaryCurrent.passengers /
                summaryCurrent.available_seats
              ) * 10000
            ) / 10000
          : 0;

      summaryPrevious.load_factor =
        summaryPrevious.available_seats > 0
          ? Math.round(
              (
                summaryPrevious.passengers /
                summaryPrevious.available_seats
              ) * 10000
            ) / 10000
          : 0;

      return res.json({
        ok: true,
        endpoint: "ACS_MY_ROUTES_OCC",
        version: "v1.0",
        authority: "POSTGRESQL_MY_ROUTES_OCC",
        current_sim_time: currentSimTime,
airline_id: airlineId,
airline: {
  airline_id: ACS_MR_integer(airline.airline_id),
  airline_name: airline.airline_name || null,
  iata: airline.iata || null,
  icao: airline.icao || null,
  color_hex: airline.color_hex || null
},
summary: {
          active_routes: routes.length,
          ...ACS_MR_buildTrend(
            summaryCurrent,
            summaryPrevious
          ),
          passenger_data_status: "LEGACY_SETTLEMENT"
        },
        routes,
        count: routes.length
      });
    } catch (error) {
      console.error("ACS MY ROUTES OCC ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "MY_ROUTES_OCC_QUERY_FAILED",
        details: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   GET /v1/routes/my-routes-occ/:routePlanId/airport-market
   ------------------------------------------------------------
   Returns active route-aircraft assignments that operate at the
   selected own route destination airport.

   The selected route must belong to the authenticated airline.
   Active route plans are returned even when no settled flights
   exist yet. Recorded traffic covers the last 7 ACS days.
   ============================================================ */

router.get(
  "/routes/my-routes-occ/:routePlanId/airport-market",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const routePlanId = Number(req.params.routePlanId);
    const requestedPage = Number(req.query.page || 1);
    const requestedLimit = Number(req.query.limit || 50);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!Number.isInteger(routePlanId) || routePlanId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ROUTE_PLAN_ID"
      });
    }

    const page =
      Number.isInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;

    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;

    const offset = (page - 1) * limit;
    const client = await pool.connect();

    try {
      const clockResult = await client.query(`
        SELECT acs_get_current_sim_time() AS current_sim_time
      `);

      const currentSimTime =
        clockResult.rows[0]?.current_sim_time || null;

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_AUTHORITY_UNAVAILABLE"
        });
      }

      const selectedRouteResult = await client.query(
        `
        SELECT
          route.id AS route_plan_id,
          route.origin,
          route.destination,
          route.route_state,
          route.route_type
        FROM public.route_plans route
        WHERE route.id = $1
          AND route.airline_id = $2
          AND UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
        LIMIT 1
        `,
        [routePlanId, airlineId]
      );

      const selectedRoute = selectedRouteResult.rows[0] || null;

      if (!selectedRoute) {
        return res.status(404).json({
          ok: false,
          error: "OWN_ACTIVE_ROUTE_NOT_FOUND"
        });
      }

      const airportIcao = String(
        selectedRoute.destination || ""
      )
        .trim()
        .toUpperCase();

      if (!airportIcao) {
        return res.status(422).json({
          ok: false,
          error: "ROUTE_DESTINATION_UNAVAILABLE"
        });
      }

      const countResult = await client.query(
        `
        SELECT COUNT(*)::integer AS total
        FROM public.route_plans route
        WHERE UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
          AND (
            UPPER(route.origin) = $1
            OR UPPER(route.destination) = $1
          )
        `,
        [airportIcao]
      );

      const total = ACS_MR_integer(
        countResult.rows[0]?.total
      );

      const marketResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          route.id AS route_plan_id,
          route.route_uid,
          route.airline_id,
          route.origin,
          route.destination,
          route.route_state,
          route.route_type,
          route.selected_days,
          route.flight_number_out,
          route.flight_number_in,
          route.distance_nm,
          route.aircraft_id,
          route.registration,
          route.model_key,
          route.aircraft,

          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,

          fleet.aircraft_uid,
          fleet.registration AS fleet_registration,
          fleet.model_key AS fleet_model_key,
          fleet.aircraft_name AS fleet_aircraft_name,
          fleet.manufacturer AS fleet_manufacturer,

          catalog.model_key AS catalog_model_key,
          catalog.manufacturer AS catalog_manufacturer,
          catalog.model AS catalog_model,
          catalog.aircraft_name AS catalog_aircraft_name,

          COALESCE(traffic.flights, 0)::integer AS flights,
          COALESCE(traffic.passengers, 0)::bigint AS passengers,
          COALESCE(traffic.available_seats, 0)::bigint
            AS available_seats

        FROM public.route_plans route
        CROSS JOIN clock

        INNER JOIN public.airlines airline
          ON airline.airline_id = route.airline_id

        LEFT JOIN public.aircraft_fleet fleet
          ON fleet.id = route.aircraft_id
         AND fleet.airline_id = route.airline_id

        LEFT JOIN public.aircraft_catalog catalog
          ON LOWER(catalog.model_key) = LOWER(
            COALESCE(fleet.model_key, route.model_key)
          )

        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS flights,
            COALESCE(
              SUM(occurrence.settled_passengers),
              0
            )::bigint AS passengers,
            COALESCE(
              SUM(
                CASE
                  WHEN occurrence.settled_load_factor > 0
                    THEN ROUND(
                      occurrence.settled_passengers::numeric /
                      occurrence.settled_load_factor
                    )
                  ELSE 0
                END
              ),
              0
            )::bigint AS available_seats
          FROM public.flight_occurrences occurrence
          WHERE occurrence.route_plan_id = route.id
            AND occurrence.airline_id = route.airline_id
            AND occurrence.settled_at IS NOT NULL
            AND occurrence.arrived_at >=
              clock.sim_time - INTERVAL '7 days'
            AND occurrence.arrived_at < clock.sim_time
        ) traffic ON true

        WHERE UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
          AND (
            UPPER(route.origin) = $1
            OR UPPER(route.destination) = $1
          )

        ORDER BY
          COALESCE(traffic.passengers, 0) DESC,
          airline.airline_name ASC,
          route.origin ASC,
          route.destination ASC,
          route.id ASC

        LIMIT $3
        OFFSET $4
        `,
        [airportIcao, currentSimTime, limit, offset]
      );

      const operators = marketResult.rows.map(row => {
        const passengers = ACS_MR_integer(row.passengers);
        const availableSeats = ACS_MR_integer(
          row.available_seats
        );

        return {
          route_plan_id: ACS_MR_integer(row.route_plan_id),
          route_uid: row.route_uid || null,
          is_own_airline:
            ACS_MR_integer(row.airline_id) === airlineId,
          airline: {
            airline_id: ACS_MR_integer(row.airline_id),
            airline_name: row.airline_name || null,
            iata: row.iata || null,
            icao: row.icao || null,
            color_hex: row.color_hex || null,
            color_hsl: row.color_hsl || null,
            color_index:
              row.color_index === null
                ? null
                : ACS_MR_integer(row.color_index)
          },
          route: {
            origin: row.origin || null,
            destination: row.destination || null,
            route_state: row.route_state || null,
            route_type: row.route_type || null,
            selected_days:
              Array.isArray(row.selected_days)
                ? row.selected_days
                : [],
            frequency_per_week:
              Array.isArray(row.selected_days)
                ? row.selected_days.length
                : 0,
            flight_numbers: {
              outbound: row.flight_number_out || null,
              return: row.flight_number_in || null
            },
            distance_nm: ACS_MR_integer(row.distance_nm)
          },
          aircraft: {
            aircraft_id:
              row.aircraft_id === null
                ? null
                : ACS_MR_integer(row.aircraft_id),
            aircraft_uid: row.aircraft_uid || null,
            registration:
              row.fleet_registration ||
              row.registration ||
              null,
            model_key:
              row.catalog_model_key ||
              row.fleet_model_key ||
              row.model_key ||
              null,
            manufacturer:
              row.catalog_manufacturer ||
              row.fleet_manufacturer ||
              null,
            model: row.catalog_model || null,
            aircraft_name:
              row.catalog_aircraft_name ||
              row.fleet_aircraft_name ||
              row.aircraft ||
              null
          },
          last_7_days: {
            flights: ACS_MR_integer(row.flights),
            passengers,
            available_seats: availableSeats,
            load_factor:
              availableSeats > 0
                ? Math.round(
                    (passengers / availableSeats) * 10000
                  ) / 10000
                : 0
          },
          traffic_data_status:
            "LEGACY_SETTLEMENT"
        };
      });

      const totalPages =
        total > 0 ? Math.ceil(total / limit) : 0;

      return res.json({
        ok: true,
        endpoint: "ACS_AIRPORT_ROUTE_MARKET",
        authority: "POSTGRESQL_AIRPORT_ROUTE_MARKET",
        current_sim_time: currentSimTime,
        airline_id: airlineId,
        selected_route: {
          route_plan_id: ACS_MR_integer(
            selectedRoute.route_plan_id
          ),
          origin: selectedRoute.origin || null,
          destination: selectedRoute.destination || null
        },
        airport_icao: airportIcao,
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          has_previous: page > 1,
          has_next: page < totalPages
        },
        operators,
        count: operators.length
      });
    } catch (error) {
      console.error(
        "ACS AIRPORT ROUTE MARKET ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "AIRPORT_ROUTE_MARKET_QUERY_FAILED",
        details: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   ACS MY ROUTES OCC — READ AUTHORITY v1.0
   ------------------------------------------------------------
   File: routes/my_routes.js

   Purpose:
   - Read and aggregate the authenticated airline route network.
   - Keep outbound and return performance separate.
   - Read canonical PostgreSQL passenger demand.
   - Compare the last 7 ACS days with the previous 7 ACS days.
   - Expose competitors operating the same directional market.

   Authority:
   - PostgreSQL
   - acs_get_current_sim_time()
   - Existing ACS route, flight and settlement authorities

   This module is read-only.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_MR_number(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function ACS_MR_integer(value) {
  return Math.trunc(ACS_MR_number(value));
}

function ACS_MR_directionKey(value) {
  const direction = String(value || "").trim().toUpperCase();
  return direction === "RETURN" ? "return" : "outbound";
}

function ACS_MR_emptyPeriod() {
  return {
    flights: 0,
    passengers: 0,
    available_seats: 0,
    load_factor: 0,
    revenue: 0,
    expenses: 0,
    profit: 0
  };
}

function ACS_MR_normalizePeriod(row, prefix) {
  const flights = ACS_MR_integer(row?.[`${prefix}_flights`]);
  const passengers = ACS_MR_integer(row?.[`${prefix}_passengers`]);
  const availableSeats = ACS_MR_integer(row?.[`${prefix}_available_seats`]);

  return {
    flights,
    passengers,
    available_seats: availableSeats,
    load_factor:
      availableSeats > 0
        ? Math.round((passengers / availableSeats) * 10000) / 10000
        : 0,
    revenue: ACS_MR_integer(row?.[`${prefix}_revenue`]),
    expenses: ACS_MR_integer(row?.[`${prefix}_expenses`]),
    profit: ACS_MR_integer(row?.[`${prefix}_profit`])
  };
}

function ACS_MR_buildTrend(current, previous) {
  const fields = [
    "flights",
    "passengers",
    "available_seats",
    "revenue",
    "expenses",
    "profit"
  ];

  const change = {};

  for (const field of fields) {
    change[field] =
      ACS_MR_number(current[field]) -
      ACS_MR_number(previous[field]);
  }

  change.load_factor =
    Math.round(
      (
        ACS_MR_number(current.load_factor) -
        ACS_MR_number(previous.load_factor)
      ) * 10000
    ) / 10000;

  return {
    last_7_days: current,
    previous_7_days: previous,
    change
  };
}

function ACS_MR_normalizeDemand(row, prefix) {
  return {
    origin: row?.[`${prefix}_origin_icao`] || null,
    destination: row?.[`${prefix}_destination_icao`] || null,
    sim_year: ACS_MR_integer(row?.[`${prefix}_sim_year`]),
    period_code: row?.[`${prefix}_period_code`] || null,
    market_scope: row?.[`${prefix}_market_scope`] || null,
    distance_nm: ACS_MR_integer(row?.[`${prefix}_distance_nm`]),
    weekly_y: ACS_MR_integer(row?.[`${prefix}_weekly_y`]),
    weekly_c: ACS_MR_integer(row?.[`${prefix}_weekly_c`]),
    weekly_f: ACS_MR_integer(row?.[`${prefix}_weekly_f`]),
    weekly_total: ACS_MR_integer(row?.[`${prefix}_weekly_total`]),
    average_daily: ACS_MR_number(row?.[`${prefix}_average_daily`]),
    authority: "POSTGRESQL_PASSENGER_MARKET_AUTHORITY"
  };
}

router.get(
  "/routes/my-routes-occ",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const client = await pool.connect();

    try {
      const clockResult = await client.query(`
        SELECT acs_get_current_sim_time() AS current_sim_time
      `);

      const currentSimTime =
        clockResult.rows[0]?.current_sim_time || null;

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_AUTHORITY_UNAVAILABLE"
        });
      }

      const airlineResult = await client.query(
        `
        SELECT
          airline_id,
          airline_name,
          iata,
          icao,
          color_hex
        FROM public.airlines
        WHERE airline_id = $1
        LIMIT 1
        `,
        [airlineId]
      );

      const airline = airlineResult.rows[0] || null;

      if (!airline) {
        return res.status(404).json({
          ok: false,
          error: "AIRLINE_NOT_FOUND"
        });
      }

      const routeResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          route.id AS route_plan_id,
          route.route_uid,
          route.airline_id,
          route.origin,
          route.destination,
          route.route_type,
          route.route_state,
          route.selected_days,
          route.departure,
          route.arrival,
          route.flight_number_out,
          route.flight_number_in,
          route.distance_nm,
          route.block_time_min,
          route.turnaround_min,
          route.total_rotation_min,
          route.aircraft_id,
          route.registration,
          route.model_key,
          route.aircraft,
          route.created_at,
          route.updated_at,

          fleet.aircraft_uid,
          fleet.model_key AS fleet_model_key,
          fleet.manufacturer AS fleet_manufacturer,
          fleet.aircraft_name AS fleet_aircraft_name,
          fleet.status AS aircraft_status,
          fleet.operational_status AS aircraft_operational_status,
          fleet.maintenance_status AS aircraft_maintenance_status,
          fleet.condition_pct,
          fleet.base_icao,
          fleet.current_airport,

          catalog.manufacturer AS catalog_manufacturer,
          catalog.model_key AS catalog_model_key,
          catalog.model AS catalog_model,
          catalog.aircraft_name AS catalog_aircraft_name,
          catalog.seats AS catalog_seats,
          catalog.range_nm AS catalog_range_nm,
          catalog.speed_kts AS catalog_speed_kts,
          catalog.aircraft_category,
          catalog.image_filename,

          outbound.origin_icao AS outbound_origin_icao,
          outbound.destination_icao AS outbound_destination_icao,
          outbound.sim_year AS outbound_sim_year,
          outbound.period_code AS outbound_period_code,
          outbound.market_scope AS outbound_market_scope,
          outbound.distance_nm AS outbound_distance_nm,
          outbound.weekly_y AS outbound_weekly_y,
          outbound.weekly_c AS outbound_weekly_c,
          outbound.weekly_f AS outbound_weekly_f,
          outbound.weekly_total AS outbound_weekly_total,
          outbound.average_daily AS outbound_average_daily,

          inbound.origin_icao AS return_origin_icao,
          inbound.destination_icao AS return_destination_icao,
          inbound.sim_year AS return_sim_year,
          inbound.period_code AS return_period_code,
          inbound.market_scope AS return_market_scope,
          inbound.distance_nm AS return_distance_nm,
          inbound.weekly_y AS return_weekly_y,
          inbound.weekly_c AS return_weekly_c,
          inbound.weekly_f AS return_weekly_f,
          inbound.weekly_total AS return_weekly_total,
          inbound.average_daily AS return_average_daily

        FROM public.route_plans route
        CROSS JOIN clock

        LEFT JOIN public.aircraft_fleet fleet
          ON fleet.id = route.aircraft_id
         AND fleet.airline_id = route.airline_id

        LEFT JOIN public.aircraft_catalog catalog
          ON LOWER(catalog.model_key) = LOWER(
            COALESCE(fleet.model_key, route.model_key)
          )

        CROSS JOIN LATERAL
          public.acs_calculate_passenger_demand(
            route.origin,
            route.destination,
            clock.sim_time
          ) outbound

        CROSS JOIN LATERAL
          public.acs_calculate_passenger_demand(
            route.destination,
            route.origin,
            clock.sim_time
          ) inbound

        WHERE route.airline_id = $1
          AND UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'

        ORDER BY
          route.origin,
          route.destination,
          route.id
        `,
        [airlineId, currentSimTime]
      );

      const performanceResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          occurrence.route_plan_id,
          occurrence.flight_direction,

          COUNT(*) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          )::integer AS current_flights,

          COALESCE(SUM(occurrence.settled_passengers) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_passengers,

          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_available_seats,

          COALESCE(SUM(occurrence.settled_revenue) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_revenue,

          COALESCE(SUM(occurrence.settled_expenses) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_expenses,

          COALESCE(SUM(occurrence.settled_profit) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
              AND occurrence.arrived_at < clock.sim_time
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS current_profit,

          COUNT(*) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          )::integer AS previous_flights,

          COALESCE(SUM(occurrence.settled_passengers) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_passengers,

          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_available_seats,

          COALESCE(SUM(occurrence.settled_revenue) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_revenue,

          COALESCE(SUM(occurrence.settled_expenses) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_expenses,

          COALESCE(SUM(occurrence.settled_profit) FILTER (
            WHERE occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
              AND occurrence.arrived_at < clock.sim_time - INTERVAL '7 days'
              AND occurrence.settled_at IS NOT NULL
          ), 0)::bigint AS previous_profit

        FROM public.flight_occurrences occurrence
        CROSS JOIN clock
        WHERE occurrence.airline_id = $1
          AND occurrence.arrived_at >= clock.sim_time - INTERVAL '14 days'
          AND occurrence.arrived_at < clock.sim_time
        GROUP BY
          occurrence.route_plan_id,
          occurrence.flight_direction
        `,
        [airlineId, currentSimTime]
      );

      const competitorResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        ),
        my_routes AS MATERIALIZED (
          SELECT
            id AS my_route_plan_id,
            UPPER(origin) AS origin,
            UPPER(destination) AS destination
          FROM public.route_plans
          WHERE airline_id = $1
            AND UPPER(COALESCE(route_state, 'ACTIVE')) = 'ACTIVE'
            AND UPPER(COALESCE(route_type, 'PASSENGER')) = 'PASSENGER'
        )
        SELECT
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          occurrence.airline_id AS competitor_airline_id,
          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,
          occurrence.aircraft_registration,
          occurrence.model_key,
          COUNT(*)::integer AS flights,
          COALESCE(SUM(occurrence.settled_passengers), 0)::bigint
            AS passengers,
          COALESCE(SUM(
            CASE
              WHEN occurrence.settled_load_factor > 0
                THEN ROUND(
                  occurrence.settled_passengers::numeric /
                  occurrence.settled_load_factor
                )
              ELSE 0
            END
          ), 0)::bigint AS available_seats

        FROM my_routes mine
        CROSS JOIN clock
        JOIN public.flight_occurrences occurrence
          ON LEAST(
               UPPER(occurrence.origin),
               UPPER(occurrence.destination)
             ) = LEAST(mine.origin, mine.destination)
         AND GREATEST(
               UPPER(occurrence.origin),
               UPPER(occurrence.destination)
             ) = GREATEST(mine.origin, mine.destination)
         AND occurrence.airline_id <> $1
         AND occurrence.operational_status = 'ARRIVED'
         AND occurrence.settled_at IS NOT NULL
         AND occurrence.arrived_at >= clock.sim_time - INTERVAL '7 days'
         AND occurrence.arrived_at < clock.sim_time

        JOIN public.airlines airline
          ON airline.airline_id = occurrence.airline_id

        GROUP BY
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          occurrence.airline_id,
          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,
          occurrence.aircraft_registration,
          occurrence.model_key

        ORDER BY
          mine.my_route_plan_id,
          occurrence.origin,
          occurrence.destination,
          passengers DESC,
          occurrence.airline_id
        `,
        [airlineId, currentSimTime]
      );

      const performanceByRoute = new Map();

      for (const row of performanceResult.rows) {
        const routeId = String(row.route_plan_id);
        const direction = ACS_MR_directionKey(row.flight_direction);

        if (!performanceByRoute.has(routeId)) {
          performanceByRoute.set(routeId, {
            outbound: null,
            return: null
          });
        }

        performanceByRoute.get(routeId)[direction] = row;
      }

      const competitorsByRoute = new Map();

      for (const row of competitorResult.rows) {
        const routeId = String(row.my_route_plan_id);

        if (!competitorsByRoute.has(routeId)) {
          competitorsByRoute.set(routeId, []);
        }

        const availableSeats = ACS_MR_integer(row.available_seats);
        const passengers = ACS_MR_integer(row.passengers);

        competitorsByRoute.get(routeId).push({
          direction: {
            origin: row.origin,
            destination: row.destination
          },
          airline: {
            airline_id: ACS_MR_integer(row.competitor_airline_id),
            airline_name: row.airline_name || null,
            iata: row.iata || null,
            icao: row.icao || null,
            color_hex: row.color_hex || null,
            color_hsl: row.color_hsl || null,
            color_index:
              row.color_index === null
                ? null
                : ACS_MR_integer(row.color_index)
          },
          aircraft: {
            registration: row.aircraft_registration || null,
            model_key: row.model_key || null
          },
          last_7_days: {
            flights: ACS_MR_integer(row.flights),
            passengers,
            available_seats: availableSeats,
            load_factor:
              availableSeats > 0
                ? Math.round((passengers / availableSeats) * 10000) / 10000
                : 0
          },
          passenger_data_status: "LEGACY_SETTLEMENT"
        });
      }

      const summaryCurrent = ACS_MR_emptyPeriod();
      const summaryPrevious = ACS_MR_emptyPeriod();

      const routes = routeResult.rows.map(row => {
        const routeId = String(row.route_plan_id);
        const routePerformance =
          performanceByRoute.get(routeId) || {};

        const outboundCurrent = ACS_MR_normalizePeriod(
          routePerformance.outbound,
          "current"
        );
        const outboundPrevious = ACS_MR_normalizePeriod(
          routePerformance.outbound,
          "previous"
        );
        const returnCurrent = ACS_MR_normalizePeriod(
          routePerformance.return,
          "current"
        );
        const returnPrevious = ACS_MR_normalizePeriod(
          routePerformance.return,
          "previous"
        );

        for (const field of [
          "flights",
          "passengers",
          "available_seats",
          "revenue",
          "expenses",
          "profit"
        ]) {
          summaryCurrent[field] +=
            outboundCurrent[field] + returnCurrent[field];
          summaryPrevious[field] +=
            outboundPrevious[field] + returnPrevious[field];
        }

        return {
          route_plan_id: ACS_MR_integer(row.route_plan_id),
          route_uid: row.route_uid || null,
          route_type: row.route_type,
          route_state: row.route_state,
          origin: row.origin,
          destination: row.destination,
          selected_days:
            Array.isArray(row.selected_days)
              ? row.selected_days
              : [],
          frequency_per_week:
            Array.isArray(row.selected_days)
              ? row.selected_days.length
              : 0,
          departure: row.departure,
          arrival: row.arrival,
          flight_numbers: {
            outbound: row.flight_number_out,
            return: row.flight_number_in
          },
          distance_nm: ACS_MR_integer(row.distance_nm),
          block_time_min: ACS_MR_integer(row.block_time_min),
          turnaround_min: ACS_MR_integer(row.turnaround_min),
          total_rotation_min: ACS_MR_integer(row.total_rotation_min),
          aircraft: {
            aircraft_id:
              row.aircraft_id === null
                ? null
                : ACS_MR_integer(row.aircraft_id),
            aircraft_uid: row.aircraft_uid || null,
            registration: row.registration || null,
            model_key:
              row.catalog_model_key ||
              row.fleet_model_key ||
              row.model_key,
            manufacturer:
              row.catalog_manufacturer ||
              row.fleet_manufacturer ||
              null,
            model: row.catalog_model || null,
            aircraft_name:
              row.catalog_aircraft_name ||
              row.fleet_aircraft_name ||
              row.aircraft ||
              null,
            status: row.aircraft_status || null,
            operational_status:
              row.aircraft_operational_status || null,
            maintenance_status:
              row.aircraft_maintenance_status || null,
            condition_pct: ACS_MR_number(row.condition_pct),
            base_icao: row.base_icao || null,
            current_airport: row.current_airport || null,
            reference_capacity: ACS_MR_integer(row.catalog_seats),
            range_nm: ACS_MR_integer(row.catalog_range_nm),
            speed_kts: ACS_MR_integer(row.catalog_speed_kts),
            category: row.aircraft_category || null,
            image_filename: row.image_filename || null,
            cabin_configuration: null,
            cabin_configuration_status: "PENDING_CABIN_FINANCE_AUTHORITY"
          },
          demand: {
            outbound: ACS_MR_normalizeDemand(row, "outbound"),
            return: ACS_MR_normalizeDemand(row, "return")
          },
          performance: {
            outbound: ACS_MR_buildTrend(
              outboundCurrent,
              outboundPrevious
            ),
            return: ACS_MR_buildTrend(
              returnCurrent,
              returnPrevious
            ),
            passenger_data_status: "LEGACY_SETTLEMENT"
          },
          competitors:
            competitorsByRoute.get(routeId) || [],
          created_at: row.created_at,
          updated_at: row.updated_at
        };
      });

      summaryCurrent.load_factor =
        summaryCurrent.available_seats > 0
          ? Math.round(
              (
                summaryCurrent.passengers /
                summaryCurrent.available_seats
              ) * 10000
            ) / 10000
          : 0;

      summaryPrevious.load_factor =
        summaryPrevious.available_seats > 0
          ? Math.round(
              (
                summaryPrevious.passengers /
                summaryPrevious.available_seats
              ) * 10000
            ) / 10000
          : 0;

      return res.json({
        ok: true,
        endpoint: "ACS_MY_ROUTES_OCC",
        version: "v1.0",
        authority: "POSTGRESQL_MY_ROUTES_OCC",
        current_sim_time: currentSimTime,
        airline_id: airlineId,
        airline: {
          airline_id: ACS_MR_integer(airline.airline_id),
          airline_name: airline.airline_name || null,
          iata: airline.iata || null,
          icao: airline.icao || null,
          color_hex: airline.color_hex || null
        },
        summary: {
          active_routes: routes.length,
          ...ACS_MR_buildTrend(
            summaryCurrent,
            summaryPrevious
          ),
          passenger_data_status: "LEGACY_SETTLEMENT"
        },
        routes,
        count: routes.length
      });
    } catch (error) {
      console.error("ACS MY ROUTES OCC ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "MY_ROUTES_OCC_QUERY_FAILED",
        details: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   GET /v1/routes/my-routes-occ/:routePlanId/airport-market
   ------------------------------------------------------------
   Returns active route-aircraft assignments that operate at the
   selected own route destination airport.

   The selected route must belong to the authenticated airline.
   Active route plans are returned even when no settled flights
   exist yet. Recorded traffic covers the last 7 ACS days.
   ============================================================ */

router.get(
  "/routes/my-routes-occ/:routePlanId/airport-market",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const routePlanId = Number(req.params.routePlanId);
    const requestedPage = Number(req.query.page || 1);
    const requestedLimit = Number(req.query.limit || 50);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!Number.isInteger(routePlanId) || routePlanId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ROUTE_PLAN_ID"
      });
    }

    const page =
      Number.isInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;

    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;

    const offset = (page - 1) * limit;
    const client = await pool.connect();

    try {
      const clockResult = await client.query(`
        SELECT acs_get_current_sim_time() AS current_sim_time
      `);

      const currentSimTime =
        clockResult.rows[0]?.current_sim_time || null;

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_AUTHORITY_UNAVAILABLE"
        });
      }

      const selectedRouteResult = await client.query(
        `
        SELECT
          route.id AS route_plan_id,
          route.origin,
          route.destination,
          route.route_state,
          route.route_type
        FROM public.route_plans route
        WHERE route.id = $1
          AND route.airline_id = $2
          AND UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
        LIMIT 1
        `,
        [routePlanId, airlineId]
      );

      const selectedRoute = selectedRouteResult.rows[0] || null;

      if (!selectedRoute) {
        return res.status(404).json({
          ok: false,
          error: "OWN_ACTIVE_ROUTE_NOT_FOUND"
        });
      }

      const airportIcao = String(
        selectedRoute.destination || ""
      )
        .trim()
        .toUpperCase();

      if (!airportIcao) {
        return res.status(422).json({
          ok: false,
          error: "ROUTE_DESTINATION_UNAVAILABLE"
        });
      }

      const countResult = await client.query(
        `
        SELECT COUNT(*)::integer AS total
        FROM public.route_plans route
        WHERE UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
          AND (
            UPPER(route.origin) = $1
            OR UPPER(route.destination) = $1
          )
        `,
        [airportIcao]
      );

      const total = ACS_MR_integer(
        countResult.rows[0]?.total
      );

      const marketResult = await client.query(
        `
        WITH clock AS MATERIALIZED (
          SELECT $2::timestamp AS sim_time
        )
        SELECT
          route.id AS route_plan_id,
          route.route_uid,
          route.airline_id,
          route.origin,
          route.destination,
          route.route_state,
          route.route_type,
          route.selected_days,
          route.flight_number_out,
          route.flight_number_in,
          route.distance_nm,
          route.aircraft_id,
          route.registration,
          route.model_key,
          route.aircraft,

          airline.airline_name,
          airline.iata,
          airline.icao,
          airline.color_hex,
          airline.color_hsl,
          airline.color_index,

          fleet.aircraft_uid,
          fleet.registration AS fleet_registration,
          fleet.model_key AS fleet_model_key,
          fleet.aircraft_name AS fleet_aircraft_name,
          fleet.manufacturer AS fleet_manufacturer,

          catalog.model_key AS catalog_model_key,
          catalog.manufacturer AS catalog_manufacturer,
          catalog.model AS catalog_model,
          catalog.aircraft_name AS catalog_aircraft_name,

          COALESCE(traffic.flights, 0)::integer AS flights,
          COALESCE(traffic.passengers, 0)::bigint AS passengers,
          COALESCE(traffic.available_seats, 0)::bigint
            AS available_seats

        FROM public.route_plans route
        CROSS JOIN clock

        INNER JOIN public.airlines airline
          ON airline.airline_id = route.airline_id

        LEFT JOIN public.aircraft_fleet fleet
          ON fleet.id = route.aircraft_id
         AND fleet.airline_id = route.airline_id

        LEFT JOIN public.aircraft_catalog catalog
          ON LOWER(catalog.model_key) = LOWER(
            COALESCE(fleet.model_key, route.model_key)
          )

        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS flights,
            COALESCE(
              SUM(occurrence.settled_passengers),
              0
            )::bigint AS passengers,
            COALESCE(
              SUM(
                CASE
                  WHEN occurrence.settled_load_factor > 0
                    THEN ROUND(
                      occurrence.settled_passengers::numeric /
                      occurrence.settled_load_factor
                    )
                  ELSE 0
                END
              ),
              0
            )::bigint AS available_seats
          FROM public.flight_occurrences occurrence
          WHERE occurrence.route_plan_id = route.id
            AND occurrence.airline_id = route.airline_id
            AND occurrence.settled_at IS NOT NULL
            AND occurrence.arrived_at >=
              clock.sim_time - INTERVAL '7 days'
            AND occurrence.arrived_at < clock.sim_time
        ) traffic ON true

        WHERE UPPER(COALESCE(route.route_state, 'ACTIVE')) = 'ACTIVE'
          AND UPPER(COALESCE(route.route_type, 'PASSENGER')) = 'PASSENGER'
          AND (
            UPPER(route.origin) = $1
            OR UPPER(route.destination) = $1
          )

        ORDER BY
          COALESCE(traffic.passengers, 0) DESC,
          airline.airline_name ASC,
          route.origin ASC,
          route.destination ASC,
          route.id ASC

        LIMIT $3
        OFFSET $4
        `,
        [airportIcao, currentSimTime, limit, offset]
      );

      const operators = marketResult.rows.map(row => {
        const passengers = ACS_MR_integer(row.passengers);
        const availableSeats = ACS_MR_integer(
          row.available_seats
        );

        return {
          route_plan_id: ACS_MR_integer(row.route_plan_id),
          route_uid: row.route_uid || null,
          is_own_airline:
            ACS_MR_integer(row.airline_id) === airlineId,
          airline: {
            airline_id: ACS_MR_integer(row.airline_id),
            airline_name: row.airline_name || null,
            iata: row.iata || null,
            icao: row.icao || null,
            color_hex: row.color_hex || null,
            color_hsl: row.color_hsl || null,
            color_index:
              row.color_index === null
                ? null
                : ACS_MR_integer(row.color_index)
          },
          route: {
            origin: row.origin || null,
            destination: row.destination || null,
            route_state: row.route_state || null,
            route_type: row.route_type || null,
            selected_days:
              Array.isArray(row.selected_days)
                ? row.selected_days
                : [],
            frequency_per_week:
              Array.isArray(row.selected_days)
                ? row.selected_days.length
                : 0,
            flight_numbers: {
              outbound: row.flight_number_out || null,
              return: row.flight_number_in || null
            },
            distance_nm: ACS_MR_integer(row.distance_nm)
          },
          aircraft: {
            aircraft_id:
              row.aircraft_id === null
                ? null
                : ACS_MR_integer(row.aircraft_id),
            aircraft_uid: row.aircraft_uid || null,
            registration:
              row.fleet_registration ||
              row.registration ||
              null,
            model_key:
              row.catalog_model_key ||
              row.fleet_model_key ||
              row.model_key ||
              null,
            manufacturer:
              row.catalog_manufacturer ||
              row.fleet_manufacturer ||
              null,
            model: row.catalog_model || null,
            aircraft_name:
              row.catalog_aircraft_name ||
              row.fleet_aircraft_name ||
              row.aircraft ||
              null
          },
          last_7_days: {
            flights: ACS_MR_integer(row.flights),
            passengers,
            available_seats: availableSeats,
            load_factor:
              availableSeats > 0
                ? Math.round(
                    (passengers / availableSeats) * 10000
                  ) / 10000
                : 0
          },
          traffic_data_status:
            "LEGACY_SETTLEMENT"
        };
      });

      const totalPages =
        total > 0 ? Math.ceil(total / limit) : 0;

      return res.json({
        ok: true,
        endpoint: "ACS_AIRPORT_ROUTE_MARKET",
        authority: "POSTGRESQL_AIRPORT_ROUTE_MARKET",
        current_sim_time: currentSimTime,
        airline_id: airlineId,
        selected_route: {
          route_plan_id: ACS_MR_integer(
            selectedRoute.route_plan_id
          ),
          origin: selectedRoute.origin || null,
          destination: selectedRoute.destination || null
        },
        airport_icao: airportIcao,
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          has_previous: page > 1,
          has_next: page < totalPages
        },
        operators,
        count: operators.length
      });
    } catch (error) {
      console.error(
        "ACS AIRPORT ROUTE MARKET ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "AIRPORT_ROUTE_MARKET_QUERY_FAILED",
        details: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   GET /v1/routes/my-routes-occ/:routePlanId/fares
   ------------------------------------------------------------
   Reads the historical reference fare and the currently
   applicable manual adjustment for each available cabin class.
   ============================================================ */

router.get(
  "/routes/my-routes-occ/:routePlanId/fares",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const routePlanId = Number(req.params.routePlanId);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!Number.isInteger(routePlanId) || routePlanId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ROUTE_PLAN_ID"
      });
    }

    const client = await pool.connect();

    try {
      const clockResult = await client.query(`
        SELECT acs_get_current_sim_time() AS current_sim_time
      `);

      const currentSimTime =
        clockResult.rows[0]?.current_sim_time || null;

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_AUTHORITY_UNAVAILABLE"
        });
      }

      const routeResult = await client.query(
        `
        SELECT
          id AS route_plan_id,
          origin,
          destination,
          distance_nm,
          route_state,
          route_type
        FROM public.route_plans
        WHERE id = $1
          AND airline_id = $2
        LIMIT 1
        `,
        [routePlanId, airlineId]
      );

      const route = routeResult.rows[0] || null;

      if (!route) {
        return res.status(404).json({
          ok: false,
          error: "OWN_ROUTE_NOT_FOUND"
        });
      }

      const fareResult = await client.query(
        `
        SELECT resolved.*
        FROM public.acs_historical_fare_rules fare_rule

        INNER JOIN public.acs_economic_periods economic_period
          ON economic_period.period_code = fare_rule.period_code

        CROSS JOIN LATERAL
          public.acs_resolve_route_fare(
            $1,
            $2,
            fare_rule.service_class,
            $3::timestamp
          ) resolved

        WHERE fare_rule.is_active = true
          AND EXTRACT(YEAR FROM $3::timestamp)::integer
            BETWEEN fare_rule.effective_from_year
                AND fare_rule.effective_to_year
          AND EXTRACT(YEAR FROM $3::timestamp)::integer
            BETWEEN economic_period.start_year
                AND economic_period.end_year

        ORDER BY
          CASE fare_rule.service_class
            WHEN 'Y' THEN 1
            WHEN 'C' THEN 2
            WHEN 'F' THEN 3
            ELSE 4
          END
        `,
        [airlineId, routePlanId, currentSimTime]
      );

      return res.json({
        ok: true,
        endpoint: "ACS_MY_ROUTE_FARES",
        authority: "POSTGRESQL_HISTORICAL_FARE_AUTHORITY",
        current_sim_time: currentSimTime,
        airline_id: airlineId,
        route: {
          route_plan_id: ACS_MR_integer(route.route_plan_id),
          origin: route.origin || null,
          destination: route.destination || null,
          distance_nm: ACS_MR_integer(route.distance_nm),
          route_state: route.route_state || null,
          route_type: route.route_type || null
        },
        fares: fareResult.rows,
        count: fareResult.rows.length
      });
    } catch (error) {
      console.error("ACS MY ROUTE FARES ERROR:", error);

      return res.status(500).json({
        ok: false,
        error: "MY_ROUTE_FARES_QUERY_FAILED",
        details: error.message
      });
    } finally {
      client.release();
    }
  }
);

export default router;

