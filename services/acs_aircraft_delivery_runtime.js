/* ============================================================
   ACS AIRCRAFT DELIVERY RUNTIME — PostgreSQL Authority v1.0
   ------------------------------------------------------------
   - Executes without browser sessions or frontend clocks.
   - Uses acs_get_current_sim_time() as the only simulation clock.
   - Supports multi-unit OWNED and LEASED factory orders.
   - Idempotency authority:
       aircraft_fleet(new_aircraft_order_id, delivery_unit_number)
   - No browser clock, browser storage, timers, or HTTP routes.
   ============================================================ */

import { pool } from "../db/pool.js";

const DELIVERY_LOCK_NAMESPACE = 1095783252;
const USED_DELIVERY_LOCK_NAMESPACE = 1095783253;

function ACS_deliveryInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function ACS_deliveryNotes(rawNotes) {
  if (!rawNotes) return {};
  if (typeof rawNotes === "object") return rawNotes;

  try {
    return JSON.parse(String(rawNotes));
  } catch (_) {
    return {};
  }
}

/* ============================================================
   ACS OCC — AIRCRAFT DELIVERED ALERT v1.0
   ------------------------------------------------------------
   - One Alert Center event per delivered aircraft.
   - Runs inside the delivery transaction.
   - No frontend authority.
   - No schema or migration changes.
   ============================================================ */

async function ACS_createAircraftDeliveredAlert(
  client,
  {
    airlineId,
    aircraftId,
    registration,
    aircraftName,
    simTime
  }
) {
  const normalizedAirlineId =
    Number(airlineId);

  const normalizedAircraftId =
    Number(aircraftId);

  if (
    !client ||
    !Number.isInteger(normalizedAirlineId) ||
    normalizedAirlineId <= 0 ||
    !Number.isInteger(normalizedAircraftId) ||
    normalizedAircraftId <= 0
  ) {
    return null;
  }

  const cleanRegistration =
    String(registration || "AIRCRAFT")
      .trim()
      .toUpperCase();

  const cleanAircraftName =
    String(aircraftName || "Aircraft")
      .trim();

  const alertKey =
    `AIRCRAFT_DELIVERED:${normalizedAircraftId}`;

  const title =
    "AIRCRAFT DELIVERED";

  const message =
    `Aircraft ${cleanRegistration} has been delivered. ` +
    `Aircraft: ${cleanAircraftName} ` +
    `Registration: ${cleanRegistration}`;

  const result = await client.query(
    `
    INSERT INTO public.occ_alerts (
      airline_id,
      alert_key,
      category,
      level,
      title,
      message,
      source,
      source_ref,
      event_sim_time,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      'my aircraft',
      'info',
      $3,
      $4,
      'aircraft_fleet',
      $5,
      $6,
      NOW(),
      NOW()
    )
    ON CONFLICT (
      airline_id,
      alert_key
    )
    WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING *
    `,
    [
      normalizedAirlineId,
      alertKey,
      title,
      message,
      String(normalizedAircraftId),
      simTime
    ]
  );

  return result.rows[0] || null;
}

/* ============================================================
   🟦 ACS OCC IV — UNIT DELIVERY SCHEDULE READER
   ------------------------------------------------------------
   - Reads the immutable schedule stored in order notes.
   - Keeps compatibility with legacy single-date orders.
   ============================================================ */

