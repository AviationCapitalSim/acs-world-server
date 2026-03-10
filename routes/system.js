import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET SYSTEM STATE
   ============================================================ */

router.get("/system/state", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT
        current_season,
        world_status,
        game_year,
        reset_flag,
        maintenance_mode
      FROM system_state
      LIMIT 1
    `);

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "SYSTEM_STATE_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      system: result.rows[0]
    });

  } catch (err) {

    console.error("SYSTEM STATE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "SYSTEM_STATE_ERROR"
    });

  }

});

/* ============================================================
   MASTER RESET (ADMIN ONLY)
   ============================================================ */

router.post("/system/reset", async (req, res) => {

  const adminToken = req.headers["x-admin-token"];

  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
  }

  try {

    const result = await pool.query(`
      UPDATE system_state
      SET
        current_season = current_season + 1,
        game_year = 1940,
        reset_flag = true,
        last_reset_at = NOW(),
        updated_at = NOW()
      RETURNING current_season, game_year, reset_flag
    `);

    res.json({
      ok: true,
      message: "WORLD RESET EXECUTED",
      system: result.rows[0]
    });

  } catch (err) {

    console.error("WORLD RESET ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "WORLD_RESET_FAILED"
    });

  }

});

export default router;

