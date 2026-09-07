/* ============================================================
   ACS OCC — AIRPORT INTELLIGENCE BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   File: routes/airport_intelligence.js

   PURPOSE
   - Read-only Airport Intelligence snapshot.
   - PostgreSQL simulation time is authoritative.
   - Reuses existing ACS airport / slot / route / pax authorities.
   - No recommendations.
   - No strategic scoring.
   - No operational writes.
   - No frontend year authority.
   - No localStorage authority.

   ENDPOINT
   GET /v1/airport-intelligence/:icao

   DATA FAMILIES
   - Airport profile / historical era
   - Slots
   - Passenger movement
   - Scheduled network activity
   - Airlines operating
   - Served destinations
   - Known airport charges

   PLAYER AUTHORITY
   - ACS presents information.
   - The player interprets.
   - The player evaluates.
   - The player decides.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();


/* ============================================================
   ACS REGION AUTHORITY
   ------------------------------------------------------------
   Keep the same Middle East presentation rule already used by
   routes/airports.js.
   ============================================================ */

const ACS_AI_REGION_SQL = `
  CASE
    WHEN UPPER(aa.country) IN (
      'AE',
      'BH',
      'IQ',
      'IR',
      'IL',
      'JO',
      'KW',
      'LB',
      'OM',
      'PS',
      'QA',
      'SA',
      'SY',
      'TR',
      'YE'
    )
    THEN 'Middle East'
    ELSE aa.continent
  END
`;


/* ============================================================
   HELPERS
   ============================================================ */

function ACS_AI_integer(value) {

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
}


function ACS_AI_number(value) {

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return parsed;
}


function ACS_AI_nullableNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}


function ACS_AI_text(value) {

  return String(value ?? "").trim();
}


function ACS_AI_nullableText(value) {

  const text = ACS_AI_text(value);

  return text || null;
}


function ACS_AI_normalizeIcao(value) {

  return ACS_AI_text(value)
    .toUpperCase();
}


function ACS_AI_countryName(countryCode) {

  const raw =
    ACS_AI_text(countryCode);

  if (!raw) {
    return null;
  }

  /*
   * airport_catalog currently uses ISO-like country codes
   * in multiple ACS authorities.
   *
   * Convert them only for user-facing display.
   * PostgreSQL country authority remains unchanged.
   */
  if (/^[A-Z]{2}$/i.test(raw)) {

    try {

      const names =
        new Intl.DisplayNames(
          ["en"],
          {
            type: "region"
          }
        );

      const display =
        names.of(
          raw.toUpperCase()
        );

      if (
        display &&
        display !== raw.toUpperCase()
      ) {
        return display;
      }

    } catch (err) {

      /*
       * Display formatting must never break
       * the Airport Intelligence endpoint.
       */
    }
  }

  return raw;
}


function ACS_AI_buildAirportLabel(
  icao,
  city,
  country
) {

  const cleanIcao =
    ACS_AI_normalizeIcao(icao);

  const cleanCity =
    ACS_AI_text(city);

  const countryName =
    ACS_AI_countryName(country);

  const location =
    [
      cleanCity,
      countryName
    ]
      .filter(Boolean)
      .join(", ");

  if (!location) {
    return cleanIcao;
  }

  return `${cleanIcao} — ${location}`;
}


function ACS_AI_aircraftTypes(value) {

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => ACS_AI_text(item))
    .filter(Boolean);
}


/* ============================================================
   HEALTH
   ============================================================ */

