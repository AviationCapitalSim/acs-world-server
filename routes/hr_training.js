/* ============================================================
   ACS HR TRAINING — COMPLETE OCC AUTHORITY
   Personnel training, pilot qualification and runtime settlement
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ACS_ensureFinancePeriod } from "./finance_core.js";

const router = express.Router();

const HR_TRAINING_LOCK_NAMESPACE = 1095783254;
const HR_TRAINING_DEFAULT_BATCH_SIZE = 100;

const PILOT_CATEGORY_RANK = Object.freeze({
  pilots_small: 1,
  pilots_medium: 2,
  pilots_large: 3,
  pilots_vlarge: 4
});

const PILOT_DEPARTMENT_IDS = Object.freeze(
  Object.keys(PILOT_CATEGORY_RANK)
);

function normalizePilotDepartment(value) {
  const deptId = String(value || "").trim();

  return Object.prototype.hasOwnProperty.call(
    PILOT_CATEGORY_RANK,
    deptId
  )
    ? deptId
    : null;
}

function getTrainingType(sourceDeptId, targetDeptId) {
  const sourceRank = PILOT_CATEGORY_RANK[sourceDeptId];
  const targetRank = PILOT_CATEGORY_RANK[targetDeptId];

  if (sourceRank === targetRank) {
    throw trainingError("TRAINING_CATEGORY_MUST_CHANGE", 400);
  }

  return targetRank > sourceRank ? "UPGRADE" : "DOWNGRADE";
}

function trainingError(code, httpStatus, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  error.details = details;
  return error;
}

function sendTrainingError(res, error) {
  return res.status(error.httpStatus || 500).json({
    ok: false,
    error: error.code || error.message,
    ...(error.details || {})
  });
}

function readTrainingRequest(req) {
  const airlineId = Number(req.airline_id);
  const sourceDeptId = normalizePilotDepartment(
    req.body?.source_dept_id
  );
  const targetDeptId = normalizePilotDepartment(
    req.body?.target_dept_id
  );
  const quantity = Number(req.body?.quantity);

  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    throw trainingError("NO_AIRLINE_ID", 400);
  }

  if (!sourceDeptId || !targetDeptId) {
    throw trainingError("INVALID_PILOT_CATEGORY", 400);
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw trainingError("INVALID_TRAINING_QUANTITY", 400);
  }

  return {
    airlineId,
    sourceDeptId,
    targetDeptId,
    quantity
  };
}

function normalizeTrainingBatchSize(value) {
  const batchSize = Math.trunc(Number(value));

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    return HR_TRAINING_DEFAULT_BATCH_SIZE;
  }

  return Math.min(batchSize, 1000);
}

async function buildPilotTrainingQuote(
  client,
  airlineId,
  sourceDeptId,
  targetDeptId,
  quantity,
  { lockDepartments = false } = {}
) {
  const trainingType = getTrainingType(
    sourceDeptId,
    targetDeptId
  );

  const simResult = await client.query(
    `
    WITH sim_clock AS (
      SELECT acs_get_current_sim_time() AS sim_time
    )
    SELECT
      sim_time,
      EXTRACT(YEAR FROM sim_time)::INTEGER AS sim_year,
      EXTRACT(MONTH FROM sim_time)::INTEGER AS sim_month
    FROM sim_clock
    `
  );

  const simTime = simResult.rows[0]?.sim_time;
  const simYear = Number(simResult.rows[0]?.sim_year);
  const simMonth = Number(simResult.rows[0]?.sim_month);
  const salaryHalf = simMonth <= 6 ? 1 : 2;

  const departmentsResult = await client.query(
    `
    SELECT dept_id, dept_name, staff, required
    FROM public.hr_departments
    WHERE airline_id = $1
      AND dept_id = ANY($2::TEXT[])
    ORDER BY dept_id
    ${lockDepartments ? "FOR UPDATE" : ""}
    `,
    [airlineId, [sourceDeptId, targetDeptId]]
  );

  if (departmentsResult.rowCount !== 2) {
    throw trainingError("PILOT_DEPARTMENT_NOT_FOUND", 404);
  }

  const departments = new Map(
    departmentsResult.rows.map(row => [row.dept_id, row])
  );
  const source = departments.get(sourceDeptId);
  const target = departments.get(targetDeptId);

  const activeResult = await client.query(
    `
    SELECT COALESCE(SUM(quantity), 0)::INTEGER AS active_quantity
    FROM public.hr_pilot_training
    WHERE airline_id = $1
      AND source_dept_id = $2
      AND status = 'ACTIVE'
    `,
    [airlineId, sourceDeptId]
  );

  const sourceStaff = Number(source.staff || 0);
  const sourceRequired = Number(source.required || 0);
  const displayedSurplus = Math.max(0, sourceStaff - sourceRequired);
  const activeQuantity = Number(
    activeResult.rows[0]?.active_quantity || 0
  );
  const transferableQuantity = Math.max(
    0,
    displayedSurplus - activeQuantity
  );

  if (quantity > transferableQuantity) {
    throw trainingError("QUANTITY_EXCEEDS_HR_SURPLUS", 409, {
      displayed_surplus: displayedSurplus,
      active_training_quantity: activeQuantity,
      transferable_quantity: transferableQuantity
    });
  }

  const priceResult = await client.query(
    `
    SELECT
      standard.standard_two_crew_cost::BIGINT AS historical_salary,
      rule.pilot_qualification_factor,
      era.era_factor,
      policy.pilot_training_hours,
      ROUND(
        standard.standard_two_crew_cost::NUMERIC *
        rule.pilot_qualification_factor *
        era.era_factor
      )::BIGINT AS cost_per_pilot,
      (
        ROUND(
          standard.standard_two_crew_cost::NUMERIC *
          rule.pilot_qualification_factor *
          era.era_factor
        )::BIGINT * $4::BIGINT
      )::BIGINT AS total_cost
    FROM public.hr_salary_standards AS standard
    JOIN public.hr_training_department_rules AS rule
      ON rule.dept_id = standard.dept_id
    JOIN public.hr_training_era_rules AS era
      ON $1 BETWEEN era.start_year AND era.end_year
    JOIN public.hr_training_policy AS policy
      ON policy.is_active = TRUE
    WHERE standard.cycle_year = $1
      AND standard.cycle_half = $2
      AND standard.dept_id = $3
      AND rule.pilot_qualification_factor IS NOT NULL
    LIMIT 1
    `,
    [simYear, salaryHalf, targetDeptId, quantity]
  );

  if (priceResult.rowCount !== 1) {
    throw trainingError("TRAINING_COST_STANDARD_NOT_FOUND", 409);
  }

  const price = priceResult.rows[0];

  return {
    airline_id: airlineId,
    training_type: trainingType,
    source_dept_id: sourceDeptId,
    source_dept_name: source.dept_name,
    target_dept_id: targetDeptId,
    target_dept_name: target.dept_name,
    quantity,
    source_staff_at_start: sourceStaff,
    source_required_at_start: sourceRequired,
    source_surplus_at_start: displayedSurplus,
    active_training_quantity: activeQuantity,
    transferable_quantity: transferableQuantity,
    target_staff_at_start: Number(target.staff || 0),
    target_required_at_start: Number(target.required || 0),
    historical_salary: Number(price.historical_salary),
    pilot_qualification_factor: Number(
      price.pilot_qualification_factor
    ),
    era_factor: Number(price.era_factor),
    cost_per_pilot: Number(price.cost_per_pilot),
    total_cost: Number(price.total_cost),
    training_hours: Number(price.pilot_training_hours),
    started_sim_at: simTime,
    salary_cycle_year: simYear,
    salary_cycle_half: salaryHalf
  };
}

async function startPilotTraining(
  airlineId,
  sourceDeptId,
  targetDeptId,
  quantity
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [HR_TRAINING_LOCK_NAMESPACE, airlineId]
    );

    await ACS_ensureFinancePeriod(client, airlineId);

    const quote = await buildPilotTrainingQuote(
      client,
      airlineId,
      sourceDeptId,
      targetDeptId,
      quantity,
      { lockDepartments: true }
    );

    const financeResult = await client.query(
      `
      SELECT capital
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    if (financeResult.rowCount !== 1) {
      throw trainingError("COMPANY_FINANCE_NOT_FOUND", 404);
    }

    const availableCapital = Number(
      financeResult.rows[0].capital || 0
    );

    if (availableCapital < quote.total_cost) {
      throw trainingError("INSUFFICIENT_CAPITAL", 409, {
        available_capital: availableCapital,
        required_capital: quote.total_cost
      });
    }

    const trainingResult = await client.query(
      `
      WITH next_training AS (
        SELECT nextval(
          pg_get_serial_sequence(
            'public.hr_pilot_training',
            'training_id'
          )
        )::BIGINT AS training_id
      )
      INSERT INTO public.hr_pilot_training (
        training_id,
        training_key,
        airline_id,
        training_type,
        source_dept_id,
        target_dept_id,
        quantity,
        source_staff_at_start,
        source_required_at_start,
        source_surplus_at_start,
        target_staff_at_start,
        target_required_at_start,
        cost_per_pilot,
        total_cost,
        started_sim_at,
        completes_sim_at,
        status
      )
      SELECT
  next_training.training_id,
  'HRPT:' ||
    ($1::INTEGER)::TEXT ||
    ':' ||
    next_training.training_id::TEXT,
  $1::INTEGER,
  $2::VARCHAR,
  $3::TEXT,
  $4::TEXT,
  $5::INTEGER,
  $6::INTEGER,
  $7::INTEGER,
  $8::INTEGER,
  $9::INTEGER,
  $10::INTEGER,
  $11::BIGINT,
  $12::BIGINT,
  $13::TIMESTAMP,
  $13::TIMESTAMP +
    ($14::INTEGER * INTERVAL '1 hour'),
  'ACTIVE'::VARCHAR
FROM next_training
      RETURNING *
      `,
      [
        airlineId,
        quote.training_type,
        sourceDeptId,
        targetDeptId,
        quantity,
        quote.source_staff_at_start,
        quote.source_required_at_start,
        quote.source_surplus_at_start,
        quote.target_staff_at_start,
        quote.target_required_at_start,
        quote.cost_per_pilot,
        quote.total_cost,
        quote.started_sim_at,
        quote.training_hours
      ]
    );

    if (trainingResult.rowCount !== 1) {
      throw new Error("PILOT_TRAINING_CREATE_FAILED");
    }

    const training = trainingResult.rows[0];
    const logResult = await client.query(
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
    $1::INTEGER,
    'EXPENSE',
    'TRAINING PILOTS',
    $2::BIGINT,
    FLOOR(
      EXTRACT(EPOCH FROM $3::TIMESTAMP) * 1000
    )::BIGINT,
    $4::TEXT,
    $5::TEXT,
    NOW()
  )
  RETURNING id
  `,
  [
    airlineId,
    quote.total_cost,
    quote.started_sim_at,
    `HR_TRAINING_PILOTS:${training.training_key}`,
    `Training Pilots — ${quote.training_type} — ` +
      `${quote.source_dept_name} to ${quote.target_dept_name} — ` +
      `${quantity} pilot${quantity === 1 ? "" : "s"}`
  ]
);

if (logResult.rowCount !== 1) {
  throw new Error("PILOT_TRAINING_FINANCE_LOG_FAILED");
}

const financeLogId = Number(logResult.rows[0].id);

await client.query(
  `
  UPDATE public.hr_pilot_training
  SET
    finance_log_id = $2::BIGINT,
    updated_at = NOW()
  WHERE training_id = $1::BIGINT
  `,
  [training.training_id, financeLogId]
);

const updatedFinance = await client.query(
  `
  UPDATE public.company_finance
  SET
    capital =
      COALESCE(capital, 0) - $2::BIGINT,

    expenses =
      COALESCE(expenses, 0) + $2::BIGINT,

    profit =
      COALESCE(profit, 0) - $2::BIGINT,

    cost_training_qualification =
      COALESCE(cost_training_qualification, 0) + $2::BIGINT,

    updated_at = NOW()
  WHERE airline_id = $1::INTEGER
  RETURNING
    capital,
    expenses,
    profit,
    cost_training_qualification
  `,
  [airlineId, quote.total_cost]
);

if (updatedFinance.rowCount !== 1) {
  throw new Error("TRAINING_FINANCE_UPDATE_FAILED");
}

    await client.query(
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
        'hr',
        'info',
        'PILOT TRAINING',
        $3,
        'hr_pilot_training',
        $4,
        $5::TIMESTAMP,
        NOW(),
        NOW()
      )
      ON CONFLICT (airline_id, alert_key)
        WHERE deleted_at IS NULL
      DO NOTHING
      `,
      [
        airlineId,
        `HR_PILOT_TRAINING_STARTED:${training.training_key}`,
        `${quantity} pilot${quantity === 1 ? "" : "s"} started ` +
          `${String(quote.training_type).toLowerCase()} training from ` +
          `${quote.source_dept_name} to ${quote.target_dept_name}.`,
        training.training_key,
        quote.started_sim_at
      ]
    );

    await client.query("COMMIT");

    return {
      ...training,
      finance_log_id: financeLogId,
      capital: Number(updatedFinance.rows[0].capital)
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
   ACS HR TRAINING — COMPLETE DUE PILOT TRAINING
   ------------------------------------------------------------
   • Uses the official simulation clock supplied by runtime
   • Moves staff only after the configured training duration
   • Recalculates payroll for both affected departments
   • Creates CREW TRAINING FINISHED exactly once
   ============================================================ */

