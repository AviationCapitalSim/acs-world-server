/* ============================================================
   ACS OCC - GLOBAL EVENTS ROUTE v1.0
   ------------------------------------------------------------
   Date: 2026-08-24
   Read-only PostgreSQL global events authority.

   PostgreSQL controls:
   - Official simulation time.
   - Publication availability.
   - Global 365-day visibility.
   - Global event totals.

   All eligible published events are returned.
   Future and expired events remain hidden.
   No embedded data, local fallback or database writes.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   GET GLOBAL EVENTS
   ------------------------------------------------------------
   CURRENT IMPLEMENTATION

   PUBLICATION:
   - Future events remain hidden.
   - Every published event uses the global 365-day rule.
   - Extended events remain visible until 365 simulated days
     after event_end_date.
   - Events without event_end_date remain visible until
     365 simulated days after publication_date.

   No ACTIVE or NORMAL lifecycle classification is applied.
   ============================================================ */

router.get(
  "/global-events",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(`
        WITH world_authority AS (
          SELECT
            acs_get_current_sim_time()
              AS current_sim_time
        ),

        published_events AS (
          SELECT
            ge.id,
            ge.event_key,
            ge.origin,
            ge.category,
            ge.headline,
            ge.summary,
            ge.article,
            ge.aviation_effect,
            ge.location,
            ge.publication_date,
            ge.image_filename

          FROM public.global_events AS ge
          CROSS JOIN world_authority

          WHERE ge.is_published = TRUE

            /* Future events remain hidden */
            AND ge.publication_date
                <= world_authority.current_sim_time::date

            /* Global 365-day visibility rule */
            AND world_authority.current_sim_time::date
                <= COALESCE(
                     ge.event_end_date,
                     ge.publication_date
                   ) + 365
        )

        SELECT
          world_authority.current_sim_time,

          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id',
                  published_events.id,
                'event_key',
                  published_events.event_key,
                'origin',
                  published_events.origin,
                'category',
                  published_events.category,
                'headline',
                  published_events.headline,
                'summary',
                  published_events.summary,
                'article',
                  published_events.article,
                'aviation_effect',
                  published_events.aviation_effect,
                'location',
                  published_events.location,
                'publication_date',
                  published_events.publication_date,
                'image_filename',
                  published_events.image_filename
              )

              ORDER BY
                published_events.publication_date DESC,
                published_events.id DESC
            ) FILTER (
              WHERE published_events.id IS NOT NULL
            ),

            '[]'::JSONB
          ) AS events

        FROM world_authority

        LEFT JOIN published_events
          ON TRUE

        GROUP BY
          world_authority.current_sim_time
      `);

      const currentSimTime =
        result.rows[0]?.current_sim_time || null;

      const events =
        Array.isArray(result.rows[0]?.events)
          ? result.rows[0].events
          : [];

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_UNAVAILABLE"
        });
      }

      res.set("Cache-Control", "no-store");

      return res.status(200).json({
        ok: true,
        time_source:
          "POSTGRESQL_TIME_AUTHORITY",
        current_sim_time: currentSimTime,
        total: events.length,
        events
      });

    } catch (error) {
      console.error(
        "ACS GLOBAL EVENTS FETCH ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ACS_GLOBAL_EVENTS_FETCH_FAILED"
      });
    }
  }
);

export default router;
