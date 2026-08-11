import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const toInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};

const cleanText = (v) => String(v || "").trim();

async function ACS_getCurrentSimTimestampMs(client) {
  const result = await client.query(`
    SELECT
      FLOOR(
        EXTRACT(EPOCH FROM acs_get_current_sim_time()) * 1000
      )::bigint AS sim_timestamp_ms
  `);

  return Number(result.rows[0]?.sim_timestamp_ms || 0);
}

/* ============================================================
   GET COMPANY FINANCE
   ============================================================ */

router.get("/finance", requireAuth, async (req, res) => {

  const airlineId = req.airline_id;
  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    const currentSimTimeMs =
      await ACS_getCurrentSimTimestampMs(client);

    const cutoffSimTimeMs =
      currentSimTimeMs - (15 * 24 * 60 * 60 * 1000);

    const financeResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    /*
     * Valor exclusivamente visual para Company Finance.
     * Mantiene visible durante el mes actual la depreciación
     * registrada en el último cierre mensual.
     */
    
    const depreciationDisplayResult = await client.query(
      `
      SELECT
        month_key,
        cost_depreciation,
        cost_insurance,
        cost_leasing,
        cost_taxes
      FROM public.finance_history
      WHERE airline_id = $1
        AND record_kind = 'MONTHLY_CLOSE'
      ORDER BY
        year DESC,
        month DESC,
        id DESC
      LIMIT 1
      `,
      [airlineId]
    );

    financeResult.rows[0].cost_depreciation_display =
      depreciationDisplayResult.rows.length
        ? Number(
            depreciationDisplayResult.rows[0]
              .cost_depreciation || 0
          )
        : Number(
            financeResult.rows[0]
              .cost_depreciation || 0
          );

    financeResult.rows[0].cost_insurance_display =
      depreciationDisplayResult.rows.length
        ? Number(
            depreciationDisplayResult.rows[0]
              .cost_insurance || 0
          )
        : Number(
            financeResult.rows[0]
              .cost_insurance || 0
          );

      financeResult.rows[0].cost_leasing_display =
      depreciationDisplayResult.rows.length
        ? Number(
            depreciationDisplayResult.rows[0]
              .cost_leasing || 0
          )
        : Number(
            financeResult.rows[0]
              .cost_leasing || 0
          );

    financeResult.rows[0].cost_taxes_display =
      depreciationDisplayResult.rows.length
        ? Number(
            depreciationDisplayResult.rows[0]
              .cost_taxes || 0
          )
        : Number(
            financeResult.rows[0]
              .cost_taxes || 0
          );
    
    const leasingResult = await client.query(
      `
      SELECT
        aircraft_name,
        manufacturer,
        model_key,
        monthly_payment,
        lease_start_date,
        lease_end_date,
        lease_years,
        status
      FROM aircraft_leasing_contracts
      WHERE airline_id = $1
      ORDER BY id
      `,
      [airlineId]
    );

    const bankLoansResult = await client.query(
      `
      SELECT
        id,
        loan_reference,
        status,
        collateral_mode,
        original_principal,
        remaining_principal,
        annual_interest_rate,
        term_months,
        monthly_payment,
        total_repayment,
        total_interest,
        opened_sim_time,
        maturity_sim_time,
        next_payment_sim_time,
        last_payment_sim_time,
        closed_sim_time,
        payment_number
      FROM bank_loans
      WHERE airline_id = $1
      ORDER BY id DESC
      `,
      [airlineId]
    );

    const activityResult = await client.query(
      `
      SELECT
        UPPER(TRIM(type)) AS type,
        COALESCE(NULLIF(TRIM(source), ''), 'UNKNOWN') AS source,
        COUNT(*)::INTEGER AS movement_count,
        SUM(amount)::BIGINT AS total_amount
      FROM finance_log
      WHERE airline_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
        AND NOT (
          type = 'INCOME'
          AND source LIKE 'FLIGHT %'
          AND POSITION('→' IN source) > 0
        )
      GROUP BY
        UPPER(TRIM(type)),
        COALESCE(NULLIF(TRIM(source), ''), 'UNKNOWN')
      ORDER BY
        UPPER(TRIM(type)),
        SUM(amount) DESC
      `,
      [
        airlineId,
        cutoffSimTimeMs,
        currentSimTimeMs
      ]
    );

    await client.query("COMMIT");

    res.set({
      "Cache-Control": "no-store, private",
      "Pragma": "no-cache",
      "Expires": "0"
    });

    return res.json({
      ok: true,
      authority: "RAILWAY_POSTGRESQL",
      current_sim_time_ms: currentSimTimeMs,
      finance: financeResult.rows[0],
      leasing_contracts: leasingResult.rows,
      bank_loans: bankLoansResult.rows,
      financial_activity: activityResult.rows
    });

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("FINANCE FETCH ERROR", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  } finally {

    client.release();

  }

});

