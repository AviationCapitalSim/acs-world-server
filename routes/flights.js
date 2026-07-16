import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// =============================================
// GET FLIGHTS
// =============================================

router.get("/flights", async (req, res) => {
  try {
    const minLat = Number(req.query.minLat);
    const maxLat = Number(req.query.maxLat);
    const minLng = Number(req.query.minLng);
    const maxLng = Number(req.query.maxLng);

    if (
      ![minLat, maxLat, minLng, maxLng].every(
        Number.isFinite
      )
    ) {
      return res.status(400).json({
        status: "error",
        msg: "bbox required"
      });
    }

    const sql = `
      SELECT
        flight_id,
        airline_id,
        flight_number,
        aircraft_type,
        origin,
        destination,
        latitude,
        longitude,
        speed,
        dep_time,
        arr_time,
        status,
        updated_at
      FROM global_flights
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND latitude BETWEEN $1 AND $2
        AND longitude BETWEEN $3 AND $4
      ORDER BY updated_at DESC
      LIMIT 5000
    `;

    const params = [
      minLat,
      maxLat,
      minLng,
      maxLng
    ];

    const { rows } = await pool.query(sql, params);

    return res.json({
      server_time: Date.now(),
      count: rows.length,
      flights: rows
    });
  } catch (err) {
    console.error("FLIGHTS QUERY ERROR:", err);

    return res.status(500).json({
      status: "error",
      msg: "database failure",
      error: err.message
    });
  }
});

// =============================================
// FLIGHT DEPARTURE
// =============================================

router.post(
  "/flight/departure",
  requireAuth,
  async (req, res) => {
    try {
      const b = req.body || {};
      const now = Date.now();

      if (
        !b.flight_id ||
        !b.airline_id ||
        !b.origin ||
        !b.destination
      ) {
        return res.status(400).json({
          status: "error",
          msg: "missing fields"
        });
      }

      await pool.query(
        `
        INSERT INTO global_flights (
          flight_id,
          airline_id,
          flight_number,
          aircraft_type,
          origin,
          destination,
          latitude,
          longitude,
          speed,
          dep_time,
          arr_time,
          status,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6,
          $7, $8, $9,
          $10, $11, $12, $13
        )
        ON CONFLICT (flight_id)
        DO UPDATE SET
          airline_id = EXCLUDED.airline_id,
          flight_number = EXCLUDED.flight_number,
          aircraft_type = EXCLUDED.aircraft_type,
          origin = EXCLUDED.origin,
          destination = EXCLUDED.destination,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          speed = EXCLUDED.speed,
          dep_time = EXCLUDED.dep_time,
          arr_time = EXCLUDED.arr_time,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
        `,
        [
          b.flight_id,
          b.airline_id,
          b.flight_number || null,
          b.aircraft_type || null,
          b.origin,
          b.destination,
          Number.isFinite(Number(b.latitude)) &&
          Number(b.latitude) !== 0
            ? Number(b.latitude)
            : null,
          Number.isFinite(Number(b.longitude)) &&
          Number(b.longitude) !== 0
            ? Number(b.longitude)
            : null,
          Number.isFinite(Number(b.speed))
            ? Number(b.speed)
            : null,
          Number(b.dep_time) || null,
          Number(b.arr_time) || null,
          Number(b.status) || 1,
          now
        ]
      );

      return res.json({
        status: "ok",
        server_time: now
      });
    } catch (err) {
      console.error("DEPARTURE ERROR:", err);

      return res.status(500).json({
        status: "error",
        msg: "departure failure",
        error: err.message
      });
    }
  }
);

// =============================================
// FLIGHT ARRIVAL
// =============================================

router.post(
  "/flight/arrival",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        flight_id,
        schedule_item_id
      } = req.body || {};

      if (!flight_id && !schedule_item_id) {
        return res.status(400).json({
          status: "error",
          msg: "flight_id or schedule_item_id required"
        });
      }

      await client.query("BEGIN");

      let scheduleItemId =
        Number(schedule_item_id) || null;

      if (!scheduleItemId && flight_id) {
        const flightResult = await client.query(
          `
          SELECT
            id,
            airline_id
          FROM schedule_items
          WHERE item_type = 'flight'
            AND (
              schedule_uid = $1
              OR route_uid = $1
              OR flight_number = $1
            )
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE
          `,
          [flight_id]
        );

        if (flightResult.rows.length) {
          scheduleItemId = Number(
            flightResult.rows[0].id
          );
        }
      }

      const settlement = null;

      if (scheduleItemId) {
        const scheduleResult = await client.query(
          `
          SELECT *
          FROM schedule_items
          WHERE id = $1
          FOR UPDATE
          `,
          [scheduleItemId]
        );

        if (!scheduleResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            status: "error",
            msg: "schedule_item not found"
          });
        }

        const schedule = scheduleResult.rows[0];

        if (schedule.item_type !== "flight") {
          await client.query("ROLLBACK");

          return res.status(409).json({
            status: "error",
            msg: "schedule_item is not a flight"
          });
        }

        if (schedule.status !== "cancelled") {
          await client.query(
            `
            UPDATE schedule_items
            SET
              status = 'completed',
              updated_at = NOW()
            WHERE id = $1
            `,
            [scheduleItemId]
          );
        }
      }

      if (flight_id) {
        await client.query(
          `
          DELETE FROM global_flights
          WHERE flight_id = $1
          `,
          [flight_id]
        );
      }

      await client.query("COMMIT");

      return res.json({
        status: "ok",
        server_time: Date.now(),
        schedule_item_id: scheduleItemId,
        settlement
      });
    } catch (err) {
      await client.query("ROLLBACK");

      console.error("ARRIVAL ERROR:", err);

      return res.status(500).json({
        status: "error",
        msg: "arrival failure",
        error: err.message
      });
    } finally {
      client.release();
    }
  }
);

export default router;
