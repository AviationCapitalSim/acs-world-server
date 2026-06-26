const express = require("express");
const router = express.Router();

module.exports = function skytrackRoutes(pool) {

  router.get("/context", async (req, res) => {
    const client = await pool.connect();

    try {
      const airlineId =
        req.user?.airline_id ||
        req.session?.user?.airline_id ||
        req.session?.airline_id;

      if (!airlineId) {
        return res.status(401).json({
          ok: false,
          error: "AIRLINE_SESSION_REQUIRED"
        });
      }

      const fleetResult = await client.query(
        `
        SELECT *
        FROM aircraft_fleet
        WHERE airline_id = $1
        ORDER BY id ASC
        `,
        [airlineId]
      );

      const scheduleResult = await client.query(
        `
        SELECT *
        FROM schedule_items
        WHERE airline_id = $1
          AND item_type = 'flight'
          AND status = 'assigned'
        ORDER BY aircraft_id ASC, dep_abs_min ASC
        `,
        [airlineId]
      );

      const routePlansResult = await client.query(
        `
        SELECT *
        FROM route_plans
        WHERE airline_id = $1
        ORDER BY id ASC
        `,
        [airlineId]
      );

      return res.json({
        ok: true,
        authority: "POSTGRESQL_SKYTRACK_AUTHORITY",
        airline_id: airlineId,
        fleet: fleetResult.rows,
        schedule_items: scheduleResult.rows,
        route_plans: routePlansResult.rows
      });

    } catch (err) {
      console.error("SKYTRACK_CONTEXT_ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "SKYTRACK_CONTEXT_ERROR",
        details: err.message
      });

    } finally {
      client.release();
    }
  });

  return router;
};
