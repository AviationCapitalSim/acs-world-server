/* ============================================================
   🟦 ACS AIRCRAFT BACKEND AUTHORITY — READ API v1.0
   ------------------------------------------------------------
   File: routes/aircraft.js
   Purpose:
   - Backend authority for Aircraft systems
   - Read aircraft fleet, new aircraft orders, factory slots,
     and used aircraft market from PostgreSQL
   - No localStorage authority
   - No Finance frontend mutation
   - No Time Engine interaction
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   🟩 HEALTH CHECK
   ============================================================ */

router.get("/aircraft/health", requireAuth, async (req, res) => {
  return res.json({
    ok: true,
    module: "aircraft",
    airline_id: req.airline_id
  });
});

/* ============================================================
   🟦 GET MY AIRCRAFT FLEET
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/fleet
   ============================================================ */

router.get("/aircraft/fleet", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        aircraft_uid,
        airline_id,
        user_id,
        source,
        ownership_type,
        manufacturer,
        model_key,
        aircraft_name,
        registration,
        serial_number,
        line_number,
        new_aircraft_order_id,
        used_listing_id,
        status,
        operational_status,
        base_icao,
        current_airport,
        year_built,
        delivery_date,
        entry_into_service_date,
        total_hours,
        total_cycles,
        condition_pct,
        maintenance_status,
        purchase_price,
        current_value,
        currency,
        created_at,
        updated_at
      FROM aircraft_fleet
      WHERE airline_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [airlineId]
    );

    return res.json({
      ok: true,
      airline_id: airlineId,
      fleet: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT FLEET ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FLEET_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 GET NEW AIRCRAFT ORDERS
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/orders
   ============================================================ */

router.get("/aircraft/orders", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        order_uid,
        airline_id,
        user_id,
        source,
        manufacturer,
        model_key,
        aircraft_name,
        factory_slot_id,
        quantity,
        unit_price,
        total_price,
        currency,
        ownership_type,
        payment_status,
        order_status,
        delivery_status,
        order_date,
        estimated_delivery_date,
        actual_delivery_date,
        notes,
        created_at,
        updated_at
      FROM new_aircraft_orders
      WHERE airline_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [airlineId]
    );

    return res.json({
      ok: true,
      airline_id: airlineId,
      orders: result.rows
    });

  } catch (err) {
    console.error("ACS NEW AIRCRAFT ORDERS ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "NEW_AIRCRAFT_ORDERS_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 GET AIRCRAFT FACTORY SLOTS
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/slots
   ============================================================ */

router.get("/aircraft/factory/slots", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        slot_uid,
        manufacturer,
        model_key,
        aircraft_name,
        production_year,
        slot_year,
        slot_month,
        available_quantity,
        reserved_quantity,
        delivered_quantity,
        base_delivery_days,
        slot_status,
        created_at,
        updated_at
      FROM aircraft_factory_slots
      ORDER BY slot_year ASC, slot_month ASC, manufacturer ASC, model_key ASC
      `
    );

    return res.json({
      ok: true,
      slots: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT FACTORY SLOTS ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FACTORY_SLOTS_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 GET USED AIRCRAFT MARKET
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/used-market
   ============================================================ */

router.get("/aircraft/used-market", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        listing_uid,
        manufacturer,
        model_key,
        aircraft_name,
        serial_number,
        previous_registration,
        previous_operator,
        year_built,
        age_years,
        total_hours,
        total_cycles,
        condition_pct,
        current_location,
        current_airport,
        base_price,
        market_price,
        currency,
        maintenance_status,
        c_check_due_hours,
        c_check_due_cycles,
        d_check_due_date,
        listing_status,
        reserved_by_airline_id,
        sold_to_airline_id,
        listed_at,
        reserved_at,
        sold_at,
        created_at,
        updated_at
      FROM used_aircraft_market
      WHERE listing_status IN ('AVAILABLE', 'RESERVED')
      ORDER BY listed_at DESC, id DESC
      `
    );

    return res.json({
      ok: true,
      used_market: result.rows
    });

  } catch (err) {
    console.error("ACS USED AIRCRAFT MARKET ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "USED_AIRCRAFT_MARKET_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS AIRCRAFT PRODUCTION RULES — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/production-rules

   Purpose:
   - Read aircraft industrial production rules
   - Defines factory availability by manufacturer/model/year
   - PostgreSQL is authority
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/production-rules", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        rule_uid,
        manufacturer,
        model_key,
        aircraft_name,
        aircraft_category,
        production_start_year,
        production_end_year,
        first_delivery_year,
        last_delivery_year,
        capacity_tier,
        manufacturer_weight,
        model_weight,
        monthly_min_units,
        monthly_max_units,
        is_factory_available,
        is_active_rule,
        notes,
        created_at,
        updated_at
      FROM aircraft_production_rules
      ORDER BY production_start_year ASC, manufacturer ASC, model_key ASC
      `
    );

    return res.json({
      ok: true,
      rules: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT PRODUCTION RULES ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_PRODUCTION_RULES_FAILED",
      details: err.message
    });
  }
});


/* ============================================================
   🟦 ACS FACTORY CATALOG — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/catalog?year=1940

   Purpose:
   - Return aircraft models available from factory for a given year
   - A model appears only while production is active
   - Once production_end_year passes, it disappears from factory
   - Used market and fleet are separate systems
   ============================================================ */

router.get("/aircraft/factory/catalog", requireAuth, async (req, res) => {
  try {
    const yearParam = req.query.year;
    const selectedYear = Number(yearParam);

    if (!yearParam || !Number.isInteger(selectedYear)) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "year query parameter is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        rule_uid,
        manufacturer,
        model_key,
        aircraft_name,
        aircraft_category,
        production_start_year,
        production_end_year,
        first_delivery_year,
        last_delivery_year,
        capacity_tier,
        manufacturer_weight,
        model_weight,
        monthly_min_units,
        monthly_max_units,
        is_factory_available,
        is_active_rule,
        notes,
        created_at,
        updated_at
      FROM aircraft_production_rules
      WHERE is_active_rule = true
        AND is_factory_available = true
        AND production_start_year <= $1
        AND (
          production_end_year IS NULL
          OR production_end_year >= $1
        )
      ORDER BY manufacturer ASC, aircraft_category ASC, model_key ASC
      `,
      [selectedYear]
    );

    return res.json({
      ok: true,
      year: selectedYear,
      factory_catalog: result.rows
    });

  } catch (err) {
    console.error("ACS FACTORY CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FACTORY_CATALOG_FAILED",
      details: err.message
    });
  }
});

export default router;
