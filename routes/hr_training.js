/* ============================================================
   ACS HR TRAINING — PILOT QUALIFICATION AUTHORITY
   Status, quote and training start
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ACS_ensureFinancePeriod } from "./finance_core.js";

const router = express.Router();

const HR_TRAINING_LOCK_NAMESPACE = 1095783254;

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
    const error = new Error("TRAINING_CATEGORY_MUST_CHANGE");
    error.code = "TRAINING_CATEGORY_MUST_CHANGE";
    error.httpStatus = 400;
    throw error;
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
    SELECT
      dept_id,
      dept_name,
      staff,
      required
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
    SELECT
      COALESCE(SUM(quantity), 0)::INTEGER AS active_quantity
    FROM public.hr_pilot_training
    WHERE airline_id = $1
      AND source_dept_id = $2
      AND status = 'ACTIVE'
    `,
    [airlineId, sourceDeptId]
  );

  const sourceStaff = Number(source.staff || 0);
  const sourceRequired = Number(source.required || 0);
  const displayedSurplus = Math.max(
    0,
    sourceStaff - sourceRequired
  );
  const activeQuantity = Number(
    activeResult.rows[0]?.active_quantity || 0
  );
  const transferableQuantity = Math.max(
    0,
    displayedSurplus - activeQuantity
  );

  if (quantity > transferableQuantity) {
    throw trainingError(
      "QUANTITY_EXCEEDS_HR_SURPLUS",
      409,
      {
        displayed_surplus: displayedSurplus,
        active_training_quantity: activeQuantity,
        transferable_quantity: transferableQuantity
      }
    );
  }

  const priceResult = await client.query(
    `
    SELECT
      standard.standard_two_crew_cost::BIGINT
        AS historical_salary,
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
    throw trainingError(
      "TRAINING_COST_STANDARD_NOT_FOUND",
      409
    );
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

    await ACS_ensureFinancePeriod(
      client,
      airlineId
    );

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
      throw trainingError(
        "COMPANY_FINANCE_NOT_FOUND",
        404
      );
    }

    const availableCapital = Number(
      financeResult.rows[0].capital || 0
    );

    if (availableCapital < quote.total_cost) {
      throw trainingError(
        "INSUFFICIENT_CAPITAL",
        409,
        {
          available_capital: availableCapital,
          required_capital: quote.total_cost
        }
      );
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
        'HRPT:' || $1::TEXT || ':' ||
          next_training.training_id::TEXT,
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
        $11,
        $12,
        $13::TIMESTAMP,
        $13::TIMESTAMP +
          ($14::INTEGER * INTERVAL '1 hour'),
        'ACTIVE'
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
        $1,
        'EXPENSE',
        'HR_TRAINING_QUALIFICATION',
        $2,
        FLOOR(
          EXTRACT(EPOCH FROM $3::TIMESTAMP) * 1000
        )::BIGINT,
        $4,
        $5,
        NOW()
      )
      RETURNING id
      `,
      [
        airlineId,
        quote.total_cost,
        quote.started_sim_at,
        `HR_TRAINING_QUALIFICATION:${training.training_key}`,
        `Pilot ${quote.training_type}: ` +
          `${quote.source_dept_name} to ` +
          `${quote.target_dept_name} — ` +
          `${quantity} pilot${quantity === 1 ? "" : "s"}`
      ]
    );

    const financeLogId = Number(
      logResult.rows[0].id
    );

    await client.query(
      `
      UPDATE public.hr_pilot_training
      SET
        finance_log_id = $2,
        updated_at = NOW()
      WHERE training_id = $1
      `,
      [training.training_id, financeLogId]
    );

    const updatedFinance = await client.query(
      `
      UPDATE public.company_finance
      SET
        capital = COALESCE(capital, 0) - $2,
        expenses = COALESCE(expenses, 0) + $2,
        profit = COALESCE(profit, 0) - $2,
        cost_hr = COALESCE(cost_hr, 0) + $2,
        cost_training_qualification =
          COALESCE(
            cost_training_qualification,
            0
          ) + $2,
        updated_at = NOW()
      WHERE airline_id = $1
      RETURNING capital
      `,
      [airlineId, quote.total_cost]
    );

    if (updatedFinance.rowCount !== 1) {
      throw new Error(
        "TRAINING_FINANCE_UPDATE_FAILED"
      );
    }

    await client.query("COMMIT");

    return {
      ...training,
      finance_log_id: financeLogId,
      capital: Number(
        updatedFinance.rows[0].capital
      )
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

      return res.json({
        ok: true,
        quote
      });
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
      console.error(
        "HR PILOT TRAINING START ERROR:",
        error
      );

      return sendTrainingError(res, error);
    }
  }
);

export {
  buildPilotTrainingQuote,
  PILOT_DEPARTMENT_IDS,
  readTrainingRequest,
  sendTrainingError,
  trainingError
};

export default router;
