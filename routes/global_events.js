/* ============================================================
   ACS OCC - GLOBAL EVENTS ROUTE v1.0
   ------------------------------------------------------------
   Date: 2026-08-24
   Read-only PostgreSQL global events authority.

   PostgreSQL controls:
   - Official simulation time.
   - Publication availability.
   - Ninety-day visibility for point events.
   - Historical duration for extended events.
   - Active lifecycle identification.

   No embedded events, future records or local fallback.
   No database writes.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   GET GLOBAL EVENTS
   ------------------------------------------------------------
   Visibility rules:

   1. Future events are not returned.

   2. Point events without event_end_date remain visible for
      exactly 90 simulated days from publication_date.

   3. Extended events remain visible while event_end_date is
      equal to or later than the current ACS date.

   4. Expired events remain permanently stored in PostgreSQL,
      but are not returned to the browser.

   Lifecycle:

   is_active = true only when an extended event remains inside
   its historical start/end period.

   event_end_date remains internal and is not exposed.
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

        visible_events AS (
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
            ge.image_filename,

            CASE
              WHEN ge.event_end_date IS NOT NULL
                AND ge.event_start_date::date
                  <= world_authority.current_sim_time::date
                AND ge.event_end_date::date
                  >= world_authority.current_sim_time::date
              THEN TRUE
              ELSE FALSE
            END AS is_active

          FROM public.global_events AS ge
          CROSS JOIN world_authority

          WHERE ge.is_published = TRUE

            AND ge.publication_date
              <= world_authority.current_sim_time::date

            AND (
              (
                ge.event_end_date IS NOT NULL

                AND ge.event_end_date::date
                  >= world_authority.current_sim_time::date
              )

              OR

              (
                ge.event_end_date IS NULL

                AND world_authority.current_sim_time::date
                  < ge.publication_date
                    + INTERVAL '90 days'
              )
            )
        )

        SELECT
          world_authority.current_sim_time,

          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id',
                  visible_events.id,
                'event_key',
                  visible_events.event_key,
                'origin',
                  visible_events.origin,
                'category',
                  visible_events.category,
                'headline',
                  visible_events.headline,
                'summary',
                  visible_events.summary,
                'article',
                  visible_events.article,
                'aviation_effect',
                  visible_events.aviation_effect,
                'location',
                  visible_events.location,
                'publication_date',
                  visible_events.publication_date,
                'image_filename',
                  visible_events.image_filename,
                'is_active',
                  visible_events.is_active
              )

              ORDER BY
                visible_events.publication_date DESC,
                visible_events.id DESC
            ) FILTER (
              WHERE visible_events.id IS NOT NULL
            ),

            '[]'::JSONB
          ) AS events

        FROM world_authority

        LEFT JOIN visible_events
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
