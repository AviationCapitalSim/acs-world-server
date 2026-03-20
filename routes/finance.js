import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET COMPANY FINANCE
   ============================================================ */

router.get("/finance/:airlineId", async (req,res)=>{

  const airlineId = req.params.airlineId;

  try{

    const result = await pool.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    if(result.rows.length === 0){

      /* Crear cuenta financiera inicial */

      await pool.query(
        `
        INSERT INTO company_finance
        (airline_id,capital)
        VALUES($1,700000)
        `,
        [airlineId]
      );

      const fresh = await pool.query(
        `
        SELECT *
        FROM company_finance
        WHERE airline_id = $1
        `,
        [airlineId]
      );

      return res.json({
        ok:true,
        finance:fresh.rows[0]
      });

    }

    res.json({
      ok:true,
      finance:result.rows[0]
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

router.patch("/finance/update", async (req,res)=>{

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

  const airline_id = toAirlineId(req.body.airline_id);

  if (!airline_id) {
    return res.status(400).json({
      ok:false,
      error:"INVALID_AIRLINE_ID"
    });
  }

  const capital          = toInt(req.body.capital);
  const revenue          = toInt(req.body.revenue);
  const expenses         = toInt(req.body.expenses);
  const profit           = toInt(req.body.profit);
  const live_revenue     = toInt(req.body.live_revenue);
  const weekly_revenue   = toInt(req.body.weekly_revenue);
  const cost_fuel        = toInt(req.body.cost_fuel);
  const cost_maintenance = toInt(req.body.cost_maintenance);
  const cost_hr          = toInt(req.body.cost_hr);
  const cost_leasing     = toInt(req.body.cost_leasing);
  const cost_airport     = toInt(req.body.cost_airport);
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
        cost_airport,
        cost_other,
        debt,
        fleet_size,
        updated_at
      )
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()
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
        cost_airport,
        cost_other,
        debt,
        fleet_size
      ]
    );

    res.json({
      ok:true
    });

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

router.post("/finance/log", async (req,res)=>{

  const {
    airline_id,
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

router.get("/finance/log/:airlineId", async (req,res)=>{

  const airlineId = req.params.airlineId;

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

export default router;
