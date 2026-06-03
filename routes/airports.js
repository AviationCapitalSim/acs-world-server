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

    const requestedLimit = Number(req.query?.limit || 5000);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 5000)
        : 5000;

    const where = [];
    const values = [];

    if (continent) {
      values.push(continent);
      where.push(`continent = $${values.length}`);
    }

    if (country) {
      values.push(country);
      where.push(`UPPER(country) = $${values.length}`);
    }

    if (region) {
      values.push(region);
      where.push(`region = $${values.length}`);
    }

    if (category) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }

    if (q) {
      values.push(`%${q}%`);
      where.push(`
        (
          icao ILIKE $${values.length}
          OR iata ILIKE $${values.length}
          OR city ILIKE $${values.length}
          OR country ILIKE $${values.length}
          OR region ILIKE $${values.length}
          OR continent ILIKE $${values.length}
        )
      `);
    }

    values.push(limit);

    const whereSql = where.length
      ? `WHERE ${where.join(" AND ")}`
      : "";

    const result = await pool.query(
      `
      SELECT
        id,
        icao,
        iata,
        city,
        country,
        continent,
        region,
        latitude,
        longitude,
        elevation_ft,
        runway_m,
        open_hrs,
        category,
        demand_y,
        demand_c,
        demand_f,
        slot_cost_usd,
        landing_fee_usd,
        fuel_usd_gal,
        ticket_fee_percent,
        pax_growth_factor,
        slot_capacity,
        aircraft_limit,
        notes,
        source,
        created_at,
        updated_at
      FROM public.airport_catalog
      ${whereSql}
      ORDER BY
        continent ASC,
        country ASC,
        city ASC,
        icao ASC
      LIMIT $${values.length}
      `,
      values
    );

    return res.json({
      ok: true,
      endpoint: "ACS_AIRPORT_CATALOG",
      version: "v1.0",
      authority: {
        airport_catalog: "public.airport_catalog"
      },
      airline_id: airlineId,
      filters: {
        continent: continent || null,
        country: country || null,
        region: region || null,
        category: category || null,
        q: q || null,
        limit
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

    const icao = String(req.params?.icao || "").trim().toUpperCase();

    if (!icao || icao.length !== 4) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ICAO",
        details: "ICAO must be a 4-character airport code"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        icao,
        iata,
        city,
        country,
        continent,
        region,
        latitude,
        longitude,
        elevation_ft,
        runway_m,
        open_hrs,
        category,
        demand_y,
        demand_c,
        demand_f,
        slot_cost_usd,
        landing_fee_usd,
        fuel_usd_gal,
        ticket_fee_percent,
        pax_growth_factor,
        slot_capacity,
        aircraft_limit,
        notes,
        source,
        created_at,
        updated_at
      FROM public.airport_catalog
      WHERE icao = $1
      LIMIT 1
      `,
      [icao]
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
      version: "v1.0",
      authority: {
        airport_catalog: "public.airport_catalog"
      },
      airline_id: airlineId,
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