/* ============================================================
   UPDATE COMPANY FINANCE â€” DEPRECATED / BLOCKED
   ============================================================ */

router.patch("/finance/update", requireAuth, async (req,res)=>{

  return res.status(410).json({
    ok: false,
    error: "FINANCE_UPDATE_DEPRECATED",
    message: "company_finance is OCC event-driven. Use canonical finance events."
  });

});

/* ============================================================
   ADD FINANCE LOG ENTRY â€” DEPRECATED / BLOCKED
   ============================================================ */

router.post("/finance/log", requireAuth, async (req,res)=>{

  return res.status(410).json({
    ok: false,
    error: "FINANCE_LOG_DIRECT_WRITE_DEPRECATED",
    message: "finance_log cannot be written directly. Use canonical OCC finance events."
  });

});

/* ============================================================
   GET FINANCE LOG HISTORY
   ============================================================ */

router.get("/finance/log", requireAuth, async (req, res) => {

  const airlineId = req.airline_id;

  try {

    const currentSimTime = await ACS_getCurrentSimTimestampMs(pool);
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
    const cutoffSimTime = currentSimTime - fifteenDaysMs;

    const result = await pool.query(
      `
      SELECT *
      FROM finance_log
      WHERE airline_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
      ORDER BY timestamp DESC, id DESC
      LIMIT 1000
      `,
      [
        airlineId,
        cutoffSimTime,
        currentSimTime
      ]
    );

    res.set({
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  "Pragma": "no-cache",
  "Expires": "0"
});

return res.json({
  ok: true,
  logs: result.rows
});

  } catch (err) {

    console.error("FINANCE LOG FETCH ERROR", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

/* ============================================================
   FINANCE â€” FLIGHT EVENT CANONICAL OCC
   ============================================================ */

router.post("/finance/flight-event", requireAuth, async (req,res)=>{

  const airline_id = req.airline_id;

  const revenue          = toInt(req.body?.revenue);
  const cost_fuel        = toInt(req.body?.cost_fuel);
  const cost_handling    = toInt(req.body?.cost_handling);
  const cost_slot        = toInt(req.body?.cost_slot);
  const cost_navigation  = toInt(req.body?.cost_navigation);
  const cost_overflight  = toInt(req.body?.cost_overflight);

  const route_plan_id    = req.body?.route_plan_id || null;
  const schedule_item_id = req.body?.schedule_item_id || null;

  const reference_uid = cleanText(req.body?.reference_uid);

  if (!reference_uid) {
    return res.status(400).json({
      ok: false,
      error: "REFERENCE_UID_REQUIRED"
    });
  }

  if (revenue < 0) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_REVENUE"
    });
  }

  const airportCost =
    cost_handling +
    cost_slot +
    cost_navigation +
    cost_overflight;

  const totalCost =
    cost_fuel +
    airportCost;

  const profit =
    revenue -
    totalCost;

  const incomeRef  = `FLIGHT:${reference_uid}:INCOME`;
  const expenseRef = `FLIGHT:${reference_uid}:EXPENSE`;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airline_id]
    );

    const currentSimTimestampMs =
    await ACS_getCurrentSimTimestampMs(client);
    
    const incomeLog = await client.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description
      )
      VALUES
      (
        $1,
        'INCOME',
        'FLIGHT_REVENUE',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
      ON CONFLICT (reference_uid)
      DO NOTHING
      RETURNING id
      `,
      [
        airline_id,
        revenue,
        currentSimTimestampMs,
        route_plan_id,
        schedule_item_id,
        incomeRef,
        "Flight revenue settled by ACS OCC"
      ]
    );

    const expenseLog = await client.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description
      )
      VALUES
      (
        $1,
        'EXPENSE',
        'FLIGHT_COST',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
      ON CONFLICT (reference_uid)
      DO NOTHING
      RETURNING id
      `,
      [
        airline_id,
        totalCost,
        currentSimTimestampMs,
        route_plan_id,
        schedule_item_id,
        expenseRef,
        "Flight costs settled by ACS OCC"
      ]
    );

    if (
      incomeLog.rows.length === 0 &&
      expenseLog.rows.length === 0
    ) {
      const snapshot = await client.query(
        `SELECT * FROM company_finance WHERE airline_id = $1`,
        [airline_id]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        already_settled: true,
        finance: snapshot.rows[0]
      });
    }

    if (
      incomeLog.rows.length !== 1 ||
      expenseLog.rows.length !== 1
    ) {
      throw new Error("PARTIAL_FLIGHT_EVENT_CONFLICT");
    }

    await client.query(
      `
      UPDATE company_finance
      SET
        revenue         = COALESCE(revenue,0) + $2,
        expenses        = COALESCE(expenses,0) + $3,
        profit          = COALESCE(profit,0) + $4,
        capital         = COALESCE(capital,0) + $4,

        live_revenue    = COALESCE(live_revenue,0) + $2,

        cost_fuel       = COALESCE(cost_fuel,0) + $5,
        cost_handling   = COALESCE(cost_handling,0) + $6,
        cost_slots      = COALESCE(cost_slots,0) + $7,
        cost_navigation = COALESCE(cost_navigation,0) + $8,
        cost_overflight = COALESCE(cost_overflight,0) + $9,
        cost_airport    = COALESCE(cost_airport,0) + $10,

        updated_at = NOW()
      WHERE airline_id = $1
      `,
      [
        airline_id,
        revenue,
        totalCost,
        profit,
        cost_fuel,
        cost_handling,
        cost_slot,
        cost_navigation,
        cost_overflight,
        airportCost
      ]
    );

    const snapshot = await client.query(
      `SELECT * FROM company_finance WHERE airline_id = $1`,
      [airline_id]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      applied: true,
      finance: snapshot.rows[0]
    });

  }
    
  catch(err){

    await client.query("ROLLBACK");

    console.error("FLIGHT EVENT ERROR",err);

    return res.status(500).json({
      ok:false,
      error:err.message
    });

  }
  finally {

    client.release();

  }

});

