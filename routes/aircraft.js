/* ============================================================
   🟦 ACS AIRCRAFT BACKEND AUTHORITY — READ API v1.1
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
   🟦 CREATE NEW AIRCRAFT ORDER — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders

   Purpose:
   - Create OEM aircraft order from Buy New
   - PostgreSQL authority only
   - Validate aircraft from aircraft_catalog
   - Validate factory availability from aircraft_production_rules
   - Validate capital from company_finance
   - Apply initial payment to company_finance
   - Register finance_log entry
   - Insert new_aircraft_orders record
   - No localStorage authority
   - No frontend finance mutation
   ============================================================ */

router.post("/aircraft/orders", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const userId = req.user_id || null;

    const modelKey = String(req.body?.model_key || "").trim();
    const quantity = Number(req.body?.quantity || 1);
    const ownershipType = String(req.body?.ownership_type || "BUY").toUpperCase();
    const dbOwnershipType =
    ownershipType === "LEASE"
    ? "LEASED"
    : "OWNED";  
    const initialPaymentPct = Number(req.body?.initial_payment_pct || 100);
    const simYear = Number(req.body?.sim_year || new Date().getUTCFullYear());

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!modelKey) {
      return res.status(400).json({
        ok: false,
        error: "MODEL_KEY_REQUIRED"
      });
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY"
      });
    }

    if (!["BUY", "LEASE"].includes(ownershipType)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OWNERSHIP_TYPE"
      });
    }

    if (
      !Number.isFinite(initialPaymentPct) ||
      initialPaymentPct <= 0 ||
      initialPaymentPct > 100
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_INITIAL_PAYMENT_PCT"
      });
    }

    if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR"
      });
    }

    await client.query("BEGIN");

    /* ============================================================
       1) ENSURE FINANCE ROW EXISTS
       ============================================================ */

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 700000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    /* ============================================================
       2) LOAD AIRCRAFT + PRODUCTION RULE
       ============================================================ */

    const aircraftResult = await client.query(
      `
      SELECT
        ac.model_key,
        ac.manufacturer,
        ac.model,
        ac.aircraft_name,
        ac.year,
        ac.price_acs_usd,
        ac.image_filename,

        pr.production_start_year,
        pr.production_end_year,
        pr.first_delivery_year,
        pr.last_delivery_year,
        pr.monthly_min_units,
        pr.monthly_max_units,
        pr.is_factory_available,
        pr.is_active_rule

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE ac.model_key = $1
        AND COALESCE(ac.is_active, true) = true
        AND pr.is_active_rule = true
        AND pr.is_factory_available = true
        AND COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $2
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $2
        )
      LIMIT 1
      `,
      [modelKey, simYear]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_AVAILABLE_FROM_FACTORY"
      });
    }

    const aircraft = aircraftResult.rows[0];

    const unitPrice = Math.round(Number(aircraft.price_acs_usd || 0));
    const totalPrice = unitPrice * quantity;

    if (!unitPrice || unitPrice <= 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRCRAFT_PRICE"
      });
    }

    const initialPaymentAmount = Math.round(
      totalPrice * (initialPaymentPct / 100)
    );

    /* ============================================================
       3) LOCK FINANCE ROW + VALIDATE CAPITAL
       ============================================================ */

    const financeBeforeResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    const financeBefore = financeBeforeResult.rows[0];
    const currentCapital = Math.round(Number(financeBefore?.capital || 0));

    if (currentCapital < initialPaymentAmount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INSUFFICIENT_CAPITAL",
        capital: currentCapital,
        required: initialPaymentAmount
      });
    }

      /* ============================================================
       4) RESERVE FACTORY SLOT + CALCULATE REAL DELIVERY DATE
       ------------------------------------------------------------
       Backend authority:
       - Lock available factory slots with FOR UPDATE
       - Reserve required quantity across one or more months
       - Preserve slot concurrency for 700+ players
       - Calculate delivery date from reserved slot position
       - Does NOT use Date.now() as delivery authority
       ============================================================ */

    const simMonth = Number(req.body?.sim_month || 1);

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    const availableSlotsResult = await client.query(
      `
      SELECT
        id,
        model_key,
        aircraft_name,
        slot_year,
        slot_month,
        COALESCE(max_quantity, 0) AS max_quantity,
        COALESCE(available_quantity, 0) AS available_quantity,
        COALESCE(reserved_quantity, 0) AS reserved_quantity,
        COALESCE(delivered_quantity, 0) AS delivered_quantity,
        COALESCE(base_delivery_days, 0) AS base_delivery_days
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND available_quantity > 0
        AND ((slot_year * 12) + slot_month) >= (($2::INTEGER * 12) + $3::INTEGER)
      ORDER BY slot_year ASC, slot_month ASC
      FOR UPDATE
      `,
      [modelKey, simYear, simMonth]
    );

    let remainingQuantityToReserve = quantity;
    const reservedFactorySlots = [];

    function ACS_getDaysInMonthUTC(year, month) {
      return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    }

    function ACS_calculateFactoryDeliveryDate(slotYear, slotMonth, capacity, slotIndex) {
      const daysInMonth = ACS_getDaysInMonthUTC(slotYear, slotMonth);

      const deliveryDay = Math.max(
        1,
        Math.min(
          daysInMonth,
          Math.round((Number(slotIndex) / (Number(capacity) + 1)) * daysInMonth)
        )
      );

      return new Date(Date.UTC(
        Number(slotYear),
        Number(slotMonth) - 1,
        deliveryDay,
        12,
        0,
        0
      ));
    }

    for (const slot of availableSlotsResult.rows) {
      if (remainingQuantityToReserve <= 0) break;

      const slotAvailable = Number(slot.available_quantity || 0);
      const slotCapacity = Math.max(
        Number(slot.max_quantity || 0),
        slotAvailable + Number(slot.reserved_quantity || 0) + Number(slot.delivered_quantity || 0),
        1
      );

      if (slotAvailable <= 0) continue;

      const reserveQty = Math.min(remainingQuantityToReserve, slotAvailable);

      const reservedBefore = Number(slot.reserved_quantity || 0);
      const deliveredBefore = Number(slot.delivered_quantity || 0);
      const reservedAfter = reservedBefore + reserveQty;
      const availableAfter = Math.max(0, slotAvailable - reserveQty);

      const deliverySlotIndex = reservedAfter;

      const slotDeliveryDate = ACS_calculateFactoryDeliveryDate(
        Number(slot.slot_year),
        Number(slot.slot_month),
        slotCapacity,
        deliverySlotIndex
      );

      await client.query(
        `
        UPDATE aircraft_factory_slots
        SET
          reserved_quantity = reserved_quantity + $2,
          available_quantity = GREATEST(0, available_quantity - $2),
          slot_status = CASE
            WHEN GREATEST(0, available_quantity - $2) <= 0
            THEN 'FULL'
            ELSE 'OPEN'
          END,
          utilization_pct = ROUND(
            (
              (
                COALESCE(reserved_quantity, 0)
                + $2
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
              /
              GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
            ) * 100,
            2
          ),
          updated_at = NOW()
        WHERE id = $1
        `,
        [slot.id, reserveQty]
      );

      reservedFactorySlots.push({
        slot_id: slot.id,
        slot_year: Number(slot.slot_year),
        slot_month: Number(slot.slot_month),
        reserved_quantity: reserveQty,
        capacity: slotCapacity,
        reserved_before: reservedBefore,
        reserved_after: reservedAfter,
        available_after: availableAfter,
        delivered_before: deliveredBefore,
        base_delivery_days: Number(slot.base_delivery_days || 0),
        estimated_delivery_date: slotDeliveryDate.toISOString()
      });

      remainingQuantityToReserve -= reserveQty;
    }

    if (remainingQuantityToReserve > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "FACTORY_SLOTS_UNAVAILABLE",
        model_key: modelKey,
        requested_quantity: quantity,
        reserved_quantity: quantity - remainingQuantityToReserve,
        missing_quantity: remainingQuantityToReserve,
        sim_year: simYear,
        sim_month: simMonth
      });
    }

    const factorySlotId = reservedFactorySlots[0]?.slot_id || null;

    const estimatedDeliveryDate = new Date(
      reservedFactorySlots[reservedFactorySlots.length - 1].estimated_delivery_date
    );

    /* ============================================================
       5) INSERT ORDER
       ============================================================ */

    const paymentStatus =
      initialPaymentPct >= 100
        ? "PAID"
        : "PARTIAL";

    const orderResult = await client.query(
      `
      INSERT INTO new_aircraft_orders (
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
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        'FACTORY',
        $3,
        $4,
        $5,
        $13,
        $6,
        $7,
        $8,
        'USD',
        $9,
        $10,
        'ORDERED',
        'PENDING_DELIVERY',
        NOW(),
        $11,
        NULL,
        $12,
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        airlineId,
        userId,
        aircraft.manufacturer,
        aircraft.model_key,
        aircraft.aircraft_name || `${aircraft.manufacturer} ${aircraft.model}`,
        quantity,
        unitPrice,
        totalPrice,
        dbOwnershipType,
        paymentStatus,
        estimatedDeliveryDate,
        JSON.stringify({
          initial_payment_pct: initialPaymentPct,
          initial_payment_amount: initialPaymentAmount,
          sim_year: simYear,
          source: "ACS_BUY_NEW_BACKEND_ORDER_V1"
        })
      ]
    );

    const order = orderResult.rows[0];

        /* ============================================================
       6) APPLY FINANCE IMPACT
       ------------------------------------------------------------
       BUY   → cost_new_aircraft_purchase
       LEASE → cost_leasing
       ============================================================ */

    if (ownershipType === "LEASE") {
      await client.query(
        `
        UPDATE company_finance
        SET
          capital = COALESCE(capital,0) - $2,
          expenses = COALESCE(expenses,0) + $2,
          profit = COALESCE(profit,0) - $2,
          cost_leasing = COALESCE(cost_leasing,0) + $2,
          updated_at = NOW()
        WHERE airline_id = $1
        `,
        [airlineId, initialPaymentAmount]
      );
    } else {
      await client.query(
        `
        UPDATE company_finance
        SET
          capital = COALESCE(capital,0) - $2,
          expenses = COALESCE(expenses,0) + $2,
          profit = COALESCE(profit,0) - $2,
          cost_new_aircraft_purchase = COALESCE(cost_new_aircraft_purchase,0) + $2,
          updated_at = NOW()
        WHERE airline_id = $1
        `,
        [airlineId, initialPaymentAmount]
      );
    }
     
    /* ============================================================
       7) FINANCE LOG
       ============================================================ */
     
    const aircraftLabel =
      aircraft.aircraft_name ||
      `${aircraft.manufacturer} ${aircraft.model}`;

    const financeSource =
      ownershipType === "LEASE"
        ? `OEM LEASE INITIAL — ${aircraftLabel}`
        : `OEM PURCHASE INITIAL — ${aircraftLabel}`;

    await client.query(
      `
      INSERT INTO finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES ($1, 'EXPENSE', $2, $3, $4)
      `,
      [
        airlineId,
        financeSource,
        initialPaymentAmount,
        Date.now()
      ]
    );

    /* ============================================================
       8) RETURN FINANCE SNAPSHOT
       ============================================================ */

    const financeAfterResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_CREATE_NEW_AIRCRAFT_ORDER",
      version: "v1.0",
      order,
      finance: financeAfterResult.rows[0],
      payment: {
        ownership_type: ownershipType,
        initial_payment_pct: initialPaymentPct,
        initial_payment_amount: initialPaymentAmount,
        total_price: totalPrice,
        currency: "USD"
      }
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS CREATE NEW AIRCRAFT ORDER ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "CREATE_NEW_AIRCRAFT_ORDER_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   🟦 ACS FACTORY SLOT AVAILABILITY — OEM BOARD v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/slots/availability?model_key=lockheed_l_049_constellation&year=1951&month=9

   Purpose:
   - Read OEM slot availability for one aircraft model/month
   - Feed Buy New Factory Slots modal
   - Shows capacity, reserved, available, utilization
   - Shows next available delivery window
   - PostgreSQL authority only
   - No reservation
   - No Finance mutation
   - No localStorage authority
   ============================================================ */

router.get("/aircraft/factory/slots/availability", requireAuth, async (req, res) => {
  try {
    const modelKey = String(req.query.model_key || "").trim();
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!modelKey) {
      return res.status(400).json({
        ok: false,
        error: "MODEL_KEY_REQUIRED"
      });
    }

    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_YEAR"
      });
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MONTH"
      });
    }

    const previousMonthDate = new Date(Date.UTC(year, month - 2, 1));
    const nextMonthDate = new Date(Date.UTC(year, month, 1));

    const currentSlotResult = await pool.query(
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

        COALESCE(
          max_quantity,
          COALESCE(available_quantity, 0)
          + COALESCE(reserved_quantity, 0)
          + COALESCE(delivered_quantity, 0)
        ) AS capacity,

        COALESCE(reserved_quantity, 0) AS reserved,
        COALESCE(available_quantity, 0) AS available,
        COALESCE(delivered_quantity, 0) AS delivered,

        CASE
          WHEN COALESCE(
            max_quantity,
            COALESCE(available_quantity, 0)
            + COALESCE(reserved_quantity, 0)
            + COALESCE(delivered_quantity, 0)
          ) > 0
          THEN ROUND(
            (
              COALESCE(reserved_quantity, 0)::NUMERIC
              /
              COALESCE(
                max_quantity,
                COALESCE(available_quantity, 0)
                + COALESCE(reserved_quantity, 0)
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
            ) * 100,
            2
          )
          ELSE 0
        END AS utilization_pct,

        slot_units_per_aircraft,
        capacity_tier,
        aircraft_size_class,
        base_delivery_days,
        slot_status,
        created_at,
        updated_at
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND slot_year = $2
        AND slot_month = $3
      LIMIT 1
      `,
      [modelKey, year, month]
    );

    const nextAvailableResult = await pool.query(
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

        COALESCE(
          max_quantity,
          COALESCE(available_quantity, 0)
          + COALESCE(reserved_quantity, 0)
          + COALESCE(delivered_quantity, 0)
        ) AS capacity,

        COALESCE(reserved_quantity, 0) AS reserved,
        COALESCE(available_quantity, 0) AS available,
        COALESCE(delivered_quantity, 0) AS delivered,

        CASE
          WHEN COALESCE(
            max_quantity,
            COALESCE(available_quantity, 0)
            + COALESCE(reserved_quantity, 0)
            + COALESCE(delivered_quantity, 0)
          ) > 0
          THEN ROUND(
            (
              COALESCE(reserved_quantity, 0)::NUMERIC
              /
              COALESCE(
                max_quantity,
                COALESCE(available_quantity, 0)
                + COALESCE(reserved_quantity, 0)
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
            ) * 100,
            2
          )
          ELSE 0
        END AS utilization_pct,

        slot_units_per_aircraft,
        capacity_tier,
        aircraft_size_class,
        base_delivery_days,
        slot_status
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND available_quantity > 0
        AND ((slot_year * 12) + slot_month) >= (($2::INTEGER * 12) + $3::INTEGER)
      ORDER BY slot_year ASC, slot_month ASC
      LIMIT 1
      `,
      [modelKey, year, month]
    );

    const currentSlot = currentSlotResult.rows[0] || null;
    const nextAvailable = nextAvailableResult.rows[0] || null;

    let estimatedDeliveryPreview = null;

    if (nextAvailable) {
      const slotBaseDate = new Date(Date.UTC(
        Number(nextAvailable.slot_year),
        Number(nextAvailable.slot_month) - 1,
        1
      ));

      estimatedDeliveryPreview = new Date(
        slotBaseDate.getTime() +
        Number(nextAvailable.base_delivery_days || 0) * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    return res.json({
      ok: true,
      endpoint: "ACS_FACTORY_SLOT_AVAILABILITY",
      version: "v1.0",

      query: {
        model_key: modelKey,
        year,
        month
      },

      navigation: {
        previous: {
          year: previousMonthDate.getUTCFullYear(),
          month: previousMonthDate.getUTCMonth() + 1
        },
        current: {
          year,
          month
        },
        next: {
          year: nextMonthDate.getUTCFullYear(),
          month: nextMonthDate.getUTCMonth() + 1
        }
      },

      slot: currentSlot,

      next_available_delivery_window: nextAvailable
        ? {
            slot_id: nextAvailable.id,
            slot_year: nextAvailable.slot_year,
            slot_month: nextAvailable.slot_month,
            capacity: Number(nextAvailable.capacity || 0),
            reserved: Number(nextAvailable.reserved || 0),
            available: Number(nextAvailable.available || 0),
            utilization_pct: Number(nextAvailable.utilization_pct || 0),
            base_delivery_days: Number(nextAvailable.base_delivery_days || 0),
            estimated_delivery_preview: estimatedDeliveryPreview
          }
        : null
    });

  } catch (err) {
    console.error("ACS FACTORY SLOT AVAILABILITY ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FACTORY_SLOT_AVAILABILITY_FAILED",
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
   🟦 ACS FACTORY CATALOG — BACKEND AUTHORITY v1.1
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/catalog?year=1940

   Purpose:
   - Return aircraft models available from factory for a given year
   - PostgreSQL authority only
   - Join aircraft_catalog + aircraft_production_rules
   - aircraft_catalog provides technical/commercial specs
   - aircraft_production_rules provides historical OEM availability
   - Used Market and Fleet remain separate systems
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/factory/catalog", requireAuth, async (req, res) => {
  try {
    const yearParam = req.query.year;
    const selectedYear = Number(yearParam);

    if (!yearParam || !Number.isInteger(selectedYear) || selectedYear < 1900 || selectedYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "Valid year query parameter is required"
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
        ac.image_filename,
        ac.image_filename AS image_file_name,

        pr.id AS production_rule_id,
        pr.rule_uid,
        pr.aircraft_category AS production_category,
        pr.production_start_year,
        pr.production_end_year,
        pr.first_delivery_year,
        pr.last_delivery_year,
        pr.capacity_tier,
        pr.manufacturer_weight,
        pr.model_weight,
        pr.monthly_min_units,
        pr.monthly_max_units,
        pr.monthly_min_units AS monthly_min,
        pr.monthly_max_units AS monthly_max,
        pr.is_factory_available,
        pr.is_active_rule

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE
        COALESCE(ac.is_active, true) = true
        AND pr.is_active_rule = true
        AND pr.is_factory_available = true
        AND COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $1
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $1
        )

      ORDER BY
        COALESCE(pr.production_start_year, ac.production_year, ac.year) ASC,
        ac.manufacturer ASC,
        ac.model ASC
      `,
      [selectedYear]
    );

    return res.json({
      ok: true,
      endpoint: "ACS_FACTORY_CATALOG",
      version: "v1.1",
      year: selectedYear,
      count: result.rows.length,

      aircraft: result.rows,

      /* Temporary migration alias — keep until Buy New fully migrates */
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

/* ============================================================
   🟦 ACS AIRCRAFT CATALOG — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/catalog

   Purpose:
   - Read the complete technical aircraft universe from PostgreSQL
   - Preserve ACS aircraft DB structure for modals, images and aircraft data
   - PostgreSQL becomes backend technical authority
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/catalog", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        catalog_uid,
        model_key,
        manufacturer,
        model,
        aircraft_name,
        production_year,
        year,
        seats,
        range_nm,
        speed_kts,
        mtow_kg,
        fuel_burn_kgph,
        price_acs_usd,
        engines,
        aircraft_category,
        status,
        image_filename,
        raw_data,
        is_active,
        created_at,
        updated_at
      FROM aircraft_catalog
      WHERE is_active = true
      ORDER BY year ASC, manufacturer ASC, model ASC
      `
    );

    return res.json({
      ok: true,
      catalog: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_CATALOG_FAILED",
      details: err.message
    });
  }
});

export default router;
