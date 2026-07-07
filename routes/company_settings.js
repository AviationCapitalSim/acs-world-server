import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   ACS COMPANY SETTINGS ROUTES
   ------------------------------------------------------------
   Backend authority for airline automation settings.

   Controls:
   - Auto Hire
   - Auto Salary
   - Manual Salary Override
   - Auto C Check
   - Auto D Check

   No localStorage authority.
   Uses secure session airline_id from requireAuth.
   ============================================================ */

async function ensureCompanySettings(airlineId) {
  const result = await pool.query(
    `
    INSERT INTO public.company_settings (
      airline_id,
      auto_hire,
      auto_salary,
      manual_salary_override,
      auto_c_check,
      auto_d_check
    )
    VALUES (
      $1,
      true,
      true,
      false,
      false,
      false
    )
    ON CONFLICT (airline_id)
    DO UPDATE SET
      airline_id = EXCLUDED.airline_id
    RETURNING
      airline_id,
      auto_hire,
      auto_salary,
      manual_salary_override,
      auto_c_check,
      auto_d_check,
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
        auto_c_check: settings.auto_c_check,
        auto_d_check: settings.auto_d_check,
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
      manual_salary_override,
      auto_c_check,
      auto_d_check
    } = req.body || {};

    const result = await pool.query(
      `
      UPDATE public.company_settings
      SET
        auto_hire = COALESCE($2, auto_hire),
        auto_salary = COALESCE($3, auto_salary),
        manual_salary_override = COALESCE($4, manual_salary_override),
        auto_c_check = COALESCE($5, auto_c_check),
        auto_d_check = COALESCE($6, auto_d_check),
        updated_at = NOW()
      WHERE airline_id = $1
      RETURNING
        airline_id,
        auto_hire,
        auto_salary,
        manual_salary_override,
        auto_c_check,
        auto_d_check,
        created_at,
        updated_at
      `,
      [
        airlineId,
        typeof auto_hire === "boolean" ? auto_hire : null,
        typeof auto_salary === "boolean" ? auto_salary : null,
        typeof manual_salary_override === "boolean" ? manual_salary_override : null,
        typeof auto_c_check === "boolean" ? auto_c_check : null,
        typeof auto_d_check === "boolean" ? auto_d_check : null
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