/* ============================================================
   FINANCE â€” HR DEPARTMENT BONUS CANONICAL OCC
   ============================================================ */

router.post("/finance/hr-bonus", requireAuth, async (req, res) => {

  const airline_id = req.airline_id;
  const dept_id = cleanText(req.body?.dept_id);
  const bonus_percent = toInt(req.body?.bonus_percent);

  if (!dept_id) {
    return res.status(400).json({ ok:false, error:"INVALID_DEPT_ID" });
  }

  if (![5,10,15,20,25].includes(bonus_percent)) {
    return res.status(400).json({ ok:false, error:"INVALID_BONUS_PERCENT" });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const simResult = await client.query(`
      SELECT
        EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
        EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month
    `);

    const simYear = Number(simResult.rows[0]?.sim_year);
    const simMonth = Number(simResult.rows[0]?.sim_month);
    const month_key = `${simYear}-${String(simMonth).padStart(2, "0")}`;

    const currentSimTimestampMs =
    await ACS_getCurrentSimTimestampMs(client);
    
    const reference_uid = `HR_BONUS:${airline_id}:${dept_id}:${month_key}`;

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airline_id]
    );

    const hrResult = await client.query(
      `
      SELECT dept_id, dept_name, staff, morale, salary, payroll
      FROM public.hr_departments
      WHERE airline_id = $1
        AND dept_id = $2
      FOR UPDATE
      `,
      [airline_id, dept_id]
    );

    if (hrResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok:false, error:"DEPARTMENT_NOT_FOUND" });
    }

    const dep = hrResult.rows[0];

    const staff = Number(dep.staff || 0);
    const salary = Number(dep.salary || 0);
    const oldMorale = Number(dep.morale || 100);

    if (staff <= 0 || salary <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok:false, error:"INVALID_BONUS_INPUT" });
    }

    const amount = Math.round(staff * salary * (bonus_percent / 100));

    const moraleGainMap = {
      5: 2,
      10: 4,
      15: 6,
      20: 8,
      25: 10
    };

    const moraleGain = moraleGainMap[bonus_percent] || 0;
    const newMorale = Math.min(100, oldMorale + moraleGain);

    const financeResult = await client.query(
      `
      SELECT capital
      FROM company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airline_id]
    );

    const capital = Number(financeResult.rows[0]?.capital || 0);

    if (capital < amount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok:false,
        error:"INSUFFICIENT_FUNDS",
        capital,
        required: amount
      });
    }

    const logResult = await client.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        reference_uid,
        description
      )
      VALUES
      (
        $1,
        'EXPENSE',
        'HR_DEPARTMENT_BONUS',
        $2,
        $3,
        $4,
        $5
      )
      ON CONFLICT (reference_uid)
      DO NOTHING
      RETURNING id
      `,
      [
        airline_id,
        amount,
        currentSimTimestampMs,
        reference_uid,
        `HR bonus ${bonus_percent}% for ${dep.dept_name} (${month_key})`
      ]
    );

    if (logResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok:false,
        error:"BONUS_ALREADY_APPLIED_THIS_MONTH",
        month_key
      });
    }

    await client.query(
      `
      UPDATE company_finance
      SET
        expenses = COALESCE(expenses,0) + $2,
        profit = COALESCE(profit,0) - $2,
        capital = COALESCE(capital,0) - $2,
        cost_hr = COALESCE(cost_hr,0) + $2,
        updated_at = NOW()
      WHERE airline_id = $1
      `,
      [airline_id, amount]
    );

    await client.query(
      `
      UPDATE public.hr_departments
      SET
        morale = $3,
        bonus = $4,
        updated_at = NOW()
      WHERE airline_id = $1
        AND dept_id = $2
      `,
      [airline_id, dept_id, newMorale, bonus_percent]
    );

    const financeSnapshot = await client.query(
      `SELECT * FROM company_finance WHERE airline_id = $1`,
      [airline_id]
    );

    await client.query("COMMIT");

    return res.json({
      ok:true,
      applied:true,
      dept_id,
      dept_name: dep.dept_name,
      month_key,
      bonus_percent,
      amount,
      old_morale: oldMorale,
      new_morale: newMorale,
      finance: financeSnapshot.rows[0]
    });

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("HR BONUS ERROR", err);

    return res.status(500).json({
      ok:false,
      error:err.message
    });

  } finally {

    client.release();

  }

});