function ACS_deliveryUnitSchedule(order, notes, quantity) {
  const storedSchedule =
    Array.isArray(notes.unit_delivery_schedule)
      ? notes.unit_delivery_schedule
      : [];

  const normalizedSchedule = storedSchedule
    .map((unit, index) => {
      const unitNumber = Math.max(
        1,
        ACS_deliveryInteger(
          unit?.unit_number,
          index + 1
        )
      );

      const estimatedDeliveryDate =
        unit?.estimated_delivery_date
          ? new Date(
              unit.estimated_delivery_date
            )
          : null;

      if (
        !estimatedDeliveryDate ||
        Number.isNaN(
          estimatedDeliveryDate.getTime()
        )
      ) {
        return null;
      }

      return {
        unit_number:
          unitNumber,

        factory_slot_id:
          ACS_deliveryInteger(
            unit?.factory_slot_id ||
            order.factory_slot_id,
            0
          ),

        estimated_delivery_date:
          estimatedDeliveryDate
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.unit_number -
        b.unit_number
    );

  if (
    normalizedSchedule.length ===
    quantity
  ) {
    return normalizedSchedule;
  }

  /*
    Legacy compatibility:
    old orders only had one parent delivery date.
    They retain their previous all-at-once behavior.
  */
  const legacyDate =
    order.estimated_delivery_date
      ? new Date(
          order.estimated_delivery_date
        )
      : null;

  if (
    !legacyDate ||
    Number.isNaN(legacyDate.getTime())
  ) {
    return [];
  }

  return Array.from(
    { length: quantity },
    (_, index) => ({
      unit_number:
        index + 1,

      factory_slot_id:
        ACS_deliveryInteger(
          order.factory_slot_id,
          0
        ),

      estimated_delivery_date:
        new Date(legacyDate)
    })
  );
}

function ACS_deliveryNumericStart(length) {
  if (length <= 1) return 1;
  return Math.pow(10, length - 1) + 1;
}

function ACS_deliveryNumberToLetters(value, length) {
  let current = Math.max(0, ACS_deliveryInteger(value));
  let text = "";

  do {
    text = String.fromCharCode(65 + (current % 26)) + text;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return text.padStart(length, "A").slice(-length);
}

async function ACS_deliveryRegistrationRule(client, baseIcao) {
  const normalizedBase = String(baseIcao || "").trim().toUpperCase();

  if (!normalizedBase) throw new Error("DELIVERY_BASE_ICAO_REQUIRED");

  const result = await client.query(
    `
    SELECT
      registration_prefix,
      registration_format,
      registration_length
    FROM public.aircraft_registration_prefixes
    WHERE is_active = TRUE
      AND $1 LIKE (icao_prefix || '%')
    ORDER BY LENGTH(icao_prefix) DESC
    LIMIT 1
    `,
    [normalizedBase]
  );

  if (!result.rows.length) {
    const error = new Error("DELIVERY_REGISTRATION_RULE_NOT_FOUND");
    error.code = "DELIVERY_REGISTRATION_RULE_NOT_FOUND";
    throw error;
  }

  return result.rows[0];
}

async function ACS_deliveryRegistration(client, rule) {
   
  const prefix = String(rule.registration_prefix || "").trim().toUpperCase();
  const format = String(rule.registration_format || "NUMERIC").trim().toUpperCase();
  const length = Math.max(1, ACS_deliveryInteger(rule.registration_length, 4));
  const initialCounter = format === "LETTERS" ? 0 : ACS_deliveryNumericStart(length);

  await client.query(
    `
    INSERT INTO public.aircraft_registration_counters (
      registration_prefix, next_number, created_at, updated_at
    )
    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (registration_prefix) DO NOTHING
    `,
    [prefix, initialCounter]
  );

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const counterResult = await client.query(
      `
      SELECT next_number
      FROM public.aircraft_registration_counters
      WHERE registration_prefix = $1
      FOR UPDATE
      `,
      [prefix]
    );

    if (!counterResult.rows.length) {
      throw new Error("DELIVERY_REGISTRATION_COUNTER_NOT_FOUND");
    }

    const counter = ACS_deliveryInteger(
      counterResult.rows[0].next_number,
      initialCounter
    );

    const suffix = format === "LETTERS"
      ? ACS_deliveryNumberToLetters(counter, length)
      : String(counter).padStart(length, "0").slice(-length);

    const registration = `${prefix}${suffix}`;

    await client.query(
      `
      UPDATE public.aircraft_registration_counters
      SET next_number = next_number + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE registration_prefix = $1
      `,
      [prefix]
    );

    const existsResult = await client.query(
      `SELECT 1 FROM public.aircraft_fleet WHERE registration = $1 LIMIT 1`,
      [registration]
    );

    if (!existsResult.rows.length) return registration;
  }

  throw new Error("DELIVERY_REGISTRATION_GENERATION_EXHAUSTED");
}

async function ACS_deliveryEnsureMaintenance(client, aircraftId, airlineId, simTime) {
  await client.query(
    `
    INSERT INTO public.aircraft_maintenance_status (
      aircraft_id,
      airline_id,
      a_check_due_date,
      b_check_due_date,
      c_check_due_date,
      d_check_due_date,
      a_check_status,
      b_check_status,
      c_check_status,
      d_check_status,
      maintenance_control_status,
      maintenance_control_reason,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3::timestamp + INTERVAL '7 days',
      $3::timestamp + INTERVAL '30 days',
      $3::timestamp + INTERVAL '12 months',
      $3::timestamp + INTERVAL '8 years',
      'OPEN',
      'OPEN',
      'OPEN',
      'OPEN',
      'SERVICEABLE',
      NULL,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (aircraft_id) DO NOTHING
    `,
    [aircraftId, airlineId, simTime]
  );
}

async function ACS_deliveryEnsureLeaseContract({
  client,
  order,
  aircraft,
  notes,
  simTime,
  quantity
}) {
  if (String(order.ownership_type || "").toUpperCase() !== "LEASED") return;

  const leaseYears = [5, 10, 15].includes(ACS_deliveryInteger(notes.lease_years))
    ? ACS_deliveryInteger(notes.lease_years)
    : 10;

  const termMonths = leaseYears * 12;
  const originalValue = Number(order.unit_price || 0);
  const initialCommitment = Number(order.initial_payment_amount || 0) / quantity;
  const monthlyPayment = Number(notes.monthly_lease_payment || 0) / quantity;
  const monthlyRatePct = Number(notes.lease_rate_pct_monthly || 0);

  await client.query(
    `
    INSERT INTO public.aircraft_leasing_contracts (
      contract_uid,
      airline_id,
      aircraft_id,
      new_aircraft_order_id,
      aircraft_name,
      model_key,
      manufacturer,
      lessor_name,
      remarketing_agent,
      lease_policy_version,
      original_aircraft_value,
      security_deposit,
      initial_commitment_amount,
      initial_commitment_pct,
      lease_years,
      term_months,
      monthly_payment,
      monthly_rate_pct,
      lease_start_date,
      lease_end_date,
      residual_floor_pct,
      residual_value,
      buyout_price,
      early_termination_penalty,
      contract_lock,
      status,
      missed_payments,
      next_payment_due_date,
      end_of_lease_options,
      notes,
      created_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      0,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16,
      $17::timestamp,
      $17::timestamp + make_interval(years => $13),
      0,
      0,
      0,
      0,
      $18,
      'ACTIVE',
      0,
      $17::timestamp + INTERVAL '1 month',
      $19::jsonb,
      jsonb_build_object(
        'source', 'ACS_AIRCRAFT_DELIVERY_RUNTIME_V1',
        'delivery_unit_number', $20::integer
      ),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.aircraft_leasing_contracts existing
      WHERE existing.aircraft_id = $2
        AND existing.status IN ('ACTIVE', 'PAYMENT_OVERDUE', 'EXTENDED')
    )
    `,
    [
      Number(order.airline_id),
      Number(aircraft.id),
      Number(order.id),
      order.aircraft_name,
      order.model_key,
      order.manufacturer,
      notes.lessor_name || "Eagle Aviation Capital",
      notes.remarketing_agent || "Eagle Broker",
      notes.lease_policy_version || "ACS_LEASE_NEW_OCC_V1",
      originalValue,
      initialCommitment,
      Number(notes.lease_initial_commitment_pct || 15),
      leaseYears,
      termMonths,
      monthlyPayment,
      monthlyRatePct,
      simTime,
      notes.contract_lock || "NO_FREE_RETURN_BEFORE_CONTRACT_END",
      JSON.stringify(
        Array.isArray(notes.end_of_lease_options)
          ? notes.end_of_lease_options
          : ["EXTEND", "BUYOUT", "RETURN_AT_CONTRACT_END"]
      ),
      Number(aircraft.delivery_unit_number)
    ]
  );
}

/* ============================================================
   🟦 ACS OCC IV — APPLY DELIVERED UNITS TO FACTORY SLOTS
   ------------------------------------------------------------
   - Updates only the slots belonging to units delivered now.
   - Does not release or complete future units.
   ============================================================ */

async function ACS_deliveryApplyUnitSlots(
  client,
  deliveredUnits
) {
  const deliveredBySlot = new Map();

  for (const unit of deliveredUnits) {
    const slotId = ACS_deliveryInteger(
      unit.factory_slot_id,
      0
    );

    if (!slotId) continue;

    deliveredBySlot.set(
      slotId,
      (
        deliveredBySlot.get(slotId) ||
        0
      ) + 1
    );
  }

  for (
    const [
      slotId,
      deliveredQuantity
    ] of deliveredBySlot
  ) {
    await client.query(
      `
      UPDATE public.aircraft_factory_slots
      SET
        reserved_quantity =
          GREATEST(
            COALESCE(
              reserved_quantity,
              0
            ) - $2,
            0
          ),

        delivered_quantity =
          COALESCE(
            delivered_quantity,
            0
          ) + $2,

        slot_status = CASE
          WHEN COALESCE(
            available_quantity,
            0
          ) <= 0
            THEN 'FULL'
          ELSE 'OPEN'
        END,

        utilization_pct = ROUND(
          (
            (
              GREATEST(
                COALESCE(
                  reserved_quantity,
                  0
                ) - $2,
                0
              )
              +
              COALESCE(
                delivered_quantity,
                0
              )
              +
              $2
            )::NUMERIC
            /
            GREATEST(
              COALESCE(
                max_quantity,
                0
              ),
              1
            )::NUMERIC
          ) * 100,
          2
        ),

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = $1
      `,
      [
        slotId,
        deliveredQuantity
      ]
    );
  }
}

async function ACS_deliveryReleaseSlots(client, order, quantity) {
  const notes = ACS_deliveryNotes(order.notes);
  let reservedSlots = Array.isArray(notes.factory_slots_reserved)
    ? notes.factory_slots_reserved
    : [];

  if (!reservedSlots.length && order.factory_slot_id) {
    reservedSlots = [{
      slot_id: order.factory_slot_id,
      reserved_quantity: quantity
    }];
  }

  for (const slot of reservedSlots) {
    const slotId = ACS_deliveryInteger(slot.slot_id);
    const reservedQuantity = Math.max(
      1,
      ACS_deliveryInteger(slot.reserved_quantity, 1)
    );

    if (!slotId) continue;

    await client.query(
      `
      UPDATE public.aircraft_factory_slots
      SET
        reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
        available_quantity = COALESCE(available_quantity, 0) + $2,
        slot_status = CASE
          WHEN COALESCE(available_quantity, 0) + $2 > 0 THEN 'OPEN'
          ELSE slot_status
        END,
        utilization_pct = ROUND(
          (
            (
              GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
              + COALESCE(delivered_quantity, 0)
            )::numeric
            / GREATEST(COALESCE(max_quantity, 0), 1)::numeric
          ) * 100,
          2
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [slotId, reservedQuantity]
    );
  }
}

async function ACS_deliveryProcessOrder(orderId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [DELIVERY_LOCK_NAMESPACE, Number(orderId)]
    );

    const clockResult = await client.query(
      `
      SELECT
        acs_get_current_sim_time()::timestamp AS sim_time,
        (EXTRACT(EPOCH FROM acs_get_current_sim_time()) * 1000)::bigint AS sim_timestamp
      `
    );

    const simTime = clockResult.rows[0].sim_time;
    const simTimestamp = clockResult.rows[0].sim_timestamp;

    const orderResult = await client.query(
      `
      SELECT o.*, u.base_icao AS user_base_icao
      FROM public.new_aircraft_orders o
      LEFT JOIN public.users u ON u.user_id = o.user_id
      WHERE o.id = $1
      FOR UPDATE OF o
      `,
      [orderId]
    );

    if (!orderResult.rows.length) {
      await client.query("ROLLBACK");
      return { processedCount: 0, action: "ORDER_NOT_FOUND" };
    }

    const order = orderResult.rows[0];
    const airlineId = Number(order.airline_id);
    const quantity = Math.max(1, ACS_deliveryInteger(order.quantity, 1));
    const notes = ACS_deliveryNotes(order.notes);
    const ownershipType = String(order.ownership_type || "OWNED").toUpperCase();
    const baseIcao = String(order.user_base_icao || "").trim().toUpperCase();
    const aircraftLabel = String(
      order.aircraft_name || `${order.manufacturer || ""} ${order.model_key || ""}`
    ).trim();

    if (
      String(order.source || "") !== "FACTORY" ||
      String(order.order_status || "") !== "ORDERED" ||
      !["PENDING_DELIVERY", "PAYMENT_HOLD"].includes(String(order.delivery_status || "")) ||
      !order.estimated_delivery_date
    ) {
      await client.query("ROLLBACK");
      return { processedCount: 0, action: "ORDER_NOT_ELIGIBLE" };
    }

    /* ============================================================
   🟦 ACS OCC IV — RESOLVE NEXT INDIVIDUAL AIRCRAFT
   ------------------------------------------------------------
   Rules:
   - Read already delivered unit numbers from aircraft_fleet.
   - Deliver only the first pending unit that is due.
   - Never deliver two units from the same order on one sim day.
   ============================================================ */

const existingResult =
  await client.query(
    `
    SELECT
      delivery_unit_number,
      delivery_date

    FROM public.aircraft_fleet

    WHERE new_aircraft_order_id = $1

    ORDER BY
      delivery_unit_number

    FOR UPDATE
    `,
    [orderId]
  );

const existingUnits = new Set(
  existingResult.rows
    .map(row =>
      Number(
        row.delivery_unit_number
      )
    )
    .filter(Number.isInteger)
);

const deliveredToday =
  existingResult.rows.some(row => {
    if (!row.delivery_date) {
      return false;
    }

    const deliveredDate =
      new Date(row.delivery_date);

    const currentDate =
      new Date(simTime);

    return (
      deliveredDate.getUTCFullYear() ===
        currentDate.getUTCFullYear() &&

      deliveredDate.getUTCMonth() ===
        currentDate.getUTCMonth() &&

      deliveredDate.getUTCDate() ===
        currentDate.getUTCDate()
    );
  });

if (deliveredToday) {
  await client.query("COMMIT");

  return {
    processedCount: 0,
    action:
      "ORDER_UNIT_ALREADY_DELIVERED_TODAY"
  };
}

const deliverySchedule =
  ACS_deliveryUnitSchedule(
    order,
    notes,
    quantity
  );

if (
  deliverySchedule.length !==
  quantity
) {
  throw new Error(
    "DELIVERY_SCHEDULE_QUANTITY_MISMATCH"
  );
}

const pendingUnits =
  deliverySchedule.filter(
    unit =>
      !existingUnits.has(
        unit.unit_number
      )
  );

if (!pendingUnits.length) {
  await client.query("ROLLBACK");

  return {
    processedCount: 0,
    action:
      "ORDER_HAS_NO_PENDING_UNITS"
  };
}

const nextUnit =
  pendingUnits[0];

if (
  nextUnit
    .estimated_delivery_date
    .getTime() >
  new Date(simTime).getTime()
) {
  /*
    Repair stale parent date if necessary.
  */
  await client.query(
    `
    UPDATE public.new_aircraft_orders
    SET
      estimated_delivery_date =
        $2::timestamp,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = $1
    `,
    [
      orderId,
      nextUnit
        .estimated_delivery_date
    ]
  );

  await client.query("COMMIT");

  return {
    processedCount: 0,
    action:
      "NEXT_ORDER_UNIT_NOT_DUE"
  };
}

/*
  Exactly one unit per order and simulation day.
*/
const dueUnits = [
  nextUnit
];

    const financeResult = await client.query(
      `
      SELECT *
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    if (!financeResult.rows.length) throw new Error("DELIVERY_FINANCE_ROW_NOT_FOUND");

    const finance = financeResult.rows[0];
    const currentCapital = Number(finance.capital || 0);
    const finalPayment = Number(order.final_payment_amount || 0);

    if (String(order.delivery_status) === "PAYMENT_HOLD") {
      const holdResult = await client.query(
        `SELECT $1::timestamp >= $2::timestamp AS expired`,
        [simTime, order.payment_hold_until]
      );

      if (holdResult.rows[0].expired !== true) {
        await client.query("COMMIT");
        return { processedCount: 0, action: "PAYMENT_HOLD_ACTIVE" };
      }

      const initialPayment = Number(order.initial_payment_amount || 0);
      const penalty = Math.round(initialPayment * 0.25);
      const refund = Math.round(initialPayment * 0.75);

      await client.query(
        `
        UPDATE public.company_finance
        SET
          capital =
            COALESCE(capital, 0) + $2,

          expenses =
            COALESCE(expenses, 0) + $3,

          profit =
            COALESCE(profit, 0) - $3,

          cost_new_aircraft_purchase =
            GREATEST(
              COALESCE(
                cost_new_aircraft_purchase,
                0
              ) - $4,
              0
            ),

          cost_other =
            COALESCE(cost_other, 0) + $3,

          updated_at = CURRENT_TIMESTAMP

        WHERE airline_id = $1
        `,
        [
          airlineId,
          refund,
          penalty,
          initialPayment
        ]
      );

      await client.query(
        `
        INSERT INTO public.finance_log (
          airline_id,
          type,
          source,
          amount,
          timestamp,
          reference_uid,
          description,
          created_at
        )
        VALUES
          (
            $1,
            'INCOME',
            'OEM PURCHASE DEFAULT REFUND',
            $2,
            $4,
            $5,
            $6,
            CURRENT_TIMESTAMP
          ),
          (
            $1,
            'EXPENSE',
            'OEM PURCHASE DEFAULT PENALTY',
            $3,
            $4,
            $7,
            $8,
            CURRENT_TIMESTAMP
          )
        `,
        [
          airlineId,
          refund,
          penalty,
          simTimestamp,
          `AIRCRAFT_DELIVERY:${orderId}:DEFAULT_REFUND`,
          `${aircraftLabel} order ${orderId}`,
          `AIRCRAFT_DELIVERY:${orderId}:DEFAULT_PENALTY`,
          `${aircraftLabel} order ${orderId}`
        ]
      );
       
      await ACS_deliveryReleaseSlots(client, order, quantity);

      await client.query(
        `
        UPDATE public.new_aircraft_orders
        SET payment_status = 'CANCELLED',
            final_payment_status = 'DEFAULTED',
            order_status = 'CANCELLED',
            delivery_status = 'CANCELLED_PAYMENT_DEFAULT',
            default_penalty_amount = $2,
            refund_amount = $3,
            delivery_resolved_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [orderId, penalty, refund]
      );

      await client.query("COMMIT");
      return { processedCount: 1, action: "PAYMENT_DEFAULT_APPLIED" };
    }

    const chargeFinalPayment =
      ownershipType !== "LEASED" &&
      String(order.payment_status || "") === "FINANCED" &&
      String(order.final_payment_status || "") !== "PAID" &&
      finalPayment > 0;

    if (chargeFinalPayment && currentCapital < finalPayment) {
      await client.query(
        `
        UPDATE public.new_aircraft_orders
        SET delivery_status = 'PAYMENT_HOLD',
            final_payment_status = 'PAYMENT_HOLD',
            payment_hold_started_at = $2::timestamp,
            payment_hold_until = $2::timestamp + INTERVAL '30 days',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [orderId, simTime]
      );

      await client.query("COMMIT");
      return { processedCount: 1, action: "PAYMENT_HOLD_APPLIED" };
    }

    if (chargeFinalPayment) {
            await client.query(
        `
        UPDATE public.company_finance
        SET
          capital =
            COALESCE(capital, 0) - $2,

          cost_new_aircraft_purchase =
            COALESCE(
              cost_new_aircraft_purchase,
              0
            ) + $2,

          updated_at = CURRENT_TIMESTAMP

        WHERE airline_id = $1
        `,
        [
          airlineId,
          finalPayment
        ]
      );

      await client.query(
        `
        INSERT INTO public.finance_log (
          airline_id,
          type,
          source,
          amount,
          timestamp,
          reference_uid,
          description,
          created_at
        )
        VALUES (
          $1,
          'INVESTMENT',
          'OEM PURCHASE FINAL',
          $2,
          $3,
          $4,
          $5,
          CURRENT_TIMESTAMP
        )
        `,
               [
          airlineId,
          finalPayment,
          simTimestamp,
          `AIRCRAFT_DELIVERY:${orderId}:FINAL_PAYMENT`,
          `${aircraftLabel} order ${orderId}`
        ]
      );

      /*
        Final payment belongs to the complete commercial order.
        Mark it as paid now so future individual deliveries
        cannot charge it again.
      */
      await client.query(
        `
        UPDATE public.new_aircraft_orders
        SET
          payment_status = 'PAID',
          final_payment_status = 'PAID',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [orderId]
      );
    }
     
        const registrationRule =
      await ACS_deliveryRegistrationRule(
        client,
        baseIcao
      );

    let createdCount = 0;

    for (const dueUnit of dueUnits) {
      const unitNumber =
        dueUnit.unit_number;

      if (
        existingUnits.has(
          unitNumber
        )
      ) {
        continue;
      }

      const registration = await ACS_deliveryRegistration(client, registrationRule);

      const fleetResult = await client.query(
        `
        INSERT INTO public.aircraft_fleet (
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
          delivery_unit_number,
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

          depreciation_status,
          depreciation_method,
          depreciation_basis,
          depreciation_residual_value,
          depreciation_useful_life_months,
          depreciation_start_sim,
          accumulated_depreciation,
          book_value,
          depreciation_last_month_key,

          cabin_rules_version,
          cabin_configuration_source,
          y_product,
          y_seats,
          c_product,
          c_seats,
          f_product,
          f_seats,
          cabin_capacity_units,
          cabin_configured_at,
          currency,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid(), $1, $2, 'FACTORY', $3, $4, $5, $6, $7,
          NULL, NULL, $8, $9, NULL, 'ACTIVE', 'AVAILABLE', $10, $10,
          EXTRACT(YEAR FROM $11::timestamp)::integer, $11, $11,
                    0,
          0,
          100,
          'SERVICEABLE',
                    
          $12::BIGINT,
          $12::BIGINT,

          CASE
            WHEN $3 = 'OWNED'
              THEN 'ACTIVE'
            ELSE 'NOT_APPLICABLE'
          END,

          CASE
            WHEN $3 = 'OWNED'
              THEN 'STRAIGHT_LINE'
            ELSE NULL
          END,

          CASE
            WHEN $3 = 'OWNED'
              THEN $12::BIGINT
            ELSE 0
          END,

          CASE
            WHEN $3 = 'OWNED'
              THEN ROUND(
                ($12::BIGINT)::NUMERIC *
                0.05::NUMERIC
              )::BIGINT
            ELSE 0
          END,

          CASE
            WHEN $3 = 'OWNED'
              THEN 240
            ELSE 0
          END,

          CASE
            WHEN $3 = 'OWNED'
              THEN $11::TIMESTAMP
            ELSE NULL
          END,

          0,

          CASE
            WHEN $3 = 'OWNED'
              THEN $12::BIGINT
            ELSE 0
          END,

          NULL,

          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          $21,
          $11,
          'USD',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING id, airline_id, delivery_unit_number
        `,
        [
          airlineId,
          order.user_id || null,
          ownershipType,
          order.manufacturer,
          order.model_key,
          aircraftLabel,
          registration,
          orderId,
          unitNumber,
          baseIcao,
          simTime,
          ownershipType === "LEASED" ? 0 : Number(order.unit_price || 0),
          order.cabin_rules_version || "ACS_CABIN_V1",
          order.cabin_configuration_source || "CATALOG_DEFAULT",
          order.y_product || "Y_SMART",
          Number(order.y_seats || 0),
          order.c_product || "C_SMART",
          Number(order.c_seats || 0),
          order.f_product || "F_SILVER",
          Number(order.f_seats || 0),
          Number(order.cabin_capacity_units || 0)
        ]
      );

      const aircraft = fleetResult.rows[0];

            await ACS_deliveryEnsureMaintenance(
        client,
        aircraft.id,
        airlineId,
        simTime
      );

      await ACS_deliveryEnsureLeaseContract({
        client,
        order,
        aircraft,
        notes,
        simTime,
        quantity
      });

      /*
        The aircraft now exists in aircraft_fleet as ACTIVE
        with its final registration. Create its delivery alert
        inside the same transaction.
      */
      await ACS_createAircraftDeliveredAlert(
        client,
        {
          airlineId,
          aircraftId:
            aircraft.id,
          registration,
          aircraftName:
            aircraftLabel,
          simTime
        }
      );

      createdCount += 1;
    }
     
/* ============================================================
   🟦 ACS OCC IV — PARTIAL OR FINAL ORDER COMPLETION
   ============================================================ */

const totalUnitsResult =
  await client.query(
    `
    SELECT
      COUNT(*)::INTEGER AS total

    FROM public.aircraft_fleet

    WHERE
      new_aircraft_order_id = $1
    `,
    [orderId]
  );

const totalUnits = Number(
  totalUnitsResult.rows[0]?.total ||
  0
);

if (totalUnits > quantity) {
  throw new Error(
    "DELIVERY_UNIT_COUNT_EXCEEDED"
  );
}

await ACS_deliveryApplyUnitSlots(
  client,
  dueUnits
);

const deliveredUnitNumbers =
  new Set([
    ...existingUnits,
    ...dueUnits.map(
      unit =>
        unit.unit_number
    )
  ]);

const remainingUnits =
  deliverySchedule.filter(
    unit =>
      !deliveredUnitNumbers.has(
        unit.unit_number
      )
  );

if (remainingUnits.length > 0) {
  const nextPendingUnit =
    remainingUnits[0];

  await client.query(
    `
    UPDATE public.new_aircraft_orders
    SET
      payment_status = 'PAID',

      final_payment_status = 'PAID',

      order_status = 'ORDERED',

      delivery_status =
        'PENDING_DELIVERY',

      estimated_delivery_date =
        $2::timestamp,

      actual_delivery_date =
        NULL,

      delivery_resolved_at =
        NULL,

      notes = (
        COALESCE(
          NULLIF(notes, ''),
          '{}'
        )::jsonb
        ||
        jsonb_build_object(
          'delivery_resolver',
          'ACS_AIRCRAFT_DELIVERY_RUNTIME_OCC_IV',

          'delivery_unit_count',
          $3::INTEGER,

          'next_delivery_unit_number',
          $4::INTEGER,

          'next_unit_delivery_date',
          ($2::timestamp)::text,

          'runtime_sim_time',
          ($5::timestamp)::text
        )
      )::text,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = $1
    `,
    [
      orderId,
      nextPendingUnit
        .estimated_delivery_date,
      totalUnits,
      nextPendingUnit
        .unit_number,
      simTime
    ]
  );

  await client.query("COMMIT");

  return {
    processedCount: 1,

    action:
      "ORDER_UNIT_DELIVERED",

    deliveredUnitNumber:
      nextUnit.unit_number,

    createdCount,

    totalUnits,

    remainingUnits:
      remainingUnits.length,

    nextDeliveryDate:
      nextPendingUnit
        .estimated_delivery_date
        .toISOString()
  };
}

if (totalUnits !== quantity) {
  throw new Error(
    "DELIVERY_FINAL_UNIT_COUNT_MISMATCH"
  );
}

await client.query(
  `
  UPDATE public.new_aircraft_orders
  SET
    payment_status = 'PAID',

    final_payment_status = 'PAID',

    order_status = 'COMPLETED',

    delivery_status = 'DELIVERED',

    actual_delivery_date =
      $2::timestamp,

    delivery_resolved_at =
      CURRENT_TIMESTAMP,

    notes = (
      COALESCE(
        NULLIF(notes, ''),
        '{}'
      )::jsonb
      ||
      jsonb_build_object(
        'delivery_resolver',
        'ACS_AIRCRAFT_DELIVERY_RUNTIME_OCC_IV',

        'delivery_unit_count',
        $3::INTEGER,

        'next_delivery_unit_number',
        NULL,

        'runtime_sim_time',
        ($2::timestamp)::text
      )
    )::text,

    updated_at =
      CURRENT_TIMESTAMP

  WHERE id = $1
  `,
  [
    orderId,
    simTime,
    totalUnits
  ]
);

await client.query("COMMIT");

return {
  processedCount: 1,

  action:
    "ORDER_FINAL_UNIT_DELIVERED",

  deliveredUnitNumber:
    nextUnit.unit_number,

  createdCount,

  totalUnits,

  remainingUnits: 0
};
     
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

/* ============================================================
   ACS USED AIRCRAFT DELIVERY — PostgreSQL Authority v1.0
   ------------------------------------------------------------
   - Uses only the ACS historical clock.
   - Activates OWNED used aircraft when delivery becomes due.
   - Starts depreciation when the aircraft enters service.
   - Does not create any financial movement.
   - Row locking and status transition guarantee idempotency.
   ============================================================ */

async function ACS_deliveryProcessUsedAircraft(aircraftId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockResult = await client.query(
      `
      SELECT pg_try_advisory_xact_lock($1, $2) AS locked
      `,
      [USED_DELIVERY_LOCK_NAMESPACE, Number(aircraftId)]
    );

    if (lockResult.rows[0]?.locked !== true) {
      await client.query("ROLLBACK");

      return {
        processedCount: 0,
        action: "USED_AIRCRAFT_ALREADY_LOCKED"
      };
    }

    const clockResult = await client.query(
      `
      SELECT acs_get_current_sim_time()::timestamp AS sim_time
      `
    );

    const simTime = clockResult.rows[0]?.sim_time;

    if (!simTime) {
      throw new Error("ACS_SIM_TIME_UNAVAILABLE");
    }

    const aircraftResult = await client.query(
      `
      SELECT
        id,
        airline_id,
        source,
        ownership_type,
        status,
        operational_status,
        delivery_date,
        entry_into_service_date,
        depreciation_status,
        depreciation_method,
        depreciation_basis,
        depreciation_residual_value,
        depreciation_useful_life_months,
        depreciation_start_sim
      FROM public.aircraft_fleet
         WHERE id = $1
        AND source = 'USED_MARKET'
        AND ownership_type = 'OWNED'
        AND depreciation_status = 'PENDING_SERVICE'
        AND status IN ('PENDING_DELIVERY', 'ACTIVE')
      FOR UPDATE SKIP LOCKED
      `,
      [aircraftId]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        processedCount: 0,
        action: "USED_AIRCRAFT_NOT_ELIGIBLE"
      };
    }

    const aircraft = aircraftResult.rows[0];

        /*
      Every used aircraft delivery or recovery must respect
      its official ACS delivery date.

      ACTIVE compatibility remains available only for a
      previously interrupted delivery transition.
    */

    if (!aircraft.delivery_date) {
      throw new Error(
        "USED_AIRCRAFT_DELIVERY_DATE_REQUIRED"
      );
    }

    const dueResult =
      await client.query(
        `
        SELECT
          $1::timestamp <=
          $2::timestamp AS due
        `,
        [
          aircraft.delivery_date,
          simTime
        ]
      );

    if (
      dueResult.rows[0]
        ?.due !== true
    ) {
      await client.query(
        "ROLLBACK"
      );

      return {
        processedCount: 0,
        action:
          "USED_AIRCRAFT_NOT_DUE"
      };
    }
     
      const dueResult = await client.query(
        `
        SELECT $1::timestamp <= $2::timestamp AS due
        `,
        [aircraft.delivery_date, simTime]
      );

      if (dueResult.rows[0]?.due !== true) {
        await client.query("ROLLBACK");

        return {
          processedCount: 0,
          action: "USED_AIRCRAFT_NOT_DUE"
        };
      }
    }

    const depreciationReady =
      String(aircraft.depreciation_status || "") === "PENDING_SERVICE" &&
      String(aircraft.depreciation_method || "") === "STRAIGHT_LINE" &&
      Number(aircraft.depreciation_basis || 0) > 0 &&
      Number(aircraft.depreciation_residual_value || 0) >= 0 &&
      Number(aircraft.depreciation_basis || 0) >
      Number(aircraft.depreciation_residual_value || 0) &&
      Number(aircraft.depreciation_useful_life_months || 0) > 0;

    if (!depreciationReady) {
      throw new Error(
        "USED_AIRCRAFT_DEPRECIATION_CONFIGURATION_INVALID"
      );
    }

        const updateResult = await client.query(
      `
      UPDATE public.aircraft_fleet
      SET
        status = 'ACTIVE',

        operational_status = CASE
          WHEN status = 'ACTIVE'
            THEN operational_status
          ELSE 'AVAILABLE'
        END,

        entry_into_service_date =
          COALESCE(entry_into_service_date, $2::timestamp),

        depreciation_status = 'ACTIVE',

        depreciation_start_sim =
          COALESCE(depreciation_start_sim, $2::timestamp),

        updated_at = CURRENT_TIMESTAMP

      WHERE id = $1
        AND source = 'USED_MARKET'
        AND ownership_type = 'OWNED'
        AND depreciation_status = 'PENDING_SERVICE'
        AND status IN ('PENDING_DELIVERY', 'ACTIVE')

      RETURNING
        id,
        airline_id,
        aircraft_name,
        registration,
        status,
        operational_status,
        entry_into_service_date,
        depreciation_status,
        depreciation_start_sim
      `,
      [aircraftId, simTime]
    );

   if (!updateResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        processedCount: 0,
        action: "USED_AIRCRAFT_ALREADY_PROCESSED"
      };
    }

        /*
      The aircraft has completed a due delivery transition
      or recovered that same transition after an interruption.

      Alert creation is idempotent through:
      AIRCRAFT_DELIVERED:<aircraft_id>
    */

    const deliveredAircraft =
      updateResult.rows[0];

    await ACS_createAircraftDeliveredAlert(
      client,
      {
        airlineId:
          deliveredAircraft.airline_id,

        aircraftId:
          deliveredAircraft.id,

        registration:
          deliveredAircraft.registration,

        aircraftName:
          deliveredAircraft.aircraft_name,

        simTime
      }
    );

    await client.query("COMMIT");

    return {
      processedCount: 1,
      action: "USED_AIRCRAFT_DELIVERED",
      aircraft: updateResult.rows[0]
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_runAircraftDeliveryRuntime({ batchSize = 100 } = {}) {
   
  const normalizedBatchSize = Math.min(
    1000,
    Math.max(1, ACS_deliveryInteger(batchSize, 100))
  );

  const factoryDueResult = await pool.query(
    `
    SELECT id
    FROM public.new_aircraft_orders
    WHERE source = 'FACTORY'
      AND order_status = 'ORDERED'
      AND delivery_status IN ('PENDING_DELIVERY', 'PAYMENT_HOLD')
      AND payment_status IN ('PAID', 'FINANCED')
      AND estimated_delivery_date IS NOT NULL
      AND estimated_delivery_date <= acs_get_current_sim_time()
    ORDER BY estimated_delivery_date, id
    LIMIT $1
    `,
    [normalizedBatchSize]
  );

    const usedDueResult = await pool.query(
    `
    SELECT id
    FROM public.aircraft_fleet
    WHERE source = 'USED_MARKET'
      AND ownership_type = 'OWNED'
      AND depreciation_status = 'PENDING_SERVICE'
      AND status IN (
        'PENDING_DELIVERY',
        'ACTIVE'
      )

      AND delivery_date
        IS NOT NULL

      AND delivery_date <=
        acs_get_current_sim_time()
        ORDER BY
      delivery_date,
      CASE
        WHEN status =
          'PENDING_DELIVERY'
          THEN 0
        ELSE 1
      END,
      id
    LIMIT $1
    `,
    [normalizedBatchSize]
  );

  let factoryProcessedCount = 0;
  let usedProcessedCount = 0;

  for (const row of factoryDueResult.rows) {
    const result = await ACS_deliveryProcessOrder(Number(row.id));

    factoryProcessedCount += Number(
      result?.processedCount || 0
    );
  }

  for (const row of usedDueResult.rows) {
    const result = await ACS_deliveryProcessUsedAircraft(
      Number(row.id)
    );

    usedProcessedCount += Number(
      result?.processedCount || 0
    );
  }

  return {
    processedCount:
      factoryProcessedCount + usedProcessedCount,

    dueCount:
      factoryDueResult.rows.length +
      usedDueResult.rows.length,

    factoryProcessedCount,
    factoryDueCount: factoryDueResult.rows.length,

    usedProcessedCount,
    usedDueCount: usedDueResult.rows.length
  };
}
