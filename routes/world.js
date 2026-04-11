import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

export default router;

/* ============================================================
   GET WORLD STATE
   ============================================================ */

router.get("/world", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT * FROM acs_world WHERE id = 1"
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "ACS world not found"
      });
    }

    const world = result.rows[0];

    res.json({
    ...world,
    server_now: Date.now()
   });

  } catch (err) {

    console.error("WORLD FETCH ERROR:", err);

    res.status(500).json({
      error: "Failed to fetch world state"
    });

  }

});

/* ============================================================
   UPDATE WORLD STATE
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
        updated_at = NOW()
      WHERE id = 1
      RETURNING *
      `,
      [status, real_start, frozen_sim_time]
    );

    res.json(result.rows[0]);

  } catch (err) {

    console.error("WORLD UPDATE ERROR:", err);

    res.status(500).json({
      error: "Failed to update world state"
    });

  }

});
