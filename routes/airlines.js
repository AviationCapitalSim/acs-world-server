import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   CREATE AIRLINE
============================================================ */

router.post("/airlines/create", async (req, res) => {

  const body = req.body;
  const userUUID = body.user_id;

  try {

    const insertAirline = await pool.query(
      `
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
        userUUID,
        body.airline_name,
        body.airline_iata,
        body.airline_icao,
        body.country,
        body.region,
        body.business_model,
        body.operation_mode
      ]
    );

    const airlineId = insertAirline.rows[0].airline_id;

    console.log("DEBUG CREATE AIRLINE", {
      airlineId,
      userUUID
    });

    await pool.query(
      `
      UPDATE users
      SET airline_id = $1
      WHERE user_id = $2
      `,
      [
        airlineId,
        userUUID
      ]
    );

    res.json({
      ok: true,
      airline_id: airlineId
    });

  } catch (err) {

    console.error("CREATE AIRLINE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

export default router;
