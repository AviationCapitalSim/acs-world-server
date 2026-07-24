/* ============================================================
   ACS OCC — GLOBAL CABIN PRESETS API
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const ACS_CABIN_PRODUCTS = Object.freeze({
  Y_SMART: 1,
  Y_CLASSIC: 1.25,
  Y_COMFORT: 1.5,
  Y_PLUS: 1.75,

  C_SMART: 2,
  C_EXECUTIVE: 2.5,
  C_PREMIER: 3,
  C_SUPERIOR: 3.5,

  F_SILVER: 4,
  F_GOLD: 4.5,
  F_PLATINUM: 5,
  F_DIAMOND: 6
});

function ACS_readCabinClass(configuration, cabinClass, defaultProduct) {
  const source = configuration?.[cabinClass] || {};

  return {
    product: String(source.product || defaultProduct)
      .trim()
      .toUpperCase(),

    seats: Number(source.seats ?? 0)
  };
}

function ACS_validateCabinClass(cabinClass) {
  return (
    Number.isInteger(cabinClass.seats) &&
    cabinClass.seats >= 0 &&
    Object.prototype.hasOwnProperty.call(
      ACS_CABIN_PRODUCTS,
      cabinClass.product
    )
  );
}

/* ============================================================
   GET /v1/cabin-presets
   GET /v1/cabin-presets?model_key=douglas_dc_9
   ============================================================ */

router.get("/cabin-presets", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);
    const modelKey = String(req.query?.model_key || "").trim();

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const values = [airlineId];
    let modelFilter = "";

    if (modelKey) {
      values.push(modelKey);
      modelFilter = "AND model_key = $2";
    }

    const result = await pool.query(
      `
      SELECT
        preset_id,
        airline_id,
        created_by_user_id,
        preset_name,
        model_key,
        y_product,
        y_seats,
        c_product,
        c_seats,
        f_product,
        f_seats,
        rules_version,
        created_at,
        updated_at
      FROM cabin_presets
      WHERE airline_id = $1
      ${modelFilter}
      ORDER BY preset_name ASC, preset_id ASC
      `,
      values
    );

    return res.json({
      ok: true,
      presets: result.rows
    });
  } catch (err) {
    console.error("ACS CABIN PRESETS READ ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "CABIN_PRESETS_READ_FAILED"
    });
  }
});

/* ============================================================
   POST /v1/cabin-presets
   ============================================================ */

router.post("/cabin-presets", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);
    const userId = req.user_id || null;

    const presetName = String(
      req.body?.preset_name || ""
    ).trim();

    const modelKey = String(
      req.body?.model_key || ""
    ).trim();

    const configuration = req.body?.configuration || {};

    const economy = ACS_readCabinClass(
      configuration,
      "Y",
      "Y_SMART"
    );

    const business = ACS_readCabinClass(
      configuration,
      "C",
      "C_SMART"
    );

    const first = ACS_readCabinClass(
      configuration,
      "F",
      "F_SILVER"
    );

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!presetName || presetName.length > 80) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PRESET_NAME"
      });
    }

    if (!modelKey) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MODEL_KEY"
      });
    }

    if (
      !ACS_validateCabinClass(economy) ||
      !ACS_validateCabinClass(business) ||
      !ACS_validateCabinClass(first)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CABIN_CONFIGURATION"
      });
    }

    const totalSeats =
      economy.seats +
      business.seats +
      first.seats;

    if (totalSeats <= 0) {
      return res.status(400).json({
        ok: false,
        error: "EMPTY_CABIN_CONFIGURATION"
      });
    }

    const aircraftResult = await pool.query(
      `
      SELECT model_key, seats
      FROM aircraft_catalog
      WHERE model_key = $1
        AND is_active = true
      LIMIT 1
      `,
      [modelKey]
    );

    if (!aircraftResult.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_MODEL_NOT_FOUND"
      });
    }

    const cabinCapacity = Number(
      aircraftResult.rows[0].seats
    );

    if (
      !Number.isFinite(cabinCapacity) ||
      cabinCapacity <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "AIRCRAFT_HAS_NO_PASSENGER_CABIN"
      });
    }

    const usedCapacity =
      economy.seats *
        ACS_CABIN_PRODUCTS[economy.product] +
      business.seats *
        ACS_CABIN_PRODUCTS[business.product] +
      first.seats *
        ACS_CABIN_PRODUCTS[first.product];

    if (usedCapacity > cabinCapacity) {
      return res.status(400).json({
        ok: false,
        error: "CABIN_CONFIGURATION_EXCEEDS_CAPACITY"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO cabin_presets (
        airline_id,
        created_by_user_id,
        preset_name,
        model_key,
        y_product,
        y_seats,
        c_product,
        c_seats,
        f_product,
        f_seats,
        rules_version,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        'ACS_CABIN_V1',
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        airlineId,
        userId,
        presetName,
        modelKey,
        economy.product,
        economy.seats,
        business.product,
        business.seats,
        first.product,
        first.seats
      ]
    );

    return res.status(201).json({
      ok: true,
      preset: result.rows[0]
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "CABIN_PRESET_NAME_ALREADY_EXISTS"
      });
    }

    console.error("ACS CABIN PRESET CREATE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "CABIN_PRESET_CREATE_FAILED"
    });
  }
});

/* ============================================================
   DELETE /v1/cabin-presets/:presetId
   ============================================================ */

router.delete(
  "/cabin-presets/:presetId",
  requireAuth,
  async (req, res) => {
    try {
      const airlineId = Number(req.airline_id);
      const presetId = Number(req.params.presetId);

      if (!Number.isInteger(airlineId) || airlineId <= 0) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      if (!Number.isInteger(presetId) || presetId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PRESET_ID"
        });
      }

      const result = await pool.query(
        `
        DELETE FROM cabin_presets
        WHERE preset_id = $1
          AND airline_id = $2
        RETURNING preset_id, preset_name, model_key
        `,
        [presetId, airlineId]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "CABIN_PRESET_NOT_FOUND"
        });
      }

      return res.json({
        ok: true,
        deleted: result.rows[0]
      });
    } catch (err) {
      console.error("ACS CABIN PRESET DELETE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "CABIN_PRESET_DELETE_FAILED"
      });
    }
  }
);

export default router;