async function completePilotTrainingById(
  trainingId,
  simTime
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const trainingResult = await client.query(
      `
      SELECT
        training_id,
        training_key,
        airline_id,
        training_type,
        source_dept_id,
        target_dept_id,
        quantity,
        completes_sim_at
      FROM public.hr_pilot_training
      WHERE training_id = $1::BIGINT
        AND status = 'ACTIVE'
        AND completes_sim_at <= $2::TIMESTAMP
      FOR UPDATE
      `,
      [trainingId, simTime]
    );

    if (trainingResult.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const training = trainingResult.rows[0];
    const airlineId = Number(training.airline_id);
    const quantity = Number(training.quantity);

    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [HR_TRAINING_LOCK_NAMESPACE, airlineId]
    );

    const departmentsResult = await client.query(
      `
      SELECT
        dept_id,
        dept_name,
        staff,
        salary
      FROM public.hr_departments
      WHERE airline_id = $1::INTEGER
        AND dept_id = ANY($2::TEXT[])
      ORDER BY dept_id
      FOR UPDATE
      `,
      [
        airlineId,
        [training.source_dept_id, training.target_dept_id]
      ]
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

    if (!source || !target) {
      throw new Error(
        `PILOT_TRAINING_DEPARTMENT_NOT_FOUND:${training.training_key}`
      );
    }

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
          WHEN dept_id = $2::TEXT
            THEN staff - $4::INTEGER
          WHEN dept_id = $3::TEXT
            THEN staff + $4::INTEGER
          ELSE staff
        END,

        payroll = ROUND(
          (
            CASE
              WHEN dept_id = $2::TEXT
                THEN staff - $4::INTEGER
              WHEN dept_id = $3::TEXT
                THEN staff + $4::INTEGER
              ELSE staff
            END
          )::NUMERIC * COALESCE(salary, 0)::NUMERIC
        )::BIGINT,

        updated_at = NOW()
      WHERE airline_id = $1::INTEGER
        AND dept_id = ANY($5::TEXT[])
      RETURNING dept_id, staff, payroll
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
      WHERE training_id = $1::BIGINT
        AND status = 'ACTIVE'
      RETURNING *
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
        $1::BIGINT,
        $2::TEXT,
        'hr',
        'info',
        'CREW TRAINING FINISHED',
        $3::TEXT,
        'hr_pilot_training',
        $4::TEXT,
        $5::TIMESTAMP,
        NOW(),
        NOW()
      )
      ON CONFLICT (airline_id, alert_key)
        WHERE deleted_at IS NULL
      DO NOTHING
      `,
      [
        airlineId,
        `HR_PILOT_TRAINING_FINISHED:${training.training_key}`,
        `${quantity} pilot${quantity === 1 ? "" : "s"} completed ` +
          `${String(training.training_type).toLowerCase()} training from ` +
          `${source.dept_name} to ${target.dept_name}.`,
        training.training_key,
        training.completes_sim_at
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

async function completeDuePilotTraining(
  simTime,
  batchSize
) {
  const dueResult = await pool.query(
    `
    SELECT training_id
    FROM public.hr_pilot_training
    WHERE status = 'ACTIVE'
      AND completes_sim_at <= $1::TIMESTAMP
    ORDER BY completes_sim_at, training_id
    LIMIT $2::INTEGER
    `,
    [simTime, batchSize]
  );

  let completedCount = 0;

  for (const row of dueResult.rows) {
    const completed = await completePilotTrainingById(
      row.training_id,
      simTime
    );

    if (completed) {
      completedCount += 1;
    }
  }

  return completedCount;
}

/* ============================================================
   ACS HR TRAINING — PERSONNEL CYCLE BOUNDARIES
   ------------------------------------------------------------
   • First cycle closes at the start of simulation day 16
   • Second cycle closes at the start of the following month
   • PostgreSQL calculates every crossed boundary
   ============================================================ */

async function getPersonnelTrainingBoundaries(
  previousSimTime,
  currentSimTime
) {
  const result = await pool.query(
    `
    WITH limits AS (
      SELECT
        COALESCE(
          $1::TIMESTAMP,
          DATE_TRUNC('month', $2::TIMESTAMP)
        ) AS previous_sim_time,
        $2::TIMESTAMP AS current_sim_time
    ),
    months AS (
      SELECT GENERATE_SERIES(
        DATE_TRUNC(
          'month',
          limits.previous_sim_time
        ),
        DATE_TRUNC(
          'month',
          limits.current_sim_time
        ),
        INTERVAL '1 month'
      )::TIMESTAMP AS month_start
      FROM limits
    ),
    boundaries AS (
      SELECT
        EXTRACT(
          YEAR FROM month_start
        )::INTEGER AS cycle_year,

        EXTRACT(
          MONTH FROM month_start
        )::INTEGER AS cycle_month,

        1::INTEGER AS cycle_half,
        month_start AS period_start_sim,

        month_start +
          INTERVAL '14 days'
            AS period_end_sim,

        month_start +
          INTERVAL '14 days'
            AS charged_sim_at

      FROM months

      UNION ALL

      SELECT
        EXTRACT(
          YEAR FROM month_start
        )::INTEGER,

        EXTRACT(
          MONTH FROM month_start
        )::INTEGER,

        2::INTEGER AS cycle_half,

        month_start +
          INTERVAL '15 days'
            AS period_start_sim,

        month_start +
          INTERVAL '1 month' -
          INTERVAL '1 day'
            AS period_end_sim,

        month_start +
          INTERVAL '1 month' -
          INTERVAL '1 day'
            AS charged_sim_at

      FROM months
    )
    SELECT
      boundaries.cycle_year,
      boundaries.cycle_month,
      boundaries.cycle_half,
      boundaries.period_start_sim,
      boundaries.period_end_sim,
      boundaries.charged_sim_at

    FROM boundaries
    CROSS JOIN limits

    WHERE boundaries.charged_sim_at >
          limits.previous_sim_time

      AND boundaries.charged_sim_at <=
          limits.current_sim_time

    ORDER BY
      boundaries.charged_sim_at,
      boundaries.cycle_half
    `,
    [
      previousSimTime || null,
      currentSimTime
    ]
  );

  return result.rows;
}

/* ============================================================
   ACS HR TRAINING — PERSONNEL TRAINING SETTLEMENT
   ------------------------------------------------------------
   • Charges every real HR department, including pilots
   • Uses historical salary, department rule and era factor
   • Never adds Training to Salaries / cost_hr
   • finance_log reference_uid guarantees cycle idempotency
   ============================================================ */

async function settlePersonnelTrainingBoundary(
  boundary,
  currentSimTime
) {
  const cycleYear = Number(boundary.cycle_year);
  const cycleMonth = Number(boundary.cycle_month);
  const cycleHalf = Number(boundary.cycle_half);
  const salaryHalf = cycleMonth <= 6 ? 1 : 2;
  const monthKey =
    `${cycleYear}-${String(cycleMonth).padStart(2, "0")}`;

  const airlinesResult = await pool.query(
    `
    SELECT DISTINCT department.airline_id
    FROM public.hr_departments AS department
    JOIN public.company_finance AS finance
      ON finance.airline_id = department.airline_id
    WHERE finance.current_sim_year = $1::INTEGER
      AND finance.current_sim_month = $2::INTEGER
    ORDER BY department.airline_id
    `,
    [cycleYear, cycleMonth]
  );

  let chargedAirlines = 0;
  let chargedTotal = 0;

  for (const airline of airlinesResult.rows) {
    const airlineId = Number(airline.airline_id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        "SELECT pg_advisory_xact_lock($1, $2)",
        [HR_TRAINING_LOCK_NAMESPACE, airlineId]
      );

      const financeResult = await client.query(
        `
        SELECT
          current_sim_year,
          current_sim_month
        FROM public.company_finance
        WHERE airline_id = $1::INTEGER
        FOR UPDATE
        `,
        [airlineId]
      );

      if (financeResult.rowCount !== 1) {
        throw new Error(
          `COMPANY_FINANCE_NOT_FOUND:${airlineId}`
        );
      }

      const finance = financeResult.rows[0];

      if (
        Number(finance.current_sim_year) !== cycleYear ||
        Number(finance.current_sim_month) !== cycleMonth
      ) {
        throw new Error(
          `HR_TRAINING_FINANCE_PERIOD_MISMATCH:` +
          `${airlineId}:${monthKey}`
        );
      }

      const policyResult = await client.query(
        `
        SELECT recurring_training_rate
        FROM public.hr_training_policy
        WHERE is_active = TRUE
        LIMIT 1
        `
      );

      if (policyResult.rowCount !== 1) {
        throw new Error(
          "ACTIVE_HR_TRAINING_POLICY_NOT_FOUND"
        );
      }

      const recurringTrainingRate = Number(
        policyResult.rows[0].recurring_training_rate
      );

      if (
        !Number.isFinite(recurringTrainingRate) ||
        recurringTrainingRate < 0
      ) {
        throw new Error(
          "INVALID_RECURRING_TRAINING_RATE"
        );
      }

      const calculationResult = await client.query(
        `
        SELECT
          department.dept_id,
          department.dept_name,
          GREATEST(
            COALESCE(department.staff, 0),
            0
          )::INTEGER AS staff_count,
          rule.salary_source,
          rule.recurring_training_factor,
          era.era_factor,
          CASE
            WHEN rule.salary_source =
                 'standard_two_crew_cost'
              THEN standard.standard_two_crew_cost
            ELSE standard.monthly_salary
          END::BIGINT AS historical_salary,

          CASE
            WHEN rule.salary_source IS NULL
              OR rule.recurring_training_factor IS NULL
              OR era.era_factor IS NULL
              OR CASE
                   WHEN rule.salary_source =
                        'standard_two_crew_cost'
                     THEN standard.standard_two_crew_cost
                   ELSE standard.monthly_salary
                 END IS NULL
              THEN NULL
            ELSE ROUND(
              GREATEST(
                COALESCE(department.staff, 0),
                0
              )::NUMERIC *
              (
                CASE
                  WHEN rule.salary_source =
                       'standard_two_crew_cost'
                    THEN standard.standard_two_crew_cost
                  ELSE standard.monthly_salary
                END
              )::NUMERIC *
              $4::NUMERIC *
              rule.recurring_training_factor::NUMERIC *
              era.era_factor::NUMERIC
            )::BIGINT
          END AS department_cost
        FROM public.hr_departments AS department
        LEFT JOIN public.hr_training_department_rules AS rule
          ON rule.dept_id = department.dept_id
        LEFT JOIN public.hr_salary_standards AS standard
          ON standard.dept_id = department.dept_id
         AND standard.cycle_year = $2::INTEGER
         AND standard.cycle_half = $3::INTEGER
        LEFT JOIN public.hr_training_era_rules AS era
          ON $2::INTEGER BETWEEN era.start_year AND era.end_year
        WHERE department.airline_id = $1::INTEGER
        ORDER BY department.dept_id
        `,
        [
          airlineId,
          cycleYear,
          salaryHalf,
          recurringTrainingRate
        ]
      );

      if (calculationResult.rowCount < 1) {
        throw new Error(
          `HR_TRAINING_DEPARTMENTS_NOT_FOUND:${airlineId}`
        );
      }

      const incompleteDepartment =
        calculationResult.rows.find(row => (
          !String(row.salary_source || "").trim() ||
          row.recurring_training_factor === null ||
          row.era_factor === null ||
          row.historical_salary === null
        ));

      if (incompleteDepartment) {
        throw new Error(
          `HR_TRAINING_RULE_NOT_FOUND:` +
          `${airlineId}:${incompleteDepartment.dept_id}`
        );
      }

      const totalCost = calculationResult.rows.reduce(
        (total, department) => {
          const departmentCost = Number(
            department.department_cost
          );

          if (!Number.isSafeInteger(departmentCost)) {
            throw new Error(
              `INVALID_HR_TRAINING_COST:` +
              `${airlineId}:${department.dept_id}`
            );
          }

          return total + departmentCost;
        },
        0
      );

      if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
        throw new Error(
          `INVALID_HR_TRAINING_TOTAL:${airlineId}:${monthKey}`
        );
      }

      if (totalCost === 0) {
        await client.query("COMMIT");
        continue;
      }

      const referenceUid =
        `HR_TRAINING_PERSONNEL:${airlineId}:` +
        `${monthKey}:H${cycleHalf}`;

      const logResult = await client.query(
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
          $1::INTEGER,
          'EXPENSE',
          'HR TRAINING PERSONNEL',
          $2::BIGINT,
          FLOOR(
            EXTRACT(EPOCH FROM $3::TIMESTAMP) * 1000
          )::BIGINT,
          $4::TEXT,
          $5::TEXT,
          NOW()
        )
        ON CONFLICT (reference_uid)
        DO NOTHING
        RETURNING id
        `,
        [
          airlineId,
          totalCost,
          boundary.charged_sim_at || currentSimTime,
          referenceUid,
          `HR Training Personnel — ${monthKey} H${cycleHalf}`
        ]
      );

      if (logResult.rowCount === 0) {
        await client.query("COMMIT");
        continue;
      }

      const updatedFinance = await client.query(
        `
        UPDATE public.company_finance
        SET
          capital =
            COALESCE(capital, 0) - $2::BIGINT,
          expenses =
            COALESCE(expenses, 0) + $2::BIGINT,
          profit =
            COALESCE(profit, 0) - $2::BIGINT,
          cost_training_qualification =
            COALESCE(
              cost_training_qualification,
              0
            ) + $2::BIGINT,
          updated_at = NOW()
        WHERE airline_id = $1::INTEGER
        RETURNING cost_training_qualification
        `,
        [airlineId, totalCost]
      );

      if (updatedFinance.rowCount !== 1) {
        throw new Error(
          `HR_TRAINING_FINANCE_UPDATE_FAILED:${airlineId}`
        );
      }

      await client.query("COMMIT");

      chargedAirlines += 1;
      chargedTotal += totalCost;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      throw error;
    } finally {
      client.release();
    }
  }

  return {
    chargedAirlines,
    chargedTotal
  };
}

