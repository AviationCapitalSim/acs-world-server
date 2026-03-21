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
      VALUES ($1, 700000)
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
   UPDATE / UPSERT COMPANY FINANCE
   ============================================================ */

router.patch("/finance/update", requireAuth, async (req,res)=>{
   
  const toInt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  };

  const toAirlineId = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  };

  const airline_id = req.airline_id;

  /* ============================================================
     🟦 CORE VALUES
  ============================================================ */

  const capital          = toInt(req.body.capital);
  const revenue          = toInt(req.body.revenue);
  const expenses         = toInt(req.body.expenses);

  // 🔥 BACKEND ES AUTORIDAD DE PROFIT
  const profit           = revenue - expenses;

  const live_revenue     = toInt(req.body.live_revenue);
  const weekly_revenue   = toInt(req.body.weekly_revenue);

  /* ============================================================
     🟦 COSTS (EXPANDED STRUCTURE)
  ============================================================ */

  const cost_fuel        = toInt(req.body.cost_fuel);
  const cost_maintenance = toInt(req.body.cost_maintenance);
  const cost_hr          = toInt(req.body.cost_hr);
  const cost_leasing     = toInt(req.body.cost_leasing);

  // 🆕 NUEVAS COLUMNAS
   
  const cost_handling    = toInt(req.body.cost_handling);
  const cost_slots       = toInt(req.body.cost_slots);
  const cost_navigation  = toInt(req.body.cost_navigation);
  const cost_overflight  = toInt(req.body.cost_overflight);

  // 🟡 LEGACY (mantener temporal)
   
  const cost_airport     =
    cost_handling +
    cost_slots +
    cost_navigation +
    cost_overflight;

  const cost_other       = toInt(req.body.cost_other);

  const debt             = toInt(req.body.debt);
  const fleet_size       = toInt(req.body.fleet_size);

  try{

    await pool.query(
      `
      INSERT INTO company_finance (
        airline_id,
        capital,
        revenue,
        expenses,
        profit,
        live_revenue,
        weekly_revenue,
        cost_fuel,
        cost_maintenance,
        cost_hr,
        cost_leasing,
        cost_handling,
        cost_slots,
        cost_navigation,
        cost_overflight,
        cost_airport,
        cost_other,
        debt,
        fleet_size,
        updated_at
      )
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,
        $12,$13,$14,$15,
        $16,$17,$18,$19,
        NOW()
      )
      ON CONFLICT (airline_id)
      DO UPDATE SET
        capital = EXCLUDED.capital,
        revenue = EXCLUDED.revenue,
        expenses = EXCLUDED.expenses,
        profit = EXCLUDED.profit,
        live_revenue = EXCLUDED.live_revenue,
        weekly_revenue = EXCLUDED.weekly_revenue,
        cost_fuel = EXCLUDED.cost_fuel,
        cost_maintenance = EXCLUDED.cost_maintenance,
        cost_hr = EXCLUDED.cost_hr,
        cost_leasing = EXCLUDED.cost_leasing,
        cost_handling = EXCLUDED.cost_handling,
        cost_slots = EXCLUDED.cost_slots,
        cost_navigation = EXCLUDED.cost_navigation,
        cost_overflight = EXCLUDED.cost_overflight,
        cost_airport = EXCLUDED.cost_airport,
        cost_other = EXCLUDED.cost_other,
        debt = EXCLUDED.debt,
        fleet_size = EXCLUDED.fleet_size,
        updated_at = NOW()
      `,
      [
        airline_id,
        capital,
        revenue,
        expenses,
        profit,
        live_revenue,
        weekly_revenue,
        cost_fuel,
        cost_maintenance,
        cost_hr,
        cost_leasing,
        cost_handling,
        cost_slots,
        cost_navigation,
        cost_overflight,
        cost_airport,
        cost_other,
        debt,
        fleet_size
      ]
    );

    res.json({ ok:true });

  }
  catch(err){

    console.error("FINANCE UPDATE ERROR",err);

    res.status(500).json({
      ok:false,
      error:err.message
    });

  }

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
      ORDER BY timestamp DESC
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

export default router;
