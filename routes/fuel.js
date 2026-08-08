/* ============================================================
   ACS OCC - FUEL MARKET ROUTE v1.0
   ------------------------------------------------------------
   Date: 2026-08-08
   Read-only PostgreSQL market authority.
   No embedded prices, interpolation or local fallback.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const fuelCatalogue = [
  {
    id: "avgas-100ll",
    code: "AVGAS",
    seriesCode: "AVGAS",
    name: "AVGAS 100LL",
    family: "Aviation Gasoline",
    engine_type: "Piston",
    grade: "100LL",
    identification: "Blue",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D910"
  },
  {
    id: "jet-a",
    code: "JET_A",
    seriesCode: "JET_FUEL_REFERENCE",
    name: "JET A",
    family: "Kerosene Jet Fuel",
    engine_type: "Turbine",
    grade: "JET A",
    identification: "Clear / Straw",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D1655"
  },
  {
    id: "jet-a1",
    code: "JET_A1",
    seriesCode: "JET_FUEL_REFERENCE",
    name: "JET A-1",
    family: "Kerosene Jet Fuel",
    engine_type: "Turbine",
    grade: "JET A-1",
    identification: "Clear / Straw",
    introduced_on: null,
    retired_on: null,
    specification: "DEF STAN 91-091"
  },
  {
    id: "saf",
    code: "SAF",
    seriesCode: "SAF",
    name: "SAF",
    family: "Sustainable Aviation Fuel",
    engine_type: "Turbine",
    grade: "Approved Blend",
    identification: "Specification dependent",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D7566 / D1655"
  }
];

function mapRecord(row) {
  return {
    period: String(row.price_year),
    price: Number(row.price_usd_per_us_gallon),
    annual_change_percent:
      row.annual_change_percent === null
        ? null
        : Number(row.annual_change_percent),
    quality_grade: row.quality_grade,
    source_method: row.data_kind,
    is_projection: row.data_kind === "PROJECTION",
    source_name: row.source_name,
    source_url: row.source_url,
    market_scope: row.market_scope,
    market_name: row.market_name,
    price_basis: row.price_basis,
    confidence: row.confidence,
    revision_code: row.revision_code,
    is_simulation_seed: row.is_simulation_seed
  };
}

router.get("/fuel/market", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH active_market AS (
        SELECT
          CASE
            WHEN fuel_code = 'AVGAS' THEN 'AVGAS'
            WHEN fuel_code IN ('TURBINE_KEROSENE_EQ', 'JET_FUEL')
              THEN 'JET_FUEL_REFERENCE'
            ELSE fuel_code
          END AS logical_series_code,
          price_year,
          price_usd_per_us_gallon,
          market_scope,
          market_name,
          data_kind,
          quality_grade,
          source_name,
          source_url,
          price_basis,
          confidence,
          revision_code,
          is_simulation_seed,
          source_retrieved_on,
          updated_at
        FROM public.fuel_market_series
        WHERE is_active = true
          AND fuel_code IN ('AVGAS', 'TURBINE_KEROSENE_EQ', 'JET_FUEL', 'SAF')
      ),
      movement AS (
        SELECT
          active_market.*,
          LAG(price_usd_per_us_gallon) OVER (
            PARTITION BY logical_series_code
            ORDER BY price_year
          ) AS prior_price
        FROM active_market
      )
      SELECT
        logical_series_code,
        price_year,
        price_usd_per_us_gallon,
        CASE
          WHEN prior_price IS NULL OR prior_price = 0 THEN NULL
          ELSE ROUND(
            ((price_usd_per_us_gallon - prior_price) / prior_price) * 100,
            4
          )
        END AS annual_change_percent,
        market_scope,
        market_name,
        data_kind,
        quality_grade,
        source_name,
        source_url,
        price_basis,
        confidence,
        revision_code,
        is_simulation_seed,
        source_retrieved_on,
        updated_at
      FROM movement
      ORDER BY logical_series_code, price_year
    `);

    const seriesByCode = new Map();

    for (const row of result.rows) {
      const records = seriesByCode.get(row.logical_series_code) || [];
      records.push(mapRecord(row));
      seriesByCode.set(row.logical_series_code, records);
    }

    const fuels = fuelCatalogue.map((fuel) => {
      const series = seriesByCode.get(fuel.seriesCode) || [];
      const first = series[0] || null;
      const latest = series[series.length - 1] || null;

      return {
        id: fuel.id,
        code: fuel.code,
        name: fuel.name,
        family: fuel.family,
        engine_type: fuel.engine_type,
        grade: fuel.grade,
        identification: fuel.identification,
        introduced_on: fuel.introduced_on,
        retired_on: fuel.retired_on,
        market_status: series.length ? "AVAILABLE" : "UNAVAILABLE",
        unit: "USD / US GAL",
        specification: fuel.specification,
        source: {
          name: latest?.source_name || null,
          market: latest?.market_name || null,
          method: latest?.source_method || null,
          coverage:
            first && latest
              ? `${first.period}-${latest.period}`
              : null,
          quality_grade: latest?.quality_grade || null
        },
        series
      };
    });

    const retrievedDates = result.rows
      .map((row) => row.source_retrieved_on)
      .filter(Boolean)
      .map((value) => new Date(value).toISOString().slice(0, 10));

    const updateTimes = result.rows
      .map((row) => row.updated_at)
      .filter(Boolean)
      .map((value) => new Date(value).toISOString());

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      as_of: retrievedDates.sort().at(-1) || null,
      dataset_revision: updateTimes.sort().at(-1) || null,
      fuels
    });
  } catch (error) {
    console.error("ACS FUEL MARKET FETCH ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "ACS_FUEL_MARKET_FETCH_FAILED"
    });
  }
});

export default router;
