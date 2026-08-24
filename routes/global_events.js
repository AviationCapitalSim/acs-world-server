import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   ACS OCC — GLOBAL EVENTS
   ------------------------------------------------------------
   PostgreSQL is the sole authority for:
   - ACS simulation time.
   - Event publication dates.
   - Published event content.

   Future events are never returned to the browser.
   event_end_date remains internal and is never exposed.
   ============================================================ */

router.get("/global-events", async (req, res) => {
  try {
    const worldResult = await pool.query(`
      SELECT
        acs_get_current_sim_time() AS current_sim_time
    `);

    const currentSimTime =
      worldResult.rows[0]?.current_sim_time || null;

    if (!currentSimTime) {
      return res.status(503).json({
        ok: false,
        error: "ACS_TIME_UNAVAILABLE"
      });
    }

    const eventsResult = await pool.query(
      `
      SELECT
        id,
        event_key,
        origin,
        category,
        headline,
        summary,
        article,
        aviation_effect,
        location,
        publication_date,
        image_filename
      FROM public.global_events
      WHERE is_published = TRUE
        AND publication_date <= $1::date
      ORDER BY
        publication_date DESC,
        id DESC
      `,
      [currentSimTime]
    );

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      ok: true,
      time_source: "POSTGRESQL_TIME_AUTHORITY",
      current_sim_time: currentSimTime,
      total: eventsResult.rows.length,
      events: eventsResult.rows
    });

  } catch (err) {
    console.error("GLOBAL EVENTS FETCH ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "GLOBAL_EVENTS_FETCH_FAILED"
    });
  }
});

export default router;
