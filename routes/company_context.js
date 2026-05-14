/* ============================================================
   === ACS COMPANY CONTEXT — CANONICAL SESSION AUTH ============
   ------------------------------------------------------------
   File: routes/company_context.js
   Purpose:
   - Provide authenticated user/company context
   - Source of truth: acs_session → requireAuth → PostgreSQL
   - Returns user base_icao, airline_id, airline identity
   - NO frontend user_id trust
   - NO localStorage authority
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   GET /v1/company/context
   ------------------------------------------------------------
   Returns:
   - authenticated user
   - airline/company data
   - operational base_icao
   ============================================================ */

router.get("/company/context", requireAuth, async (req, res) => {

  try {

    const userId = req.user_id;
    const airlineId = req.airline_id;

    if (!userId || !airlineId) {
      return res.status(401).json({
        ok: false,
        error: "AUTH_CONTEXT_MISSING"
      });
    }

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
        ON a.airline_id = u.airline_id

      WHERE
        u.user_id = $1
        AND u.airline_id = $2

      LIMIT 1
    `, [
      userId,
      airlineId
    ]);

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "COMPANY_CONTEXT_NOT_FOUND"
      });
    }

    const row = result.rows[0];

    return res.json({
      ok: true,

      user: {
        user_id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        country: row.user_country,
        base_icao: row.base_icao,
        airline_id: row.airline_id
      },

      airline: {
        airline_id: row.airline_id,
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

    console.error("❌ COMPANY CONTEXT ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "COMPANY_CONTEXT_FAILED"
    });

  }

});

export default router;