/* ============================================================
   FINANCE â€” MONTHLY PAYROLL CANONICAL OCC
   ============================================================ */

router.post("/finance/payroll", requireAuth, async (req,res)=>{

  const airline_id = req.airline_id;

  const month_key = cleanText(req.body?.month_key);
  const amount    = toInt(req.body?.amount);

  if (!month_key || !/^\d{4}-\d{2}$/.test(month_key)) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_MONTH_KEY"
    });
  }

  if (amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_PAYROLL_AMOUNT"
    });
  }

  const reference_uid = `PAYROLL:${airline_id}:${month_key}`;
  const sourceKey = `HR_PAYROLL_${month_key}`;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airline_id]
    );

    const currentSimTimestampMs =
    await ACS_getCurrentSimTimestampMs(client); 
    
    const logResult = await client.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        reference_uid,
        description
      )
      VALUES
      (
        $1,
        'EXPENSE',
        $2,
        $3,
        $4,
        $5,
        $6
      )
      ON CONFLICT (reference_uid)
      DO NOTHING
      RETURNING id
      `,
      [
        airline_id,
        sourceKey,
        amount,
        currentSimTimestampMs,
        reference_uid,
        "Monthly payroll settled by ACS OCC"
      ]
    );

    if (logResult.rows.length === 0) {

      const snapshot = await client.query(
        `SELECT * FROM company_finance WHERE airline_id = $1`,
        [airline_id]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        already_applied: true,
        month_key,
        finance: snapshot.rows[0]
      });
    }

    await client.query(
      `
      UPDATE company_finance
      SET
        expenses   = COALESCE(expenses,0) + $2,
        profit     = COALESCE(profit,0) - $2,
        capital    = COALESCE(capital,0) - $2,
        cost_hr    = COALESCE(cost_hr,0) + $2,
        updated_at = NOW()
      WHERE airline_id = $1
      `,
      [airline_id, amount]
    );

    const snapshot = await client.query(
      `SELECT * FROM company_finance WHERE airline_id = $1`,
      [airline_id]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      applied: true,
      month_key,
      finance: snapshot.rows[0]
    });

  }
  catch(err){

    await client.query("ROLLBACK");

    console.error("MONTHLY PAYROLL ERROR", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  }
  finally {

    client.release();

  }

});

/* ============================================================
   GET FINANCE HISTORY — ACS POSTGRESQL AUTHORITY
   ------------------------------------------------------------
   Returns:
   - Available simulation years
   - Closed monthly records
   - Legacy cutover record
   - Current open month when applicable
   ============================================================ */

router.get(
  "/finance/history",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const requestedYear = Number(req.query?.year);

    if (
      !Number.isInteger(airlineId) ||
      airlineId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const client = await pool.connect();

    try {
      const clockResult = await client.query(
        `
        SELECT
          acs_get_current_sim_time() AS sim_time,
          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::integer AS sim_year,
          EXTRACT(
            MONTH FROM acs_get_current_sim_time()
          )::integer AS sim_month
        `
      );

      const simTime =
        clockResult.rows[0]?.sim_time;

      const simYear = Number(
        clockResult.rows[0]?.sim_year
      );

      const simMonth = Number(
        clockResult.rows[0]?.sim_month
      );

      const selectedYear =
        Number.isInteger(requestedYear) &&
        requestedYear >= 1900 &&
        requestedYear <= 2200
          ? requestedYear
          : simYear;

      const yearsResult = await client.query(
        `
        SELECT DISTINCT year
        FROM (
          SELECT
            history.year::integer AS year
          FROM public.finance_history history
          WHERE history.airline_id = $1
            AND history.year IS NOT NULL

          UNION

          SELECT $2::integer
        ) available_years
        ORDER BY year DESC
        `,
        [airlineId, simYear]
      );

      const historyResult = await client.query(
        `
        SELECT
          id,
          airline_id,
          year,
          month,
          month_key,

          record_kind,
          data_quality,

          opening_capital,
          closing_capital,
          capital,

          revenue,
          expenses,
          profit,
          debt,
          fleet_size,

          cost_fuel,
          cost_handling,
          cost_landing,
          cost_slots,
          cost_navigation,
          cost_overflight,
          cost_airport,
          cost_maintenance,
          cost_hr,
          cost_leasing,
          cost_loans,
          cost_other,
          cost_new_aircraft_purchase,
          cost_used_aircraft_purchase,

          flight_count,
          passenger_count,

          period_start_sim,
          period_end_sim,
          closed_by,
          metadata
        FROM public.finance_history
        WHERE airline_id = $1
          AND year = $2
        ORDER BY month, id
        `,
        [airlineId, selectedYear]
      );

      let openMonth = null;

      if (selectedYear === simYear) {
        const currentResult = await client.query(
          `
          SELECT
            airline_id,
            current_sim_year AS year,
            current_sim_month AS month,

            opening_capital,
            capital AS closing_capital,
            capital,

            revenue,
            expenses,
            profit,
            debt,
            fleet_size,

            cost_fuel,
            cost_handling,
            cost_landing,
            cost_slots,
            cost_navigation,
            cost_overflight,
            cost_airport,
            cost_maintenance,
            cost_hr,
            cost_leasing,
            cost_loans,
                        cost_other,
            cost_new_aircraft_purchase,
            cost_used_aircraft_purchase,

            current_activity.flight_count,
            current_activity.passenger_count

          FROM public.company_finance finance

          CROSS JOIN LATERAL (
            SELECT
              COUNT(*)::integer AS flight_count,

              COALESCE(
                SUM(
                  COALESCE(
                    occurrence.settled_passengers,
                    0
                  )
                ),
                0
              )::bigint AS passenger_count

            FROM public.flight_occurrences occurrence

            WHERE occurrence.airline_id =
                  finance.airline_id

              AND occurrence.settled_at IS NOT NULL

              AND occurrence.arrived_at >=
                  make_date(
                    finance.current_sim_year,
                    finance.current_sim_month,
                    1
                  )::timestamp

              AND occurrence.arrived_at <
                  (
                    make_date(
                      finance.current_sim_year,
                      finance.current_sim_month,
                      1
                    )
                    + INTERVAL '1 month'
                  )::timestamp
          ) current_activity

          WHERE finance.airline_id = $1
          LIMIT 1
          `,
          [airlineId]
        );

        if (currentResult.rows.length) {
          openMonth = {
            ...currentResult.rows[0],
            month_key:
              `${simYear}-${String(simMonth).padStart(2, "0")}`,
            record_kind: "OPEN_PERIOD",
            data_quality: "LIVE",
            period_start_sim:
              `${simYear}-${String(simMonth).padStart(2, "0")}-01`,
            period_end_sim: null,
            closed_by: null,
            metadata: {
              monthly_breakdown_available: true,
              open_period: true
            }
          };
        }
      }

      const annualRows = [
        ...historyResult.rows,
        ...(openMonth ? [openMonth] : [])
      ];

      const annualSummary = annualRows.reduce(
        (summary, row) => {
          summary.revenue += Number(
            row.revenue || 0
          );

          summary.expenses += Number(
            row.expenses || 0
          );

          summary.profit += Number(
            row.profit || 0
          );

          summary.flight_count += Number(
            row.flight_count || 0
          );

          summary.passenger_count += Number(
            row.passenger_count || 0
          );

          return summary;
        },
        {
          revenue: 0,
          expenses: 0,
          profit: 0,
          flight_count: 0,
          passenger_count: 0
        }
      );

      return res.json({
        ok: true,
        authority: "POSTGRESQL",
        sim_time: simTime,
        current_year: simYear,
        current_month: simMonth,
        selected_year: selectedYear,
        available_years:
          yearsResult.rows.map(
            row => Number(row.year)
          ),
        annual_summary: annualSummary,
        months: historyResult.rows,
        open_month: openMonth
      });
    } catch (error) {
      console.error(
        "FINANCE HISTORY FETCH ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "FINANCE_HISTORY_FETCH_FAILED",
        detail: error.message
      });
    } finally {
      client.release();
    }
  }
);

export default router;

