/* ============================================================
   ACS HR TRAINING — PILOT QUALIFICATION AUTHORITY
   Status, quote and training start
   ============================================================ */

import { pool } from "../db/pool.js";

const TRAINING_LOCK_NAMESPACE = 1095783254;
const HR_DEPARTMENT_COUNT = 18;

function normalizeBatchSize(value) {
  return Math.max(1, Math.min(1000, Math.trunc(Number(value) || 500)));
}

async function completeDuePilotTraining(simTime, batchSize) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dueResult = await client.query(
      `
      SELECT
        training_id, training_key, airline_id, training_type,
        source_dept_id, target_dept_id, quantity, completes_sim_at
      FROM public.hr_pilot_training
      WHERE status = 'ACTIVE'
        AND completes_sim_at <= $1::TIMESTAMP
      ORDER BY completes_sim_at, training_id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
      `,
      [simTime, batchSize]
    );

    for (const training of dueResult.rows) {
      const airlineId = Number(training.airline_id);
      const quantity = Number(training.quantity);

      await client.query(
        "SELECT pg_advisory_xact_lock($1, $2)",
        [TRAINING_LOCK_NAMESPACE, airlineId]
      );

      const departmentsResult = await client.query(
        `
        SELECT dept_id, dept_name, staff
        FROM public.hr_departments
        WHERE airline_id = $1
          AND dept_id = ANY($2::TEXT[])
        ORDER BY dept_id
        FOR UPDATE
        `,
        [airlineId, [training.source_dept_id, training.target_dept_id]]
      );

      if (departmentsResult.rowCount !== 2) {
        throw new Error(
          `PILOT_TRAINING_DEPARTMENT_NOT_FOUND:${training.training_key}`
        );
      }

      const source = departmentsResult.rows.find(
        row => row.dept_id === training.source_dept_id
      );
      const target = departmentsResult.rows.find(
        row => row.dept_id === training.target_dept_id
      );

      if (Number(source.staff || 0) < quantity) {
        throw new Error(
          `PILOT_TRAINING_SOURCE_STAFF_CONFLICT:${training.training_key}`
        );
      }

      const staffResult = await client.query(
        `
        UPDATE public.hr_departments
        SET
          staff = CASE
            WHEN dept_id = $2 THEN staff - $4
            WHEN dept_id = $3 THEN staff + $4
            ELSE staff
          END,
          payroll = ROUND(
            (CASE
              WHEN dept_id = $2 THEN staff - $4
              WHEN dept_id = $3 THEN staff + $4
              ELSE staff
            END)::NUMERIC * salary::NUMERIC
          )::BIGINT,
          updated_at = NOW()
        WHERE airline_id = $1
          AND dept_id = ANY($5::TEXT[])
        RETURNING dept_id
        `,
        [
          airlineId,
          training.source_dept_id,
          training.target_dept_id,
          quantity,
          [training.source_dept_id, training.target_dept_id]
        ]
      );

      if (staffResult.rowCount !== 2) {
        throw new Error(
          `PILOT_TRAINING_STAFF_UPDATE_FAILED:${training.training_key}`
        );
      }

      const completedResult = await client.query(
        `
        UPDATE public.hr_pilot_training
        SET
          status = 'COMPLETED',
          completed_sim_at = completes_sim_at,
          updated_at = NOW()
        WHERE training_id = $1
          AND status = 'ACTIVE'
        RETURNING training_id
        `,
        [training.training_id]
      );

      if (completedResult.rowCount !== 1) {
        throw new Error(
          `PILOT_TRAINING_COMPLETION_FAILED:${training.training_key}`
        );
      }

      await client.query(
        `
        INSERT INTO public.occ_alerts (
          airline_id, alert_key, category, level, title, message,
          source, source_ref, event_sim_time, created_at, updated_at
        )
        VALUES (
          $1, $2, 'hr', 'info', 'CREW TRAINING FINISHED', $3,
          'hr_pilot_training', $4, $5::TIMESTAMP, NOW(), NOW()
        )
        ON CONFLICT (airline_id, alert_key)
          WHERE deleted_at IS NULL
        DO NOTHING
        `,
        [
          airlineId,
          `HR_TRAINING_FINISHED:${training.training_key}`,
          `${quantity} pilot${quantity === 1 ? "" : "s"} completed ` +
            `${String(training.training_type).toLowerCase()} training ` +
            `from ${source.dept_name} to ${target.dept_name}.`,
          training.training_key,
          training.completes_sim_at
        ]
      );
    }

    await client.query("COMMIT");
    return dueResult.rowCount;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function getCrossedBoundaries(previousSimTime, currentSimTime) {
  if (!previousSimTime || !currentSimTime) return [];

  const result = await pool.query(
    `
    WITH limits AS (
      SELECT $1::TIMESTAMP AS previous_time, $2::TIMESTAMP AS current_time
    ),
    months AS (
      SELECT generate_series(
        DATE_TRUNC('month', previous_time),
        DATE_TRUNC('month', current_time),
        INTERVAL '1 month'
      )::TIMESTAMP AS month_start
      FROM limits
    ),
    boundaries AS (
      SELECT
        EXTRACT(YEAR FROM month_start)::INTEGER AS cycle_year,
        EXTRACT(MONTH FROM month_start)::INTEGER AS cycle_month,
        1::INTEGER AS cycle_half,
        month_start AS period_start_sim,
        month_start + INTERVAL '14 days' AS period_end_sim
      FROM months
      UNION ALL
      SELECT
        EXTRACT(YEAR FROM month_start)::INTEGER,
        EXTRACT(MONTH FROM month_start)::INTEGER,
        2::INTEGER,
        month_start + INTERVAL '15 days',
        month_start + INTERVAL '1 month' - INTERVAL '1 day'
      FROM months
    )
    SELECT boundaries.*
    FROM boundaries CROSS JOIN limits
    WHERE period_end_sim > previous_time
      AND period_end_sim <= current_time
    ORDER BY period_end_sim
    `,
    [previousSimTime, currentSimTime]
  );

  return result.rows;
}