/* ============================================================
   ACS HR TRAINING — RUNTIME AUTHORITY
   ------------------------------------------------------------
   • Completes due pilot training
   • Charges crossed personnel-training boundaries
   • Returns one canonical processed count to the supervisor
   ============================================================ */

async function ACS_runHRTrainingRuntime({
  job,
  simTime
} = {}) {
  let officialSimTime = simTime;

  if (!officialSimTime) {
    const clockResult = await pool.query(
      `
      SELECT acs_get_current_sim_time() AS sim_time
      `
    );

    officialSimTime = clockResult.rows[0]?.sim_time;
  }

  if (!officialSimTime) {
    throw new Error("HR_TRAINING_SIM_TIME_NOT_FOUND");
  }

  const batchSize = normalizeTrainingBatchSize(
    job?.config?.pilot_completion_batch_size ??
    job?.batch_size
  );

  const completedPilotTraining =
    await completeDuePilotTraining(
      officialSimTime,
      batchSize
    );

  const boundaries =
    await getPersonnelTrainingBoundaries(
      job?.last_cursor_sim_time || null,
      officialSimTime
    );

  let personnelCycles = 0;
  let personnelAirlines = 0;
  let personnelChargedTotal = 0;

  for (const boundary of boundaries) {
    const settlement =
      await settlePersonnelTrainingBoundary(
        boundary,
        officialSimTime
      );

    personnelCycles += 1;
    personnelAirlines += settlement.chargedAirlines;
    personnelChargedTotal += settlement.chargedTotal;
  }

  return {
    processedCount:
      completedPilotTraining + personnelAirlines,
    completedPilotTraining,
    personnelCycles,
    personnelAirlines,
    personnelChargedTotal
  };
}

