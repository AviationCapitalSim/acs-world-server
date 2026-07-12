/* ============================================================
   ACS AIRPORT BACKEND AUTHORITY — READ API v3.0
   ------------------------------------------------------------
   File: routes/airports.js

   PostgreSQL authorities:
   - v_acs_airport_authority_current
   - airport_historical_profiles
   - airport_slot_bookings
   - acs_get_current_sim_time()

   No frontend year authority.
   No localStorage authority.
   Safe for ACS global operation.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const OPERATION_FILTERS = Object.freeze({
  base: "aa.base_operation_allowed = TRUE",
  route: "aa.passenger_route_allowed = TRUE",
  slot: "aa.slot_reservation_allowed = TRUE",
  schedule: "aa.schedule_operation_allowed = TRUE",
  delivery: "aa.aircraft_delivery_allowed = TRUE",
  positioning: "aa.aircraft_positioning_allowed = TRUE"
});

const ACS_REGION_SQL = `
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
   HEALTH
   ============================================================ */

router.get("/airports/health", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        acs_get_current_sim_time() AS current_sim_time,
        COUNT(*)::INTEGER AS active_airports,
        COUNT(DISTINCT country)::INTEGER AS active_countries
      FROM public.v_acs_airport_authority_current
    `);

    return res.json({
      ok: true,
      module: "airports",
      version: "v3.0",
      authority: "POSTGRESQL_ACS_AIRPORT_AUTHORITY",
      airline_id: req.airline_id,
      current_sim_time:
        result.rows[0]?.current_sim_time || null,
      active_airports:
        Number(result.rows[0]?.active_airports || 0),
      active_countries:
        Number(result.rows[0]?.active_countries || 0)
    });
  } catch (err) {
    console.error("ACS AIRPORT HEALTH ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRPORT_HEALTH_FAILED"
    });
  }
});

/* ============================================================
   GET /v1/airports/catalog

   Optional filters:
   - continent
   - country
   - region
   - category
   - q
   - operation:
       base
       route
       slot
       schedule
       delivery
       positioning
   - limit

   sim_year is intentionally ignored.
   PostgreSQL server time is authoritative.
   ============================================================ */

router.get("/airports/catalog", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const continent =
      String(req.query?.continent || "").trim();

    const country =
      String(req.query?.country || "")
        .trim()
        .toUpperCase();

    const region =
      String(req.query?.region || "").trim();

    const category =
      String(req.query?.category || "").trim();

    const q =
      String(req.query?.q || "").trim();

    const operation =
      String(req.query?.operation || "")
        .trim()
        .toLowerCase();

    if (
      operation &&
      !Object.prototype.hasOwnProperty.call(
        OPERATION_FILTERS,
        operation
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRPORT_OPERATION",
        allowed_operations:
          Object.keys(OPERATION_FILTERS)
      });
    }

    const requestedLimit =
      Number(req.query?.limit || 5000);

    const limit =
      Number.isFinite(requestedLimit) &&
      requestedLimit > 0
        ? Math.min(
            Math.floor(requestedLimit),
            5000
          )
        : 5000;

    const where = [];
    const values = [];

    if (continent) {
  values.push(continent);

  where.push(
    `${ACS_REGION_SQL} = $${values.length}`
  );
}

    if (country) {
      values.push(country);

      where.push(
        `UPPER(aa.country) = $${values.length}`
      );
    }

    if (region) {
      values.push(region);

      where.push(
        `aa.region = $${values.length}`
      );
    }

    if (category) {
      values.push(category);

      where.push(`
        COALESCE(
          ahp.category,
          aa.category
        ) = $${values.length}
      `);
    }

    if (q) {
      values.push(`%${q}%`);

      where.push(`
        (
          aa.icao ILIKE $${values.length}
          OR aa.iata ILIKE $${values.length}
          OR aa.city ILIKE $${values.length}
          OR aa.country ILIKE $${values.length}
          OR aa.region ILIKE $${values.length}
          OR aa.continent ILIKE $${values.length}
        )
      `);
    }

    if (operation) {
      where.push(OPERATION_FILTERS[operation]);
    }

    values.push(limit);

    const whereSql =
      where.length > 0
        ? `WHERE ${where.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
      WITH reserved_slots AS (
        SELECT
          airport_icao AS icao,
          COUNT(*)::INTEGER AS reserved_slots
        FROM public.airport_slot_bookings
        WHERE slot_status = 'RESERVED'
        GROUP BY airport_icao
      )
      SELECT
        aa.airport_id AS id,
        aa.icao,
        aa.iata,
        aa.city,
        aa.country,
        aa.continent AS geographic_continent,
        ${ACS_REGION_SQL} AS continent,
        aa.region,
        aa.latitude,
        aa.longitude,
        aa.elevation_ft,

        aa.runway_m AS runway_m_base,
        COALESCE(
          ahp.runway_m,
          aa.runway_m
        ) AS runway_m,

        aa.open_hrs AS open_hrs_base,
        COALESCE(
          ahp.open_hrs,
          aa.open_hrs
        ) AS open_hrs,

        aa.category AS category_base,
        COALESCE(
          ahp.category,
          aa.category
        ) AS category,

        aa.aircraft_limit AS aircraft_limit_base,
        COALESCE(
          ahp.aircraft_limit,
          aa.aircraft_limit
        ) AS aircraft_limit,

        aa.demand_y,
        aa.demand_c,
        aa.demand_f,

        aa.slot_cost_usd
          AS slot_cost_base_usd,

        COALESCE(
          ahp.slot_cost_usd,
          aa.slot_cost_usd
        ) AS slot_cost_usd,

        aa.landing_fee_usd
          AS landing_fee_base_usd,

        COALESCE(
          ahp.landing_fee_usd,
          aa.landing_fee_usd
        ) AS landing_fee_usd,

        aa.fuel_usd_gal
          AS fuel_base_usd_gal,

        COALESCE(
          ahp.fuel_usd_gal,
          aa.fuel_usd_gal
        ) AS fuel_usd_gal,

        aa.ticket_fee_percent
          AS ticket_fee_percent_base,

        COALESCE(
          ahp.ticket_fee_percent,
          aa.ticket_fee_percent
        ) AS ticket_fee_percent,

        aa.pax_growth_factor
          AS pax_growth_factor_base,

        COALESCE(
          ahp.pax_growth_factor,
          aa.pax_growth_factor
        ) AS pax_growth_factor,

        aa.slot_capacity
          AS slot_capacity_base,

        COALESCE(
          ahp.slot_capacity,
          aa.slot_capacity,
          0
        )::INTEGER AS slot_capacity,

        COALESCE(
          rs.reserved_slots,
          0
        )::INTEGER AS reserved_slots,

        GREATEST(
          COALESCE(
            ahp.slot_capacity,
            aa.slot_capacity,
            0
          ) - COALESCE(
            rs.reserved_slots,
            0
          ),
          0
        )::INTEGER AS available_slots,

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
        END AS slot_utilization_pct,

        aa.current_sim_time,
        aa.sim_year AS economic_year,
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

        ahp.id AS historical_profile_id,
        ahp.era_from,
        ahp.era_to,
        ahp.era_label,
        ahp.expansion_stage,

        COALESCE(
          ahp.airport_status,
          'ACTIVE'
        ) AS airport_status,

        ahp.source
          AS historical_profile_source,

        aa.notes,
        aa.source,
        aa.created_at,
        aa.updated_at

      FROM public.v_acs_airport_authority_current aa

      LEFT JOIN LATERAL (
        SELECT hp.*
        FROM public.airport_historical_profiles hp
        WHERE hp.airport_icao = aa.icao
          AND aa.sim_year
              BETWEEN hp.era_from AND hp.era_to
        ORDER BY hp.era_from DESC
        LIMIT 1
      ) ahp
        ON TRUE

      LEFT JOIN reserved_slots rs
        ON rs.icao = aa.icao

      ${whereSql}

      ORDER BY
       ${ACS_REGION_SQL},
       aa.country,
       aa.city,
       aa.icao

      LIMIT $${values.length}
      `,
      values
    );

    const firstAirport =
      result.rows[0] || null;

    return res.json({
      ok: true,
      endpoint: "ACS_AIRPORT_CATALOG",
      version: "v3.0",

      authority: {
        airport_availability:
          "public.v_acs_airport_authority_current",
        simulation_time:
          "public.acs_get_current_sim_time()",
        historical_profiles:
          "public.airport_historical_profiles",
        slot_bookings:
          "public.airport_slot_bookings"
      },

      airline_id: airlineId,

      current_sim_time:
        firstAirport?.current_sim_time || null,

      sim_year:
        firstAirport?.sim_year || null,

      sim_month:
        firstAirport?.sim_month || null,

      filters: {
        continent: continent || null,
        country: country || null,
        region: region || null,
        category: category || null,
        q: q || null,
        operation: operation || null,
        limit
      },

      count: result.rows.length,
      airports: result.rows
    });
  } catch (err) {
    console.error(
      "ACS AIRPORT CATALOG ERROR:",
      err
    );

    return res.status(500).json({
      ok: false,
      error: "AIRPORT_CATALOG_FAILED"
    });
  }
});

/* ============================================================
   GET /v1/airports/catalog/:icao

   Returns the airport only when it is operational
   in the current PostgreSQL simulation period.
   ============================================================ */

router.get(
  "/airports/catalog/:icao",
  requireAuth,
  async (req, res) => {
    try {
      const airlineId =
        Number(req.airline_id);

      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0
      ) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      const icao =
        String(req.params?.icao || "")
          .trim()
          .toUpperCase();

      if (!/^[A-Z0-9]{4}$/.test(icao)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ICAO"
        });
      }

      const result = await pool.query(
        `
        WITH reserved_slots AS (
          SELECT
            airport_icao AS icao,
            COUNT(*)::INTEGER AS reserved_slots
          FROM public.airport_slot_bookings
          WHERE slot_status = 'RESERVED'
            AND airport_icao = $1
          GROUP BY airport_icao
        )
        SELECT
          aa.airport_id AS id,
          aa.icao,
          aa.iata,
          aa.city,
          aa.country,
          aa.continent AS geographic_continent,
          ${ACS_REGION_SQL} AS continent,
          aa.region,
          aa.latitude,
          aa.longitude,
          aa.elevation_ft,

          aa.runway_m AS runway_m_base,
          COALESCE(
            ahp.runway_m,
            aa.runway_m
          ) AS runway_m,

          aa.open_hrs AS open_hrs_base,
          COALESCE(
            ahp.open_hrs,
            aa.open_hrs
          ) AS open_hrs,

          aa.category AS category_base,
          COALESCE(
            ahp.category,
            aa.category
          ) AS category,

          aa.aircraft_limit
            AS aircraft_limit_base,

          COALESCE(
            ahp.aircraft_limit,
            aa.aircraft_limit
          ) AS aircraft_limit,

          aa.demand_y,
          aa.demand_c,
          aa.demand_f,

          aa.slot_cost_usd
            AS slot_cost_base_usd,

          COALESCE(
            ahp.slot_cost_usd,
            aa.slot_cost_usd
          ) AS slot_cost_usd,

          aa.landing_fee_usd
            AS landing_fee_base_usd,

          COALESCE(
            ahp.landing_fee_usd,
            aa.landing_fee_usd
          ) AS landing_fee_usd,

          aa.fuel_usd_gal
            AS fuel_base_usd_gal,

          COALESCE(
            ahp.fuel_usd_gal,
            aa.fuel_usd_gal
          ) AS fuel_usd_gal,

          aa.ticket_fee_percent
            AS ticket_fee_percent_base,

          COALESCE(
            ahp.ticket_fee_percent,
            aa.ticket_fee_percent
          ) AS ticket_fee_percent,

          aa.pax_growth_factor
            AS pax_growth_factor_base,

          COALESCE(
            ahp.pax_growth_factor,
            aa.pax_growth_factor
          ) AS pax_growth_factor,

          aa.slot_capacity
            AS slot_capacity_base,

          COALESCE(
            ahp.slot_capacity,
            aa.slot_capacity,
            0
          )::INTEGER AS slot_capacity,

          COALESCE(
            rs.reserved_slots,
            0
          )::INTEGER AS reserved_slots,

          GREATEST(
            COALESCE(
              ahp.slot_capacity,
              aa.slot_capacity,
              0
            ) - COALESCE(
              rs.reserved_slots,
              0
            ),
            0
          )::INTEGER AS available_slots,

          aa.current_sim_time,
          aa.sim_year AS economic_year,
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

          ahp.id AS historical_profile_id,
          ahp.era_from,
          ahp.era_to,
          ahp.era_label,
          ahp.expansion_stage,

          COALESCE(
            ahp.airport_status,
            'ACTIVE'
          ) AS airport_status,

          ahp.source
            AS historical_profile_source,

          aa.notes,
          aa.source,
          aa.created_at,
          aa.updated_at

        FROM public.v_acs_airport_authority_current aa

        LEFT JOIN LATERAL (
          SELECT hp.*
          FROM public.airport_historical_profiles hp
          WHERE hp.airport_icao = aa.icao
            AND aa.sim_year
                BETWEEN hp.era_from AND hp.era_to
          ORDER BY hp.era_from DESC
          LIMIT 1
        ) ahp
          ON TRUE

        LEFT JOIN reserved_slots rs
          ON rs.icao = aa.icao

        WHERE aa.icao = $1

        LIMIT 1
        `,
        [icao]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "AIRPORT_NOT_AVAILABLE_IN_CURRENT_SIM_PERIOD",
          icao
        });
      }

      return res.json({
        ok: true,
        endpoint: "ACS_AIRPORT_BY_ICAO",
        version: "v3.0",

        authority: {
          airport_availability:
            "public.v_acs_airport_authority_current",
          simulation_time:
            "public.acs_get_current_sim_time()",
          historical_profiles:
            "public.airport_historical_profiles",
          slot_bookings:
            "public.airport_slot_bookings"
        },

        airline_id: airlineId,
        current_sim_time:
          result.rows[0].current_sim_time,
        sim_year:
          result.rows[0].sim_year,
        sim_month:
          result.rows[0].sim_month,
        airport:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ACS AIRPORT BY ICAO ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error: "AIRPORT_BY_ICAO_FAILED"
      });
    }
  }
);

export default router;