router.get(
  "/airport-intelligence/health",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT
            acs_get_current_sim_time()
              AS current_sim_time,

            COUNT(*)::INTEGER
              AS available_airports

          FROM public.v_acs_airport_authority_current
          `
        );

      return res.json({
        ok: true,

        module:
          "airport-intelligence",

        version:
          "v1.0",

        authority:
          "POSTGRESQL_ACS_AIRPORT_INTELLIGENCE",

        airline_id:
          Number(req.airline_id),

        current_sim_time:
          result.rows[0]
            ?.current_sim_time || null,

        available_airports:
          ACS_AI_integer(
            result.rows[0]
              ?.available_airports
          )
      });

    } catch (err) {

      console.error(
        "ACS AIRPORT INTELLIGENCE HEALTH ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRPORT_INTELLIGENCE_HEALTH_FAILED"
      });
    }
  }
);


/* ============================================================
   GET /v1/airport-intelligence/:icao
   ------------------------------------------------------------
   One canonical read-only snapshot for the selected airport.

   IMPORTANT
   - The PostgreSQL ACS clock is read once.
   - Every query uses that same simulation instant.
   - Passenger movement = actual ARRIVED + CONSUMED traffic
     from the beginning of the current ACS month up to now.
   - Scheduled network = current ACTIVE passenger route plans.
   - Weekly flights = airport movements generated by the current
     route-plan weekly pattern:
       selected_days × 2
     because every round-trip route touches each endpoint once
     outbound and once inbound per selected operating day.
   ============================================================ */

router.get(
  "/airport-intelligence/:icao",
  requireAuth,
  async (req, res) => {

    const airlineId =
      Number(req.airline_id);

    if (
      !Number.isInteger(airlineId) ||
      airlineId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "NO_AIRLINE_SESSION"
      });
    }


    const icao =
      ACS_AI_normalizeIcao(
        req.params?.icao
      );

    if (!/^[A-Z0-9]{4}$/.test(icao)) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_ICAO"
      });
    }


    const client =
      await pool.connect();

    let transactionStarted =
      false;


    try {

      /* ========================================================
         1) READ-ONLY CONSISTENT SNAPSHOT
         ======================================================== */

      await client.query(
        `
        BEGIN
        ISOLATION LEVEL REPEATABLE READ
        READ ONLY
        `
      );

      transactionStarted =
        true;


      /* ========================================================
         2) CANONICAL ACS TIME
         ======================================================== */

      const clockResult =
        await client.query(
          `
          SELECT
            acs_get_current_sim_time()
              AS current_sim_time
          `
        );

      const currentSimTime =
        clockResult.rows[0]
          ?.current_sim_time || null;


      if (!currentSimTime) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted =
          false;

        return res.status(503).json({
          ok: false,
          error:
            "ACS_TIME_UNAVAILABLE"
        });
      }


      /* ========================================================
         3) AIRPORT + HISTORICAL + SLOT AUTHORITY
         --------------------------------------------------------
         Mirrors the same authorities used by routes/airports.js.
         ======================================================== */

      const airportResult =
        await client.query(
          `
          WITH reserved_slots AS MATERIALIZED (

            SELECT
              airport_icao AS icao,

              COUNT(*)::INTEGER
                AS reserved_slots

            FROM public.airport_slot_bookings

            WHERE slot_status = 'RESERVED'
              AND UPPER(airport_icao) = $1

            GROUP BY
              airport_icao
          )

          SELECT
            aa.airport_id AS id,

            aa.icao,
            aa.iata,
            aa.city,
            aa.country,

            aa.continent
              AS geographic_continent,

            ${ACS_AI_REGION_SQL}
              AS continent,

            aa.region,

            aa.latitude,
            aa.longitude,
            aa.elevation_ft,

            aa.runway_m
              AS runway_m_base,

            COALESCE(
              ahp.runway_m,
              aa.runway_m
            )::INTEGER
              AS runway_m,

            aa.open_hrs
              AS open_hrs_base,

            COALESCE(
              ahp.open_hrs,
              aa.open_hrs
            )
              AS open_hrs,

            aa.category
              AS category_base,

            COALESCE(
              ahp.category,
              aa.category
            )
              AS category,

            aa.aircraft_limit
              AS aircraft_limit_base,

            COALESCE(
              ahp.aircraft_limit,
              aa.aircraft_limit
            )
              AS aircraft_limit,

            aa.demand_y,
            aa.demand_c,
            aa.demand_f,

            aa.slot_cost_usd
              AS slot_cost_base_usd,

            COALESCE(
              ahp.slot_cost_usd,
              aa.slot_cost_usd
            )
              AS slot_cost_usd,

            aa.landing_fee_usd
              AS landing_fee_base_usd,

            COALESCE(
              ahp.landing_fee_usd,
              aa.landing_fee_usd
            )
              AS landing_fee_usd,

            aa.ticket_fee_percent
              AS ticket_fee_percent_base,

            COALESCE(
              ahp.ticket_fee_percent,
              aa.ticket_fee_percent
            )
              AS ticket_fee_percent,

            aa.pax_growth_factor
              AS pax_growth_factor_base,

            COALESCE(
              ahp.pax_growth_factor,
              aa.pax_growth_factor
            )
              AS pax_growth_factor,

            aa.slot_capacity
              AS slot_capacity_base,

            COALESCE(
              ahp.slot_capacity,
              aa.slot_capacity,
              0
            )::INTEGER
              AS slot_capacity,

            COALESCE(
              rs.reserved_slots,
              0
            )::INTEGER
              AS reserved_slots,

            GREATEST(
              COALESCE(
                ahp.slot_capacity,
                aa.slot_capacity,
                0
              )
              -
              COALESCE(
                rs.reserved_slots,
                0
              ),
              0
            )::INTEGER
              AS available_slots,

            CASE
              WHEN COALESCE(
                ahp.slot_capacity,
                aa.slot_capacity,
                0
              ) > 0
              THEN ROUND(
                (
                  COALESCE(
                    rs.reserved_slots,
                    0
                  )::NUMERIC
                  /
                  COALESCE(
                    ahp.slot_capacity,
                    aa.slot_capacity
                  )::NUMERIC
                ) * 100,
                2
              )
              ELSE 0
            END
              AS slot_utilization_pct,

            aa.current_sim_time,
            aa.sim_year,
            aa.sim_month,

            aa.commercial_open_year,
            aa.commercial_open_date,
            aa.commercial_close_year,
            aa.commercial_close_date,

            aa.opening_date_precision,
            aa.historical_data_quality,

            aa.operational_role,
            aa.availability_basis,

            aa.passenger_service,
            aa.scheduled_service,

            aa.base_operation_allowed,
            aa.passenger_route_allowed,
            aa.slot_reservation_allowed,
            aa.schedule_operation_allowed,
            aa.aircraft_delivery_allowed,
            aa.aircraft_positioning_allowed,

            aa.emergency_diversion_allowed,
            aa.skytrack_visible,
            aa.global_events_visible,

            aa.operational_data_quality,

            aa.effective_from_year,
            aa.effective_to_year,

            (ahp.id IS NOT NULL)
              AS historical_profile_applied,

            ahp.id
              AS historical_profile_id,

            ahp.era_from,
            ahp.era_to,
            ahp.era_label,
            ahp.expansion_stage,

            COALESCE(
              ahp.airport_status,
              'ACTIVE'
            )
              AS airport_status,

            ahp.source
              AS historical_profile_source

          FROM public.v_acs_airport_authority_current aa

          LEFT JOIN LATERAL (

            SELECT
              hp.*

            FROM public.airport_historical_profiles hp

            WHERE UPPER(hp.airport_icao) =
                  UPPER(aa.icao)

              AND aa.sim_year
                  BETWEEN
                    hp.era_from
                    AND hp.era_to

            ORDER BY
              hp.era_from DESC

            LIMIT 1

          ) ahp
            ON TRUE

          LEFT JOIN reserved_slots rs
            ON UPPER(rs.icao) =
               UPPER(aa.icao)

          WHERE UPPER(aa.icao) = $1

          LIMIT 1
          `,
          [
            icao
          ]
        );


      if (!airportResult.rows.length) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted =
          false;

        return res.status(404).json({
          ok: false,
          error:
            "AIRPORT_NOT_AVAILABLE_IN_CURRENT_SIM_PERIOD",
          icao
        });
      }


      const airport =
        airportResult.rows[0];


      /* ========================================================
         4) PASSENGER MOVEMENT — CURRENT ACS MONTH
         --------------------------------------------------------
         Actual traffic only:
         - ARRIVED occurrence
         - settled
         - CONSUMED ACS_GLOBAL_PAX_V3 result
         - origin OR destination touches selected airport
         ======================================================== */

      const passengerMovementResult =
        await client.query(
          `
          WITH clock AS MATERIALIZED (
            SELECT
              $2::TIMESTAMP
                AS sim_time,

              DATE_TRUNC(
                'month',
                $2::TIMESTAMP
              )
                AS month_start
          )

          SELECT
            COUNT(
              DISTINCT occurrence.id
            )::INTEGER
              AS movements,

            COALESCE(
              SUM(
                COALESCE(
                  passenger_result.captured_y,
                  0
                )
                +
                COALESCE(
                  passenger_result.captured_c,
                  0
                )
                +
                COALESCE(
                  passenger_result.captured_f,
                  0
                )
              ),
              0
            )::BIGINT
              AS passengers,

            COALESCE(
              SUM(
                passenger_result.offered_seats
              ),
              0
            )::BIGINT
              AS offered_seats,

            COUNT(
              DISTINCT occurrence.airline_id
            )::INTEGER
              AS operating_airlines,

            COUNT(
              DISTINCT occurrence.route_plan_id
            )::INTEGER
              AS operated_routes,

            MIN(
              occurrence.arrived_at
            )
              AS first_recorded_arrival,

            MAX(
              occurrence.arrived_at
            )
              AS last_recorded_arrival

          FROM public.flight_occurrences occurrence

          CROSS JOIN clock

          INNER JOIN
            public.acs_passenger_flight_results
              passenger_result

            ON passenger_result.occurrence_id =
               occurrence.id

           AND passenger_result.result_status =
               'CONSUMED'

          WHERE occurrence.operational_status =
                'ARRIVED'

            AND occurrence.settled_at
                IS NOT NULL

            AND occurrence.arrived_at
                IS NOT NULL

            AND occurrence.arrived_at >=
                clock.month_start

            AND occurrence.arrived_at <
                clock.sim_time

            AND (
              UPPER(occurrence.origin) = $1
              OR
              UPPER(occurrence.destination) = $1
            )
          `,
          [
            icao,
            currentSimTime
          ]
        );


      /* ========================================================
         5) CURRENT ACTIVE OPERATIONS
         --------------------------------------------------------
         Snapshot only. No status interpretation.
         ======================================================== */

      const activeOperationsResult =
        await client.query(
          `
          SELECT
            COUNT(*)::INTEGER
              AS active_flights,

            COUNT(
              DISTINCT airline_id
            )::INTEGER
              AS active_airlines

          FROM public.flight_occurrences

          WHERE operational_status IN (
            'DISPATCHED',
            'EN_ROUTE'
          )

            AND (
              UPPER(origin) = $1
              OR
              UPPER(destination) = $1
            )
          `,
          [
            icao
          ]
        );


      /* ========================================================
         6) SCHEDULED NETWORK SUMMARY
         --------------------------------------------------------
         Route plans are round-trip network authority.
         selected_days is JSONB in route_plans.
         ======================================================== */

      const networkSummaryResult =
        await client.query(
          `
          SELECT
            COUNT(
              DISTINCT route.id
            )::INTEGER
              AS active_routes,

            COUNT(
              DISTINCT route.airline_id
            )::INTEGER
              AS airlines,

            COALESCE(
              SUM(
                JSONB_ARRAY_LENGTH(
                  COALESCE(
                    route.selected_days,
                    '[]'::JSONB
                  )
                ) * 2
              ),
              0
            )::INTEGER
              AS weekly_flights,

            COUNT(
              DISTINCT CASE
                WHEN UPPER(route.origin) = $1
                  THEN UPPER(route.destination)

                WHEN UPPER(route.destination) = $1
                  THEN UPPER(route.origin)

                ELSE NULL
              END
            )::INTEGER
              AS destinations

          FROM public.route_plans route

          WHERE UPPER(
            COALESCE(
              route.route_state,
              'ACTIVE'
            )
          ) = 'ACTIVE'

            AND UPPER(
              COALESCE(
                route.route_type,
                'PASSENGER'
              )
            ) = 'PASSENGER'

            AND (
              UPPER(route.origin) = $1
              OR
              UPPER(route.destination) = $1
            )
          `,
          [
            icao
          ]
        );


      /* ========================================================
         7) AIRLINES OPERATING THIS AIRPORT
         --------------------------------------------------------
         Scheduled ACTIVE passenger network.
         No score / no ranking judgement.
         Ordering is factual:
         weekly movements, then airline name.
         ======================================================== */
const airlinesResult =
  await client.query(
    `
    SELECT
      airline.airline_id,
      airline.airline_name,
      airline.iata,
      airline.icao,

      MAX(
        UPPER(
          BTRIM(player.base_icao)
        )
      )
        AS base_icao,

      MAX(
        base_airport.city
      )
        AS base_city,

      COUNT(
        DISTINCT route.id
      )::INTEGER
        AS routes,

      COALESCE(
        SUM(
          JSONB_ARRAY_LENGTH(
            COALESCE(
              route.selected_days,
              '[]'::JSONB
            )
          ) * 2
        ),
        0
      )::INTEGER
        AS weekly_flights,

      COUNT(
        DISTINCT CASE
          WHEN UPPER(route.origin) = $1
            THEN UPPER(route.destination)

          WHEN UPPER(route.destination) = $1
            THEN UPPER(route.origin)

          ELSE NULL
        END
      )::INTEGER
        AS destinations,

      ARRAY_AGG(
        DISTINCT COALESCE(
          NULLIF(
            BTRIM(route.aircraft),
            ''
          ),
          NULLIF(
            BTRIM(route.model_key),
            ''
          )
        )
      )
      FILTER (
        WHERE COALESCE(
          NULLIF(
            BTRIM(route.aircraft),
            ''
          ),
          NULLIF(
            BTRIM(route.model_key),
            ''
          )
        ) IS NOT NULL
      )
        AS aircraft_types

    FROM public.route_plans route

    INNER JOIN public.airlines airline
      ON airline.airline_id =
         route.airline_id

    LEFT JOIN public.users player
      ON player.airline_id =
         airline.airline_id

    LEFT JOIN public.v_acs_airport_authority_current base_airport
      ON UPPER(BTRIM(base_airport.icao)) =
         UPPER(BTRIM(player.base_icao))

    WHERE UPPER(
      COALESCE(
        route.route_state,
        'ACTIVE'
      )
    ) = 'ACTIVE'

      AND UPPER(
        COALESCE(
          route.route_type,
          'PASSENGER'
        )
      ) = 'PASSENGER'

      AND (
        UPPER(route.origin) = $1
        OR
        UPPER(route.destination) = $1
      )

    GROUP BY
      airline.airline_id,
      airline.airline_name,
      airline.iata,
      airline.icao

    ORDER BY
      weekly_flights DESC,
      airline.airline_name ASC,
      airline.airline_id ASC
    `,
    [
      icao
    ]
  );

      /* ========================================================
         8) SERVED DESTINATIONS
         --------------------------------------------------------
         Uses airport_catalog only to obtain city / country context.
         No recommendation logic.
         ======================================================== */

      const destinationsResult =
        await client.query(
          `
          WITH destination_routes AS (

            SELECT
              route.id,
              route.airline_id,

              CASE
                WHEN UPPER(route.origin) = $1
                  THEN UPPER(route.destination)

                WHEN UPPER(route.destination) = $1
                  THEN UPPER(route.origin)

                ELSE NULL
              END
                AS destination_icao,

              JSONB_ARRAY_LENGTH(
                COALESCE(
                  route.selected_days,
                  '[]'::JSONB
                )
              ) * 2
                AS weekly_flights,

              COALESCE(
                NULLIF(
                  BTRIM(route.aircraft),
                  ''
                ),
                NULLIF(
                  BTRIM(route.model_key),
                  ''
                )
              )
                AS aircraft_type

            FROM public.route_plans route

            WHERE UPPER(
              COALESCE(
                route.route_state,
                'ACTIVE'
              )
            ) = 'ACTIVE'

              AND UPPER(
                COALESCE(
                  route.route_type,
                  'PASSENGER'
                )
              ) = 'PASSENGER'

              AND (
                UPPER(route.origin) = $1
                OR
                UPPER(route.destination) = $1
              )
          )

          SELECT
            destination_routes.destination_icao
              AS icao,

            airport.iata,
            airport.city,
            airport.country,

            COUNT(
              DISTINCT destination_routes.airline_id
            )::INTEGER
              AS airlines,

            COUNT(
              DISTINCT destination_routes.id
            )::INTEGER
              AS routes,

            COALESCE(
              SUM(
                destination_routes.weekly_flights
              ),
              0
            )::INTEGER
              AS weekly_flights,

            ARRAY_AGG(
              DISTINCT
                destination_routes.aircraft_type
            )
            FILTER (
              WHERE
                destination_routes.aircraft_type
                IS NOT NULL
            )
              AS aircraft_types

          FROM destination_routes

          LEFT JOIN public.airport_catalog airport
            ON UPPER(airport.icao) =
               destination_routes.destination_icao

          WHERE destination_routes.destination_icao
                IS NOT NULL

          GROUP BY
            destination_routes.destination_icao,
            airport.iata,
            airport.city,
            airport.country

          ORDER BY
            weekly_flights DESC,
            destination_routes.destination_icao ASC
          `,
          [
            icao
          ]
        );


      /* ========================================================
         9) COMMIT READ-ONLY SNAPSHOT
         ======================================================== */

      await client.query(
        "COMMIT"
      );

      transactionStarted =
        false;


      /* ========================================================
         10) RESPONSE NORMALIZATION
         ======================================================== */

      const passengerMovement =
        passengerMovementResult.rows[0] || {};

      const activeOperations =
        activeOperationsResult.rows[0] || {};

      const networkSummary =
        networkSummaryResult.rows[0] || {};


      const countryName =
        ACS_AI_countryName(
          airport.country
        );


      const airportLabel =
        ACS_AI_buildAirportLabel(
          airport.icao,
          airport.city,
          airport.country
        );


      const airlines =
        airlinesResult.rows.map(
          row => ({
            is_own_airline:
              ACS_AI_integer(
                row.airline_id
              ) === airlineId,

            airline_id:
              ACS_AI_integer(
                row.airline_id
              ),

            airline_name:
              ACS_AI_nullableText(
                row.airline_name
              ),

            iata:
              ACS_AI_nullableText(
                row.iata
              ),

            icao:
              ACS_AI_nullableText(
                row.icao
              ),

            routes:
              ACS_AI_integer(
                row.routes
              ),

            weekly_flights:
              ACS_AI_integer(
                row.weekly_flights
              ),

            destinations:
              ACS_AI_integer(
                row.destinations
              ),

            aircraft_types:
              ACS_AI_aircraftTypes(
                row.aircraft_types
              )
          })
        );


      const destinations =
        destinationsResult.rows.map(
          row => {

            const destinationCountryName =
              ACS_AI_countryName(
                row.country
              );

            return {
              icao:
                ACS_AI_nullableText(
                  row.icao
                ),

              iata:
                ACS_AI_nullableText(
                  row.iata
                ),

              city:
                ACS_AI_nullableText(
                  row.city
                ),

              country_code:
                ACS_AI_nullableText(
                  row.country
                ),

              country:
                destinationCountryName,

              label:
                ACS_AI_buildAirportLabel(
                  row.icao,
                  row.city,
                  row.country
                ),

              airlines:
                ACS_AI_integer(
                  row.airlines
                ),

              routes:
                ACS_AI_integer(
                  row.routes
                ),

              weekly_flights:
                ACS_AI_integer(
                  row.weekly_flights
                ),

              aircraft_types:
                ACS_AI_aircraftTypes(
                  row.aircraft_types
                )
            };
          }
        );


      return res.json({
        ok: true,

        endpoint:
          "ACS_AIRPORT_INTELLIGENCE",

        version:
          "v1.0",

        authority: {
          simulation_time:
            "public.acs_get_current_sim_time()",

          airport_availability:
            "public.v_acs_airport_authority_current",

          historical_profiles:
            "public.airport_historical_profiles",

          slot_bookings:
            "public.airport_slot_bookings",

          scheduled_network:
            "public.route_plans",

          airlines:
            "public.airlines",

          passenger_traffic:
            [
              "public.flight_occurrences",
              "public.acs_passenger_flight_results"
            ]
        },


        current_sim_time:
          currentSimTime,

        sim_year:
          ACS_AI_integer(
            airport.sim_year
          ),

        sim_month:
          ACS_AI_integer(
            airport.sim_month
          ),


        airport: {
          id:
            ACS_AI_integer(
              airport.id
            ),

          icao:
            ACS_AI_nullableText(
              airport.icao
            ),

          iata:
            ACS_AI_nullableText(
              airport.iata
            ),

          city:
            ACS_AI_nullableText(
              airport.city
            ),

          country_code:
            ACS_AI_nullableText(
              airport.country
            ),

          country:
            countryName,

          geographic_continent:
            ACS_AI_nullableText(
              airport.geographic_continent
            ),

          continent:
            ACS_AI_nullableText(
              airport.continent
            ),

          region:
            ACS_AI_nullableText(
              airport.region
            ),

          latitude:
            ACS_AI_nullableNumber(
              airport.latitude
            ),

          longitude:
            ACS_AI_nullableNumber(
              airport.longitude
            ),

          elevation_ft:
            ACS_AI_nullableNumber(
              airport.elevation_ft
            ),

          runway_m:
            ACS_AI_integer(
              airport.runway_m
            ),

          open_hrs:
            ACS_AI_nullableText(
              airport.open_hrs
            ),

          category:
            ACS_AI_nullableText(
              airport.category
            ),

          aircraft_limit:
            ACS_AI_nullableText(
              airport.aircraft_limit
            ),

          airport_status:
            ACS_AI_nullableText(
              airport.airport_status
            ),

          display_label:
            airportLabel
        },


        era: {
          historical_profile_applied:
            Boolean(
              airport.historical_profile_applied
            ),

          historical_profile_id:
            airport.historical_profile_id === null
              ? null
              : ACS_AI_integer(
                  airport.historical_profile_id
                ),

          era_from:
            airport.era_from === null
              ? null
              : ACS_AI_integer(
                  airport.era_from
                ),

          era_to:
            airport.era_to === null
              ? null
              : ACS_AI_integer(
                  airport.era_to
                ),

          era_label:
            ACS_AI_nullableText(
              airport.era_label
            ),

          expansion_stage:
            ACS_AI_nullableText(
              airport.expansion_stage
            ),

          source:
            ACS_AI_nullableText(
              airport.historical_profile_source
            )
        },


        activity: {
          passenger_movement: {
            period:
              "CURRENT_ACS_MONTH_TO_DATE",

            passengers:
              ACS_AI_integer(
                passengerMovement.passengers
              ),

            airport_movements:
              ACS_AI_integer(
                passengerMovement.movements
              ),

            offered_seats:
              ACS_AI_integer(
                passengerMovement.offered_seats
              ),

            airlines:
              ACS_AI_integer(
                passengerMovement.operating_airlines
              ),

            routes:
              ACS_AI_integer(
                passengerMovement.operated_routes
              ),

            first_recorded_arrival:
              passengerMovement.first_recorded_arrival
              || null,

            last_recorded_arrival:
              passengerMovement.last_recorded_arrival
              || null,

            traffic_data_status:
              "ACS_GLOBAL_PAX_V3"
          },


          slots: {
            capacity:
              ACS_AI_integer(
                airport.slot_capacity
              ),

            used:
              ACS_AI_integer(
                airport.reserved_slots
              ),

            available:
              ACS_AI_integer(
                airport.available_slots
              ),

            utilization_pct:
              ACS_AI_number(
                airport.slot_utilization_pct
              )
          },


          scheduled_network: {
            airlines:
              ACS_AI_integer(
                networkSummary.airlines
              ),

            active_routes:
              ACS_AI_integer(
                networkSummary.active_routes
              ),

            weekly_flights:
              ACS_AI_integer(
                networkSummary.weekly_flights
              ),

            destinations:
              ACS_AI_integer(
                networkSummary.destinations
              )
          },


          current_operations: {
            active_flights:
              ACS_AI_integer(
                activeOperations.active_flights
              ),

            active_airlines:
              ACS_AI_integer(
                activeOperations.active_airlines
              )
          }
        },


        costs: {
          slot_cost_usd:
            ACS_AI_nullableNumber(
              airport.slot_cost_usd
            ),

          landing_fee_usd:
            ACS_AI_nullableNumber(
              airport.landing_fee_usd
            ),

          ticket_fee_percent:
            ACS_AI_nullableNumber(
              airport.ticket_fee_percent
            ),

          pax_growth_factor:
            ACS_AI_nullableNumber(
              airport.pax_growth_factor
            ),

          source:
            airport.historical_profile_applied
              ? "CURRENT_HISTORICAL_PROFILE"
              : "AIRPORT_BASE_AUTHORITY"
        },


        network: {
          airlines,
          destinations
        }
      });


    } catch (err) {

      if (transactionStarted) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch (rollbackErr) {

          console.error(
            "ACS AIRPORT INTELLIGENCE ROLLBACK ERROR:",
            rollbackErr
          );
        }
      }


      console.error(
        "ACS AIRPORT INTELLIGENCE ERROR:",
        {
          icao,
          airline_id:
            airlineId,
          code:
            err?.code || null,
          message:
            err?.message || null,
          stack:
            err?.stack || null
        }
      );


      return res.status(500).json({
        ok: false,
        error:
          "AIRPORT_INTELLIGENCE_FAILED",

        details:
          err?.message || null
      });

    } finally {

      client.release();
    }
  }
);


export default router;
