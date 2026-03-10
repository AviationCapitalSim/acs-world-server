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

export default router;
