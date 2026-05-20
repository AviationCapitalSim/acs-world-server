/* ============================================================
   🏭 ACS FACTORY ROUTES — HISTORICAL OEM CATALOG v1.0
   ------------------------------------------------------------
   File: routes/factory.js
   Purpose:
   - Serve historical Buy New aircraft catalog
   - PostgreSQL authority only
   - Join aircraft_catalog + aircraft_production_rules
   - Filter by simulation year
   - Exclude future aircraft
   - Multiplayer-ready backend source of truth
   ============================================================ */

import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET /v1/aircraft/factory/catalog?year=1940
   ============================================================ */

router.get("/catalog", async (req, res) => {
  try {
    const year = Number(req.query.year);

    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_YEAR",
        message: "A valid simulation year is required."
      });
    }

    const result = await pool.query(
      `
      SELECT
        ac.id,
        ac.catalog_uid,
        ac.model_key,
        ac.manufacturer,
        ac.model,
        ac.aircraft_name,
        ac.production_year,
        ac.year,
        ac.seats,
        ac.range_nm,
        ac.speed_kts,
        ac.mtow_kg,
        ac.fuel_burn_kgph,
        ac.price_acs_usd,

        pr.category,
        pr.production_start_year,
        pr.production_end_year,
        pr.monthly_min,
        pr.monthly_max,
        pr.capacity_tier

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE
        COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $1
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $1
        )

      ORDER BY
        ac.manufacturer ASC,
        pr.category ASC,
        ac.model ASC;
      `,
      [year]
    );

    return res.json({
      ok: true,
      year,
      count: result.rows.length,
      aircraft: result.rows
    });

  } catch (err) {
    console.error("ACS FACTORY CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FACTORY_CATALOG_FAILED"
    });
  }
});

export default router;
