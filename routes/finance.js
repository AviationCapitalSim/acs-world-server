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
   UPDATE / UPSERT COMPANY FINANCE
   ============================================================ */

router.patch("/finance/update", async (req,res)=>{

  const {
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
  } = req.body;

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

    res.json({ok:true});

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

  try{

    const {
      airline_id,
      type,
      source,
      amount,
      timestamp
    } = req.body;

    if(!airline_id){
      return res.status(400).json({
        ok:false,
        error:"airline_id required"
      });
    }

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
        type || "UNKNOWN",
        source || "SYSTEM",
        Number(amount) || 0,
        timestamp || new Date().toISOString()
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

export default router;
