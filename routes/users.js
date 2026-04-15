/* ============================================================
   === ACS USERS ROUTES — PROFILE ==============================
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET USER PROFILE (DASHBOARD)
   ============================================================ */

router.get("/users/profile/:userId", async (req, res) => {

  try {

    const { userId } = req.params;

    console.log("[ACS PROFILE] Request for user:", userId);

    /* ================= USER ================= */

    const userResult = await pool.query(`
      SELECT user_id, email, airline_id, base_icao, base_city, base_country
      FROM users
      WHERE user_id = $1
      LIMIT 1
    `, [userId]);

    if (!userResult.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "USER_NOT_FOUND"
      });
    }

    const user = userResult.rows[0];

    /* ================= AIRLINE ================= */

    let airline = {};

    if (user.airline_id) {

      const airlineResult = await pool.query(`
        SELECT airline_id, airline_name, country, rank
        FROM airlines
        WHERE airline_id = $1
        LIMIT 1
      `, [user.airline_id]);

      if (airlineResult.rows.length) {
        airline = airlineResult.rows[0];
      }
    }

    /* ================= RESPONSE ================= */

    return res.json({
      status: "success",
      user,
      airline
    });

  } catch (err) {

    console.error("[ACS PROFILE ERROR]", err);

    return res.status(500).json({
      status: "error",
      message: "PROFILE_FETCH_FAILED"
    });
  }

});

export default router;
