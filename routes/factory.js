/* ============================================================
   🏭 ACS FACTORY ROUTES — HISTORICAL OEM CATALOG v1.1
   ------------------------------------------------------------
   File: routes/factory.js
   Purpose:
   - Serve historical Buy New aircraft catalog
   - PostgreSQL authority only
   - Join aircraft_catalog + aircraft_production_rules
   - Filter by simulation year
   - Return full technical + image metadata
   - Keep temporary factory_catalog alias for migration safety
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

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
        ac.engines,
        ac.aircraft_category,
        ac.status,
        ac.image_filename AS image_file_name,

        pr.aircraft_category AS production_category,
        pr.production_start_year,
        pr.production_end_year,
        pr.first_delivery_year,
        pr.last_delivery_year,
        pr.capacity_tier,
        pr.monthly_min,
        pr.monthly_max

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE
        COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $1
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $1
        )
        AND COALESCE(ac.is_active, true) = true

      ORDER BY
        COALESCE(pr.production_start_year, ac.production_year, ac.year) ASC,
        ac.manufacturer ASC,
        ac.model ASC;
      `,
      [year]
    );

    return res.json({
      ok: true,
      endpoint: "ACS_FACTORY_CATALOG",
      version: "v1.1",
      year,
      count: result.rows.length,

      /* Canonical new payload */
      aircraft: result.rows,

      /* Temporary migration alias — do not remove yet */
      factory_catalog: result.rows
    });

  } catch (err) {
    console.error("ACS FACTORY CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FACTORY_CATALOG_FAILED",
      message: err.message
    });
  }
});

export default router;
