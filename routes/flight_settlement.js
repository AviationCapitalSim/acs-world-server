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
          catalog.seats,
          catalog.fuel_burn_kgph,
          catalog.fuel_code,
          fuel_product.density_kg_per_us_gallon,
          fuel_market.resolved_fuel_code,
          fuel_market.resolved_price_year,
          fuel_market.price_usd_per_us_gallon,
          flight_economics.passenger_yield_usd_per_pax_mile,
          flight_economics.demand_multiplier,
          flight_economics.handling_base_usd,
          flight_economics.landing_fee_base_usd,
          flight_economics.navigation_usd_per_nm,
          flight_economics.overflight_usd_per_nm,
          allocation.offered_seats,
          allocation.captured_y,
          allocation.captured_c,
          allocation.captured_f,
          allocation.captured_total AS allocated_passengers,
          allocation.load_factor AS allocated_load_factor,
          allocation.competition_score,
          allocation.route_maturity
        FROM due
        JOIN public.route_plans route
          ON route.id = due.route_plan_id
         AND route.airline_id = due.airline_id
        JOIN public.aircraft_fleet fleet
          ON fleet.id = due.aircraft_id
         AND fleet.airline_id = due.airline_id
        JOIN public.aircraft_catalog catalog
         ON catalog.model_key = fleet.model_key
        JOIN public.fuel_product_catalog fuel_product
         ON fuel_product.fuel_code = catalog.fuel_code
        JOIN LATERAL public.acs_resolve_fuel_market_price(
          catalog.fuel_code
        ) fuel_market ON true
        JOIN public.acs_economic_periods period
          ON EXTRACT(YEAR FROM due.arrived_at)::integer
             BETWEEN period.era_start_year AND period.era_end_year
        JOIN public.flight_economics flight_economics
          ON flight_economics.period_id = period.id
        JOIN LATERAL public.acs_allocate_passengers_for_flight(
          due.id
        ) allocation ON true
      ),
            base_amounts AS MATERIALIZED (
        SELECT
          economics.*,

          LEAST(
            1::numeric,
            GREATEST(
              0::numeric,
              COALESCE(
                economics.hr_pax_reduction_pct,
                0
              )::numeric
            )
          ) AS hr_reduction_fraction,

          GREATEST(
            0.25,
            COALESCE(block_time_min, 60)::numeric / 60
          ) AS block_hours

        FROM economics
      ),

      adjusted_amounts AS MATERIALIZED (
        SELECT
          base_amounts.*,

          CASE
            WHEN hr_operational_outcome = 'CANCELLED'
              THEN 0
            ELSE FLOOR(
              COALESCE(captured_y, 0)::numeric
              * (1::numeric - hr_reduction_fraction)
            )::integer
          END AS adjusted_captured_y,

          CASE
            WHEN hr_operational_outcome = 'CANCELLED'
              THEN 0
            ELSE FLOOR(
              COALESCE(captured_c, 0)::numeric
              * (1::numeric - hr_reduction_fraction)
            )::integer
          END AS adjusted_captured_c,

          CASE
            WHEN hr_operational_outcome = 'CANCELLED'
              THEN 0
            ELSE FLOOR(
              COALESCE(captured_f, 0)::numeric
              * (1::numeric - hr_reduction_fraction)
            )::integer
          END AS adjusted_captured_f

        FROM base_amounts
      ),

      amounts AS MATERIALIZED (
        SELECT
          adjusted_amounts.*,

          (
            adjusted_captured_y
            + adjusted_captured_c
            + adjusted_captured_f
          )::integer AS passengers,

          GREATEST(
            COALESCE(allocated_passengers, 0)::integer
            - (
                adjusted_captured_y
                + adjusted_captured_c
                + adjusted_captured_f
              ),
            0
          )::integer AS hr_pax_lost_amount,

          CASE
            WHEN COALESCE(offered_seats, 0) > 0
              THEN (
                adjusted_captured_y
                + adjusted_captured_c
                + adjusted_captured_f
              )::numeric
              / offered_seats::numeric
            ELSE 0::numeric
          END AS load_factor,

          ROUND(
            (
              adjusted_captured_y
              + adjusted_captured_c
              + adjusted_captured_f
            )
            * COALESCE(distance_nm, 0)
            * COALESCE(
                passenger_yield_usd_per_pax_mile,
                0
              )
            * COALESCE(demand_multiplier, 1)
          )::bigint AS revenue_amount,

          ROUND(
            (
              fuel_burn_kgph
              * block_hours
              / density_kg_per_us_gallon
            )
            * price_usd_per_us_gallon
          )::bigint AS fuel_amount,

          ROUND(
            COALESCE(handling_base_usd, 0)
          )::bigint AS handling_amount,

          ROUND(
            COALESCE(landing_fee_base_usd, 0)
          )::bigint AS landing_amount,

          ROUND(
            COALESCE(distance_nm, 0)
            * COALESCE(navigation_usd_per_nm, 0)
          )::bigint AS navigation_amount,

          ROUND(
            COALESCE(distance_nm, 0)
            * COALESCE(overflight_usd_per_nm, 0)
          )::bigint AS overflight_amount

        FROM adjusted_amounts
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

          settled_passengers =
            amounts.passengers,

          settled_load_factor =
            amounts.load_factor,

          hr_pax_lost =
            amounts.hr_pax_lost_amount,

          settled_revenue =
            amounts.revenue_amount,
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
        RETURNING
          occurrence.id,
          occurrence.route_plan_id,
          occurrence.airline_id,
          occurrence.schedule_item_id,
          occurrence.arrived_at,
          occurrence.settled_load_factor
      ),
      updated_schedule_items AS (
        UPDATE public.schedule_items item
        SET
          settled_load_factor = occurrence.settled_load_factor,
          updated_at = CURRENT_TIMESTAMP
        FROM updated_occurrences occurrence
        WHERE item.id = occurrence.schedule_item_id
        RETURNING item.id
      ),
      maturity_routes AS MATERIALIZED (
        SELECT
          occurrence.route_plan_id,
          occurrence.airline_id,
          MAX(occurrence.arrived_at) AS as_of_sim_time
        FROM updated_occurrences occurrence
        WHERE occurrence.route_plan_id IS NOT NULL
          AND occurrence.arrived_at IS NOT NULL
        GROUP BY occurrence.route_plan_id, occurrence.airline_id
      ),
      maturity_snapshots AS MATERIALIZED (
        SELECT
          route.route_plan_id,
          route.airline_id,
          evaluation.*
        FROM maturity_routes route
        JOIN LATERAL public.acs_evaluate_route_maturity(
          route.route_plan_id,
          route.as_of_sim_time
        ) evaluation ON true
      ),
      updated_maturity AS (
        INSERT INTO public.acs_route_market_maturity (
          route_plan_id,
          airline_id,
          first_scheduled_sim_time,
          last_completed_sim_time,
          scheduled_due_flights,
          completed_flights,
          cancelled_flights,
          on_time_flights,
          compliance_ratio,
          punctuality_ratio,
          organic_awareness,
          operational_bonus,
          marketing_bonus,
          maturity_score,
          rules_version,
          created_at,
          updated_at
        )
        SELECT
          snapshot.route_plan_id,
          snapshot.airline_id,
          snapshot.first_scheduled_sim_time,
          snapshot.last_completed_sim_time,
          snapshot.scheduled_due_flights,
          snapshot.completed_flights,
          snapshot.cancelled_flights,
          snapshot.on_time_flights,
          snapshot.compliance_ratio,
          snapshot.punctuality_ratio,
          snapshot.organic_awareness,
          snapshot.operational_bonus,
          0,
          snapshot.maturity_score,
          'ACS_PAX_SETTLEMENT_V1',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM maturity_snapshots snapshot
        ON CONFLICT (route_plan_id)
        DO UPDATE SET
          airline_id = EXCLUDED.airline_id,
          first_scheduled_sim_time = EXCLUDED.first_scheduled_sim_time,
          last_completed_sim_time = EXCLUDED.last_completed_sim_time,
          scheduled_due_flights = EXCLUDED.scheduled_due_flights,
          completed_flights = EXCLUDED.completed_flights,
          cancelled_flights = EXCLUDED.cancelled_flights,
          on_time_flights = EXCLUDED.on_time_flights,
          compliance_ratio = EXCLUDED.compliance_ratio,
          punctuality_ratio = EXCLUDED.punctuality_ratio,
          organic_awareness = EXCLUDED.organic_awareness,
          operational_bonus = EXCLUDED.operational_bonus,
          maturity_score = EXCLUDED.maturity_score,
          rules_version = 'ACS_PAX_SETTLEMENT_V1',
          updated_at = CURRENT_TIMESTAMP
        RETURNING route_plan_id
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
