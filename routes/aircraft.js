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
    initial_payment_amount,
    final_payment_amount,
    currency,
    ownership_type,
    payment_status,
    final_payment_status,
    order_status,
    delivery_status,
    order_date,
    estimated_delivery_date,
    actual_delivery_date,
    payment_hold_started_at,
    payment_hold_until,
    default_penalty_amount,
    refund_amount,
    delivery_resolved_at,
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

/* ============================================================
   🟦 ACS LEASE NEW OCC POLICY — SERVER AUTHORITY v1.0
   ------------------------------------------------------------
   The frontend may send lease metadata, but backend remains the
   authority for:
   - lease initial commitment
   - lease duration
   - monthly lease rate
   - lessor / broker naming
   ============================================================ */

const requestedInitialPaymentPct =
  Number(req.body?.initial_payment_pct || 100);

const requestedLeaseYears =
  Number(req.body?.lease_years || 10);

const leaseYears =
  ownershipType === "LEASE"
    ? requestedLeaseYears
    : null;

const leaseTermMonths =
  ownershipType === "LEASE"
    ? leaseYears * 12
    : null;

const leaseRatePctMonthly =
  ownershipType === "LEASE"
    ? leaseYears === 5
      ? 0.0125
      : leaseYears === 10
        ? 0.0095
        : leaseYears === 15
          ? 0.0075
          : 0.0095
    : null;

const lessorName =
  ownershipType === "LEASE"
    ? "Eagle Aviation Capital"
    : null;

const remarketingAgent =
  ownershipType === "LEASE"
    ? "Eagle Broker"
    : null;

const leasePolicyVersion =
  ownershipType === "LEASE"
    ? "ACS_LEASE_NEW_OCC_V1"
    : null;

/*
  BUY uses selected initial payment.
  LEASE always uses 15% initial lease commitment.
*/
const initialPaymentPct =
  ownershipType === "LEASE"
    ? 15
    : requestedInitialPaymentPct;

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

if (
  ownershipType === "LEASE" &&
  ![5, 10, 15].includes(Number(leaseYears))
) {
  return res.status(400).json({
    ok: false,
    error: "INVALID_LEASE_YEARS",
    allowed_values: [5, 10, 15]
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

    /* ============================================================
   🟦 ACS BUY / LEASE PAYMENT SPLIT — BACKEND AUTHORITY v1.1
   ------------------------------------------------------------
   BUY:
   - initial_payment_pct defines upfront payment
   - remaining balance becomes final_payment_amount

   LEASE:
   - initial_payment_pct is forced to 15%
   - final_payment_amount must be 0
   - lease monthly payment is calculated from aircraft value
   ============================================================ */

const initialPaymentAmount = Math.round(
  totalPrice * (initialPaymentPct / 100)
);

const finalPaymentAmount =
  ownershipType === "LEASE"
    ? 0
    : Math.max(totalPrice - initialPaymentAmount, 0);

const monthlyLeasePayment =
  ownershipType === "LEASE"
    ? Math.round(totalPrice * Number(leaseRatePctMonthly || 0))
    : null;

const leaseInitialCommitmentAmount =
  ownershipType === "LEASE"
    ? initialPaymentAmount
    : null;
     
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
       - Delivery date = max(projected slot date, current sim date)
         + base_delivery_days
       - Does NOT use Date.now() as delivery authority
       ============================================================ */

    const simMonth = Number(req.body?.sim_month || 1);
    const simDay = Number(req.body?.sim_day || 1);

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_DAY"
      });
    }

    const currentSimDate = new Date(Date.UTC(
      simYear,
      simMonth - 1,
      simDay,
      12,
      0,
      0
    ));

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

    function ACS_getProjectedFactorySlotDate(slotYear, slotMonth, capacity, slotIndex) {
      const daysInMonth = ACS_getDaysInMonthUTC(slotYear, slotMonth);

      const projectedSlotDay = Math.max(
        1,
        Math.min(
          daysInMonth,
          Math.round((Number(slotIndex) / (Number(capacity) + 1)) * daysInMonth)
        )
      );

      return new Date(Date.UTC(
        Number(slotYear),
        Number(slotMonth) - 1,
        projectedSlotDay,
        12,
        0,
        0
      ));
    }

    function ACS_getEstimatedDeliveryDate(projectedSlotDate, currentSimDate, baseDeliveryDays) {
      const deliveryBaseDate =
        projectedSlotDate.getTime() < currentSimDate.getTime()
          ? currentSimDate
          : projectedSlotDate;

      return new Date(
        deliveryBaseDate.getTime() +
        Number(baseDeliveryDays || 0) * 24 * 60 * 60 * 1000
      );
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

      const projectedSlotDate = ACS_getProjectedFactorySlotDate(
        Number(slot.slot_year),
        Number(slot.slot_month),
        slotCapacity,
        deliverySlotIndex
      );

      const slotDeliveryDate = ACS_getEstimatedDeliveryDate(
        projectedSlotDate,
        currentSimDate,
        Number(slot.base_delivery_days || 0)
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
        projected_slot_date: projectedSlotDate.toISOString(),
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
        sim_month: simMonth,
        sim_day: simDay
      });
    }

    const factorySlotId = reservedFactorySlots[0]?.slot_id || null;

    const estimatedDeliveryDate = new Date(
      reservedFactorySlots[reservedFactorySlots.length - 1].estimated_delivery_date
    );

    /* ============================================================
   5) INSERT ORDER
   ------------------------------------------------------------
   ACS OCC Rule:
   - Store Buy New financial state in real DB columns
   - notes remains secondary audit metadata only
   - Resolver must never depend only on notes JSON
   ============================================================ */