/* ============================================================
   GET HR TRAINING STATUS
   ============================================================ */

router.get(
  "/hr/training/:airlineId",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const requestedAirlineId = Number(req.params.airlineId);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    if (requestedAirlineId !== airlineId) {
      return res.status(403).json({
        ok: false,
        error: "AIRLINE_ACCESS_DENIED"
      });
    }

    const client = await pool.connect();

    try {
      const departmentResult = await client.query(
        `
        WITH active_by_source AS (
          SELECT
            source_dept_id,
            SUM(quantity)::INTEGER AS active_quantity
          FROM public.hr_pilot_training
          WHERE airline_id = $1
            AND status = 'ACTIVE'
          GROUP BY source_dept_id
        )
        SELECT
          department.dept_id,
          department.dept_name,
          department.staff,
          department.required,
          GREATEST(
            department.staff - department.required,
            0
          )::INTEGER AS displayed_surplus,
          COALESCE(active.active_quantity, 0)::INTEGER
            AS active_training_quantity,
          GREATEST(
            department.staff - department.required -
            COALESCE(active.active_quantity, 0),
            0
          )::INTEGER AS transferable_quantity
        FROM public.hr_departments AS department
        LEFT JOIN active_by_source AS active
          ON active.source_dept_id = department.dept_id
        WHERE department.airline_id = $1
          AND department.dept_id = ANY($2::TEXT[])
        ORDER BY
          CASE department.dept_id
            WHEN 'pilots_small' THEN 1
            WHEN 'pilots_medium' THEN 2
            WHEN 'pilots_large' THEN 3
            WHEN 'pilots_vlarge' THEN 4
          END
        `,
        [airlineId, PILOT_DEPARTMENT_IDS]
      );

      const activeResult = await client.query(
        `
        SELECT
          training_id,
          training_key,
          training_type,
          source_dept_id,
          target_dept_id,
          quantity,
          cost_per_pilot,
          total_cost,
          started_sim_at,
          completes_sim_at,
          status
        FROM public.hr_pilot_training
        WHERE airline_id = $1
          AND status = 'ACTIVE'
        ORDER BY completes_sim_at, training_id
        `,
        [airlineId]
      );

      const policyResult = await client.query(
        `
        SELECT pilot_training_hours
        FROM public.hr_training_policy
        WHERE is_active = TRUE
        LIMIT 1
        `
      );

      if (policyResult.rowCount !== 1) {
        throw new Error("ACTIVE_HR_TRAINING_POLICY_NOT_FOUND");
      }

      return res.json({
        ok: true,
        training_hours: Number(
          policyResult.rows[0].pilot_training_hours
        ),
        pilot_departments: departmentResult.rows,
        active_training: activeResult.rows
      });
    } catch (error) {
      console.error("HR TRAINING FETCH ERROR:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   POST HR PILOT TRAINING QUOTE
   ============================================================ */

router.post(
  "/hr/training/pilots/quote",
  requireAuth,
  async (req, res) => {
    let request;

    try {
      request = readTrainingRequest(req);
    } catch (error) {
      return sendTrainingError(res, error);
    }

    const client = await pool.connect();

    try {
      const quote = await buildPilotTrainingQuote(
        client,
        request.airlineId,
        request.sourceDeptId,
        request.targetDeptId,
        request.quantity
      );

      return res.json({ ok: true, quote });
    } catch (error) {
      console.error("HR PILOT TRAINING QUOTE ERROR:", error);
      return sendTrainingError(res, error);
    } finally {
      client.release();
    }
  }
);

/* ============================================================
   POST HR PILOT TRAINING START
   ============================================================ */

router.post(
  "/hr/training/pilots/start",
  requireAuth,
  async (req, res) => {
    let request;

    try {
      request = readTrainingRequest(req);
    } catch (error) {
      return sendTrainingError(res, error);
    }

    try {
      const training = await startPilotTraining(
        request.airlineId,
        request.sourceDeptId,
        request.targetDeptId,
        request.quantity
      );

      return res.status(201).json({
        ok: true,
        training
      });
    } catch (error) {
      console.error("HR PILOT TRAINING START ERROR:", error);
      return sendTrainingError(res, error);
    }
  }
);

export {
  ACS_runHRTrainingRuntime,
  buildPilotTrainingQuote,
  completeDuePilotTraining,
  PILOT_DEPARTMENT_IDS,
  readTrainingRequest,
  sendTrainingError,
  startPilotTraining,
  trainingError
};

export default router;