async function settleStaffTrainingBoundary(boundary, currentSimTime) {
  const client = await pool.connect();
  const year = Number(boundary.cycle_year);
  const month = Number(boundary.cycle_month);
  const half = Number(boundary.cycle_half);
  const salaryHalf = month <= 6 ? 1 : 2;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock($1, hashtext($2))",
      [TRAINING_LOCK_NAMESPACE, `STAFF:${monthKey}:H${half}`]
    );

    await client.query(
      `
      SELECT airline_id
      FROM public.company_finance
      WHERE current_sim_year = $1 AND current_sim_month = $2
      ORDER BY airline_id
      FOR UPDATE
      `,
      [year, month]
    );

    await client.query(
      `
      SELECT department.id
      FROM public.hr_departments AS department
      JOIN public.company_finance AS finance
        ON finance.airline_id = department.airline_id
       AND finance.current_sim_year = $1
       AND finance.current_sim_month = $2
      ORDER BY department.airline_id, department.dept_id
      FOR UPDATE OF department
      `,
      [year, month]
    );

    const result = await client.query(
      `
      WITH active_policy AS (
        SELECT recurring_training_rate
        FROM public.hr_training_policy
        WHERE is_active = TRUE
        LIMIT 1
      ),
      raw_calculation AS (
        SELECT
          department.airline_id,
          department.dept_id,
          department.dept_name,
          GREATEST(COALESCE(department.staff, 0), 0)::INTEGER AS staff_count,
          rule.salary_source,
          CASE
            WHEN rule.salary_source = 'standard_two_crew_cost'
              THEN standard.standard_two_crew_cost
            ELSE standard.monthly_salary
          END::BIGINT AS historical_salary,
          policy.recurring_training_rate AS training_rate,
          rule.recurring_training_factor AS department_factor,
          era.era_factor
        FROM public.hr_departments AS department
        JOIN public.company_finance AS finance
          ON finance.airline_id = department.airline_id
         AND finance.current_sim_year = $1
         AND finance.current_sim_month = $2
        JOIN public.hr_training_department_rules AS rule
          ON rule.dept_id = department.dept_id
        JOIN public.hr_salary_standards AS standard
          ON standard.dept_id = department.dept_id
         AND standard.cycle_year = $1
         AND standard.cycle_half = $3
        JOIN public.hr_training_era_rules AS era
          ON $1 BETWEEN era.start_year AND era.end_year
        CROSS JOIN active_policy AS policy
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.hr_staff_training_cycles AS existing
          WHERE existing.airline_id = department.airline_id
            AND existing.cycle_year = $1
            AND existing.cycle_month = $2
            AND existing.cycle_half = $4
        )
      ),
      department_counts AS (
        SELECT airline_id, COUNT(*)::INTEGER AS department_count
        FROM raw_calculation
        GROUP BY airline_id
      ),
      expected_airlines AS (
        SELECT finance.airline_id
        FROM public.company_finance AS finance
        WHERE finance.current_sim_year = $1
          AND finance.current_sim_month = $2
          AND EXISTS (
            SELECT 1 FROM public.hr_departments AS department
            WHERE department.airline_id = finance.airline_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.hr_staff_training_cycles AS existing
            WHERE existing.airline_id = finance.airline_id
              AND existing.cycle_year = $1
              AND existing.cycle_month = $2
              AND existing.cycle_half = $4
          )
      ),
      incomplete AS (
        SELECT expected.airline_id
        FROM expected_airlines AS expected
        LEFT JOIN department_counts AS counts
          ON counts.airline_id = expected.airline_id
        WHERE COALESCE(counts.department_count, 0) <> $5
      ),
      calculation AS (
        SELECT
          raw.*,
          ROUND(
            raw.staff_count::NUMERIC * raw.historical_salary::NUMERIC *
            raw.training_rate * raw.department_factor * raw.era_factor
          )::BIGINT AS department_cost
        FROM raw_calculation AS raw
        JOIN department_counts AS counts
          ON counts.airline_id = raw.airline_id
         AND counts.department_count = $5
      ),
      summary AS (
        SELECT
          airline_id,
          SUM(staff_count)::INTEGER AS staff_total,
          SUM(department_cost)::BIGINT AS total_cost
        FROM calculation
        GROUP BY airline_id
      ),
      inserted_logs AS (
        INSERT INTO public.finance_log (
          airline_id, type, source, amount, timestamp,
          reference_uid, description, created_at
        )
        SELECT
          airline_id,
          'EXPENSE',
          'HR_TRAINING_QUALIFICATION',
          total_cost,
          FLOOR(EXTRACT(EPOCH FROM $6::TIMESTAMP) * 1000)::BIGINT,
          'HR_STAFF_TRAINING:' || airline_id::TEXT || ':' ||
            $7 || ':H' || $4::TEXT,
          'Training Qualification — ' || $7 || ' H' || $4::TEXT,
          NOW()
        FROM summary
        WHERE total_cost > 0
        ON CONFLICT (reference_uid) DO NOTHING
        RETURNING id, airline_id
      ),
      inserted_cycles AS (
        INSERT INTO public.hr_staff_training_cycles (
          cycle_key, airline_id, cycle_year, cycle_month, cycle_half,
          period_start_sim, period_end_sim, charged_sim_at,
          staff_total, total_cost, finance_log_id
        )
        SELECT
          'HRST:' || summary.airline_id::TEXT || ':' ||
            $7 || ':H' || $4::TEXT,
          summary.airline_id,
          $1, $2, $4,
          $8::TIMESTAMP, $9::TIMESTAMP, $6::TIMESTAMP,
          summary.staff_total, summary.total_cost, log.id
        FROM summary
        JOIN inserted_logs AS log ON log.airline_id = summary.airline_id
        ON CONFLICT (airline_id, cycle_year, cycle_month, cycle_half)
        DO NOTHING
        RETURNING training_cycle_id, airline_id, total_cost
      ),
      inserted_details AS (
        INSERT INTO public.hr_staff_training_cycle_details (
          training_cycle_id, dept_id, dept_name, staff_count,
          salary_source, historical_salary, training_rate,
          department_factor, era_factor, department_cost
        )
        SELECT
          cycle.training_cycle_id,
          calculation.dept_id,
          calculation.dept_name,
          calculation.staff_count,
          calculation.salary_source,
          calculation.historical_salary,
          calculation.training_rate,
          calculation.department_factor,
          calculation.era_factor,
          calculation.department_cost
        FROM calculation
        JOIN inserted_cycles AS cycle
          ON cycle.airline_id = calculation.airline_id
        RETURNING training_detail_id
      ),
      updated_finance AS (
        UPDATE public.company_finance AS finance
        SET
          capital = COALESCE(finance.capital, 0) - cycle.total_cost,
          expenses = COALESCE(finance.expenses, 0) + cycle.total_cost,
          profit = COALESCE(finance.profit, 0) - cycle.total_cost,
          cost_hr = COALESCE(finance.cost_hr, 0) + cycle.total_cost,
          cost_training_qualification = COALESCE(
            finance.cost_training_qualification, 0
          ) + cycle.total_cost,
          updated_at = NOW()
        FROM inserted_cycles AS cycle
        WHERE finance.airline_id = cycle.airline_id
        RETURNING finance.airline_id
      )
      SELECT
        (SELECT COUNT(*)::INTEGER FROM incomplete) AS incomplete_count,
        (SELECT COUNT(*)::INTEGER FROM inserted_cycles) AS cycle_count,
        (SELECT COUNT(*)::INTEGER FROM inserted_details) AS detail_count,
        (SELECT COUNT(*)::INTEGER FROM updated_finance) AS finance_count,
        (SELECT COALESCE(SUM(total_cost), 0)::BIGINT FROM inserted_cycles)
          AS charged_total
      `,
      [
        year,
        month,
        salaryHalf,
        half,
        HR_DEPARTMENT_COUNT,
        currentSimTime,
        monthKey,
        boundary.period_start_sim,
        boundary.period_end_sim
      ]
    );

    const row = result.rows[0];
    const incompleteCount = Number(row.incomplete_count || 0);
    const cycleCount = Number(row.cycle_count || 0);
    const detailCount = Number(row.detail_count || 0);
    const financeCount = Number(row.finance_count || 0);

    if (incompleteCount > 0) {
      throw new Error(`HR_TRAINING_DEPARTMENT_SET_INCOMPLETE:${incompleteCount}`);
    }

    if (
      detailCount !== cycleCount * HR_DEPARTMENT_COUNT ||
      financeCount !== cycleCount
    ) {
      throw new Error("HR_TRAINING_SETTLEMENT_COUNT_MISMATCH");
    }

    await client.query("COMMIT");

    return {
      cycleCount,
      chargedTotal: Number(row.charged_total || 0)
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_runHRTrainingRuntime({ job, simTime } = {}) {
  const batchSize = normalizeBatchSize(
    job?.config?.pilot_completion_batch_size || job?.batch_size
  );

  const completedCount = await completeDuePilotTraining(
    simTime,
    batchSize
  );

  const boundaries = await getCrossedBoundaries(
    job?.last_cursor_sim_time,
    simTime
  );

  let cycleCount = 0;
  let chargedTotal = 0;

  for (const boundary of boundaries) {
    const result = await settleStaffTrainingBoundary(boundary, simTime);
    cycleCount += result.cycleCount;
    chargedTotal += result.chargedTotal;
  }

  return {
    processedCount: completedCount + cycleCount,
    completedCount,
    cycleCount,
    chargedTotal
  };
}

