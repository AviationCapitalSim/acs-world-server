import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   GET HR DEPARTMENTS
============================================================ */

router.get("/hr/departments/:airlineId", async (req, res) => {

  const airlineId = req.params.airlineId;

  try {

    const result = await pool.query(
      `
      SELECT
        dept_id,
        staff,
        morale
      FROM hr_departments
      WHERE airline_id = $1
      ORDER BY dept_id
      `,
      [airlineId]
    );

    res.json({
      ok: true,
      departments: result.rows
    });

  } catch (err) {

    console.error("HR FETCH ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

export default router;
