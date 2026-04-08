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

    // 🧠 calcular tiempo simulado REAL
    let simTime = world.frozen_sim_time;

    if (world.status === "running" && world.real_start) {

      const elapsedRealMs = Date.now() - new Date(world.real_start).getTime();

      // ⏱ 1 segundo real = 1 minuto simulado
      const simElapsed = elapsedRealMs * 60;

      simTime = world.frozen_sim_time + simElapsed;
    }

    // 📅 convertir a año
    const simDate = new Date(simTime);
    const simYear = simDate.getUTCFullYear();

    res.json({
      ok: true,
      ...world,
      sim_time: simTime,
      sim_year: simYear,
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