/* ============================================================
   🟦 ACS BUY / LEASE PAYMENT STATUS RULE — v1.1
   ------------------------------------------------------------
   LEASE:
   - Treated as paid for delivery purposes after lease commitment.
   - No final purchase balance exists.
   - Must never enter PAYMENT_HOLD due to final payment.
   ============================================================ */

const paymentStatus =
  ownershipType === "LEASE"
    ? "PAID"
    : initialPaymentPct >= 100
      ? "PAID"
      : "FINANCED";

const finalPaymentStatus =
  ownershipType === "LEASE"
    ? "PAID"
    : paymentStatus === "PAID"
      ? "PAID"
      : "NOT_DUE";

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
    initial_payment_amount,
    final_payment_amount,
    currency,
    ownership_type,
    payment_status,
    final_payment_status,
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
    $15,
    $6,
    $7,
    $8,
    $9,
    $10,
    'USD',
    $11,
    $12,
    $13,
    'ORDERED',
    'PENDING_DELIVERY',
    NOW(),
    $14,
    NULL,
    $16,
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
    initialPaymentAmount,
    finalPaymentAmount,
    dbOwnershipType,
    paymentStatus,
    finalPaymentStatus,
    estimatedDeliveryDate,
    factorySlotId,
    JSON.stringify({
      initial_payment_pct: initialPaymentPct,
      initial_payment_amount: initialPaymentAmount,
      final_payment_amount: finalPaymentAmount,
      final_payment_status: finalPaymentStatus,
      sim_year: simYear,
      sim_month: simMonth,
      sim_day: simDay,
      factory_slot_id: factorySlotId,
      factory_slots_reserved: reservedFactorySlots,

/* Lease New OCC metadata */
lease_years: ownershipType === "LEASE" ? leaseYears : null,
lease_term_months: ownershipType === "LEASE" ? leaseTermMonths : null,
monthly_lease_payment: ownershipType === "LEASE" ? monthlyLeasePayment : null,
lease_initial_commitment_pct: ownershipType === "LEASE" ? 15 : null,
lease_initial_commitment_amount: ownershipType === "LEASE" ? leaseInitialCommitmentAmount : null,
lease_rate_pct_monthly: ownershipType === "LEASE" ? leaseRatePctMonthly : null,
lessor_name: ownershipType === "LEASE" ? lessorName : null,
remarketing_agent: ownershipType === "LEASE" ? remarketingAgent : null,
lease_policy_version: ownershipType === "LEASE" ? leasePolicyVersion : null,
contract_lock: ownershipType === "LEASE" ? "NO_FREE_RETURN_BEFORE_CONTRACT_END" : null,
end_of_lease_options: ownershipType === "LEASE"
  ? ["EXTEND", "BUYOUT", "RETURN_AT_CONTRACT_END"]
  : null,

source: ownershipType === "LEASE"
  ? "ACS_LEASE_NEW_BACKEND_ORDER_OCC_V1"
  : "ACS_BUY_NEW_BACKEND_ORDER_V3_REAL_PAYMENT_COLUMNS"
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
  db_ownership_type: dbOwnershipType,
  initial_payment_pct: initialPaymentPct,
  initial_payment_amount: initialPaymentAmount,
  final_payment_amount: finalPaymentAmount,
  total_price: totalPrice,
  payment_status: paymentStatus,
  final_payment_status: finalPaymentStatus,

  lease: ownershipType === "LEASE"
    ? {
        lease_years: leaseYears,
        lease_term_months: leaseTermMonths,
        monthly_lease_payment: monthlyLeasePayment,
        lease_initial_commitment_pct: 15,
        lease_initial_commitment_amount: leaseInitialCommitmentAmount,
        lease_rate_pct_monthly: leaseRatePctMonthly,
        lessor_name: lessorName,
        remarketing_agent: remarketingAgent,
        lease_policy_version: leasePolicyVersion,
        contract_lock: "NO_FREE_RETURN_BEFORE_CONTRACT_END",
        end_of_lease_options: ["EXTEND", "BUYOUT", "RETURN_AT_CONTRACT_END"]
      }
    : null,

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
    let projectedSlotDatePreview = null;

    function ACS_getDaysInMonthUTC(year, month) {
      return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    }

    function ACS_getProjectedFactorySlotDate(slotYear, slotMonth, capacity, reserved) {
      const daysInMonth = ACS_getDaysInMonthUTC(slotYear, slotMonth);

      const nextSlotIndex = Number(reserved || 0) + 1;

      const projectedSlotDay = Math.max(
        1,
        Math.min(
          daysInMonth,
          Math.round((nextSlotIndex / (Number(capacity || 1) + 1)) * daysInMonth)
        )
      );

      return new Date(Date.UTC(
        Number(slotYear),
        Number(slotMonth) - 1,
        projectedSlotDay,
        12,
        0,
        0
      ));
    }

    if (nextAvailable) {
      const projectedSlotDate = ACS_getProjectedFactorySlotDate(
        Number(nextAvailable.slot_year),
        Number(nextAvailable.slot_month),
        Number(nextAvailable.capacity || 1),
        Number(nextAvailable.reserved || 0)
      );

      projectedSlotDatePreview = projectedSlotDate.toISOString();

      estimatedDeliveryPreview = new Date(
        projectedSlotDate.getTime() +
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
            projected_slot_date_preview: projectedSlotDatePreview,
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

/* ============================================================
   🟦 ACS BUY NEW DELIVERY RESOLVER — DRY RUN v1.2
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders/delivery-resolver/dry-run

   Purpose:
   - Preview due Buy New aircraft orders
   - No Finance mutation
   - No aircraft_fleet insert
   - No factory slot update
   - No Time Engine mutation
   - Multiplayer-safe design preview

   v1.2 Scope:
   - PAID + PENDING_DELIVERY → deliver preview
   - FINANCED + sufficient capital → charge final payment + deliver preview
   - FINANCED + insufficient capital → move to PAYMENT_HOLD preview
   - PAYMENT_HOLD before grace limit → PAYMENT_HOLD_ACTIVE
   - PAYMENT_HOLD at/after grace limit → DEFAULT_AFTER_PAYMENT_HOLD
   - Default math:
     penalty = 25% initial_payment_amount
     refund  = 75% initial_payment_amount
   ============================================================ */

router.post("/aircraft/orders/delivery-resolver/dry-run", requireAuth, async (req, res) => {
  try {
    const simYear = Number(req.body?.sim_year);
    const simMonth = Number(req.body?.sim_month);
    const simDay = Number(req.body?.sim_day);

    if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR"
      });
    }

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_DAY"
      });
    }

    const resolverDate = new Date(Date.UTC(
      simYear,
      simMonth - 1,
      simDay,
      12,
      0,
      0
    ));

    /* ============================================================
       1) LOAD DUE ORDERS — DRY RUN ONLY
       ------------------------------------------------------------
       Includes:
       - PENDING_DELIVERY orders due by estimated_delivery_date
       - PAYMENT_HOLD orders due for grace-period review
       ============================================================ */

    const dueOrdersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_uid,
        o.airline_id,
        o.user_id,
        o.manufacturer,
        o.model_key,
        o.aircraft_name,
        o.factory_slot_id,
        o.quantity,
        o.unit_price,
        o.total_price,
        o.initial_payment_amount,
        o.final_payment_amount,
        o.payment_status,
        o.final_payment_status,
        o.order_status,
        o.delivery_status,
        o.estimated_delivery_date,
        o.actual_delivery_date,
        o.payment_hold_started_at,
        o.payment_hold_until,
        o.default_penalty_amount,
        o.refund_amount,
        o.delivery_resolved_at,
        f.capital AS current_capital
      FROM new_aircraft_orders o
      LEFT JOIN company_finance f
        ON f.airline_id = o.airline_id
      WHERE o.source = 'FACTORY'
        AND o.order_status = 'ORDERED'
        AND o.delivery_status IN ('PENDING_DELIVERY', 'PAYMENT_HOLD')
        AND o.payment_status IN ('PAID', 'FINANCED')
        AND o.estimated_delivery_date IS NOT NULL
        AND o.estimated_delivery_date <= $1
      ORDER BY o.estimated_delivery_date ASC, o.id ASC
      `,
      [resolverDate]
    );

    /* ============================================================
       2) BUILD PREVIEW ACTIONS
       ============================================================ */

    const preview = dueOrdersResult.rows.map(order => {
      const paymentStatus = String(order.payment_status || "");
      const deliveryStatus = String(order.delivery_status || "");
      const finalPaymentStatus = String(order.final_payment_status || "");

      const capital = Math.round(Number(order.current_capital || 0));
      const initialPayment = Math.round(Number(order.initial_payment_amount || 0));
      const finalPayment = Math.round(Number(order.final_payment_amount || 0));

      const paymentHoldUntil = order.payment_hold_until
        ? new Date(order.payment_hold_until)
        : null;

      const defaultPenaltyAmount = Math.round(initialPayment * 0.25);
      const refundAmount = Math.round(initialPayment * 0.75);

      let resolver_action = "NO_ACTION";
      let resolver_reason = "NO_MATCHING_RULE";
      let payment_hold_status = null;
      let default_preview = null;

      /* ============================================================
         2A) STANDARD PENDING DELIVERY RULES
         ============================================================ */

      if (deliveryStatus === "PENDING_DELIVERY" && paymentStatus === "PAID") {
        resolver_action = "DELIVER_PAID_ORDER";
        resolver_reason = "ORDER_FULLY_PAID_AND_DUE_FOR_DELIVERY";
      }

      if (deliveryStatus === "PENDING_DELIVERY" && paymentStatus === "FINANCED") {
        if (capital >= finalPayment) {
          resolver_action = "CHARGE_FINAL_PAYMENT_AND_DELIVER";
          resolver_reason = "CAPITAL_SUFFICIENT_FOR_FINAL_PAYMENT";
        } else {
          resolver_action = "MOVE_TO_PAYMENT_HOLD";
          resolver_reason = "INSUFFICIENT_CAPITAL_FOR_FINAL_PAYMENT";
        }
      }

      /* ============================================================
         2B) PAYMENT HOLD GRACE PERIOD RULES — v1.2
         ------------------------------------------------------------
         If resolverDate < payment_hold_until:
         - Order remains in PAYMENT_HOLD

         If resolverDate >= payment_hold_until:
         - Order defaults
         - 25% of initial payment retained as penalty
         - 75% refunded to company capital
         - No aircraft created
         - Factory slot must be released in LIVE
         ============================================================ */

      if (deliveryStatus === "PAYMENT_HOLD") {
        if (!paymentHoldUntil || Number.isNaN(paymentHoldUntil.getTime())) {
          resolver_action = "PAYMENT_HOLD_REVIEW_BLOCKED";
          resolver_reason = "PAYMENT_HOLD_UNTIL_MISSING_OR_INVALID";
          payment_hold_status = "INVALID_PAYMENT_HOLD_DATE";
        } else if (resolverDate.getTime() < paymentHoldUntil.getTime()) {
          resolver_action = "PAYMENT_HOLD_ACTIVE";
          resolver_reason = "GRACE_PERIOD_STILL_ACTIVE";
          payment_hold_status = "ACTIVE";
        } else {
          resolver_action = "DEFAULT_AFTER_PAYMENT_HOLD";
          resolver_reason = "PAYMENT_HOLD_GRACE_PERIOD_EXPIRED";
          payment_hold_status = "EXPIRED";

          default_preview = {
            payment_status_after_default: "CANCELLED",
            final_payment_status_after_default: "DEFAULTED",
            delivery_status_after_default: "CANCELLED_PAYMENT_DEFAULT",
            default_penalty_amount: defaultPenaltyAmount,
            refund_amount: refundAmount,
            capital_before_refund: capital,
            capital_after_refund_preview: capital + refundAmount,
            aircraft_fleet_created: false,
            factory_slot_release_required: true,
            factory_slot_id: order.factory_slot_id || null
          };
        }
      }

      return {
        ...order,
        resolver_action,
        resolver_reason,
        resolver_date: resolverDate.toISOString(),

        payment_hold_status,
        payment_hold_until_iso: paymentHoldUntil
          ? paymentHoldUntil.toISOString()
          : null,

        capital_available: capital,
        initial_payment_amount_numeric: initialPayment,
        final_payment_required: finalPayment,
        capital_sufficient_for_final_payment: capital >= finalPayment,

        default_penalty_preview: defaultPenaltyAmount,
        refund_preview: refundAmount,
        default_preview,

        dry_run_only: true,
        mutation_performed: false
      };
    });

    return res.json({
      ok: true,
      endpoint: "ACS_BUY_NEW_DELIVERY_RESOLVER_DRY_RUN",
      version: "v1.2",
      mode: "DRY_RUN_NO_MUTATION",
      resolver_date: resolverDate.toISOString(),
      due_count: preview.length,
      due_orders: preview
    });

  } catch (err) {
    console.error("ACS BUY NEW DELIVERY RESOLVER DRY RUN ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "BUY_NEW_DELIVERY_RESOLVER_DRY_RUN_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS BUY NEW DELIVERY RESOLVER — LIVE v1.2
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders/delivery-resolver

   Purpose:
   - Resolve due Buy New aircraft orders
   - Multiplayer-safe backend authority
   - Charges final payment when capital is sufficient
   - Delivers aircraft into aircraft_fleet
   - Moves financed orders to PAYMENT_HOLD when capital is insufficient
   - Defaults PAYMENT_HOLD orders after 30 simulated days
   - Releases factory slot on payment default
   - Registers finance_log entries
   - Does NOT mutate Time Engine
   - Does NOT use localStorage
   - Does NOT touch Lease New

   v1.2 Scope:
   - PAID + PENDING_DELIVERY → deliver
   - FINANCED + sufficient capital → charge final payment + deliver
   - FINANCED + insufficient capital → PAYMENT_HOLD
   - PAYMENT_HOLD + resolverDate < payment_hold_until → keep active
   - PAYMENT_HOLD + resolverDate >= payment_hold_until → DEFAULT
   ============================================================ */

router.post("/aircraft/orders/delivery-resolver", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const simYear = Number(req.body?.sim_year);
    const simMonth = Number(req.body?.sim_month);
    const simDay = Number(req.body?.sim_day);

    /*
      Optional OCC test guard:
      - If order_id is provided, LIVE resolver processes only that order.
      - This protects production tests when due_count contains more than one order.
    */
    const requestedOrderId =
      req.body?.order_id === undefined || req.body?.order_id === null || req.body?.order_id === ""
        ? null
        : Number(req.body.order_id);

    if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR"
      });
    }

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_DAY"
      });
    }

    if (
      requestedOrderId !== null &&
      (!Number.isInteger(requestedOrderId) || requestedOrderId <= 0)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ORDER_ID"
      });
    }

    const resolverDate = new Date(Date.UTC(
      simYear,
      simMonth - 1,
      simDay,
      12,
      0,
      0
    ));

    await client.query("BEGIN");

    /* ============================================================
       1) LOAD DUE ORDERS — MULTIPLAYER SAFE
       ------------------------------------------------------------
       Includes:
       - PENDING_DELIVERY due orders
       - PAYMENT_HOLD due orders for grace/default review

       Optional:
       - requestedOrderId limits LIVE mutation to one order.
       ============================================================ */

    const dueOrdersResult = await client.query(
      `
      SELECT
        o.*,
        f.capital AS current_capital,
        u.base_icao AS user_base_icao
      FROM new_aircraft_orders o
      LEFT JOIN company_finance f
        ON f.airline_id = o.airline_id
      LEFT JOIN users u
        ON u.user_id = o.user_id
      WHERE o.source = 'FACTORY'
        AND o.order_status = 'ORDERED'
        AND o.delivery_status IN ('PENDING_DELIVERY', 'PAYMENT_HOLD')
        AND o.payment_status IN ('PAID', 'FINANCED')
        AND o.estimated_delivery_date IS NOT NULL
        AND o.estimated_delivery_date <= $1
        AND ($2::BIGINT IS NULL OR o.id = $2::BIGINT)
      ORDER BY o.estimated_delivery_date ASC, o.id ASC
      FOR UPDATE OF o SKIP LOCKED
      `,
      [resolverDate, requestedOrderId]
    );

    const processed = [];
    const skipped = [];

    /* ============================================================
       2) PROCESS EACH DUE ORDER
       ============================================================ */

    for (const order of dueOrdersResult.rows) {
      const orderId = Number(order.id);
      const airlineId = Number(order.airline_id);
      const quantity = Math.max(1, Number(order.quantity || 1));

      const paymentStatus = String(order.payment_status || "");
      const deliveryStatus = String(order.delivery_status || "");

      const initialPaymentAmount = Math.round(Number(order.initial_payment_amount || 0));
      const finalPaymentAmount = Math.round(Number(order.final_payment_amount || 0));
      const currentCapital = Math.round(Number(order.current_capital || 0));

      const aircraftLabel =
        order.aircraft_name ||
        `${order.manufacturer || ""} ${order.model_key || ""}`.trim();

      const baseIcao =
        order.user_base_icao ||
        null;

      /* ============================================================
         2A) PAYMENT HOLD DEFAULT REVIEW — v1.2
         ------------------------------------------------------------
         Rule:
         If resolverDate >= payment_hold_until and order remains
         PAYMENT_HOLD:
         - Cancel order
         - final_payment_status = DEFAULTED
         - delivery_status = CANCELLED_PAYMENT_DEFAULT
         - Retain 25% initial payment as penalty
         - Refund 75% initial payment to capital
         - Release factory slot
         - Do NOT create aircraft_fleet
         ============================================================ */

      if (deliveryStatus === "PAYMENT_HOLD") {
        const paymentHoldUntil = order.payment_hold_until
          ? new Date(order.payment_hold_until)
          : null;

        if (!paymentHoldUntil || Number.isNaN(paymentHoldUntil.getTime())) {
          skipped.push({
            order_id: orderId,
            airline_id: airlineId,
            aircraft_name: aircraftLabel,
            action: "PAYMENT_HOLD_REVIEW_BLOCKED",
            reason: "PAYMENT_HOLD_UNTIL_MISSING_OR_INVALID"
          });

          continue;
        }

        if (resolverDate.getTime() < paymentHoldUntil.getTime()) {
          processed.push({
            order_id: orderId,
            airline_id: airlineId,
            aircraft_name: aircraftLabel,
            action: "PAYMENT_HOLD_ACTIVE",
            reason: "GRACE_PERIOD_STILL_ACTIVE",
            payment_hold_until: paymentHoldUntil.toISOString(),
            mutation: "NO_DEFAULT_APPLIED"
          });

          continue;
        }

        const defaultPenaltyAmount = Math.round(initialPaymentAmount * 0.25);
        const refundAmount = Math.round(initialPaymentAmount * 0.75);

        /* ============================================================
           2A.1) LOCK FINANCE ROW
           ============================================================ */

        await client.query(
          `
          SELECT airline_id
          FROM company_finance
          WHERE airline_id = $1
          FOR UPDATE
          `,
          [airlineId]
        );

        /* ============================================================
           2A.2) APPLY REFUND TO COMPANY CAPITAL
           ------------------------------------------------------------
           Penalty is retained by OEM.
           Since the original initial payment was already recorded as an
           expense when the order was created, LIVE default only returns
           the refundable 75% to capital and logs both audit lines.
           ============================================================ */

        const financeBeforeDefaultResult = await client.query(
          `
          SELECT *
          FROM company_finance
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        const financeBeforeDefault = financeBeforeDefaultResult.rows[0] || null;
        const capitalBeforeRefund = Math.round(Number(financeBeforeDefault?.capital || 0));

        await client.query(
          `
          UPDATE company_finance
          SET
            capital = COALESCE(capital, 0) + $2,
            revenue = COALESCE(revenue, 0) + $2,
            profit = COALESCE(profit, 0) + $2,
            updated_at = NOW()
          WHERE airline_id = $1
          `,
          [airlineId, refundAmount]
        );

        const financeAfterDefaultResult = await client.query(
          `
          SELECT *
          FROM company_finance
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        const financeAfterDefault = financeAfterDefaultResult.rows[0] || null;
        const capitalAfterRefund = Math.round(Number(financeAfterDefault?.capital || 0));

        /* ============================================================
           2A.3) FINANCE LOG — REFUND + PENALTY
           ============================================================ */

        await client.query(
          `
          INSERT INTO finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            created_at
          )
          VALUES
            ($1, 'INCOME', $2, $3, $5, NOW()),
            ($1, 'EXPENSE', $4, $6, $5, NOW())
          `,
          [
            airlineId,
            `OEM PURCHASE DEFAULT REFUND — ${aircraftLabel}`,
            refundAmount,
            `OEM PURCHASE DEFAULT PENALTY — ${aircraftLabel}`,
            Date.now(),
            defaultPenaltyAmount
          ]
        );

        /* ============================================================
           2A.4) RELEASE FACTORY SLOT(S)
           ------------------------------------------------------------
           Uses notes.factory_slots_reserved when available.
           Fallback: factory_slot_id + order quantity.
           ============================================================ */

        let reservedSlots = [];

        try {
          const parsedNotes =
            order.notes && String(order.notes).trim()
              ? JSON.parse(order.notes)
              : {};

          if (Array.isArray(parsedNotes.factory_slots_reserved)) {
            reservedSlots = parsedNotes.factory_slots_reserved;
          }
        } catch (notesError) {
          reservedSlots = [];
        }

        if (!reservedSlots.length && order.factory_slot_id) {
          reservedSlots = [{
            slot_id: order.factory_slot_id,
            reserved_quantity: quantity
          }];
        }

        const releasedSlots = [];

        for (const slot of reservedSlots) {
          const slotId = Number(slot.slot_id);
          const reservedQty = Math.max(1, Number(slot.reserved_quantity || 1));

          if (!slotId) continue;

          const slotUpdateResult = await client.query(
            `
            UPDATE aircraft_factory_slots
            SET
              reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
              available_quantity = COALESCE(available_quantity, 0) + $2,
              slot_status = CASE
                WHEN COALESCE(available_quantity, 0) + $2 > 0
                THEN 'OPEN'
                ELSE slot_status
              END,
              utilization_pct = ROUND(
                (
                  (
                    GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
                    + COALESCE(delivered_quantity, 0)
                  )::NUMERIC
                  /
                  GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
                ) * 100,
                2
              ),
              updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              available_quantity,
              reserved_quantity,
              delivered_quantity,
              slot_status,
              utilization_pct
            `,
            [slotId, reservedQty]
          );

          if (slotUpdateResult.rows[0]) {
            releasedSlots.push(slotUpdateResult.rows[0]);
          }
        }

        /* ============================================================
           2A.5) MARK ORDER AS CANCELLED PAYMENT DEFAULT
           ============================================================ */

        const defaultOrderResult = await client.query(
          `
          UPDATE new_aircraft_orders
          SET
            payment_status = 'CANCELLED',
            final_payment_status = 'DEFAULTED',
            order_status = 'CANCELLED',
            delivery_status = 'CANCELLED_PAYMENT_DEFAULT',
            default_penalty_amount = $2,
            refund_amount = $3,
            delivery_resolved_at = NOW(),
            notes = (
              COALESCE(NULLIF(notes, ''), '{}')::jsonb
              || jsonb_build_object(
                'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2_DEFAULT',
                'payment_default_applied', true,
                'delivery_resolver_date', ($4::timestamp)::text,
                'payment_hold_until', ($5::timestamp)::text,
                'default_penalty_amount', $2::numeric,
                'refund_amount', $3::numeric,
                'capital_before_refund', $6::numeric,
                'capital_after_refund', $7::numeric,
                'aircraft_fleet_created', false,
                'factory_slots_released', $8::jsonb
              )
            )::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            orderId,
            defaultPenaltyAmount,
            refundAmount,
            resolverDate,
            paymentHoldUntil,
            capitalBeforeRefund,
            capitalAfterRefund,
            JSON.stringify(releasedSlots)
          ]
        );

        processed.push({
          order_id: orderId,
          airline_id: airlineId,
          aircraft_name: aircraftLabel,
          action: "DEFAULT_AFTER_PAYMENT_HOLD_APPLIED",
          reason: "PAYMENT_HOLD_GRACE_PERIOD_EXPIRED",
          payment_status: "CANCELLED",
          final_payment_status: "DEFAULTED",
          delivery_status: "CANCELLED_PAYMENT_DEFAULT",
          default_penalty_amount: defaultPenaltyAmount,
          refund_amount: refundAmount,
          capital_before_refund: capitalBeforeRefund,
          capital_after_refund: capitalAfterRefund,
          aircraft_fleet_created: false,
          released_slots: releasedSlots,
          order: defaultOrderResult.rows[0],
          finance: financeAfterDefault
        });

        continue;
      }

      /* ============================================================
         2B) PENDING DELIVERY RULES
         ============================================================ */

      const shouldChargeFinalPayment =
        paymentStatus === "FINANCED" &&
        finalPaymentAmount > 0;

      if (shouldChargeFinalPayment && currentCapital < finalPaymentAmount) {
        const paymentHoldUntil = new Date(
          resolverDate.getTime() + (30 * 24 * 60 * 60 * 1000)
        );

        const holdResult = await client.query(
          `
          UPDATE new_aircraft_orders
          SET
            delivery_status = 'PAYMENT_HOLD',
            final_payment_status = 'PAYMENT_HOLD',
            payment_hold_started_at = $2::timestamp,
            payment_hold_until = $3::timestamp,
            notes = (
              COALESCE(NULLIF(notes, ''), '{}')::jsonb
              || jsonb_build_object(
                'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2_PAYMENT_HOLD',
                'payment_hold_triggered', true,
                'payment_hold_reason', 'INSUFFICIENT_CAPITAL_FOR_FINAL_PAYMENT',
                'payment_hold_started_at', ($2::timestamp)::text,
                'payment_hold_until', ($3::timestamp)::text,
                'capital_available_at_delivery', $4::numeric,
                'final_payment_required', $5::numeric
              )
            )::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            orderId,
            resolverDate,
            paymentHoldUntil,
            currentCapital,
            finalPaymentAmount
          ]
        );

        processed.push({
          order_id: orderId,
          airline_id: airlineId,
          aircraft_name: aircraftLabel,
          action: "MOVED_TO_PAYMENT_HOLD",
          capital_available: currentCapital,
          final_payment_required: finalPaymentAmount,
          payment_hold_started_at: resolverDate.toISOString(),
          payment_hold_until: paymentHoldUntil.toISOString(),
          order: holdResult.rows[0]
        });

        continue;
      }

      /* ============================================================
         2C) LOCK FINANCE ROW
         ============================================================ */

      await client.query(
        `
        SELECT airline_id
        FROM company_finance
        WHERE airline_id = $1
        FOR UPDATE
        `,
        [airlineId]
      );

      /* ============================================================
         2D) CHARGE FINAL PAYMENT IF FINANCED
         ============================================================ */

      if (shouldChargeFinalPayment) {
        await client.query(
          `
          UPDATE company_finance
          SET
            capital = COALESCE(capital, 0) - $2,
            expenses = COALESCE(expenses, 0) + $2,
            profit = COALESCE(profit, 0) - $2,
            cost_new_aircraft_purchase = COALESCE(cost_new_aircraft_purchase, 0) + $2,
            updated_at = NOW()
          WHERE airline_id = $1
          `,
          [airlineId, finalPaymentAmount]
        );

        await client.query(
          `
          INSERT INTO finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            created_at
          )
          VALUES ($1, 'EXPENSE', $2, $3, $4, NOW())
          `,
          [
            airlineId,
            `OEM PURCHASE FINAL — ${aircraftLabel}`,
            finalPaymentAmount,
            Date.now()
          ]
        );
      }

      /* ============================================================
         2E) INSERT AIRCRAFT INTO FLEET
         ============================================================ */

      const insertedAircraft = [];

      for (let i = 0; i < quantity; i += 1) {
        const fleetResult = await client.query(
          `
          INSERT INTO aircraft_fleet (
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
          )
          VALUES (
            gen_random_uuid(),
            $1,
            $2,
            'FACTORY',
            $3,
            $4,
            $5,
            $6,
            NULL,
            NULL,
            NULL,
            $7,
            NULL,
            'ACTIVE',
            'AVAILABLE',
            $8,
            $8,
            $9,
            $10,
            $10,
            0,
            0,
            100,
            'SERVICEABLE',
            $11,
            $11,
            'USD',
            NOW(),
            NOW()
          )
          RETURNING id, aircraft_uid, airline_id, model_key, aircraft_name, status, operational_status
          `,
          [
            airlineId,
            order.user_id || null,
            order.ownership_type || "OWNED",
            order.manufacturer,
            order.model_key,
            aircraftLabel,
            orderId,
            baseIcao,
            simYear,
            resolverDate,
            Math.round(Number(order.unit_price || 0))
          ]
        );

        insertedAircraft.push(fleetResult.rows[0]);
      }

      /* ============================================================
         2F) UPDATE FACTORY SLOT(S) FROM RESERVED TO DELIVERED
         ============================================================ */

      let reservedSlots = [];

      try {
        const parsedNotes =
          order.notes && String(order.notes).trim()
            ? JSON.parse(order.notes)
            : {};

        if (Array.isArray(parsedNotes.factory_slots_reserved)) {
          reservedSlots = parsedNotes.factory_slots_reserved;
        }
      } catch (notesError) {
        reservedSlots = [];
      }

      if (!reservedSlots.length && order.factory_slot_id) {
        reservedSlots = [{
          slot_id: order.factory_slot_id,
          reserved_quantity: quantity
        }];
      }

      for (const slot of reservedSlots) {
        const slotId = Number(slot.slot_id);
        const reservedQty = Math.max(1, Number(slot.reserved_quantity || 1));

        if (!slotId) continue;

        await client.query(
          `
          UPDATE aircraft_factory_slots
          SET
            reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
            delivered_quantity = COALESCE(delivered_quantity, 0) + $2,
            slot_status = CASE
              WHEN COALESCE(available_quantity, 0) <= 0
              THEN 'FULL'
              ELSE 'OPEN'
            END,
            utilization_pct = ROUND(
              (
                (
                  GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
                  + COALESCE(delivered_quantity, 0)
                  + $2
                )::NUMERIC
                /
                GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
              ) * 100,
              2
            ),
            updated_at = NOW()
          WHERE id = $1
          `,
          [slotId, reservedQty]
        );
      }

      /* ============================================================
         2G) MARK ORDER AS DELIVERED
         ============================================================ */

      const orderUpdateResult = await client.query(
        `
        UPDATE new_aircraft_orders
        SET
          payment_status = 'PAID',
          final_payment_status = 'PAID',
          order_status = 'COMPLETED',
          delivery_status = 'DELIVERED',
          actual_delivery_date = $2::timestamp,
          delivery_resolved_at = NOW(),
          notes = (
            COALESCE(NULLIF(notes, ''), '{}')::jsonb
            || jsonb_build_object(
              'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2',
              'delivery_resolved', true,
              'delivery_resolver_date', ($2::timestamp)::text,
              'aircraft_created_count', $3::integer
            )
          )::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [orderId, resolverDate, insertedAircraft.length]
      );

      processed.push({
        order_id: orderId,
        airline_id: airlineId,
        aircraft_name: aircraftLabel,
        action: shouldChargeFinalPayment
          ? "FINAL_PAYMENT_CHARGED_AND_DELIVERED"
          : "PAID_ORDER_DELIVERED",
        final_payment_charged: shouldChargeFinalPayment ? finalPaymentAmount : 0,
        aircraft_created_count: insertedAircraft.length,
        aircraft: insertedAircraft,
        order: orderUpdateResult.rows[0]
      });
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_BUY_NEW_DELIVERY_RESOLVER",
      version: "v1.2",
      mode: "LIVE_MUTATION",
      resolver_date: resolverDate.toISOString(),
      requested_order_id: requestedOrderId,
      processed_count: processed.length,
      skipped_count: skipped.length,
      processed,
      skipped
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS BUY NEW DELIVERY RESOLVER LIVE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "BUY_NEW_DELIVERY_RESOLVER_LIVE_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
