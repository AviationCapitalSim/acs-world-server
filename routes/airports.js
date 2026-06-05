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
   🟧 ACS HISTORICAL ECONOMIC PROFILE — AIRPORT COST FACTOR v1.0
   ------------------------------------------------------------
   Purpose:
   - Apply simulated-year economic scaling to airport costs
   - Preserve raw airport_catalog values
   - Avoid frontend/localStorage economic authority
   - Safe migration path for Route Schedule and continent pages

   IMPORTANT:
   - This does not mutate PostgreSQL data.
   - This only adjusts API response values when sim_year is provided.
   ============================================================ */

function ACS_parseSimYear(value) {
  const year = Number(value);

  if (!Number.isFinite(year)) {
    return null;
  }

  const cleanYear = Math.floor(year);

  if (cleanYear < 1900 || cleanYear > 2100) {
    return null;
  }

  return cleanYear;
}

function ACS_getHistoricalEconomicProfile(simYear) {
  if (!simYear) {
    return {
      applied: false,
      year: null,
      factor: 1.0,
      label: "BASE_CATALOG"
    };
  }

  if (simYear < 1940) {
    return {
      applied: true,
      year: simYear,
      factor: 0.05,
      label: "PRE_1940_EARLY_AVIATION"
    };
  }

  if (simYear < 1950) {
    return {
      applied: true,
      year: simYear,
      factor: 0.10,
      label: "1940S_POSTWAR_AVIATION"
    };
  }

  if (simYear < 1958) {
    return {
      applied: true,
      year: simYear,
      factor: 0.25,
      label: "1950S_EARLY_COMMERCIAL_EXPANSION"
    };
  }

  if (simYear < 1965) {
    return {
      applied: true,
      year: simYear,
      factor: 0.45,
      label: "EARLY_JET_AGE"
    };
  }

  if (simYear < 1975) {
    return {
      applied: true,
      year: simYear,
      factor: 0.60,
      label: "JET_AGE_EXPANSION"
    };
  }

  if (simYear < 1990) {
    return {
      applied: true,
      year: simYear,
      factor: 0.80,
      label: "DEREGULATION_AND_GLOBAL_GROWTH"
    };
  }

  if (simYear < 2005) {
    return {
      applied: true,
      year: simYear,
      factor: 1.00,
      label: "MODERN_BASELINE"
    };
  }

  if (simYear < 2020) {
    return {
      applied: true,
      year: simYear,
      factor: 1.20,
      label: "HIGH_COST_GLOBALIZATION"
    };
  }

  return {
    applied: true,
    year: simYear,
    factor: 1.35,
    label: "POST_2020_HIGH_COST_ENVIRONMENT"
  };
}

function ACS_roundMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.round(n * 100) / 100;
}

function ACS_applyHistoricalAirportEconomics(row, simYear) {
  const profile = ACS_getHistoricalEconomicProfile(simYear);
  const factor = profile.factor;

  const rawSlotCost = ACS_roundMoney(row.slot_cost_usd);
  const rawLandingFee = ACS_roundMoney(row.landing_fee_usd);
  const rawFuelPrice = ACS_roundMoney(row.fuel_usd_gal);

  return {
    ...row,

    slot_cost_base_usd: rawSlotCost,
    landing_fee_base_usd: rawLandingFee,
    fuel_base_usd_gal: rawFuelPrice,

    slot_cost_usd: ACS_roundMoney(rawSlotCost * factor),
    landing_fee_usd: ACS_roundMoney(rawLandingFee * factor),
    fuel_usd_gal: ACS_roundMoney(rawFuelPrice * factor),

    economic_year: profile.year,
    economic_era_factor: profile.factor,
    economic_era_label: profile.label,
    historical_economics_applied: profile.applied
  };
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
