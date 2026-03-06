const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

/* ============================================================
   GET WORLD STATE
   Returns the single global ACS world
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

    res.json(result.rows[0]);

  } catch (err) {

    console.error("WORLD FETCH ERROR:", err);

    res.status(500).json({
      error: "Failed to fetch world state"
    });

  }

});

module.exports = router;
