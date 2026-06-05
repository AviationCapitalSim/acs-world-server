/* ============================================================
   🟦 ACS AIRPORT BACKEND AUTHORITY — READ API v1.0
   ------------------------------------------------------------
   File: routes/airports.js

   Purpose:
   - Backend authority for Airport Catalog systems
   - Read airport_catalog from PostgreSQL
   - Prepare migration path for the 7 continent HTML pages
   - No localStorage authority
   - No frontend airport database authority
   - Safe for 700+ players

   Endpoints:
   - GET /v1/airports/health
   - GET /v1/airports/catalog
   - GET /v1/airports/catalog?continent=South%20America
   - GET /v1/airports/catalog?country=BR
   - GET /v1/airports/catalog?category=Primary%20Hub
   - GET /v1/airports/catalog/:icao
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   🟧 ACS SIMULATION YEAR VALIDATION — v2.0
   ------------------------------------------------------------
   Purpose:
   - Validate ACS simulated year
   - Supported ACS timeline: 1940–2030
   - Used by airport historical profile resolution
   ============================================================ */

function ACS_parseSimYear(value) {
  const year = Number(value);

  if (!Number.isFinite(year)) {
    return null;
  }

  const cleanYear = Math.floor(year);

  if (cleanYear < 1940 || cleanYear > 2030) {
    return null;
  }

  return cleanYear;
}

/* ============================================================
   🟩 HEALTH CHECK
   ============================================================ */

router.get("/airports/health", requireAuth, async (req, res) => {
  return res.json({
    ok: true,
    module: "airports",
    authority: "airport_catalog",
    airline_id: req.airline_id
  });
});

/* ============================================================
   🟦 GET AIRPORT CATALOG — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/airports/catalog

   Optional query params:
   - continent
   - country
   - region
   - category
   - q
   - limit

   Examples:
   /v1/airports/catalog?continent=South%20America
   /v1/airports/catalog?country=BR
   /v1/airports/catalog?category=Primary%20Hub
   /v1/airports/catalog?q=Buenos
   ============================================================ */

