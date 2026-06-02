import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET WORLD STATE — POSTGRESQL TIME AUTHORITY
   ============================================================ */

router.get("/world", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        sim_start,
        sim_end,
        real_start,
        frozen_sim_time,
        status,
        updated_at,
        acs_get_current_sim_time() AS current_sim_time,
        'POSTGRESQL_TIME_AUTHORITY' AS time_source
      FROM acs_world
      WHERE id = 1
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "ACS_WORLD_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      world: result.rows[0]
    });

  } catch (err) {
    console.error("WORLD FETCH ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "WORLD_FETCH_FAILED"
    });
  }
});

/* ============================================================
   UPDATE WORLD STATE — ADMIN CONTROLLED
   NOTE:
   This endpoint does NOT calculate time in JavaScript.
   PostgreSQL remains the authority.
   ============================================================ */

router.post("/world", async (req, res) => {
  try {
    const { status, real_start, frozen_sim_time } = req.body;

    const result = await pool.query(
      `
      UPDATE acs_world
      SET
        status = COALESCE($1, status),
        real_start = COALESCE($2, real_start),
        frozen_sim_time = COALESCE($3, frozen_sim_time),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING
        id,
        sim_start,
        sim_end,
        real_start,
        frozen_sim_time,
        status,
        updated_at,
        acs_get_current_sim_time() AS current_sim_time,
        'POSTGRESQL_TIME_AUTHORITY' AS time_source
      `,
      [status, real_start, frozen_sim_time]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "ACS_WORLD_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      world: result.rows[0]
    });

  } catch (err) {
    console.error("WORLD UPDATE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "WORLD_UPDATE_FAILED"
    });
  }
});

export default router;
