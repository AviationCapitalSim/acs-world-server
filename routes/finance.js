import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ACS_settleFlight } from "./flight_settlement.js";

const router = express.Router();

const toInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};

const cleanText = (v) => String(v || "").trim();

/* ============================================================
   GET COMPANY FINANCE
   ============================================================ */

router.get("/finance", requireAuth, async (req,res)=>{

  const airlineId = req.airline_id;

  try{

    await pool.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    const result = await pool.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    const leasing = await pool.query(
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
WHERE airline_id=$1
ORDER BY id
`,
[airlineId]
);
    
    return res.json({
  ok: true,
  finance: result.rows[0],
  leasing_contracts: leasing.rows
  });

  }
    
  catch(err){

    console.error("FINANCE FETCH ERROR",err);

    return res.status(500).json({
      ok:false,
      error:err.message
    });

  }

});

/* ============================================================
   UPDATE COMPANY FINANCE — DEPRECATED / BLOCKED
   ============================================================ */

router.patch("/finance/update", requireAuth, async (req,res)=>{

  return res.status(410).json({
    ok: false,
    error: "FINANCE_UPDATE_DEPRECATED",
    message: "company_finance is OCC event-driven. Use canonical finance events."
  });

});

/* ============================================================
   ADD FINANCE LOG ENTRY — DEPRECATED / BLOCKED
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

router.get("/finance/log", requireAuth, async (req,res)=>{

  const airlineId = req.airline_id;

  try{

    const result = await pool.query(
      `
      SELECT *
      FROM finance_log
      WHERE airline_id = $1
      ORDER BY id DESC
      LIMIT 50
      `,
      [airlineId]
    );

    return res.json({
      ok:true,
      logs: result.rows
    });

  }
  catch(err){

    console.error("FINANCE LOG FETCH ERROR",err);

    return res.status(500).json({
      ok:false,
      error:err.message
    });

  }

});

/* ============================================================
   FINANCE — FLIGHT EVENT CANONICAL OCC
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
        Date.now(),
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
        Date.now(),
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
   FINANCE — HR DEPARTMENT BONUS CANONICAL OCC
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
        Date.now(),
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
   FINANCE — MONTHLY PAYROLL CANONICAL OCC
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
        Date.now(),
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

router.post("/finance/flight-settlement", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const scheduleItemId = Number(req.body?.schedule_item_id);

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!scheduleItemId || !Number.isInteger(scheduleItemId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SCHEDULE_ITEM_ID"
      });
    }

    await client.query("BEGIN");

    const settlement = await ACS_settleFlight(
      client,
      airlineId,
      scheduleItemId
    );

    if (!settlement.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json(settlement);
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_FLIGHT_SETTLEMENT",
      settlement
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS FLIGHT SETTLEMENT ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FLIGHT_SETTLEMENT_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

export default router;
