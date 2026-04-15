/* ============================================================
   === ACS USERS PROFILE — CANONICAL (JOIN MODE) ===============
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

router.get("/users/profile/:userId", async (req, res) => {

  try {

    const { userId } = req.params;

    console.log("[ACS PROFILE] Request:", userId);

    const result = await pool.query(`
      SELECT 
        u.user_id,
        u.full_name,
        u.email,
        u.country AS user_country,
        u.base_icao,
        u.airline_id,

        a.airline_name,
        a.country AS airline_country,
        a.iata,
        a.icao,
        a.region,
        a.business_model,
        a.operation_mode

      FROM users u
      LEFT JOIN airlines a
        ON a.user_id = u.user_id

      WHERE u.user_id = $1
      LIMIT 1
    `, [userId]);

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "USER_NOT_FOUND"
      });
    }

    const row = result.rows[0];

    return res.json({
      status: "success",
      user: {
        user_id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        country: row.user_country,
        base_icao: row.base_icao,
        airline_id: row.airline_id
      },
      airline: {
        airline_name: row.airline_name,
        country: row.airline_country,
        iata: row.iata,
        icao: row.icao,
        region: row.region,
        business_model: row.business_model,
        operation_mode: row.operation_mode
      }
    });

  } catch (err) {

    console.error("❌ PROFILE ERROR:", err);

    return res.status(500).json({
      status: "error",
      message: "PROFILE_FETCH_FAILED"
    });
  }

});

export default router;