router.get("/airports/catalog", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    const continent = String(req.query?.continent || "").trim();
    const country = String(req.query?.country || "").trim().toUpperCase();
    const region = String(req.query?.region || "").trim();
    const category = String(req.query?.category || "").trim();
    const q = String(req.query?.q || "").trim();

    const simYear = ACS_parseSimYear(req.query?.sim_year);

    if (
      req.query?.sim_year !== undefined &&
      (simYear === null || simYear < 1940 || simYear > 2030)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR",
        details: "sim_year must be between 1940 and 2030"
      });
    }

    const requestedLimit = Number(req.query?.limit || 5000);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 5000)
        : 5000;

    const where = [];
    const values = [simYear];

    if (continent) {
      values.push(continent);
      where.push(`ac.continent = $${values.length}`);
    }

    if (country) {
      values.push(country);
      where.push(`UPPER(ac.country) = $${values.length}`);
    }

    if (region) {
      values.push(region);
      where.push(`ac.region = $${values.length}`);
    }

    if (category) {
      values.push(category);
      where.push(`COALESCE(ahp.category, ac.category) = $${values.length}`);
    }

    if (q) {
      values.push(`%${q}%`);
      where.push(`
        (
          ac.icao ILIKE $${values.length}
          OR ac.iata ILIKE $${values.length}
          OR ac.city ILIKE $${values.length}
          OR ac.country ILIKE $${values.length}
          OR ac.region ILIKE $${values.length}
          OR ac.continent ILIKE $${values.length}
        )
      `);
    }

    values.push(limit);

    const whereSql = where.length
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
        ac.id,
        ac.icao,
        ac.iata,
        ac.city,
        ac.country,
        ac.continent,
        ac.region,
        ac.latitude,
        ac.longitude,
        ac.elevation_ft,

        ac.runway_m AS runway_m_base,
        COALESCE(ahp.runway_m, ac.runway_m) AS runway_m,

        ac.open_hrs AS open_hrs_base,
        COALESCE(ahp.open_hrs, ac.open_hrs) AS open_hrs,

        ac.category AS category_base,
        COALESCE(ahp.category, ac.category) AS category,

        ac.aircraft_limit AS aircraft_limit_base,
        COALESCE(ahp.aircraft_limit, ac.aircraft_limit) AS aircraft_limit,

        ac.demand_y,
        ac.demand_c,
        ac.demand_f,

        ac.slot_cost_usd AS slot_cost_base_usd,
        COALESCE(ahp.slot_cost_usd, ac.slot_cost_usd) AS slot_cost_usd,

        ac.landing_fee_usd AS landing_fee_base_usd,
        COALESCE(ahp.landing_fee_usd, ac.landing_fee_usd) AS landing_fee_usd,

        ac.fuel_usd_gal AS fuel_base_usd_gal,
        COALESCE(ahp.fuel_usd_gal, ac.fuel_usd_gal) AS fuel_usd_gal,

        ac.ticket_fee_percent AS ticket_fee_percent_base,
        COALESCE(
          ahp.ticket_fee_percent,
          ac.ticket_fee_percent
        ) AS ticket_fee_percent,

        ac.pax_growth_factor AS pax_growth_factor_base,
        COALESCE(
          ahp.pax_growth_factor,
          ac.pax_growth_factor
        ) AS pax_growth_factor,

        ac.slot_capacity AS slot_capacity_base,
        COALESCE(
          ahp.slot_capacity,
          ac.slot_capacity,
          0
        )::INTEGER AS slot_capacity,

        COALESCE(rs.reserved_slots, 0)::INTEGER AS reserved_slots,

        GREATEST(
          COALESCE(ahp.slot_capacity, ac.slot_capacity, 0)
          - COALESCE(rs.reserved_slots, 0),
          0
        )::INTEGER AS available_slots,

        CASE
          WHEN COALESCE(ahp.slot_capacity, ac.slot_capacity, 0) > 0 THEN
            ROUND(
              (
                COALESCE(rs.reserved_slots, 0)::NUMERIC
                /
                COALESCE(
                  ahp.slot_capacity,
                  ac.slot_capacity
                )::NUMERIC
              ) * 100,
              2
            )
          ELSE 0
        END AS slot_utilization_pct,

        $1::INTEGER AS economic_year,

        (ahp.id IS NOT NULL) AS historical_profile_applied,

        ahp.id AS historical_profile_id,
        ahp.era_from,
        ahp.era_to,
        ahp.era_label,
        ahp.expansion_stage,
        COALESCE(ahp.airport_status, 'ACTIVE') AS airport_status,
        ahp.source AS historical_profile_source,

        ac.notes,
        ac.source,
        ac.created_at,
        ac.updated_at

      FROM public.airport_catalog ac

      LEFT JOIN LATERAL (
        SELECT hp.*
        FROM public.airport_historical_profiles hp
        WHERE hp.airport_icao = ac.icao
          AND $1::INTEGER IS NOT NULL
          AND $1::INTEGER BETWEEN hp.era_from AND hp.era_to
        ORDER BY hp.era_from DESC
        LIMIT 1
      ) ahp
        ON TRUE

      LEFT JOIN reserved_slots rs
        ON rs.icao = ac.icao

      ${whereSql}

      ORDER BY
        ac.continent ASC,
        ac.country ASC,
        ac.city ASC,
        ac.icao ASC

      LIMIT $${values.length}
      `,
      values
    );

    return res.json({
      ok: true,
      endpoint: "ACS_AIRPORT_CATALOG",
      version: "v2.0",
      authority: {
        airport_catalog: "public.airport_catalog",
        historical_profiles: "public.airport_historical_profiles",
        slot_bookings: "public.airport_slot_bookings"
      },
      airline_id: airlineId,
      filters: {
        continent: continent || null,
        country: country || null,
        region: region || null,
        category: category || null,
        q: q || null,
        sim_year: simYear,
        limit
      },
      historical_resolution: {
        requested_year: simYear,
        source:
          simYear === null
            ? "BASE_AIRPORT_CATALOG"
            : "AIRPORT_HISTORICAL_PROFILES"
      },
      count: result.rows.length,
      airports: result.rows
    });

  } catch (err) {
    console.error("ACS AIRPORT CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRPORT_CATALOG_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 GET AIRPORT BY ICAO — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/airports/catalog/:icao

   Example:
   /v1/airports/catalog/SVMI
   ============================================================ */

router.get("/airports/catalog/:icao", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    const simYear = ACS_parseSimYear(req.query?.sim_year);

    if (
      req.query?.sim_year !== undefined &&
      (simYear === null || simYear < 1940 || simYear > 2030)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR",
        details: "sim_year must be between 1940 and 2030"
      });
    }

    const icao = String(req.params?.icao || "")
      .trim()
      .toUpperCase();

    if (!icao || icao.length !== 4) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ICAO",
        details: "ICAO must be a 4-character airport code"
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
        ac.id,
        ac.icao,
        ac.iata,
        ac.city,
        ac.country,
        ac.continent,
        ac.region,
        ac.latitude,
        ac.longitude,
        ac.elevation_ft,

        ac.runway_m AS runway_m_base,
        COALESCE(ahp.runway_m, ac.runway_m) AS runway_m,

        ac.open_hrs AS open_hrs_base,
        COALESCE(ahp.open_hrs, ac.open_hrs) AS open_hrs,

        ac.category AS category_base,
        COALESCE(ahp.category, ac.category) AS category,

        ac.aircraft_limit AS aircraft_limit_base,
        COALESCE(
          ahp.aircraft_limit,
          ac.aircraft_limit
        ) AS aircraft_limit,

        ac.demand_y,
        ac.demand_c,
        ac.demand_f,

        ac.slot_cost_usd AS slot_cost_base_usd,
        COALESCE(
          ahp.slot_cost_usd,
          ac.slot_cost_usd
        ) AS slot_cost_usd,

        ac.landing_fee_usd AS landing_fee_base_usd,
        COALESCE(
          ahp.landing_fee_usd,
          ac.landing_fee_usd
        ) AS landing_fee_usd,

        ac.fuel_usd_gal AS fuel_base_usd_gal,
        COALESCE(
          ahp.fuel_usd_gal,
          ac.fuel_usd_gal
        ) AS fuel_usd_gal,

        ac.ticket_fee_percent AS ticket_fee_percent_base,
        COALESCE(
          ahp.ticket_fee_percent,
          ac.ticket_fee_percent
        ) AS ticket_fee_percent,

        ac.pax_growth_factor AS pax_growth_factor_base,
        COALESCE(
          ahp.pax_growth_factor,
          ac.pax_growth_factor
        ) AS pax_growth_factor,

        ac.slot_capacity AS slot_capacity_base,
        COALESCE(
          ahp.slot_capacity,
          ac.slot_capacity,
          0
        )::INTEGER AS slot_capacity,

        COALESCE(
          rs.reserved_slots,
          0
        )::INTEGER AS reserved_slots,

        GREATEST(
          COALESCE(
            ahp.slot_capacity,
            ac.slot_capacity,
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
            ac.slot_capacity,
            0
          ) > 0 THEN
            ROUND(
              (
                COALESCE(
                  rs.reserved_slots,
                  0
                )::NUMERIC
                /
                COALESCE(
                  ahp.slot_capacity,
                  ac.slot_capacity
                )::NUMERIC
              ) * 100,
              2
            )
          ELSE 0
        END AS slot_utilization_pct,

        $2::INTEGER AS economic_year,

        (ahp.id IS NOT NULL) AS historical_profile_applied,

        ahp.id AS historical_profile_id,
        ahp.era_from,
        ahp.era_to,
        ahp.era_label,
        ahp.expansion_stage,

        COALESCE(
          ahp.airport_status,
          'ACTIVE'
        ) AS airport_status,

        ahp.source AS historical_profile_source,

        ac.notes,
        ac.source,
        ac.created_at,
        ac.updated_at

      FROM public.airport_catalog ac

      LEFT JOIN LATERAL (
        SELECT hp.*
        FROM public.airport_historical_profiles hp
        WHERE hp.airport_icao = ac.icao
          AND $2::INTEGER IS NOT NULL
          AND $2::INTEGER BETWEEN hp.era_from AND hp.era_to
        ORDER BY hp.era_from DESC
        LIMIT 1
      ) ahp
        ON TRUE

      LEFT JOIN reserved_slots rs
        ON rs.icao = ac.icao

      WHERE ac.icao = $1

      LIMIT 1
      `,
      [icao, simYear]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "AIRPORT_NOT_FOUND",
        icao
      });
    }

    return res.json({
      ok: true,
      endpoint: "ACS_AIRPORT_BY_ICAO",
      version: "v2.0",
      authority: {
        airport_catalog: "public.airport_catalog",
        historical_profiles: "public.airport_historical_profiles",
        slot_bookings: "public.airport_slot_bookings"
      },
      airline_id: airlineId,
      historical_resolution: {
        requested_year: simYear,
        source:
          simYear === null
            ? "BASE_AIRPORT_CATALOG"
            : "AIRPORT_HISTORICAL_PROFILES"
      },
      airport: result.rows[0]
    });

  } catch (err) {
    console.error("ACS AIRPORT BY ICAO ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRPORT_BY_ICAO_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   EXPORT
   ============================================================ */

export default router;
