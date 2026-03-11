import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   CREATE AIRLINE
   ============================================================ */

router.post("/airlines/create", async (req, res) => {

  const {
    user_id,
    airline_name,
    airline_iata,
    airline_icao,
    country,
    region,
    business_model,
    operation_mode
  } = req.body;

  try {

    const insertResult = await pool.query(`
      INSERT INTO airlines
      (
        user_id,
        airline_name,
        iata,
        icao,
        country,
        region,
        business_model,
        operation_mode
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING airline_id
    `,
    [
      user_id,
      airline_name,
      airline_iata,
      airline_icao,
      country,
      region,
      business_model,
      operation_mode
    ]);

    const airlineId = insertResult.rows[0].airline_id;

    await pool.query(`
      UPDATE users
      SET airline_id = $1
      WHERE user_id = $2
    `,
    [String(airlineId), user_id]);

    res.json({
      ok: true,
      airline_id: airlineId
    });

  } catch (err) {

    console.error("CREATE AIRLINE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message || "CREATE_AIRLINE_FAILED"
    });

  }

});

export default router;
