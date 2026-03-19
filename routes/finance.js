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
        VALUES($1,5000000)
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
   APPLY FINANCE DELTA (CANONICAL · EVENT-DRIVEN)
   ============================================================ */

router.patch("/finance/update", async (req,res)=>{

  const toInt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  };

  const airline_id = Number(req.body.airline_id);

  if (!Number.isInteger(airline_id) || airline_id <= 0) {
    return res.status(400).json({
      ok:false,
      error:"INVALID_AIRLINE_ID"
    });
  }

  /* ============================================================
     DELTA VALUES (PER EVENT, NOT SNAPSHOT)
     ============================================================ */

  const delta = {
    capital:          toInt(req.body.capital),
    revenue:          toInt(req.body.revenue),
    expenses:         toInt(req.body.expenses),
    profit:           toInt(req.body.profit),
    live_revenue:     toInt(req.body.live_revenue),
    weekly_revenue:   toInt(req.body.weekly_revenue),
    cost_fuel:        toInt(req.body.cost_fuel),
    cost_maintenance: toInt(req.body.cost_maintenance),
    cost_hr:          toInt(req.body.cost_hr),
    cost_leasing:     toInt(req.body.cost_leasing),
    cost_airport:     toInt(req.body.cost_airport),
    cost_other:       toInt(req.body.cost_other),
    debt:             toInt(req.body.debt),
    fleet_size:       toInt(req.body.fleet_size)
  };

  try{

    await pool.query("BEGIN");

    /* ============================================================
       ENSURE ROW EXISTS
       ============================================================ */

    await pool.query(
      `
      INSERT INTO company_finance (airline_id)
      VALUES($1)
      ON CONFLICT (airline_id) DO NOTHING
      `,
      [airline_id]
    );

    /* ============================================================
       APPLY DELTA (ATOMIC)
       ============================================================ */

    await pool.query(
      `
      UPDATE company_finance
      SET
        capital          = COALESCE(capital,0) + $2,
        revenue          = COALESCE(revenue,0) + $3,
        expenses         = COALESCE(expenses,0) + $4,
        profit           = COALESCE(profit,0) + $5,
        live_revenue     = COALESCE(live_revenue,0) + $6,
        weekly_revenue   = COALESCE(weekly_revenue,0) + $7,
        cost_fuel        = COALESCE(cost_fuel,0) + $8,
        cost_maintenance = COALESCE(cost_maintenance,0) + $9,
        cost_hr          = COALESCE(cost_hr,0) + $10,
        cost_leasing     = COALESCE(cost_leasing,0) + $11,
        cost_airport     = COALESCE(cost_airport,0) + $12,
        cost_other       = COALESCE(cost_other,0) + $13,
        debt             = COALESCE(debt,0) + $14,
        fleet_size       = GREATEST(COALESCE(fleet_size,0), $15),
        updated_at       = NOW()
      WHERE airline_id = $1
      `,
      [
        airline_id,
        delta.capital,
        delta.revenue,
        delta.expenses,
        delta.profit,
        delta.live_revenue,
        delta.weekly_revenue,
        delta.cost_fuel,
        delta.cost_maintenance,
        delta.cost_hr,
        delta.cost_leasing,
        delta.cost_airport,
        delta.cost_other,
        delta.debt,
        delta.fleet_size
      ]
    );

    await pool.query("COMMIT");

    res.json({ ok:true });

  }
  catch(err){

    await pool.query("ROLLBACK");

    console.error("FINANCE DELTA ERROR",err);

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
   GET FINANCE LOG (CANONICAL LEDGER)
   ============================================================ */

router.get("/finance/log/:airlineId", async (req,res)=>{

  const airlineId = Number(req.params.airlineId);

  if(!Number.isInteger(airlineId)){
    return res.status(400).json({
      ok:false,
      error:"INVALID_AIRLINE_ID"
    });
  }

  try{

    const result = await pool.query(
  `
  SELECT
    id,
    airline_id,
    type,
    source,
    CAST(amount AS BIGINT) AS amount,
    CAST(timestamp AS BIGINT) AS timestamp
  FROM finance_log
  WHERE airline_id = $1
    AND timestamp IS NOT NULL
  ORDER BY timestamp DESC
  LIMIT 100
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
