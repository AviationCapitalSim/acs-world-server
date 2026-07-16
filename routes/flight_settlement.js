/* ============================================================
   ACS FLIGHT SETTLEMENT  ENGINE
   ------------------------------------------------------------
   File: routes/flight_settlement.js

   Authority:
   - PostgreSQL only
   - ACS OCC
   - Airbus OCC
   - Backend authority only
   - 700+ players ready
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

const ACS_FLIGHT_SETTLEMENT_LOCK = 1179863380;

const ACS_money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};

export async function ACS_runFlightSettlementRuntime({
  batchSize = 100
} = {}) {
  const normalizedBatchSize = Math.min(
    500,
    Math.max(1, Number.parseInt(batchSize, 10) || 100)
  );
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [ACS_FLIGHT_SETTLEMENT_LOCK]
    );

        await client.query(
      `
      SELECT pg_advisory_xact_lock(
        1095783253,
        airline_id
      )
      FROM public.company_finance
      WHERE airline_id IS NOT NULL
      ORDER BY airline_id
      `
    );
     
    const result = await client.query(
      `
      WITH clock AS MATERIALIZED (
        SELECT
          acs_get_current_sim_time() AS sim_time,
          FLOOR(
            EXTRACT(EPOCH FROM acs_get_current_sim_time()) * 1000
          )::bigint AS sim_timestamp_ms
      ),
      legacy_cutoff AS MATERIALIZED (
        SELECT
          airline_id,
          TO_TIMESTAMP(
            MAX(closed_sim_timestamp)::double precision / 1000
          )::timestamp AS cutoff_sim_time
        FROM public.finance_history
        WHERE record_kind = 'LEGACY_CUTOVER'
          AND closed_sim_timestamp IS NOT NULL
        GROUP BY airline_id
      ),
      due AS MATERIALIZED (
        SELECT occurrence.*
       FROM public.flight_occurrences occurrence
        JOIN public.company_finance finance
          ON finance.airline_id = occurrence.airline_id
        LEFT JOIN legacy_cutoff cutoff
          ON cutoff.airline_id = occurrence.airline_id
        WHERE occurrence.operational_status = 'ARRIVED'
          AND EXTRACT(YEAR FROM occurrence.arrived_at)::integer
              = finance.current_sim_year
          AND EXTRACT(MONTH FROM occurrence.arrived_at)::integer
              = finance.current_sim_month
          AND occurrence.settled_at IS NULL
          AND occurrence.arrived_at IS NOT NULL
          AND (
            cutoff.cutoff_sim_time IS NULL
            OR occurrence.arrived_at > cutoff.cutoff_sim_time
          )
        ORDER BY occurrence.arrived_at, occurrence.id
        LIMIT $1
        FOR UPDATE OF occurrence SKIP LOCKED
      ),
      economics AS MATERIALIZED (
        SELECT
          due.*,
          catalog.seats,
          catalog.fuel_burn_kgph,
          flight_economics.passenger_yield_usd_per_pax_mile,
          flight_economics.demand_multiplier,
          flight_economics.fuel_price_usd_per_gallon,
          flight_economics.handling_base_usd,
          flight_economics.landing_fee_base_usd,
          flight_economics.navigation_usd_per_nm,
          flight_economics.overflight_usd_per_nm,
          route_rank.route_number
        FROM due
        JOIN public.route_plans route
          ON route.id = due.route_plan_id
         AND route.airline_id = due.airline_id
        JOIN public.aircraft_fleet fleet
          ON fleet.id = due.aircraft_id
         AND fleet.airline_id = due.airline_id
        JOIN public.aircraft_catalog catalog
          ON catalog.model_key = fleet.model_key
        JOIN public.acs_economic_periods period
          ON EXTRACT(YEAR FROM due.arrived_at)::integer
             BETWEEN period.era_start_year AND period.era_end_year
        JOIN public.flight_economics flight_economics
          ON flight_economics.period_id = period.id
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS route_number
          FROM public.route_plans ordered_route
          WHERE ordered_route.airline_id = due.airline_id
            AND ordered_route.id <= due.route_plan_id
        ) route_rank
      ),
      base_amounts AS MATERIALIZED (
        SELECT
          economics.*,
          LEAST(
            0.92,
            CASE
              WHEN route_number <= 4 THEN 0.74 * 1.18
              ELSE 0.62
            END
          )::numeric AS load_factor,
          GREATEST(
            0.25,
            COALESCE(block_time_min, 60)::numeric / 60
          ) AS block_hours
        FROM economics
      ),
      amounts AS MATERIALIZED (
        SELECT
          base_amounts.*,
          GREATEST(
            1,
            ROUND(COALESCE(seats, 0) * load_factor)
          )::integer AS passengers,
          ROUND(
            GREATEST(1, ROUND(COALESCE(seats, 0) * load_factor))
            * COALESCE(distance_nm, 0)
            * COALESCE(passenger_yield_usd_per_pax_mile, 0)
            * COALESCE(demand_multiplier, 1)
          )::bigint AS revenue_amount,
          ROUND(
            (
              COALESCE(fuel_burn_kgph, 0)
              * block_hours / 3.04
            ) * COALESCE(fuel_price_usd_per_gallon, 0)
          )::bigint AS fuel_amount,
          ROUND(COALESCE(handling_base_usd, 0))::bigint AS handling_amount,
          ROUND(COALESCE(landing_fee_base_usd, 0))::bigint AS landing_amount,
          ROUND(
            COALESCE(distance_nm, 0)
            * COALESCE(navigation_usd_per_nm, 0)
          )::bigint AS navigation_amount,
          ROUND(
            COALESCE(distance_nm, 0)
            * COALESCE(overflight_usd_per_nm, 0)
          )::bigint AS overflight_amount
        FROM base_amounts
      ),
      inserted_logs AS MATERIALIZED (
        INSERT INTO public.finance_log (
          airline_id,
          type,
          source,
          amount,
          timestamp,
          route_plan_id,
          schedule_item_id,
          reference_uid,
          description,
          created_at
        )
        SELECT
          amounts.airline_id,
          entry.type,
          entry.source,
          entry.amount,
          FLOOR(
            EXTRACT(EPOCH FROM amounts.arrived_at) * 1000
          )::bigint,
          amounts.route_plan_id,
          amounts.schedule_item_id,
          'FLIGHT_OCCURRENCE:' || amounts.occurrence_key || ':' || entry.suffix,
          entry.description,
          CURRENT_TIMESTAMP
        FROM amounts
        CROSS JOIN clock
        CROSS JOIN LATERAL (
          VALUES
            (
              'INCOME', 'FLIGHT_REVENUE', amounts.revenue_amount,
              'REVENUE',
              'Flight revenue ' || amounts.origin || '-' || amounts.destination
            ),
            (
              'EXPENSE', 'FLIGHT_FUEL', amounts.fuel_amount,
              'FUEL',
              'Fuel cost ' || amounts.origin || '-' || amounts.destination
            ),
            (
              'EXPENSE', 'FLIGHT_HANDLING', amounts.handling_amount,
              'HANDLING',
              'Handling cost ' || amounts.origin || '-' || amounts.destination
            ),
            (
              'EXPENSE', 'FLIGHT_LANDING', amounts.landing_amount,
              'LANDING',
              'Landing fee ' || amounts.origin || '-' || amounts.destination
            ),
            (
              'EXPENSE', 'FLIGHT_NAVIGATION', amounts.navigation_amount,
              'NAVIGATION',
              'Navigation cost ' || amounts.origin || '-' || amounts.destination
            ),
            (
              'EXPENSE', 'FLIGHT_OVERFLIGHT', amounts.overflight_amount,
              'OVERFLIGHT',
              'Overflight cost ' || amounts.origin || '-' || amounts.destination
            )
        ) AS entry(type, source, amount, suffix, description)
        ON CONFLICT (reference_uid) DO NOTHING
        RETURNING id, airline_id, type, source, reference_uid
      ),
      complete_occurrences AS MATERIALIZED (
        SELECT
          amounts.id AS occurrence_id,
          MIN(inserted_logs.id) FILTER (
            WHERE inserted_logs.source = 'FLIGHT_REVENUE'
          ) AS finance_log_id
        FROM amounts
        JOIN inserted_logs
          ON inserted_logs.reference_uid LIKE
             'FLIGHT_OCCURRENCE:' || amounts.occurrence_key || ':%'
        GROUP BY amounts.id
        HAVING COUNT(*) = 6
      ),
      finance_delta AS MATERIALIZED (
        SELECT
          amounts.airline_id,
          SUM(amounts.revenue_amount)::bigint AS revenue,
          SUM(
            amounts.fuel_amount
            + amounts.handling_amount
            + amounts.landing_amount
            + amounts.navigation_amount
            + amounts.overflight_amount
          )::bigint AS expenses,
          SUM(amounts.fuel_amount)::bigint AS fuel,
          SUM(amounts.handling_amount + amounts.landing_amount)::bigint AS handling,
          SUM(amounts.navigation_amount)::bigint AS navigation,
          SUM(amounts.overflight_amount)::bigint AS overflight,
          SUM(
            amounts.handling_amount
            + amounts.landing_amount
            + amounts.navigation_amount
            + amounts.overflight_amount
          )::bigint AS airport
        FROM amounts
        JOIN complete_occurrences complete
          ON complete.occurrence_id = amounts.id
        GROUP BY amounts.airline_id
      ),
      updated_finance AS (
        UPDATE public.company_finance finance
        SET
          revenue = COALESCE(finance.revenue, 0) + delta.revenue,
          live_revenue = COALESCE(finance.live_revenue, 0) + delta.revenue,
          weekly_revenue = COALESCE(finance.weekly_revenue, 0) + delta.revenue,
          expenses = COALESCE(finance.expenses, 0) + delta.expenses,
          profit = COALESCE(finance.profit, 0) + delta.revenue - delta.expenses,
          capital = COALESCE(finance.capital, 0) + delta.revenue - delta.expenses,
          cost_fuel = COALESCE(finance.cost_fuel, 0) + delta.fuel,
          cost_handling = COALESCE(finance.cost_handling, 0) + delta.handling,
          cost_navigation = COALESCE(finance.cost_navigation, 0) + delta.navigation,
          cost_overflight = COALESCE(finance.cost_overflight, 0) + delta.overflight,
          cost_airport = COALESCE(finance.cost_airport, 0) + delta.airport,
          updated_at = CURRENT_TIMESTAMP
        FROM finance_delta delta
        WHERE finance.airline_id = delta.airline_id
        RETURNING finance.airline_id
      ),
      updated_occurrences AS (
        UPDATE public.flight_occurrences occurrence
        SET
          settled_at = clock.sim_time,
          settled_passengers = amounts.passengers,
          settled_load_factor = amounts.load_factor,
          settled_revenue = amounts.revenue_amount,
          settled_expenses = (
            amounts.fuel_amount
            + amounts.handling_amount
            + amounts.landing_amount
            + amounts.navigation_amount
            + amounts.overflight_amount
          ),
          settled_profit = amounts.revenue_amount - (
            amounts.fuel_amount
            + amounts.handling_amount
            + amounts.landing_amount
            + amounts.navigation_amount
            + amounts.overflight_amount
          ),
          finance_log_id = complete.finance_log_id,
          updated_at = CURRENT_TIMESTAMP
        FROM amounts
        JOIN complete_occurrences complete
          ON complete.occurrence_id = amounts.id
        JOIN updated_finance finance
          ON finance.airline_id = amounts.airline_id
        CROSS JOIN clock
        WHERE occurrence.id = amounts.id
          AND occurrence.settled_at IS NULL
        RETURNING occurrence.id
      )
      SELECT COUNT(*)::integer AS processed_count
      FROM updated_occurrences
      `,
      [normalizedBatchSize]
    );

    await client.query("COMMIT");

    return {
      processedCount: Number(result.rows[0]?.processed_count || 0)
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

export default router;
