import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   ACS COMPANY SETTINGS ROUTES
   ------------------------------------------------------------
   • Backend authority for company automation settings
   • Replaces localStorage authority for:
     - Auto Hire
     - Auto Salary
     - Manual Salary Override
   • Uses secure session airline_id from requireAuth
   ============================================================ */

/* ============================================================
   ENSURE COMPANY SETTINGS EXISTS
   ============================================================ */

async function ensureCompanySettings(airlineId) {

  const result = await pool.query(
    `
    INSERT INTO company_settings
      (airline_id, auto_hire, auto_salary, manual_salary_override)
    VALUES
      ($1, true, true, false)
    ON CONFLICT (airline_id)
    DO UPDATE SET
      airline_id = EXCLUDED.airline_id
    RETURNING
      airline_id,
      auto_hire,
      auto_salary,
      manual_salary_override,
      created_at,
      updated_at
    `,
    [airlineId]
  );

  return result.rows[0];

}

/* ============================================================
   GET COMPANY SETTINGS
   ------------------------------------------------------------
   GET /v1/company/settings
   ============================================================ */

router.get("/company/settings", requireAuth, async (req, res) => {

  try {

    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    const settings = await ensureCompanySettings(airlineId);

    return res.json({
      ok: true,
      settings: {
        airline_id: settings.airline_id,
        auto_hire: settings.auto_hire,
        auto_salary: settings.auto_salary,
        manual_salary_override: settings.manual_salary_override,
        created_at: settings.created_at,
        updated_at: settings.updated_at
      }
    });

  } catch (err) {

    console.error("COMPANY SETTINGS GET ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

/* ============================================================
   PATCH COMPANY SETTINGS
   ------------------------------------------------------------
   PATCH /v1/company/settings
   ============================================================ */

router.patch("/company/settings", requireAuth, async (req, res) => {

  try {

    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    await ensureCompanySettings(airlineId);

    const {
      auto_hire,
      auto_salary,
      manual_salary_override
    } = req.body || {};

    const result = await pool.query(
      `
      UPDATE company_settings
      SET
        auto_hire = COALESCE($2, auto_hire),
        auto_salary = COALESCE($3, auto_salary),
        manual_salary_override = COALESCE($4, manual_salary_override),
        updated_at = NOW()
      WHERE airline_id = $1
      RETURNING
        airline_id,
        auto_hire,
        auto_salary,
        manual_salary_override,
        created_at,
        updated_at
      `,
      [
        airlineId,
        typeof auto_hire === "boolean" ? auto_hire : null,
        typeof auto_salary === "boolean" ? auto_salary : null,
        typeof manual_salary_override === "boolean" ? manual_salary_override : null
      ]
    );

    return res.json({
      ok: true,
      settings: result.rows[0]
    });

  } catch (err) {

    console.error("COMPANY SETTINGS PATCH ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

export default router;
