import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   GET COMPANY FINANCE
   ============================================================ */

router.get("/finance", requireAuth, async (req,res)=>{

  const airlineId = req.airline_id;

  try{

    /* ✅ STEP 1 — ENSURE ROW EXISTS (ATÓMICO) */

    await pool.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 1500000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    /* ✅ STEP 2 — FETCH REAL STATE */

    const result = await pool.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    return res.json({
      ok:true,
      finance: result.rows[0]
    });

  }
  catch(err){

    console.error("FINANCE FETCH ERROR",err);

    res.status(500).json({
      ok:false,
      error:err.message
    });

  }

});

/* ============================================================
   UPDATE COMPANY FINANCE — DEPRECATED / BLOCKED
   ------------------------------------------------------------
   ACS OCC RULE:
   company_finance cannot be overwritten from frontend.
   Finance is event-driven only.
   ============================================================ */

router.patch("/finance/update", requireAuth, async (req,res)=>{

  return res.status(410).json({
    ok: false,
    error: "FINANCE_UPDATE_DEPRECATED",
    message: "company_finance is OCC event-driven. Use canonical finance events."
  });

});
   
/* ============================================================
   ADD FINANCE LOG ENTRY
   ============================================================ */

router.post("/finance/log", requireAuth, async (req,res)=>{

  const airline_id = req.airline_id;

const {
  type,
  source,
  amount,
  timestamp
} = req.body;

  try{

    await pool.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES($1,$2,$3,$4,$5)
      `,
      [
        airline_id,
        type,
        source,
        amount,
        timestamp
      ]
    );

    res.json({ok:true});

  }
  catch(err){

    console.error("FINANCE LOG ERROR",err);

    res.status(500).json({
      ok:false,
      error:err.message
    });

  }

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

    res.json({
      ok:true,
      logs: result.rows
    });

  }
  catch(err){

    console.error("FINANCE LOG FETCH ERROR",err);

    res.status(500).json({
      ok:false,
      error:err.message
    });

  }

});

/* ============================================================
   ✈️ FINANCE — FLIGHT EVENT (CANONICAL OCC ENGINE) ✅ FIXED
   ============================================================ */

router.post("/finance/flight-event", requireAuth, async (req,res)=>{

const {
  revenue,
  cost_fuel,
  cost_handling,
  cost_slot,
  cost_navigation,
  cost_overflight
} = req.body;

const airline_id = req.airline_id;

  try{

    /* ============================================================
       🔒 FORCE INTEGER (CRITICAL FIX)
       ============================================================ */

    const toInt = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.round(n);
    };

    const airlineId = toInt(airline_id);

    const r           = toInt(revenue);
    const fuel        = toInt(cost_fuel);
    const handling    = toInt(cost_handling);
    const slot        = toInt(cost_slot);
    const navigation  = toInt(cost_navigation);
    const overflight  = toInt(cost_overflight);

    const airport   = handling + slot + navigation + overflight;
    const totalCost = fuel + airport;
    const profit    = r - totalCost;

    /* ============================================================
       📊 LOG (AGREGADO)
       ============================================================ */

    await pool.query(`
      INSERT INTO finance_log
      (airline_id, type, source, amount, timestamp)
      VALUES($1,'INCOME','FLIGHT',$2,$3)
    `,[
      airlineId,
      r,
      Date.now()
    ]);

    /* ============================================================
       🏦 UPDATE COMPANY FINANCE
       ============================================================ */

    await pool.query(`
      UPDATE company_finance
      SET
        revenue        = COALESCE(revenue,0) + $2,
        expenses       = COALESCE(expenses,0) + $3,
        profit         = COALESCE(profit,0) + $4,
        capital        = COALESCE(capital,0) + $4,

        live_revenue   = COALESCE(live_revenue,0) + $2,

        cost_fuel      = COALESCE(cost_fuel,0) + $5,

        cost_handling  = COALESCE(cost_handling,0) + $6,
        cost_slots     = COALESCE(cost_slots,0) + $7,
        cost_navigation= COALESCE(cost_navigation,0) + $8,
        cost_overflight= COALESCE(cost_overflight,0) + $9,

        cost_airport   = COALESCE(cost_airport,0) + $10,

        updated_at = NOW()

      WHERE airline_id = $1
    `,[
      airlineId,
      r,
      totalCost,
      profit,
      fuel,
      handling,
      slot,
      navigation,
      overflight,
      airport
    ]);

    /* ============================================================
       📥 RETURN SNAPSHOT
       ============================================================ */

    const result = await pool.query(
      `SELECT * FROM company_finance WHERE airline_id = $1`,
      [airlineId]
    );

    res.json({
      ok:true,
      finance: result.rows[0]
    });

  }
  catch(err){

    console.error("FLIGHT EVENT ERROR",err);

    res.status(500).json({
      ok:false,
      error:err.message
    });

  }

});

/* ============================================================
   💰 FINANCE — MONTHLY PAYROLL EVENT (BACKEND AUTHORITY)
   ------------------------------------------------------------
   • Ejecuta payroll mensual UNA sola vez por month_key
   • Backend = autoridad de capital
   • Idempotencia por airline_id + month_key
   ============================================================ */

router.post("/finance/payroll", requireAuth, async (req,res)=>{

  const airline_id = req.airline_id;

  const toInt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  };

  const month_key = String(req.body?.month_key || "").trim();
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

  const sourceKey = `HR_PAYROLL_${month_key}`;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    /* ============================================================
       1) ENSURE COMPANY FINANCE ROW EXISTS
       ============================================================ */

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 700000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airline_id]
    );

    /* ============================================================
       2) IDEMPOTENCY CHECK
       Una sola aplicación por mes
       ============================================================ */

    const existingLog = await client.query(
      `
      SELECT id
      FROM finance_log
      WHERE airline_id = $1
        AND type = 'EXPENSE'
        AND source = $2
      LIMIT 1
      `,
      [airline_id, sourceKey]
    );

    if (existingLog.rows.length > 0) {

      const snapshot = await client.query(
        `
        SELECT *
        FROM company_finance
        WHERE airline_id = $1
        `,
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

    /* ============================================================
       3) APPLY MONTHLY PAYROLL TO LEDGER
       ============================================================ */

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

    /* ============================================================
       4) LOG EVENT
       ============================================================ */

    await client.query(
      `
      INSERT INTO finance_log
      (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES ($1, 'EXPENSE', $2, $3, $4)
      `,
      [
        airline_id,
        sourceKey,
        amount,
        Date.now()
      ]
    );

    /* ============================================================
       5) RETURN UPDATED SNAPSHOT
       ============================================================ */

    const snapshot = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
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

export default router;
