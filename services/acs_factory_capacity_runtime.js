/* ============================================================
   ACS FACTORY CAPACITY RUNTIME — PostgreSQL Authority v1.0
   ------------------------------------------------------------
   Creates only missing OEM production months. Existing capacity,
   reservations and deliveries are never changed.
   ============================================================ */

import { pool } from "../db/pool.js";

const ACS_FACTORY_CAPACITY_LOCK_NAMESPACE = 1095783254;

function ACS_normalizeInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export async function ACS_runFactoryCapacityRuntime({
  simTime = null,
  horizonYears = 10,
  minimumHorizonYear = 2035
} = {}) {
  const client = await pool.connect();

  const simDate = simTime ? new Date(simTime) : new Date();

  if (Number.isNaN(simDate.getTime())) {
    throw new Error("INVALID_FACTORY_RUNTIME_SIM_TIME");
  }

  const normalizedHorizonYears = ACS_normalizeInteger(
    horizonYears,
    10,
    1,
    50
  );
  const normalizedMinimumHorizonYear = ACS_normalizeInteger(
    minimumHorizonYear,
    2035,
    1900,
    2200
  );
  const horizonEndYear = Math.max(
    normalizedMinimumHorizonYear,
    simDate.getUTCFullYear() + normalizedHorizonYears
  );

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [ACS_FACTORY_CAPACITY_LOCK_NAMESPACE, horizonEndYear]
    );

    const insertResult = await client.query(
      `
      INSERT INTO public.aircraft_factory_slots (
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
        max_quantity,
        utilization_pct,
        aircraft_size_class,
        capacity_tier,
        slot_units_per_aircraft,
        created_at,
        updated_at
      )
      SELECT
        rules.manufacturer,
        rules.model_key,
        rules.aircraft_name,
        rules.production_start_year,
        EXTRACT(YEAR FROM months.month_start)::INTEGER,
        EXTRACT(MONTH FROM months.month_start)::INTEGER,
        rules.monthly_max_units,
        0,
        0,
        CASE UPPER(rules.aircraft_category)
          WHEN 'PISTON'       THEN 60
          WHEN 'TURBOPROP'    THEN 75
          WHEN 'REGIONAL_JET' THEN 90
          WHEN 'NARROWBODY'   THEN 120
          WHEN 'COMBI'        THEN 120
          WHEN 'WIDEBODY'     THEN 150
          ELSE 90
        END,
        'OPEN',
        rules.monthly_max_units,
        0,
        CASE
          WHEN UPPER(rules.aircraft_category) = 'WIDEBODY'
            THEN 'WIDEBODY_HEAVY'
          ELSE 'MEDIUM_AIRCRAFT'
        END,
        rules.capacity_tier,
        CASE UPPER(rules.aircraft_category)
          WHEN 'PISTON'    THEN 1
          WHEN 'TURBOPROP' THEN 1
          WHEN 'WIDEBODY'  THEN 4
          ELSE 2
        END,
        NOW(),
        NOW()
      FROM public.aircraft_production_rules rules
      CROSS JOIN LATERAL generate_series(
        make_date(rules.production_start_year, 1, 1),
        make_date(
          COALESCE(rules.production_end_year, $1::INTEGER),
          12,
          1
        ),
        INTERVAL '1 month'
      ) AS months(month_start)
      WHERE rules.is_active_rule = TRUE
        AND rules.is_factory_available = TRUE
        AND rules.monthly_max_units > 0
        AND rules.production_start_year <=
            COALESCE(rules.production_end_year, $1::INTEGER)
      ON CONFLICT (model_key, slot_year, slot_month)
      DO NOTHING
      RETURNING id
      `,
      [horizonEndYear]
    );

    await client.query("COMMIT");

    return {
      processedCount: insertResult.rowCount,
      insertedSlotMonths: insertResult.rowCount,
      horizonEndYear
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
